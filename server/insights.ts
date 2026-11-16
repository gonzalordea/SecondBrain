import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.ts';
import { parse, requireUser } from './http.ts';

export const GRAPH_NOTE_LIMIT = 500;

/** Nearest neighbours of every note (by note embedding), excluding pairs already linked explicitly. */
async function similarPairs(db: Db, userId: string, minSim: number, perNote: number) {
  // ponytail: O(n·k) lateral nearest-neighbour scan over at most GRAPH_NOTE_LIMIT notes; precompute into a table if libraries get large.
  return db.query<{ a: string; b: string; sim: number }>(
    `WITH recent AS (
       SELECT id, embedding FROM notes WHERE owner_id = $1 AND deleted_at IS NULL AND embedding IS NOT NULL
       ORDER BY updated_at DESC LIMIT $4)
     SELECT DISTINCT least(a.id, nb.id) AS a, greatest(a.id, nb.id) AS b, nb.sim
       FROM recent a
       CROSS JOIN LATERAL (
         SELECT r.id, 1 - (a.embedding <=> r.embedding) AS sim FROM recent r
          WHERE r.id <> a.id ORDER BY a.embedding <=> r.embedding LIMIT $3) nb
      WHERE nb.sim >= $2
        AND NOT EXISTS (SELECT 1 FROM note_links l WHERE (l.source_id = a.id AND l.target_id = nb.id) OR (l.source_id = nb.id AND l.target_id = a.id))`,
    [userId, minSim, perNote, GRAPH_NOTE_LIMIT],
  );
}

