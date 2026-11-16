import type { FastifyBaseLogger } from 'fastify';
import { toVector, type Db } from './db.ts';

// ---------- Parsing: #tags, @people, [[wikilinks]] ----------

const TAG_RE = /(?:^|\s)#([\p{L}\p{N}_-]{1,50})/gu;
const PERSON_RE = /(?:^|[\s(])@(?:\[([^\]\n]{1,80})\]|(\p{L}[\p{L}\p{N}_-]{0,49}))/gu;
const WIKILINK_RE = /\[\[([^\]\n|]{1,200})(?:\|[^\]\n]*)?\]\]/g;

const uniqCi = (xs: string[]) => {
  const seen = new Map<string, string>();
  for (const x of xs.map((s) => s.trim()).filter(Boolean)) if (!seen.has(x.toLowerCase())) seen.set(x.toLowerCase(), x);
  return [...seen.values()];
};

export function parseContent(text: string) {
  // Code is not prose: `#include` or `@decorator` inside code blocks must not become tags/people.
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  return {
    tags: uniqCi([...prose.matchAll(TAG_RE)].map((m) => m[1])),
    people: uniqCi([...prose.matchAll(PERSON_RE)].map((m) => m[1] ?? m[2])),
    links: uniqCi([...prose.matchAll(WIKILINK_RE)].map((m) => m[1])),
  };
}

// ---------- Chunking ----------

// The embedding model reads at most 128 tokens (~500 chars); longer chunks would be silently truncated.
export const CHUNK_SIZE = 480;
const OVERLAP = 80;

export function chunkText(text: string, size = CHUNK_SIZE, overlap = OVERLAP): string[] {
  const parts: string[] = [];
  for (const para of text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= size) { parts.push(para); continue; }
    // Long paragraph: pack whole sentences; hard-cut (with overlap) sentences that alone exceed the size.
    let buf = '';
    const flush = () => { if (buf) parts.push(buf); buf = ''; };
    for (const s of para.split(/(?<=[.!?…])\s+/)) {
      if (s.length > size) {
        flush();
        for (let i = 0; i < s.length; i += size - overlap) parts.push(s.slice(i, i + size));
        continue;
      }
      if (buf && buf.length + 1 + s.length > size) flush();
      buf = buf ? `${buf} ${s}` : s;
    }
    flush();
  }
  // Merge small neighbouring paragraphs so short notes don't explode into tiny chunks.
  const chunks: string[] = [];
  for (const p of parts) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + p.length + 2 <= size) chunks[chunks.length - 1] = `${last}\n\n${p}`;
    else chunks.push(p);
  }
  return chunks;
}

// ---------- Embeddings ----------

export interface Embedder { embed(texts: string[]): Promise<number[][]> }

export function localEmbedder(model: string, cacheDir: string): Embedder {
  let extractor: Promise<any> | undefined;
  const load = () => (extractor ??= import('@huggingface/transformers').then(({ pipeline, env }) => {
    env.cacheDir = cacheDir;
    return pipeline('feature-extraction', model, { dtype: 'q8' });
  }));
  return {
    async embed(texts) {
      const ext = await load();
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 16) {
        const t = await ext(texts.slice(i, i + 16), { pooling: 'mean', normalize: true });
        out.push(...(t.tolist() as number[][]));
      }
      return out;
    },
  };
}

export function meanNormalized(vs: number[][]): number[] {
  const m = vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length);
  const n = Math.hypot(...m) || 1;
  return m.map((x) => x / n);
}

// ---------- Derived data kept in sync with note text ----------

