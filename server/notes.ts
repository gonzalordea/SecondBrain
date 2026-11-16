import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.ts';
import { HttpError, notFound, parse, requireUser } from './http.ts';
import { syncDerived, type Indexer } from './processing.ts';

export const MAX_CONTENT = 200_000;

const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const noteType = z.enum(['note', 'document', 'task']);
const taskStatus = z.enum(['todo', 'doing', 'done']);
const tagName = z.string().trim().min(1).max(50).regex(/^[\p{L}\p{N}_ -]+$/u, 'Etiqueta inválida');
const fields = {
  type: noteType,
  title: z.string().trim().min(1).max(200),
  content: z.string().max(MAX_CONTENT),
  category: z.string().trim().max(60).nullable(),
  status: taskStatus.nullable(),
  dueDate: z.iso.date().nullable(),
  tags: z.array(tagName).max(30),
};
const createBody = z.object({
  ...fields,
  type: fields.type.default('note'),
  content: fields.content.default(''),
}).partial({ category: true, status: true, dueDate: true, tags: true });
const patchBody = z.object(fields).partial().extend({ version: z.number().int().positive() });

export type Access = 'owner' | 'editor' | 'viewer';

/** The single gate for note access: owner, or an explicit share. Everything else is "not found". */
export async function loadNote(db: Db, noteId: string, userId: string, opts: { write?: boolean; ownerOnly?: boolean; includeDeleted?: boolean } = {}) {
  const [n] = await db.query(
    `SELECT n.*, CASE WHEN n.owner_id = $2 THEN 'owner' ELSE s.role END AS access
       FROM notes n LEFT JOIN note_shares s ON s.note_id = n.id AND s.user_id = $2
      WHERE n.id = $1 AND (n.owner_id = $2 OR s.user_id IS NOT NULL)`,
    [noteId, userId],
  );
  if (!n || (n.deleted_at && !opts.includeDeleted)) throw notFound('Nota');
  // A deleted note is only visible to its owner (in the trash), never through a share.
  if (n.deleted_at && n.access !== 'owner') throw notFound('Nota');
  if (opts.ownerOnly && n.access !== 'owner') {
    throw n.access ? new HttpError(403, 'forbidden', 'Solo el propietario puede hacer esto') : notFound('Nota');
  }
  if (opts.write && n.access === 'viewer') throw new HttpError(403, 'forbidden', 'Solo tienes permiso de lectura');
  return n as Record<string, any> & { access: Access };
}

export async function noteDto(db: Db, n: Record<string, any>) {
  const [tags, people, out, inc, owner, files] = await Promise.all([
    db.query('SELECT t.name, nt.source FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = $1 ORDER BY lower(t.name)', [n.id]),
    db.query('SELECT e.name, e.kind, ne.source FROM note_entities ne JOIN entities e ON e.id = ne.entity_id WHERE ne.note_id = $1 ORDER BY lower(e.name)', [n.id]),
    db.query(`SELECT DISTINCT n2.id, n2.title FROM note_links l JOIN notes n2 ON n2.id = l.target_id
               WHERE l.source_id = $1 AND n2.deleted_at IS NULL AND n2.owner_id = $2`, [n.id, n.owner_id]),
    db.query(`SELECT DISTINCT n2.id, n2.title FROM note_links l JOIN notes n2 ON n2.id = l.source_id
               WHERE l.target_id = $1 AND n2.deleted_at IS NULL AND n2.owner_id = $2`, [n.id, n.owner_id]),
    db.query('SELECT display_name FROM users WHERE id = $1', [n.owner_id]),
    db.query('SELECT id, filename, mime, size, created_at FROM note_files WHERE note_id = $1 ORDER BY created_at', [n.id]),
  ]);
  return {
    id: n.id, type: n.type, title: n.title, content: n.content,
    summary: n.summary, summaryMethod: n.summary_method, category: n.category,
    status: n.status, dueDate: fmtDate(n.due_date), version: n.version, source: n.source,
    embeddingStatus: n.embedding_status, createdAt: n.created_at, updatedAt: n.updated_at, deletedAt: n.deleted_at,
    access: n.access ?? 'owner', owner: { displayName: owner[0]?.display_name },
    tags: tags.map((t) => t.name), textTags: tags.filter((t) => t.source === 'text').map((t) => t.name), people: people.filter((p) => p.kind === 'person').map((p) => p.name),
    aiPeople: people.filter((p) => p.kind === 'person' && p.source === 'ai').map((p) => p.name),
    concepts: people.filter((p) => p.kind === 'concept').map((p) => p.name),
    enrichStatus: n.enrich_status,
    // Links point at the owner's other notes; a share recipient must not learn their titles.
    linksOut: n.access && n.access !== 'owner' ? [] : out, linksIn: n.access && n.access !== 'owner' ? [] : inc,
    files: files.map((f) => ({ id: f.id, filename: f.filename, mime: f.mime, size: f.size, createdAt: f.created_at })),
  };
}

