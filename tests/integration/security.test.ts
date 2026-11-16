import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, fakeLlm, makeApp, parseSse } from '../helpers.ts';

const { llm, calls } = fakeLlm();
let ctx: Awaited<ReturnType<typeof makeApp>>;
let alice: Client, mallory: Client;
let secret: any;

beforeAll(async () => {
  ctx = await makeApp({}, { llm });
  alice = await Client.register(ctx.app, 'alice@example.com');
  mallory = await Client.register(ctx.app, 'mallory@example.com');
  secret = (await alice.post('/api/notes', { title: 'Contraseña del banco', content: 'El PIN de la tarjeta es 4321. #privado @Banco' })).json();
  await mallory.post('/api/notes', { title: 'Notas de Mallory', content: 'Lista de la compra: pan y leche' });
  await ctx.indexer.idle();
});
afterAll(() => ctx.app.close());

describe('SQL injection', () => {
  const payloads = ["' OR 1=1 --", "'; DROP TABLE notes; --", '") OR ("1"="1', "1' UNION SELECT password_hash FROM users --"];

  it('treats injection payloads in every filter as plain data', async () => {
    for (const p of payloads) {
      const enc = encodeURIComponent(p);
      for (const url of [
        `/api/search?q=${enc}&mode=keyword`, `/api/search?q=${enc}&mode=hybrid`,
        `/api/search?q=pin&tags=${enc}`, `/api/search?q=pin&category=${enc}`,
        `/api/notes?tag=${enc}`, `/api/notes?category=${enc}`,
      ]) {
        const res = await mallory.get(url);
        expect([200, 400]).toContain(res.statusCode);
        if (res.statusCode === 200) expect(res.body).not.toContain('4321');
      }
    }
    expect((await ctx.db.query('SELECT count(*)::int AS c FROM notes'))[0].c).toBeGreaterThanOrEqual(2);
  });

  it('rejects identifiers and enums that are not on the allow-list', async () => {
    expect((await mallory.get('/api/notes?sort=title;DROP TABLE users')).statusCode).toBe(400);
    expect((await mallory.get(`/api/notes/${encodeURIComponent("1' OR '1'='1")}`)).statusCode).toBe(400);
    expect((await mallory.get('/api/search?q=x&mode=../../etc')).statusCode).toBe(400);
  });
});

describe('cross-user isolation', () => {
  it('returns 404 for every operation on another user\'s note', async () => {
    const id = secret.id;
    const attempts = [
      mallory.get(`/api/notes/${id}`),
      mallory.patch(`/api/notes/${id}`, { version: 1, content: 'hacked' }),
      mallory.del(`/api/notes/${id}`),
      mallory.get(`/api/notes/${id}/versions`),
      mallory.get(`/api/notes/${id}/versions/1`),
      mallory.post(`/api/notes/${id}/versions/1/restore`),
      mallory.get(`/api/notes/${id}/related`),
      mallory.post(`/api/notes/${id}/summarize`),
      mallory.get(`/api/notes/${id}/export.md`),
      mallory.get(`/api/notes/${id}/shares`),
      mallory.put(`/api/notes/${id}/shares`, { email: 'mallory@example.com', role: 'editor' }),
      mallory.post(`/api/trash/${id}/restore`),
      mallory.del(`/api/trash/${id}`),
    ];
    for (const res of await Promise.all(attempts)) expect(res.statusCode, res.body).toBe(404);
    // Linking to someone else's note is also refused.
    const own = (await mallory.get('/api/notes')).json().items[0];
    expect((await mallory.post(`/api/notes/${own.id}/links`, { targetId: id })).statusCode).toBe(404);
    expect((await alice.get(`/api/notes/${id}`)).json().content).toContain('4321');
  });

  it('never surfaces another user\'s content in search, graph, stats, export or the assistant', async () => {
    for (const mode of ['semantic', 'keyword', 'hybrid']) {
      const res = await mallory.get(`/api/search?q=${encodeURIComponent('PIN de la tarjeta del banco')}&mode=${mode}&minSimilarity=-1`);
      expect(res.body).not.toContain('4321');
      expect(res.json().items.every((i: any) => i.title === 'Notas de Mallory')).toBe(true);
    }
    expect((await mallory.get('/api/graph')).body).not.toContain('banco');
    expect((await mallory.get('/api/stats')).json().totals.notes).toBe(1);
    expect((await mallory.get('/api/facets')).body).not.toContain('privado');
    expect((await mallory.get('/api/export')).body).not.toContain('4321');

    const conv = (await mallory.post('/api/conversations', {})).json();
    calls.length = 0;
    const res = await mallory.post(`/api/conversations/${conv.id}/messages`, { content: '¿Cuál es el PIN de la tarjeta del banco?' });
    expect(res.body).not.toContain('4321');
    for (const call of calls) expect(call.docs.map((d) => d.text).join()).not.toContain('4321');
    expect(parseSse(res.body).find((e) => e.event === 'done')).toBeDefined();
  });

  it('keeps conversations private', async () => {
    const conv = (await alice.post('/api/conversations', {})).json();
    expect((await mallory.get(`/api/conversations/${conv.id}`)).statusCode).toBe(404);
    expect((await mallory.post(`/api/conversations/${conv.id}/messages`, { content: 'hola' })).statusCode).toBe(404);
    expect((await mallory.del(`/api/conversations/${conv.id}`)).statusCode).toBe(404);
  });
});

