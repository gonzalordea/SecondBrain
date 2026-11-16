import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.ts';
import { HttpError, parse, requireUser } from './http.ts';
import { createNote, loadNote, MAX_CONTENT } from './notes.ts';
import { extractFileText, type Indexer } from './processing.ts';

const exportNote = z.object({
  id: z.string().max(100),
  type: z.enum(['note', 'document', 'task']).default('note'),
  title: z.string().trim().min(1).max(200),
  content: z.string().max(MAX_CONTENT).default(''),
  category: z.string().trim().max(60).nullish(),
  status: z.enum(['todo', 'doing', 'done']).nullish(),
  dueDate: z.iso.date().nullish(),
  tags: z.array(z.string().trim().min(1).max(50).regex(/^[\p{L}\p{N}_ -]+$/u)).max(30).default([]),
});
export const exportFile = z.object({
  format: z.literal('secondbrain-export'),
  version: z.literal(1),
  notes: z.array(exportNote).max(5000),
  links: z.array(z.object({ source: z.string(), target: z.string() })).max(50_000).default([]),
});

const ALLOWED = /\.(json|md|markdown|txt|pdf)$/i;

// The type comes from the (already allow-listed) extension, never from the client's Content-Type.
export const mimeFor = (name: string) =>
  /\.pdf$/i.test(name) ? 'application/pdf' : /\.(md|markdown)$/i.test(name) ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';

/** Client filenames can carry paths or control characters; keep only a clean base name. */
export const safeFilename = (name: string) =>
  (name.split(/[\\/]/).pop() ?? '').replace(/[\x00-\x1f\x7f"]/g, '').trim().slice(-200) || 'fichero';

/** RFC 6266 header with an ASCII fallback and the exact UTF-8 name. */
export const attachment = (name: string) => {
  const ascii = name.normalize('NFKD').replace(/[^\w .-]/g, '').trim() || 'fichero';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

export async function ioRoutes(app: FastifyInstance, { db, indexer }: { db: Db; indexer: Indexer }) {
  app.get('/api/export', async (req, reply) => {
    const user = requireUser(req);
    const notes = await db.query(
      `SELECT n.id, n.type, n.title, n.content, n.category, n.status, to_char(n.due_date, 'YYYY-MM-DD') AS due_date, n.summary, n.created_at, n.updated_at,
              coalesce((SELECT array_agg(t.name ORDER BY lower(t.name)) FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                         WHERE nt.note_id = n.id AND nt.source = 'manual'), '{}') AS tags
         FROM notes n WHERE n.owner_id = $1 AND n.deleted_at IS NULL ORDER BY n.created_at`, [user.id]);
    const links = await db.query(
      `SELECT l.source_id AS source, l.target_id AS target FROM note_links l JOIN notes n ON n.id = l.source_id JOIN notes m ON m.id = l.target_id
        WHERE l.kind = 'manual' AND n.owner_id = $1 AND n.deleted_at IS NULL AND m.deleted_at IS NULL`, [user.id]);
    reply.header('content-disposition', `attachment; filename="secondbrain-${new Date().toISOString().slice(0, 10)}.json"`);
    return {
      format: 'secondbrain-export', version: 1, exportedAt: new Date().toISOString(),
      notes: notes.map((n) => ({
        id: n.id, type: n.type, title: n.title, content: n.content, category: n.category, status: n.status,
        dueDate: n.due_date, summary: n.summary, tags: n.tags, createdAt: n.created_at, updatedAt: n.updated_at,
      })),
      links,
    };
  });

  app.get('/api/notes/:id/export.md', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const n = await loadNote(db, id, user.id);
    const tags = (await db.query('SELECT t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = $1', [id])).map((t) => t.name);
    const yaml = (s: string) => JSON.stringify(s); // JSON strings are valid YAML scalars and escape safely
    const front = [`title: ${yaml(n.title)}`, `type: ${n.type}`, n.category && `category: ${yaml(n.category)}`,
      tags.length && `tags: [${tags.map(yaml).join(', ')}]`, `updated: ${new Date(n.updated_at).toISOString()}`].filter(Boolean).join('\n');
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition', attachment(`${n.title.slice(0, 80)}.md`));
    return `---\n${front}\n---\n\n${n.content}\n`;
  });

  // Download the original file behind an imported document. Same access rule as reading the note.
  app.get('/api/notes/:id/files/:fileId', async (req, reply) => {
    const user = requireUser(req);
    const { id, fileId } = parse(z.object({ id: z.uuid(), fileId: z.uuid() }), req.params);
    await loadNote(db, id, user.id);
    const [f] = await db.query('SELECT filename, mime, data FROM note_files WHERE id = $1 AND note_id = $2', [fileId, id]);
    if (!f) throw new HttpError(404, 'not_found', 'Fichero no encontrado');
    const data = Buffer.from(f.data); // pg gives a Buffer, PGlite a Uint8Array
    reply.header('content-type', f.mime);
    reply.header('content-length', data.length);
    reply.header('content-disposition', attachment(f.filename));
    // Uploaded bytes are untrusted: never let a browser treat them as a page of this origin.
    reply.header('content-security-policy', "sandbox; default-src 'none'");
    reply.header('cache-control', 'private, no-store');
    return reply.send(data);
  });

  app.post('/api/import', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    if (!req.isMultipart()) throw new HttpError(415, 'multipart_required', 'Envía los ficheros como multipart/form-data');
    const created: { id: string; title: string; type: string }[] = [];
    const errors: { file: string; message: string }[] = [];

    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const name = part.filename || 'fichero';
      if (!ALLOWED.test(name)) {
        await part.toBuffer().catch(() => {}); // drain the stream before moving on
        errors.push({ file: name, message: 'Tipo no soportado (usa .json, .md, .txt o .pdf)' });
        continue;
      }
      const buf = await part.toBuffer(); // throws 413 when over the size limit
      try {
        if (/\.json$/i.test(name)) {
          let data: unknown;
          try { data = JSON.parse(buf.toString('utf8')); } catch { throw new Error('JSON mal formado'); }
          const parsed = exportFile.safeParse(data);
          if (!parsed.success) throw new Error(`No es una exportación válida de SecondBrain: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
          const idMap = new Map<string, string>();
          for (const n of parsed.data.notes) {
            const note = await createNote(db, user.id, { ...n, category: n.category ?? null, status: n.status ?? null, dueDate: n.dueDate ?? null }, 'import');
            idMap.set(n.id, note.id);
            created.push({ id: note.id, title: note.title, type: note.type });
            indexer.enqueue(note.id);
          }
          for (const l of parsed.data.links) {
            const s = idMap.get(l.source), t = idMap.get(l.target);
            if (s && t && s !== t) await db.query(`INSERT INTO note_links (source_id, target_id, kind) VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`, [s, t]);
          }
        } else {
          const { title, content } = await extractFileText(name, buf);
          if (!content.trim()) throw new Error('No se pudo extraer texto (¿PDF escaneado sin OCR?)');
          if (content.length > MAX_CONTENT) throw new Error(`El texto supera ${MAX_CONTENT} caracteres`);
          const note = await createNote(db, user.id, { type: 'document', title, content }, 'upload',
            { filename: safeFilename(name), mime: mimeFor(name), data: buf });
          created.push({ id: note.id, title: note.title, type: note.type });
          indexer.enqueue(note.id);
        }
      } catch (err) {
        errors.push({ file: name, message: (err as Error).message.slice(0, 300) });
      }
    }
    if (!created.length && !errors.length) throw new HttpError(400, 'no_files', 'No se recibió ningún fichero');
    return { imported: created.length, notes: created, errors };
  });
}
