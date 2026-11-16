import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { toVector, type Db } from './db.ts';
import { parse, requireUser } from './http.ts';
import { loadNote } from './notes.ts';
import type { Embedder } from './processing.ts';

const csv = z.string().max(500).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.string().max(50)).max(10));

export const searchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  mode: z.enum(['hybrid', 'semantic', 'keyword']).default('hybrid'),
  alpha: z.coerce.number().min(0).max(1).default(0.6), // weight of semantic vs keyword score in hybrid mode
  recency: z.coerce.number().min(0).max(1).default(0), // 0 = ignore age, 1 = only recency matters
  minSimilarity: z.coerce.number().min(-1).max(1).default(0.25),
  type: z.enum(['note', 'document', 'task']).optional(),
  tags: csv.optional(),
  category: z.string().max(60).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQuery = z.infer<typeof searchQuery>;

/** Shared WHERE clause for note filters. Values always go through params, never into the SQL string. */
function filters(q: Partial<SearchQuery>, params: unknown[]) {
  const where: string[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (q.type) where.push(`n.type = ${p(q.type)}`);
  if (q.category) where.push(`lower(n.category) = lower(${p(q.category)})`);
  if (q.from) where.push(`n.updated_at >= ${p(q.from)}::date`);
  if (q.to) where.push(`n.updated_at < ${p(q.to)}::date + 1`);
  for (const tag of q.tags ?? []) {
    where.push(`EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id AND lower(t.name) = lower(${p(tag)}))`);
  }
  return where.length ? ' AND ' + where.join(' AND ') : '';
}

export async function semanticCandidates(db: Db, userId: string, vec: number[], q: Partial<SearchQuery>, limit: number) {
  const params: unknown[] = [userId, toVector(vec)];
  const extra = filters(q, params);
  params.push(limit);
  // ponytail: exact per-user scan (owner index, not HNSW) so filters never drop true matches; switch to HNSW + iterative scan past ~100k chunks per user.
  return db.query<{ note_id: string; sim: number; snippet: string }>(
    `SELECT c.note_id, max(1 - (c.embedding <=> $2::vector)) AS sim,
            (array_agg(c.content ORDER BY c.embedding <=> $2::vector))[1] AS snippet
       FROM chunks c JOIN notes n ON n.id = c.note_id
      WHERE c.owner_id = $1 AND n.owner_id = $1 AND n.deleted_at IS NULL${extra}
      GROUP BY c.note_id ORDER BY sim DESC LIMIT $${params.length}`,
    params,
  );
}

async function keywordCandidates(db: Db, userId: string, q: SearchQuery, limit: number) {
  const params: unknown[] = [userId, q.q, q.q.toLowerCase()];
  const extra = filters(q, params);
  params.push(limit);
  return db.query<{ note_id: string; rank: number; snippet: string }>(
    `SELECT n.id AS note_id,
            ts_rank_cd(n.tsv, websearch_to_tsquery('simple', $2)) + CASE WHEN position($3 in lower(n.title)) > 0 THEN 0.5 ELSE 0 END AS rank,
            ts_headline('simple', n.content, websearch_to_tsquery('simple', $2),
                        'StartSel=' || chr(1) || ', StopSel=' || chr(2) || ', MaxWords=35, MinWords=12, MaxFragments=1') AS snippet
       FROM notes n
      WHERE n.owner_id = $1 AND n.deleted_at IS NULL
        AND (n.tsv @@ websearch_to_tsquery('simple', $2) OR position($3 in lower(n.title)) > 0)${extra}
      ORDER BY rank DESC LIMIT $${params.length}`,
    params,
  );
}

export async function search(db: Db, embedder: Embedder, userId: string, q: SearchQuery) {
  const pool = Math.max(q.limit * 3, 30);
  const [sem, kw] = await Promise.all([
    q.mode === 'keyword' ? [] : embedder.embed([q.q]).then(([v]) => semanticCandidates(db, userId, v, q, pool)),
    q.mode === 'semantic' ? [] : keywordCandidates(db, userId, q, pool),
  ]);
  const maxRank = Math.max(0, ...kw.map((k) => k.rank)) || 1;
  const byId = new Map<string, { semantic: number; keyword: number; snippet: string }>();
  for (const s of sem) {
    if (s.sim < q.minSimilarity) continue;
    byId.set(s.note_id, { semantic: Math.max(0, s.sim), keyword: 0, snippet: s.snippet });
  }
  for (const k of kw) {
    const e = byId.get(k.note_id);
    const keyword = k.rank / maxRank;
    // ts_headline marks hits with \x01..\x02; prefer it when it actually highlighted something.
    if (e) { e.keyword = keyword; if (k.snippet.includes('\x01')) e.snippet = k.snippet; }
    else byId.set(k.note_id, { semantic: 0, keyword, snippet: k.snippet });
  }
  if (!byId.size) return [];

  const meta = await db.query(
    `SELECT n.id, n.type, n.title, n.category, n.status, n.updated_at,
            coalesce((SELECT array_agg(t.name ORDER BY lower(t.name)) FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id), '{}') AS tags
       FROM notes n WHERE n.id = ANY($1::uuid[])`, [[...byId.keys()]]);
  const w = q.mode === 'semantic' ? 1 : q.mode === 'keyword' ? 0 : q.alpha;
  return meta
    .map((m) => {
      const s = byId.get(m.id)!;
      const ageDays = (Date.now() - new Date(m.updated_at).getTime()) / 86_400_000;
      const recency = Math.exp(-ageDays / 30);
      const relevance = w * s.semantic + (1 - w) * s.keyword;
      const score = (1 - q.recency) * relevance + q.recency * recency;
      return {
        id: m.id, type: m.type, title: m.title, category: m.category, status: m.status, tags: m.tags,
        updatedAt: m.updated_at, snippet: s.snippet.slice(0, 600),
        scores: { score: round(score), semantic: round(s.semantic), keyword: round(s.keyword), recency: round(recency) },
      };
    })
    .sort((a, b) => b.scores.score - a.scores.score)
    .slice(0, q.limit);
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export async function searchRoutes(app: FastifyInstance, { db, embedder }: { db: Db; embedder: Embedder }) {
  app.get('/api/search', async (req) => {
    const user = requireUser(req);
    const q = parse(searchQuery, req.query);
    const t0 = performance.now();
    const items = await search(db, embedder, user.id, q);
    return { items, tookMs: Math.round(performance.now() - t0) };
  });

  app.get('/api/notes/:id/related', async (req) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(30).default(8) }), req.query);
    const n = await loadNote(db, id, user.id);
    // Suggestions come from the owner's library; showing them to a share recipient would leak other notes.
    if (n.access !== 'owner' || !n.embedding) return { items: [], ready: n.embedding_status === 'ready' };
    const rows = await db.query(
      `SELECT m.id, m.title, m.type, 1 - (m.embedding <=> $2::vector) AS similarity,
              EXISTS (SELECT 1 FROM note_links l WHERE (l.source_id = $1 AND l.target_id = m.id) OR (l.source_id = m.id AND l.target_id = $1)) AS linked,
              (SELECT count(*)::int FROM note_tags a JOIN note_tags b ON a.tag_id = b.tag_id WHERE a.note_id = $1 AND b.note_id = m.id) AS shared_tags
         FROM notes m
        WHERE m.owner_id = $3 AND m.deleted_at IS NULL AND m.id <> $1 AND m.embedding IS NOT NULL
        ORDER BY m.embedding <=> $2::vector LIMIT $4`,
      [id, n.embedding, user.id, limit]);
    return {
      ready: true,
      items: rows.map((r) => ({ id: r.id, title: r.title, type: r.type, similarity: round(r.similarity), linked: r.linked, sharedTags: r.shared_tags })),
    };
  });
}