describe('sharing permissions', () => {
  let shared: any, viewer: Client, editor: Client;
  beforeAll(async () => {
    shared = (await alice.post('/api/notes', { title: 'Plan compartido', content: 'Borrador del plan' })).json();
    viewer = await Client.register(ctx.app, 'viewer@example.com');
    editor = await Client.register(ctx.app, 'editor@example.com');
    expect((await alice.put(`/api/notes/${shared.id}/shares`, { email: 'viewer@example.com', role: 'viewer' })).statusCode).toBe(200);
    expect((await alice.put(`/api/notes/${shared.id}/shares`, { email: 'editor@example.com', role: 'editor' })).statusCode).toBe(200);
    await ctx.indexer.idle();
  });

  it('lets a viewer read but not write, delete, reshare or see related notes', async () => {
    expect((await viewer.get(`/api/notes/${shared.id}`)).json()).toMatchObject({ access: 'viewer', title: 'Plan compartido' });
    expect((await viewer.patch(`/api/notes/${shared.id}`, { version: 1, content: 'x' })).statusCode).toBe(403);
    expect((await viewer.post(`/api/notes/${shared.id}/versions/1/restore`)).statusCode).toBe(403);
    expect((await viewer.del(`/api/notes/${shared.id}`)).statusCode).toBe(403);
    expect((await viewer.put(`/api/notes/${shared.id}/shares`, { email: 'mallory@example.com', role: 'editor' })).statusCode).toBe(403);
    expect((await viewer.get(`/api/notes/${shared.id}/related`)).json().items).toEqual([]);
    expect((await viewer.get('/api/notes?scope=shared')).json().items.map((i: any) => i.id)).toEqual([shared.id]);
    // Shared notes do not feed the recipient's own search index.
    expect((await viewer.get('/api/search?q=plan&mode=keyword')).json().items).toEqual([]);
  });

  it('lets an editor edit but not delete or manage sharing', async () => {
    const res = await editor.patch(`/api/notes/${shared.id}`, { version: 1, content: 'Plan revisado por el editor' });
    expect(res.statusCode).toBe(200);
    expect((await editor.del(`/api/notes/${shared.id}`)).statusCode).toBe(403);
    expect((await editor.get(`/api/notes/${shared.id}/shares`)).statusCode).toBe(403);
  });

  it('hides a shared note from recipients once it is in the trash, and revocation works', async () => {
    await alice.del(`/api/notes/${shared.id}`);
    expect((await viewer.get(`/api/notes/${shared.id}`)).statusCode).toBe(404);
    await alice.post(`/api/trash/${shared.id}/restore`);
    const viewerId = viewer.user.id;
    expect((await alice.del(`/api/notes/${shared.id}/shares/${viewerId}`)).statusCode).toBe(200);
    expect((await viewer.get(`/api/notes/${shared.id}`)).statusCode).toBe(404);
  });
});

