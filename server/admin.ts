import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.ts';
import { HttpError, notFound, parse, requireAdmin } from './http.ts';

// Admins manage accounts, never content: no endpoint here returns note text.
export async function adminRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    const rows = await db.query(
      `SELECT u.id, u.email, u.display_name, u.role, u.disabled, u.created_at,
              (SELECT count(*) FROM notes n WHERE n.owner_id = u.id AND n.deleted_at IS NULL)::int AS notes,
              (SELECT max(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
         FROM users u ORDER BY u.created_at`);
    return {
      items: rows.map((r) => ({
        id: r.id, email: r.email, displayName: r.display_name, role: r.role, disabled: r.disabled,
        createdAt: r.created_at, notes: r.notes, lastSeen: r.last_seen,
      })),
    };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const body = parse(z.object({ role: z.enum(['user', 'admin']).optional(), disabled: z.boolean().optional() }).strict(), req.body);
    if (id === admin.id) throw new HttpError(400, 'self_change', 'No puedes cambiar tu propio rol ni desactivarte');
    const [u] = await db.query(
      `UPDATE users SET role = coalesce($2, role), disabled = coalesce($3, disabled) WHERE id = $1 RETURNING id, role, disabled`,
      [id, body.role ?? null, body.disabled ?? null]);
    if (!u) throw notFound('Usuario');
    if (u.disabled || body.role) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]); // take effect immediately
    return { id: u.id, role: u.role, disabled: u.disabled };
  });
}
