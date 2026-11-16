import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.ts';
import type { Config } from './config.ts';
import { HttpError, parse, requireUser, type Role } from './http.ts';

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw, salt, len, opts, (e, k) => (e ? rej(e) : res(k))));

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return timingSafeEqual(key, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const COOKIE = 'sb_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const email = z.email().max(254).transform((e) => e.toLowerCase());
const password = z.string().min(10, 'Mínimo 10 caracteres').max(200);
const registerBody = z.object({ email, password, displayName: z.string().trim().min(1).max(80) });
const loginBody = z.object({ email, password: z.string().min(1).max(200) });

export async function authPlugin(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  // Used to keep login timing identical whether or not the email exists.
  const dummyHash = await hashPassword(randomBytes(16).toString('hex'));
  const ttlMs = config.SESSION_TTL_DAYS * 86_400_000;

  app.decorateRequest('user', null);
  app.decorateRequest('csrfToken', null);

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const unsafe = !SAFE_METHODS.has(req.method);
    // Cross-site form/fetch posts carry a foreign Origin; refuse them before anything else (covers login CSRF).
    if (unsafe && req.headers.origin) {
      const origin = URL.parse(req.headers.origin);
      // req.host honours X-Forwarded-Host only when TRUST_PROXY is on. Parsing it through URL makes
      // "example.com:443" and "https://example.com" compare equal.
      if (!origin || origin.host !== URL.parse(`${origin.protocol}//${req.host}`)?.host) throw new HttpError(403, 'bad_origin', 'Origen no permitido');
    }
    const token = req.cookies[COOKIE];
    if (!token) return;
    const [row] = await db.query(
      `SELECT s.csrf_token, s.last_seen_at, u.id, u.email, u.display_name, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`,
      [sha256(token)],
    );
    if (!row) return;
    req.user = { id: row.id, email: row.email, displayName: row.display_name, role: row.role as Role };
    req.csrfToken = row.csrf_token;
    if (unsafe) {
      const sent = req.headers['x-csrf-token'];
      if (typeof sent !== 'string' || !safeEqual(sent, row.csrf_token)) {
        throw new HttpError(403, 'csrf', 'Token CSRF inválido');
      }
    }
    if (Date.now() - new Date(row.last_seen_at).getTime() > 300_000) {
      await db.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [sha256(token)]);
    }
  });

  async function startSession(reply: FastifyReply, userId: string) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    await db.query(
      `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + $4 * interval '1 millisecond')`,
      [sha256(token), userId, csrf, ttlMs],
    );
    reply.setCookie(COOKIE, token, {
      httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/', maxAge: ttlMs / 1000,
    });
    return csrf;
  }

  const me = async (userId: string, csrfToken: string) => {
    const [u] = await db.query('SELECT id, email, display_name, role, created_at FROM users WHERE id = $1', [userId]);
    return { user: { id: u.id, email: u.email, displayName: u.display_name, role: u.role, createdAt: u.created_at }, csrfToken };
  };

  const authLimit = { rateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' } };

  app.post('/api/auth/register', { config: authLimit }, async (req, reply) => {
    const body = parse(registerBody, req.body); // unknown keys such as "role" are stripped
    const hash = await hashPassword(body.password);
    const rows = await db.query(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)
       ON CONFLICT (lower(email)) DO NOTHING RETURNING id`,
      [body.email, hash, body.displayName],
    );
    if (!rows.length) throw new HttpError(409, 'email_taken', 'Ese email ya está registrado');
    const csrf = await startSession(reply, rows[0].id);
    reply.code(201);
    return me(rows[0].id, csrf);
  });

  app.post('/api/auth/login', { config: authLimit }, async (req, reply) => {
    const body = parse(loginBody, req.body);
    const [u] = await db.query('SELECT id, password_hash, disabled FROM users WHERE lower(email) = $1', [body.email]);
    const ok = await verifyPassword(body.password, u?.password_hash ?? dummyHash);
    if (!u || !ok) throw new HttpError(401, 'invalid_credentials', 'Email o contraseña incorrectos');
    if (u.disabled) throw new HttpError(403, 'disabled', 'Cuenta desactivada');
    // A fresh token on every login: an attacker-planted cookie (session fixation) is never promoted.
    const old = req.cookies[COOKIE];
    if (old) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(old)]);
    const csrf = await startSession(reply, u.id);
    return me(u.id, csrf);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const user = requireUser(req);
    return me(user.id, req.csrfToken!);
  });

  app.post('/api/auth/password', { config: authLimit }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ currentPassword: z.string().max(200), newPassword: password }), req.body);
    const [u] = await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!(await verifyPassword(body.currentPassword, u.password_hash))) {
      throw new HttpError(400, 'wrong_password', 'La contraseña actual no es correcta');
    }
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(body.newPassword), user.id]);
    // Revoke every session (including stolen ones), then issue a new one for this browser.
    await db.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
    const csrf = await startSession(reply, user.id);
    return me(user.id, csrf);
  });

  app.delete('/api/auth/account', { config: authLimit }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ password: z.string().max(200) }), req.body);
    const [u] = await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!(await verifyPassword(body.password, u.password_hash))) {
      throw new HttpError(400, 'wrong_password', 'Contraseña incorrecta');
    }
    await db.query('DELETE FROM users WHERE id = $1', [user.id]); // cascades to every owned row
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
}