export async function insightsRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/api/graph', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({
      similar: z.enum(['0', '1']).default('1'),
      threshold: z.coerce.number().min(0).max(1).default(0.55),
    }), req.query);
    const notes = await db.query(
      `SELECT id, title, type FROM notes WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT $2`,
      [user.id, GRAPH_NOTE_LIMIT]);
    const ids = notes.map((n) => n.id);
    const [[{ total }], tagEdges, personEdges, links, similar] = await Promise.all([
      db.query(`SELECT count(*)::int AS total FROM notes WHERE owner_id = $1 AND deleted_at IS NULL`, [user.id]),
      db.query(`SELECT nt.note_id, t.id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ANY($1::uuid[])`, [ids]),
      db.query(`SELECT ne.note_id, e.id, e.name FROM note_entities ne JOIN entities e ON e.id = ne.entity_id WHERE ne.note_id = ANY($1::uuid[])`, [ids]),
      db.query(`SELECT DISTINCT source_id, target_id FROM note_links WHERE source_id = ANY($1::uuid[]) AND target_id = ANY($1::uuid[])`, [ids]),
      q.similar === '1' ? similarPairs(db, user.id, q.threshold, 3) : Promise.resolve([]),
    ]);
    const nodes = new Map<string, { id: string; kind: string; label: string; type?: string; degree: number }>();
    for (const n of notes) nodes.set(`n:${n.id}`, { id: `n:${n.id}`, kind: 'note', label: n.title, type: n.type, degree: 0 });
    const edges: { source: string; target: string; kind: string; weight?: number }[] = [];
    const add = (source: string, target: string, kind: string, weight?: number) => {
      if (!nodes.has(source) || !nodes.has(target)) return;
      nodes.get(source)!.degree++; nodes.get(target)!.degree++;
      edges.push({ source, target, kind, ...(weight !== undefined && { weight: Math.round(weight * 1000) / 1000 }) });
    };
    for (const t of tagEdges) {
      if (!nodes.has(`t:${t.id}`)) nodes.set(`t:${t.id}`, { id: `t:${t.id}`, kind: 'concept', label: t.name, degree: 0 });
      add(`n:${t.note_id}`, `t:${t.id}`, 'tag');
    }
    for (const p of personEdges) {
      if (!nodes.has(`p:${p.id}`)) nodes.set(`p:${p.id}`, { id: `p:${p.id}`, kind: 'person', label: p.name, degree: 0 });
      add(`n:${p.note_id}`, `p:${p.id}`, 'mention');
    }
    for (const l of links) add(`n:${l.source_id}`, `n:${l.target_id}`, 'link');
    for (const s of similar) add(`n:${s.a}`, `n:${s.b}`, 'similar', s.sim);
    return { nodes: [...nodes.values()], edges, truncated: total > notes.length, totalNotes: total };
  });

  app.get('/api/insights/connections', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({
      limit: z.coerce.number().int().min(1).max(50).default(10),
      threshold: z.coerce.number().min(0).max(1).default(0.45),
    }), req.query);
    const pairs = await similarPairs(db, user.id, q.threshold, 5);
    if (!pairs.length) return { items: [] };
    // "Hidden" connections: semantically close but sharing no tag (explicit links were already excluded).
    const shared = new Set((await db.query(
      `SELECT DISTINCT a.note_id || ':' || b.note_id AS k FROM note_tags a JOIN note_tags b ON a.tag_id = b.tag_id AND a.note_id < b.note_id
        WHERE a.note_id = ANY($1::uuid[]) AND b.note_id = ANY($1::uuid[])`,
      [[...new Set(pairs.flatMap((p) => [p.a, p.b]))]])).map((r) => r.k));
    const hidden = pairs.filter((p) => !shared.has(`${p.a}:${p.b}`)).sort((x, y) => y.sim - x.sim).slice(0, q.limit);
    const titles = new Map((await db.query('SELECT id, title, type FROM notes WHERE id = ANY($1::uuid[])',
      [[...new Set(hidden.flatMap((p) => [p.a, p.b]))]])).map((r) => [r.id, r]));
    return {
      items: hidden.map((p) => ({
        a: { id: p.a, title: titles.get(p.a)?.title, type: titles.get(p.a)?.type },
        b: { id: p.b, title: titles.get(p.b)?.title, type: titles.get(p.b)?.type },
        similarity: Math.round(p.sim * 1000) / 1000,
      })),
    };
  });

  app.get('/api/stats', async (req) => {
    const user = requireUser(req);
    const u = [user.id];
    const live = `owner_id = $1 AND deleted_at IS NULL`;
    const liveN = `n.owner_id = $1 AND n.deleted_at IS NULL`;
    const [byType, words, tasks, counts, topTags, topPeople, activity, connected, orphans, indexing, sources] = await Promise.all([
      db.query(`SELECT type, count(*)::int AS count FROM notes WHERE ${live} GROUP BY type`, u),
      db.query(`SELECT coalesce(sum(array_length(regexp_split_to_array(nullif(trim(content), ''), '\\s+'), 1)), 0)::int AS words FROM notes WHERE ${live}`, u),
      db.query(`SELECT count(*) FILTER (WHERE status = 'todo')::int AS todo, count(*) FILTER (WHERE status = 'doing')::int AS doing,
                       count(*) FILTER (WHERE status = 'done')::int AS done,
                       count(*) FILTER (WHERE status <> 'done' AND due_date < current_date)::int AS overdue
                  FROM notes WHERE ${live} AND type = 'task'`, u),
      db.query(`SELECT
          (SELECT count(*) FROM notes WHERE owner_id = $1 AND deleted_at IS NOT NULL)::int AS trash,
          (SELECT count(*) FROM note_versions v JOIN notes n ON n.id = v.note_id WHERE ${liveN})::int AS versions,
          (SELECT count(*) FROM conversations WHERE owner_id = $1)::int AS conversations,
          (SELECT count(DISTINCT (l.source_id, l.target_id)) FROM note_links l JOIN notes n ON n.id = l.source_id JOIN notes m ON m.id = l.target_id
            WHERE n.owner_id = $1 AND n.deleted_at IS NULL AND m.deleted_at IS NULL)::int AS links,
          (SELECT count(*) FROM chunks c JOIN notes n ON n.id = c.note_id WHERE c.owner_id = $1 AND n.deleted_at IS NULL)::int AS chunks`, u),
      db.query(`SELECT t.name, count(*)::int AS count FROM note_tags nt JOIN tags t ON t.id = nt.tag_id JOIN notes n ON n.id = nt.note_id
                 WHERE ${liveN} GROUP BY t.id ORDER BY count DESC, lower(t.name) LIMIT 8`, u),
      db.query(`SELECT e.name, count(*)::int AS count FROM note_entities ne JOIN entities e ON e.id = ne.entity_id JOIN notes n ON n.id = ne.note_id
                 WHERE ${liveN} GROUP BY e.id ORDER BY count DESC, lower(e.name) LIMIT 8`, u),
      db.query(`SELECT to_char(w, 'YYYY-MM-DD') AS week,
                       (SELECT count(*) FROM notes WHERE owner_id = $1 AND created_at >= w AND created_at < w + interval '7 days')::int AS created,
                       (SELECT count(*) FROM notes WHERE owner_id = $1 AND updated_at >= w AND updated_at < w + interval '7 days')::int AS updated
                  FROM generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') AS w`, u),
      db.query(`SELECT n.id, n.title, count(*)::int AS degree FROM notes n
                  JOIN note_links l ON l.source_id = n.id OR l.target_id = n.id
                 WHERE ${liveN} GROUP BY n.id ORDER BY degree DESC LIMIT 5`, u),
      db.query(`SELECT count(*)::int AS count FROM notes n WHERE ${liveN}
                   AND NOT EXISTS (SELECT 1 FROM note_links l WHERE l.source_id = n.id OR l.target_id = n.id)
                   AND NOT EXISTS (SELECT 1 FROM note_tags WHERE note_id = n.id)
                   AND NOT EXISTS (SELECT 1 FROM note_entities WHERE note_id = n.id)`, u),
      db.query(`SELECT embedding_status AS status, count(*)::int AS count FROM notes WHERE ${live} GROUP BY embedding_status`, u),
      db.query(`SELECT source, count(*)::int AS count FROM notes WHERE ${live} GROUP BY source`, u),
    ]);
    const obj = (rows: any[], k: string) => Object.fromEntries(rows.map((r) => [r[k], r.count]));
    const types = { note: 0, document: 0, task: 0, ...obj(byType, 'type') };
    const total = types.note + types.document + types.task;
    return {
      totals: { notes: total, ...types, words: words[0].words, ...counts[0] },
      tasks: tasks[0],
      topTags, topPeople, activity,
      mostConnected: connected,
      orphans: orphans[0].count,
      indexing: { ready: 0, pending: 0, failed: 0, ...obj(indexing, 'status') },
      sources: obj(sources, 'source'),
    };
  });
}