describe('privilege escalation', () => {
  it('ignores a role sent at registration', async () => {
    const c = new Client(ctx.app);
    const res = await c.post('/api/auth/register', { email: 'sneaky@example.com', password: 'long enough password', displayName: 'S', role: 'admin' });
    expect(res.json().user.role).toBe('user');
    c.csrf = res.json().csrfToken;
    expect((await c.get('/api/admin/users')).statusCode).toBe(403);
    expect((await c.patch(`/api/admin/users/${c.user?.id ?? res.json().user.id}`, { role: 'admin' })).statusCode).toBe(403);
  });

  it('lets an admin manage users but not read their notes, and disabling kills sessions', async () => {
    await ctx.db.query(`UPDATE users SET role = 'admin' WHERE email = 'alice@example.com'`);
    const list = await alice.get('/api/admin/users');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('password');
    const target = list.json().items.find((u: any) => u.email === 'mallory@example.com');
    expect((await alice.patch(`/api/admin/users/${alice.user.id}`, { role: 'user' })).statusCode).toBe(400);
    expect((await alice.patch(`/api/admin/users/${target.id}`, { role: 'admin', password_hash: 'x' })).statusCode).toBe(400); // .strict()
    expect((await alice.patch(`/api/admin/users/${target.id}`, { disabled: true })).json().disabled).toBe(true);
    expect((await mallory.get('/api/auth/me')).statusCode).toBe(401);
    const relog = await new Client(ctx.app).post('/api/auth/login', { email: 'mallory@example.com', password: 'correct horse battery' });
    expect(relog.statusCode).toBe(403);
    await alice.patch(`/api/admin/users/${target.id}`, { disabled: false });
  });
});

describe('CSRF and origin checks', () => {
  it('rejects state-changing requests without the session CSRF token', async () => {
    const res = await alice.req('POST', '/api/notes', { title: 'x' }, { 'x-csrf-token': '' });
    expect(res.statusCode).toBe(403);
    const wrong = await alice.req('POST', '/api/notes', { title: 'x' }, { 'x-csrf-token': 'a'.repeat(32) });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('csrf');
    // Another user's token is no good either.
    expect((await alice.req('DELETE', `/api/notes/${secret.id}`, undefined, { 'x-csrf-token': mallory.csrf })).statusCode).toBe(403);
    expect((await alice.get(`/api/notes/${secret.id}`)).statusCode).toBe(200);
  });

  it('rejects cross-origin posts, including login', async () => {
    const evil = { origin: 'https://evil.example' };
    expect((await alice.req('POST', '/api/notes', { title: 'x' }, evil)).statusCode).toBe(403);
    const login = await new Client(ctx.app).req('POST', '/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' }, evil);
    expect(login.statusCode).toBe(403);
    expect((await alice.req('POST', '/api/notes', { title: 'ok' }, { origin: 'http://localhost:80' })).statusCode).toBe(201);
  });
});

describe('sessions', () => {
  it('sets a hardened cookie and stores only a hash of the token', async () => {
    const c = new Client(ctx.app);
    const res = await c.post('/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' });
    const cookie = res.cookies.find((x) => x.name === 'sb_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    const rows = await ctx.db.query('SELECT token_hash FROM sessions');
    expect(rows.some((r) => r.token_hash === cookie.value)).toBe(false);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
  });

  it('issues a new token at login even if the browser already had one (no fixation)', async () => {
    const c = new Client(ctx.app);
    c.cookie = 'sb_session=attacker-chosen-value';
    await c.post('/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' });
    expect(c.cookie).not.toContain('attacker-chosen-value');
  });

  it('revokes all other sessions on password change', async () => {
    const u = await Client.register(ctx.app, 'rotate@example.com');
    const other = new Client(ctx.app);
    other.csrf = (await other.post('/api/auth/login', { email: 'rotate@example.com', password: 'correct horse battery' })).json().csrfToken;
    const res = await u.post('/api/auth/password', { currentPassword: 'correct horse battery', newPassword: 'an even better one' });
    expect(res.statusCode).toBe(200);
    u.csrf = res.json().csrfToken;
    expect((await other.get('/api/auth/me')).statusCode).toBe(401);
    expect((await u.get('/api/auth/me')).statusCode).toBe(200);
  });

  it('rejects requests without a session', async () => {
    const anon = new Client(ctx.app);
    for (const url of ['/api/notes', '/api/search?q=x', '/api/graph', '/api/stats', '/api/export', '/api/conversations', '/api/admin/users']) {
      expect((await anon.get(url)).statusCode, url).toBe(401);
    }
  });
});