// pg returns DATE as a JS Date at local midnight; PGlite as a string. Normalise to YYYY-MM-DD.
const fmtDate = (d: unknown) => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const x = d as Date;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

const listQuery = z.object({
  scope: z.enum(['mine', 'shared']).default('mine'),
  type: noteType.optional(),
  status: taskStatus.optional(),
  tag: z.string().max(50).optional(),
  category: z.string().max(60).optional(),
  sort: z.enum(['updated', 'created', 'title', 'due']).default('updated'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const SORTS = { updated: 'n.updated_at DESC', created: 'n.created_at DESC', title: 'lower(n.title) ASC', due: 'n.due_date ASC NULLS LAST, n.updated_at DESC' } as const;

/** enrichMin: notes at least this long are marked for automatic enrichment when their text changes; null = off. */
export async function notesRoutes(app: FastifyInstance, { db, indexer, coalesceSeconds, enrichMin }: { db: Db; indexer: Indexer; coalesceSeconds: number; enrichMin: number | null }) {
  app.get('/api/notes', async (req) => {
    const user = requireUser(req);
    const q = parse(listQuery, req.query);
    const params: unknown[] = [user.id];
    const where = ['n.deleted_at IS NULL'];
    if (q.scope === 'mine') where.push('n.owner_id = $1');
    else where.push('EXISTS (SELECT 1 FROM note_shares s WHERE s.note_id = n.id AND s.user_id = $1)');
    if (q.type) { params.push(q.type); where.push(`n.type = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`n.status = $${params.length}`); }
    if (q.category) { params.push(q.category); where.push(`lower(n.category) = lower($${params.length})`); }
    if (q.tag) {
      params.push(q.tag);
      where.push(`EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id AND lower(t.name) = lower($${params.length}))`);
    }
    const whereSql = where.join(' AND ');
    const [{ total }] = await db.query(`SELECT count(*)::int AS total FROM notes n WHERE ${whereSql}`, params);
    params.push(q.limit, q.offset);
    const rows = await db.query(
      `SELECT n.id, n.type, n.title, left(n.content, 240) AS excerpt, n.category, n.status, n.due_date, n.version,
              n.embedding_status, n.created_at, n.updated_at, u.display_name AS owner_name,
              coalesce((SELECT array_agg(t.name ORDER BY lower(t.name)) FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id), '{}') AS tags
         FROM notes n JOIN users u ON u.id = n.owner_id
        WHERE ${whereSql} ORDER BY ${SORTS[q.sort]}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      total,
      items: rows.map((r) => ({
        id: r.id, type: r.type, title: r.title, excerpt: r.excerpt, category: r.category, status: r.status,
        dueDate: fmtDate(r.due_date), version: r.version, embeddingStatus: r.embedding_status,
        createdAt: r.created_at, updatedAt: r.updated_at, tags: r.tags, ownerName: r.owner_name,
      })),
    };
  });

  app.post('/api/notes', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(createBody, req.body);
    const note = await createNote(db, user.id, body, { enrichMin });
    indexer.enqueue(note.id);
    reply.code(201);
    return noteDto(db, note);
  });

  app.get('/api/notes/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    return noteDto(db, await loadNote(db, id, user.id));
  });

  app.patch('/api/notes/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(patchBody, req.body);
    const updated = await db.tx(async (t) => {
      const { access } = await loadNote(t, id, user.id, { write: true });
      // Re-read under a row lock so the snapshot and the version check see the same state.
      const [n] = await t.query('SELECT * FROM notes WHERE id = $1 FOR UPDATE', [id]);
      if (n.version !== body.version) {
        throw new HttpError(409, 'version_conflict', `La nota cambió en otra sesión (versión actual ${n.version})`);
      }
      const textChanged = (body.title !== undefined && body.title !== n.title) || (body.content !== undefined && body.content !== n.content);
      const [row] = await t.query(
        `UPDATE notes SET
           title = coalesce($2, title), content = coalesce($3, content), type = coalesce($4, type),
           category = CASE WHEN $5::boolean THEN $6 ELSE category END,
           status = CASE WHEN $7::boolean THEN $8 ELSE status END,
           due_date = CASE WHEN $9::boolean THEN $10::date ELSE due_date END,
           version = version + 1, updated_at = now(),
           embedding_status = CASE WHEN $11::boolean THEN 'pending' ELSE embedding_status END,
           enrich_status = CASE WHEN $11::boolean AND $12::int IS NOT NULL AND length(coalesce($3, content)) >= $12 THEN 'pending' ELSE enrich_status END
         WHERE id = $1 RETURNING *`,
        [id, body.title ?? null, body.content ?? null, body.type ?? null,
          body.category !== undefined, body.category || null,
          body.status !== undefined, body.status ?? null,
          body.dueDate !== undefined, body.dueDate ?? null, textChanged, enrichMin],
      );
      if (textChanged) await recordVersion(t, row, user.id, 'edit', coalesceSeconds);
      if (textChanged || body.tags) await syncDerived(t, row as any, body.tags);
      return { ...row, access, textChanged };
    });
    if (updated.textChanged) indexer.enqueue(id);
    return noteDto(db, updated);
  });

  app.delete('/api/notes/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await loadNote(db, id, user.id, { ownerOnly: true });
    await db.query('UPDATE notes SET deleted_at = now() WHERE id = $1', [id]);
    return { ok: true };
  });

  // ---------- Versions ----------

  app.get('/api/notes/:id/versions', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const n = await loadNote(db, id, user.id);
    const rows = await db.query(
      `SELECT v.version, v.title, length(v.content) AS length, v.created_at, u.display_name AS edited_by
         FROM note_versions v LEFT JOIN users u ON u.id = v.edited_by
        WHERE v.note_id = $1 ORDER BY v.version DESC`, [id]);
    return {
      current: { version: n.version, title: n.title, updatedAt: n.updated_at },
      versions: rows.map((r) => ({ version: r.version, title: r.title, length: r.length, createdAt: r.created_at, editedBy: r.edited_by })),
    };
  });

  const versionParams = z.object({ id: uuid, v: z.coerce.number().int().positive() });

  app.get('/api/notes/:id/versions/:v', async (req) => {
    const user = requireUser(req);
    const { id, v } = parse(versionParams, req.params);
    await loadNote(db, id, user.id);
    const [row] = await db.query('SELECT version, title, content, created_at FROM note_versions WHERE note_id = $1 AND version = $2', [id, v]);
    if (!row) throw notFound('Versión');
    return { version: row.version, title: row.title, content: row.content, createdAt: row.created_at };
  });

  app.post('/api/notes/:id/versions/:v/restore', async (req) => {
    const user = requireUser(req);
    const { id, v } = parse(versionParams, req.params);
    const updated = await db.tx(async (t) => {
      const { access } = await loadNote(t, id, user.id, { write: true });
      await t.query('SELECT 1 FROM notes WHERE id = $1 FOR UPDATE', [id]);
      const [old] = await t.query('SELECT title, content FROM note_versions WHERE note_id = $1 AND version = $2', [id, v]);
      if (!old) throw notFound('Versión');
      const [row] = await t.query(
        `UPDATE notes SET title = $2, content = $3, version = version + 1, updated_at = now(), embedding_status = 'pending',
                enrich_status = CASE WHEN $4::int IS NOT NULL AND length($3) >= $4 THEN 'pending' ELSE enrich_status END
          WHERE id = $1 RETURNING *`, [id, old.title, old.content, enrichMin]);
      await recordVersion(t, row, user.id, 'restore');
      await syncDerived(t, row as any);
      return { ...row, access };
    });
    indexer.enqueue(id);
    return noteDto(db, updated);
  });

  // ---------- Trash ----------

  app.get('/api/trash', async (req) => {
    const user = requireUser(req);
    const rows = await db.query(
      `SELECT id, type, title, left(content, 160) AS excerpt, deleted_at FROM notes
        WHERE owner_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`, [user.id]);
    return { items: rows.map((r) => ({ id: r.id, type: r.type, title: r.title, excerpt: r.excerpt, deletedAt: r.deleted_at })) };
  });

  app.post('/api/trash/:id/restore', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const n = await loadNote(db, id, user.id, { ownerOnly: true, includeDeleted: true });
    if (!n.deleted_at) throw new HttpError(400, 'not_in_trash', 'La nota no está en la papelera');
    const [row] = await db.query('UPDATE notes SET deleted_at = NULL, updated_at = now() WHERE id = $1 RETURNING *', [id]);
    return noteDto(db, { ...row, access: 'owner' });
  });

  app.delete('/api/trash/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const n = await loadNote(db, id, user.id, { ownerOnly: true, includeDeleted: true });
    if (!n.deleted_at) throw new HttpError(400, 'not_in_trash', 'Solo se pueden eliminar definitivamente notas de la papelera');
    await db.query('DELETE FROM notes WHERE id = $1', [id]);
    return { ok: true };
  });

  app.delete('/api/trash', async (req) => {
    const user = requireUser(req);
    const rows = await db.query('DELETE FROM notes WHERE owner_id = $1 AND deleted_at IS NOT NULL RETURNING id', [user.id]);
    return { deleted: rows.length };
  });

  // ---------- Facets (tags, categories, people) ----------

  app.get('/api/facets', async (req) => {
    const user = requireUser(req);
    const [tags, categories, people] = await Promise.all([
      db.query(`SELECT t.name, count(n.id)::int AS count FROM tags t
                  JOIN note_tags nt ON nt.tag_id = t.id JOIN notes n ON n.id = nt.note_id AND n.deleted_at IS NULL
                 WHERE t.owner_id = $1 GROUP BY t.id ORDER BY count DESC, lower(t.name)`, [user.id]),
      db.query(`SELECT category AS name, count(*)::int AS count FROM notes
                 WHERE owner_id = $1 AND deleted_at IS NULL AND category IS NOT NULL GROUP BY category ORDER BY count DESC`, [user.id]),
      db.query(`SELECT e.name, count(n.id)::int AS count FROM entities e
                  JOIN note_entities ne ON ne.entity_id = e.id JOIN notes n ON n.id = ne.note_id AND n.deleted_at IS NULL
                 WHERE e.owner_id = $1 AND e.kind = 'person' GROUP BY e.id ORDER BY count DESC, lower(e.name)`, [user.id]),
    ]);
    return { tags, categories, people };
  });

  // ---------- Manual links ----------

  app.post('/api/notes/:id/links', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { targetId } = parse(z.object({ targetId: uuid }), req.body);
    await loadNote(db, id, user.id, { ownerOnly: true });
    await loadNote(db, targetId, user.id, { ownerOnly: true });
    if (id === targetId) throw new HttpError(400, 'self_link', 'Una nota no puede enlazarse consigo misma');
    await db.query(`INSERT INTO note_links (source_id, target_id, kind) VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`, [id, targetId]);
    reply.code(201);
    return { ok: true };
  });

  app.delete('/api/notes/:id/links/:targetId', async (req) => {
    const user = requireUser(req);
    const { id, targetId } = parse(z.object({ id: uuid, targetId: uuid }), req.params);
    await loadNote(db, id, user.id, { ownerOnly: true });
    await db.query(`DELETE FROM note_links WHERE source_id = $1 AND target_id = $2 AND kind = 'manual'`, [id, targetId]);
    return { ok: true };
  });

  // ---------- Sharing ----------

  app.get('/api/notes/:id/shares', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await loadNote(db, id, user.id, { ownerOnly: true });
    const rows = await db.query(
      `SELECT u.id, u.email, u.display_name, s.role FROM note_shares s JOIN users u ON u.id = s.user_id
        WHERE s.note_id = $1 ORDER BY s.created_at`, [id]);
    return { shares: rows.map((r) => ({ userId: r.id, email: r.email, displayName: r.display_name, role: r.role })) };
  });

  app.put('/api/notes/:id/shares', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ email: z.email().transform((e) => e.toLowerCase()), role: z.enum(['viewer', 'editor']) }), req.body);
    await loadNote(db, id, user.id, { ownerOnly: true });
    const [target] = await db.query('SELECT id FROM users WHERE lower(email) = $1 AND NOT disabled', [body.email]);
    if (!target) throw notFound('Usuario');
    if (target.id === user.id) throw new HttpError(400, 'self_share', 'No puedes compartir una nota contigo mismo');
    await db.query(
      `INSERT INTO note_shares (note_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (note_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [id, target.id, body.role]);
    return { ok: true };
  });

  app.delete('/api/notes/:id/shares/:userId', async (req) => {
    const user = requireUser(req);
    const { id, userId } = parse(z.object({ id: uuid, userId: uuid }), req.params);
    // The owner can revoke anyone; a recipient can remove themselves.
    const n = await loadNote(db, id, user.id);
    if (n.access !== 'owner' && userId !== user.id) throw new HttpError(403, 'forbidden', 'Solo el propietario puede hacer esto');
    await db.query('DELETE FROM note_shares WHERE note_id = $1 AND user_id = $2', [id, userId]);
    return { ok: true };
  });
}

type VersionReason = 'create' | 'edit' | 'restore' | 'import';

/**
 * History holds saved states. Autosaves by the same person within the window keep updating the
 * entry that started the burst, so typing produces one version, not hundreds. Imports and restores
 * are never overwritten that way: they are states someone may want to go back to.
 */
async function recordVersion(db: Db, n: Record<string, any>, userId: string, reason: VersionReason, coalesceSeconds = 0) {
  if (coalesceSeconds > 0) {
    const [last] = await db.query(
      `SELECT id FROM note_versions
        WHERE note_id = $1 AND edited_by = $2 AND reason IN ('create', 'edit')
          AND created_at > now() - $3 * interval '1 second'
          AND version = (SELECT max(version) FROM note_versions WHERE note_id = $1)`,
      [n.id, userId, coalesceSeconds]);
    if (last) {
      await db.query(`UPDATE note_versions SET version = $2, title = $3, content = $4, reason = 'edit' WHERE id = $1`,
        [last.id, n.version, n.title, n.content]);
      return;
    }
  }
  await db.query(
    `INSERT INTO note_versions (note_id, version, title, content, edited_by, reason) VALUES ($1, $2, $3, $4, $5, $6)`,
    [n.id, n.version, n.title, n.content, userId, reason]);
}

export async function createNote(
  db: Db, ownerId: string,
  body: { type: string; title: string; content: string; category?: string | null; status?: string | null; dueDate?: string | null; tags?: string[] },
  { source = 'manual', file, enrichMin = null }: { source?: 'manual' | 'import' | 'upload'; file?: { filename: string; mime: string; data: Buffer }; enrichMin?: number | null } = {},
) {
  return db.tx(async (t) => {
    const [row] = await t.query(
      `INSERT INTO notes (owner_id, type, title, content, category, status, due_date, source, enrich_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9::int IS NOT NULL AND length($4) >= $9 THEN 'pending' ELSE 'none' END) RETURNING *`,
      [ownerId, body.type, body.title, body.content, body.category || null,
        body.type === 'task' ? body.status ?? 'todo' : body.status ?? null, body.dueDate ?? null, source, enrichMin]);
    await recordVersion(t, row, ownerId, source === 'manual' ? 'create' : 'import');
    if (file) {
      // Same transaction as the note: a document never exists without its original, or vice versa.
      await t.query(
        `INSERT INTO note_files (note_id, owner_id, filename, mime, size, sha256, data) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.id, ownerId, file.filename, file.mime, file.data.length, createHash('sha256').update(file.data).digest('hex'), file.data]);
    }
    await syncDerived(t, row as any, body.tags ?? []);
    return { ...row, access: 'owner' } as Record<string, any> & { access: 'owner' };
  });
}