/** Recompute tags (from #hashtags and, if given, the explicit list), people and wikilinks for a note. */
export async function syncDerived(db: Db, note: { id: string; owner_id: string; title: string; content: string }, explicitTags?: string[]) {
  const parsed = parseContent(note.content);
  const upsertTag = async (name: string) =>
    (await db.query<{ id: string }>(
      `INSERT INTO tags (owner_id, name) VALUES ($1, $2)
       ON CONFLICT (owner_id, lower(name)) DO UPDATE SET name = tags.name RETURNING id`,
      [note.owner_id, name],
    ))[0].id;

  if (explicitTags) {
    await db.query('DELETE FROM note_tags WHERE note_id = $1', [note.id]);
    for (const t of uniqCi(explicitTags)) {
      await db.query(`INSERT INTO note_tags (note_id, tag_id, source) VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`, [note.id, await upsertTag(t)]);
    }
  } else {
    await db.query(`DELETE FROM note_tags WHERE note_id = $1 AND source = 'text'`, [note.id]);
  }
  for (const t of parsed.tags) {
    await db.query(`INSERT INTO note_tags (note_id, tag_id, source) VALUES ($1, $2, 'text') ON CONFLICT DO NOTHING`, [note.id, await upsertTag(t)]);
  }

  await db.query('DELETE FROM note_entities WHERE note_id = $1', [note.id]);
  for (const name of parsed.people) {
    const [e] = await db.query<{ id: string }>(
      `INSERT INTO entities (owner_id, kind, name) VALUES ($1, 'person', $2)
       ON CONFLICT (owner_id, kind, lower(name)) DO UPDATE SET name = entities.name RETURNING id`,
      [note.owner_id, name],
    );
    await db.query('INSERT INTO note_entities (note_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [note.id, e.id]);
  }

  await db.query(`DELETE FROM note_links WHERE source_id = $1 AND kind = 'wikilink'`, [note.id]);
  if (parsed.links.length) {
    await db.query(
      `INSERT INTO note_links (source_id, target_id, kind)
       SELECT $1, id, 'wikilink' FROM notes
        WHERE owner_id = $2 AND deleted_at IS NULL AND id <> $1 AND lower(title) = ANY($3::text[])
       ON CONFLICT DO NOTHING`,
      [note.id, note.owner_id, parsed.links.map((l) => l.toLowerCase())],
    );
  }
  // Earlier notes may already point at this title with [[...]]: link them now that the target exists.
  const t = note.title.toLowerCase();
  await db.query(
    `INSERT INTO note_links (source_id, target_id, kind)
     SELECT id, $1, 'wikilink' FROM notes
      WHERE owner_id = $2 AND deleted_at IS NULL AND id <> $1
        AND (position($3 in lower(content)) > 0 OR position($4 in lower(content)) > 0)
     ON CONFLICT DO NOTHING`,
    [note.id, note.owner_id, `[[${t}]]`, `[[${t}|`],
  );
}

// ---------- Background indexer ----------

export interface Indexer { enqueue(noteId: string): void; idle(): Promise<void> }

export function createIndexer(db: Db, embedder: Embedder, log: FastifyBaseLogger): Indexer {
  // ponytail: single in-process queue; pending notes are re-queued on boot. Move to a job table + workers if indexing becomes a bottleneck.
  let chain = Promise.resolve();
  const queued = new Set<string>();

  async function index(noteId: string) {
    const [n] = await db.query('SELECT id, owner_id, title, content, version FROM notes WHERE id = $1', [noteId]);
    if (!n) return;
    const pieces = chunkText(n.content);
    const texts = pieces.length ? pieces : [n.title];
    // The title is prepended to what gets embedded (not to what is stored) so every chunk carries its topic.
    const vectors = await embedder.embed(texts.map((c) => `${n.title}\n${c}`));
    await db.tx(async (t) => {
      const [still] = await t.query('SELECT 1 FROM notes WHERE id = $1 AND version = $2 FOR UPDATE', [n.id, n.version]);
      if (!still) return; // edited meanwhile; the newer version is already queued
      await t.query('DELETE FROM chunks WHERE note_id = $1', [n.id]);
      for (let i = 0; i < texts.length; i++) {
        await t.query('INSERT INTO chunks (note_id, owner_id, idx, content, embedding) VALUES ($1, $2, $3, $4, $5::vector)',
          [n.id, n.owner_id, i, texts[i], toVector(vectors[i])]);
      }
      await t.query(`UPDATE notes SET embedding = $2::vector, embedding_status = 'ready' WHERE id = $1`,
        [n.id, toVector(meanNormalized(vectors))]);
    });
  }

  return {
    enqueue(noteId) {
      if (queued.has(noteId)) return;
      queued.add(noteId);
      chain = chain.then(async () => {
        queued.delete(noteId); // an edit arriving while we index re-queues the note
        try {
          await index(noteId);
        } catch (err) {
          log.error({ err, noteId }, 'indexing failed');
          await db.query(`UPDATE notes SET embedding_status = 'failed' WHERE id = $1`, [noteId]).catch(() => {});
        }
      });
    },
    idle: () => chain,
  };
}

// ---------- File extraction ----------

export async function extractFileText(filename: string, buf: Buffer): Promise<{ title: string; content: string }> {
  const base = filename.replace(/\.[^.]+$/, '').slice(0, 200) || 'Documento';
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('El fichero no es un PDF válido');
    const { extractText } = await import('unpdf');
    const { text } = await extractText(new Uint8Array(buf), { mergePages: true });
    return { title: base, content: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() };
  }
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') {
    const content = buf.toString('utf8').replace(/^﻿/, '');
    const h1 = /^#\s+(.+)$/m.exec(content);
    return { title: (h1?.[1] ?? base).trim().slice(0, 200), content };
  }
  throw new Error(`Tipo de fichero no soportado: .${ext}`);
}