describe('input validation and limits', () => {
  it('rejects oversized, malformed and mistyped input', async () => {
    expect((await alice.post('/api/notes', { title: 'big', content: 'x'.repeat(200_001) })).statusCode).toBe(400);
    expect((await alice.post('/api/notes', { title: '' })).statusCode).toBe(400);
    expect((await alice.post('/api/notes', { title: 'x', type: 'admin' })).statusCode).toBe(400);
    expect((await alice.post('/api/notes', { title: 'x', tags: ['<script>'] })).statusCode).toBe(400);
    expect((await alice.post('/api/notes', { title: 'x', dueDate: '2024-13-45' })).statusCode).toBe(400);
    expect((await alice.req('POST', '/api/notes', '{"title":', { 'content-type': 'application/json' })).statusCode).toBe(400);
    expect((await alice.req('POST', '/api/notes', { title: 'x', content: 'y'.repeat(1_100_000) })).statusCode).toBe(413);
    expect((await alice.get('/api/search?q=' + 'a'.repeat(501))).statusCode).toBe(400);
  });

  it('stores HTML as inert text and serves strict security headers', async () => {
    const res = await alice.post('/api/notes', { title: '<img src=x onerror=alert(1)>', content: '<script>alert(1)</script>' });
    expect(res.headers['content-type']).toContain('application/json');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const md = await alice.get(`/api/notes/${res.json().id}/export.md`);
    expect(md.headers['content-type']).toContain('text/markdown');
  });

  it('does not leak internals in errors', async () => {
    const res = await alice.get('/api/does-not-exist');
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toMatch(/stack|at .*\.ts/);
  });
});

describe('rate limiting', () => {
  it('throttles repeated login attempts', async () => {
    const limited = await makeApp({ AUTH_RATE_LIMIT_MAX: '3' });
    try {
      const c = new Client(limited.app);
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await c.post('/api/auth/login', { email: 'x@example.com', password: 'wrong-password' })).statusCode);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await limited.app.close();
    }
  });
});

describe('shared notes do not reveal the owner\'s other notes', () => {
  it('hides link titles from share recipients', async () => {
    const owner = await Client.register(ctx.app, 'linker@example.com');
    const hidden = (await owner.post('/api/notes', { title: 'Diario íntimo', content: 'privado' })).json();
    const shared = (await owner.post('/api/notes', { title: 'Lista compartida', content: 'Ver [[Diario íntimo]]' })).json();
    expect(shared.linksOut.map((l: any) => l.id)).toEqual([hidden.id]);
    const friend = await Client.register(ctx.app, 'friend@example.com');
    await owner.put(`/api/notes/${shared.id}/shares`, { email: 'friend@example.com', role: 'viewer' });
    const seen = (await friend.get(`/api/notes/${shared.id}`)).json();
    expect(seen.linksOut).toEqual([]);
    expect(seen.linksIn).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain(hidden.id);
  });
});

describe('list pagination', () => {
  it('pages through notes with limit/offset', async () => {
    const u = await Client.register(ctx.app, 'pager@example.com');
    for (let i = 0; i < 5; i++) await u.post('/api/notes', { title: `N${i}` });
    const p1 = (await u.get('/api/notes?limit=2&sort=title')).json();
    const p3 = (await u.get('/api/notes?limit=2&offset=4&sort=title')).json();
    expect(p1.total).toBe(5);
    expect(p1.items.map((i: any) => i.title)).toEqual(['N0', 'N1']);
    expect(p3.items.map((i: any) => i.title)).toEqual(['N4']);
  });
});
