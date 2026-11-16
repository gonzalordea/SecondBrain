import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.ts';
import { HttpError, parse, requireUser } from './http.ts';
import { loadNote } from './notes.ts';
import { extractiveSummary, llmError, type Enrichment, type Llm } from './assistant.ts';
import type { Embedder } from './processing.ts';

export interface Enricher {
  /** Called after a note is (re)indexed; runs once edits have been quiet for the configured delay. */
  schedule(noteId: string): void;
  /** Enrich now. `force` ignores the length threshold and the "already up to date" check. */
  run(noteId: string, opts?: { force?: boolean }): Promise<{ summary: string; method: 'llm' | 'extractive' } | null>;
  idle(): Promise<void>;
  /** Drop pending timers on shutdown; their notes stay 'pending' and are rescheduled on boot. */
  stop(): void;
}

interface Options { enabled: boolean; delayMs: number; minChars: number }

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Never trust model output blindly: clean, dedupe, cap, and keep only people actually named in the text. */
export function cleanEnrichment(e: Enrichment, content: string): Enrichment {
  const text = fold(content);
  const uniq = (xs: string[], max: number, maxLen: number) => {
    const seen = new Map<string, string>();
    for (const raw of xs) {
      const x = raw.replace(/^[@#]/, '').replace(/\s+/g, ' ').trim();
      if (x && x.length <= maxLen && !seen.has(fold(x))) seen.set(fold(x), x);
    }
    return [...seen.values()].slice(0, max);
  };
  return {
    summary: e.summary.trim().slice(0, 2000),
    people: uniq(e.people, 15, 80).filter((p) => text.includes(fold(p))), // hallucinated names are dropped
    concepts: uniq(e.concepts, 12, 60),
  };
}

export function createEnricher(db: Db, embedder: Embedder, llm: Llm | null, log: FastifyBaseLogger, opts: Options): Enricher {
  // ponytail: in-process timers + one serial queue; pending/failed notes are rescheduled on boot. A job table if several replicas run.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let chain: Promise<unknown> = Promise.resolve();

  async function enrich(noteId: string, force: boolean) {
    const [n] = await db.query('SELECT id, owner_id, title, content, version, enriched_version FROM notes WHERE id = $1 AND deleted_at IS NULL', [noteId]);
    if (!n) return null;
    if (!force && (n.content.length < opts.minChars || n.enriched_version === n.version)) {
      if (n.content.length < opts.minChars) await db.query(`UPDATE notes SET enrich_status = 'none' WHERE id = $1 AND enrich_status = 'pending'`, [noteId]);
      return null;
    }
    let result: Enrichment, method: 'llm' | 'extractive';
    if (llm) {
      result = cleanEnrichment(await llm.enrich(n.title, n.content), n.content);
      method = 'llm';
    } else {
      result = { summary: await extractiveSummary(embedder, n.content), people: [], concepts: [] };
      method = 'extractive';
    }
    await db.tx(async (t) => {
      // If the note changed while the model was thinking, the save is still useful but stays 'pending':
      // that later edit has already scheduled another run.
      await t.query(
        `UPDATE notes SET summary = $2, summary_method = $3, enriched_version = $4,
                enrich_status = CASE WHEN version = $4 THEN 'done' ELSE 'pending' END
          WHERE id = $1`, [noteId, result.summary, method, n.version]);
      if (method !== 'llm') return; // without a model there is nothing to extract; keep earlier AI entities
      await t.query(`DELETE FROM note_entities WHERE note_id = $1 AND source = 'ai'`, [noteId]);
      for (const [kind, names] of [['person', result.people], ['concept', result.concepts]] as const) {
        for (const name of names) {
          const [e] = await t.query<{ id: string }>(
            `INSERT INTO entities (owner_id, kind, name) VALUES ($1, $2, $3)
             ON CONFLICT (owner_id, kind, lower(name)) DO UPDATE SET name = entities.name RETURNING id`, [n.owner_id, kind, name]);
          // An @mention of the same person keeps its 'text' row.
          await t.query(`INSERT INTO note_entities (note_id, entity_id, source) VALUES ($1, $2, 'ai') ON CONFLICT DO NOTHING`, [noteId, e.id]);
        }
      }
    });
    return { summary: result.summary, method };
  }

  const queue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };

  return {
    schedule(noteId) {
      if (!opts.enabled) return;
      clearTimeout(timers.get(noteId));
      db.query(
        `UPDATE notes SET enrich_status = 'pending'
          WHERE id = $1 AND length(content) >= $2 AND enriched_version IS DISTINCT FROM version`, [noteId, opts.minChars],
      ).catch((err) => log.error({ err, noteId }, 'could not mark enrichment pending'));
      timers.set(noteId, setTimeout(() => {
        timers.delete(noteId);
        queue(() => enrich(noteId, false)).catch(async (err) => {
          log.error({ err, noteId }, 'enrichment failed');
          await db.query(`UPDATE notes SET enrich_status = 'failed' WHERE id = $1`, [noteId]).catch(() => {});
        });
      }, opts.delayMs).unref());
    },
    run: (noteId, { force = false } = {}) => queue(() => enrich(noteId, force)),
    stop() { for (const t of timers.values()) clearTimeout(t); timers.clear(); },
    async idle() {
      while (timers.size) await new Promise((r) => setTimeout(r, 10));
      await chain;
    },
  };
}

export async function enrichRoutes(app: FastifyInstance, { db, enricher, aiRateLimit }: { db: Db; enricher: Enricher; aiRateLimit: number }) {
  // Manual "Generar / Regenerar": same pipeline as the automatic one, run now.
  app.post('/api/notes/:id/summarize', { config: { rateLimit: { max: aiRateLimit, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const n = await loadNote(db, id, user.id, { write: true });
    if (!n.content.trim()) throw new HttpError(400, 'empty', 'La nota está vacía');
    try {
      return (await enricher.run(id, { force: true }))!;
    } catch (err) {
      throw llmError(err);
    }
  });
}
