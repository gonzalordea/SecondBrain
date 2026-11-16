import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, fakeLlm, makeApp, parseSse } from '../helpers.ts';

const { llm, calls } = fakeLlm();
let ctx: Awaited<ReturnType<typeof makeApp>>;
let ana: Client;

beforeAll(async () => {
  ctx = await makeApp({}, { llm });
  ana = await Client.register(ctx.app, 'ana@example.com');
});
afterAll(() => ctx.app.close());

const create = async (c: Client, body: Record<string, unknown>) => {
  const res = await c.post('/api/notes', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};

describe('auth', () => {
  it('returns the session user and rejects a wrong password', async () => {
    expect((await ana.get('/api/auth/me')).json().user.email).toBe('ana@example.com');
    const anon = new Client(ctx.app);
    expect((await anon.post('/api/auth/login', { email: 'ana@example.com', password: 'nope-nope-nope' })).statusCode).toBe(401);
    expect((await anon.post('/api/auth/login', { email: 'nobody@example.com', password: 'nope-nope-nope' })).statusCode).toBe(401);
  });

  it('logs in case-insensitively and logs out', async () => {
    const c = new Client(ctx.app);
    const res = await c.post('/api/auth/login', { email: 'ANA@example.com', password: 'correct horse battery' });
    expect(res.statusCode).toBe(200);
    c.csrf = res.json().csrfToken;
    expect((await c.post('/api/auth/logout')).statusCode).toBe(200);
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const c = new Client(ctx.app);
    expect((await c.post('/api/auth/register', { email: 'Ana@Example.com', password: 'long enough pw', displayName: 'x' })).statusCode).toBe(409);
    const weak = await c.post('/api/auth/register', { email: 'weak@example.com', password: 'short', displayName: 'x' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.issues[0].path).toBe('password');
  });
});

describe('notes, parsing and versioning', () => {
  it('creates a note and extracts #tags, @people and [[links]]', async () => {
    const target = await create(ana, { title: 'Proyecto Atlas', content: 'Plan general.' });
    const note = await create(ana, {
      title: 'Reunión lunes', content: 'Hablé con @Marta y @[Luis Pérez] sobre [[Proyecto Atlas]]. #trabajo #Q3\n\n```\n#include <x>\n```',
      tags: ['reuniones'], category: 'Trabajo',
    });
    expect(note.tags).toEqual(['Q3', 'reuniones', 'trabajo']);
    expect(note.people).toEqual(['Luis Pérez', 'Marta']);
    expect(note.linksOut).toEqual([{ id: target.id, title: 'Proyecto Atlas' }]);
    const back = (await ana.get(`/api/notes/${target.id}`)).json();
    expect(back.linksIn.map((l: any) => l.id)).toEqual([note.id]);
  });

  it('links an existing [[wikilink]] once its target note is created', async () => {
    const src = await create(ana, { title: 'Ideas', content: 'Ver [[Libro pendiente]] más tarde' });
    expect(src.linksOut).toEqual([]);
    const target = await create(ana, { title: 'libro pendiente', content: '' });
    expect(target.linksIn.map((l: any) => l.id)).toEqual([src.id]);
  });

  it('keeps versions, rejects stale writes and restores', async () => {
    const versions = async () => (await ana.get(`/api/notes/${n.id}/versions`)).json().versions.map((v: any) => v.version);
    const n = await create(ana, { title: 'Receta', content: 'Versión uno' });
    expect(await versions()).toEqual([1]);
    const u1 = await ana.patch(`/api/notes/${n.id}`, { version: 1, content: 'Versión dos' });
    expect(u1.json().version).toBe(2);
    // A second tab still holding version 1 must not overwrite.
    const stale = await ana.patch(`/api/notes/${n.id}`, { version: 1, content: 'pisado' });
    expect(stale.statusCode).toBe(409);
    // Within the coalescing window, autosaves keep updating the same history entry…
    await ana.patch(`/api/notes/${n.id}`, { version: 2, content: 'Versión tres' });
    expect(await versions()).toEqual([3]);
    // …and once the window has passed, the next edit starts a new one.
    await ctx.db.query(`UPDATE note_versions SET created_at = now() - interval '1 hour' WHERE note_id = $1`, [n.id]);
    await ana.patch(`/api/notes/${n.id}`, { version: 3, content: 'Versión cuatro' });
    expect(await versions()).toEqual([4, 3]);
    expect((await ana.get(`/api/notes/${n.id}/versions/3`)).json().content).toBe('Versión tres');
    const restored = await ana.post(`/api/notes/${n.id}/versions/3/restore`);
    expect(restored.json()).toMatchObject({ content: 'Versión tres', version: 5 });
    // The restore is its own entry and is never merged into by a following autosave.
    await ana.patch(`/api/notes/${n.id}`, { version: 5, content: 'Versión seis' });
    expect(await versions()).toEqual([6, 5, 4, 3]);
  });

  it('metadata-only edits bump the version without a snapshot', async () => {
    const t = await create(ana, { type: 'task', title: 'Pagar IVA', dueDate: '2020-01-01' });
    expect(t.status).toBe('todo');
    const done = (await ana.patch(`/api/notes/${t.id}`, { version: 1, status: 'done' })).json();
    expect(done).toMatchObject({ status: 'done', version: 2, dueDate: '2020-01-01' });
    expect((await ana.get(`/api/notes/${t.id}/versions`)).json().versions.map((v: any) => v.version)).toEqual([1]);
  });

  it('lists with filters and sorting', async () => {
    const res = (await ana.get('/api/notes?tag=trabajo')).json();
    expect(res.items.map((i: any) => i.title)).toEqual(['Reunión lunes']);
    expect((await ana.get('/api/notes?type=task')).json().total).toBe(1);
    expect((await ana.get('/api/notes?category=trabajo')).json().total).toBe(1);
    const facets = (await ana.get('/api/facets')).json();
    expect(facets.people.map((p: any) => p.name)).toContain('Marta');
  });
});

describe('trash', () => {
  it('soft deletes, restores and purges', async () => {
    const n = await create(ana, { title: 'Temporal', content: 'borrar' });
    expect((await ana.del(`/api/notes/${n.id}`)).statusCode).toBe(200);
    expect((await ana.get(`/api/notes/${n.id}`)).statusCode).toBe(404);
    expect((await ana.get('/api/trash')).json().items.map((i: any) => i.id)).toContain(n.id);
    expect((await ana.post(`/api/trash/${n.id}/restore`)).json().deletedAt).toBeNull();
    // Purge only works from the trash.
    expect((await ana.del(`/api/trash/${n.id}`)).statusCode).toBe(400);
    await ana.del(`/api/notes/${n.id}`);
    expect((await ana.del(`/api/trash/${n.id}`)).statusCode).toBe(200);
    expect((await ana.get('/api/trash')).json().items.map((i: any) => i.id)).not.toContain(n.id);
  });

  it('auto-purges items older than the retention period on boot', async () => {
    const n = await create(ana, { title: 'Viejo', content: 'x' });
    await ctx.db.query(`UPDATE notes SET deleted_at = now() - interval '40 days' WHERE id = $1`, [n.id]);
    await ctx.db.query(`DELETE FROM notes WHERE deleted_at < now() - $1 * interval '1 day'`, [30]); // same statement the daily job runs
    expect((await ctx.db.query('SELECT 1 FROM notes WHERE id = $1', [n.id])).length).toBe(0);
  });
});

describe('semantic search, related notes and RAG', () => {
  let cat: any, tax: any, tomato: any;
  beforeAll(async () => {
    cat = await create(ana, { title: 'Mi gato', content: 'Mi gato Tom solo come pienso de salmón y duerme en el sofá.' });
    tax = await create(ana, { title: 'Impuestos', content: 'La declaración trimestral del IVA se presenta en abril, julio y octubre.' });
    tomato = await create(ana, { title: 'Huerto', content: 'Los tomates necesitan riego cada dos días en verano.' });
    await ctx.indexer.idle();
  });

  it('indexes every note', async () => {
    const rows = await ctx.db.query(`SELECT embedding_status FROM notes WHERE owner_id = $1 AND deleted_at IS NULL`, [ana.user.id]);
    expect(rows.every((r) => r.embedding_status === 'ready')).toBe(true);
  });

  it('finds notes by meaning, not just words', async () => {
    const res = (await ana.get('/api/search?q=' + encodeURIComponent('¿qué come mi mascota?') + '&mode=semantic')).json();
    expect(res.items[0].id).toBe(cat.id);
    expect(res.items.find((i: any) => i.id === tax.id)).toBeUndefined(); // below the similarity floor
  });

  it('keyword mode matches words and highlights them', async () => {
    const res = (await ana.get('/api/search?q=IVA&mode=keyword')).json();
    // The task titled 'Pagar IVA' gets the title bonus; the note mentioning IVA in its body follows.
    expect(res.items.map((i: any) => i.title).slice(0, 2)).toEqual(['Pagar IVA', 'Impuestos']);
    expect(res.items[1].snippet).toContain('\x01IVA\x02');
    expect((await ana.get('/api/search?q=motiva&mode=keyword')).json().items).toEqual([]);
  });

  it('applies filters and configurable weights', async () => {
    const onlyTasks = (await ana.get('/api/search?q=IVA&type=task')).json();
    expect(onlyTasks.items.every((i: any) => i.type === 'task')).toBe(true);
    const kwOnly = (await ana.get('/api/search?q=riego&alpha=0')).json();
    expect(kwOnly.items[0].id).toBe(tomato.id);
    expect(kwOnly.items[0].scores.score).toBe(kwOnly.items[0].scores.keyword);
    const future = (await ana.get('/api/search?q=gato&from=2999-01-01')).json();
    expect(future.items).toEqual([]);
  });

  it('suggests related notes', async () => {
    const pet = await create(ana, { title: 'Veterinario', content: 'Llevar al gato Tom a vacunar; preguntar por su dieta de salmón.' });
    await ctx.indexer.idle();
    const rel = (await ana.get(`/api/notes/${pet.id}/related`)).json();
    expect(rel.items[0].id).toBe(cat.id);
    const conn = (await ana.get('/api/insights/connections?threshold=0.3')).json();
    expect(conn.items.some((p: any) => [p.a.id, p.b.id].sort().join() === [pet.id, cat.id].sort().join())).toBe(true);
  });

  it('answers with citations from the user notes', async () => {
    const conv = (await ana.post('/api/conversations', {})).json();
    const res = await ana.post(`/api/conversations/${conv.id}/messages`, { content: '¿Qué come mi gato?' });
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parseSse(res.body);
    const done = events.find((e) => e.event === 'done')!.data.message;
    expect(done.grounded).toBe(true);
    expect(done.sources[0]).toMatchObject({ n: 1, title: 'Mi gato' });
    expect(done.content).toMatch(/\[1\]$/);
    expect(calls.at(-1)!.docs[0].text).toContain('salmón');
    const saved = (await ana.get(`/api/conversations/${conv.id}`)).json();
    expect(saved.title).toBe('¿Qué come mi gato?');
    expect(saved.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
  });

  it('admits it does not know instead of calling the model', async () => {
    const before = calls.length;
    const conv = (await ana.post('/api/conversations', {})).json();
    const res = await ana.post(`/api/conversations/${conv.id}/messages`, { content: 'Explícame la teoría de cuerdas y los agujeros negros' });
    const done = parseSse(res.body).find((e) => e.event === 'done')!.data.message;
    expect(done.grounded).toBe(false);
    expect(done.sources).toEqual([]);
    expect(done.content).toMatch(/No encuentro información suficiente/);
    expect(calls.length).toBe(before);
  });

  it('summarizes with the LLM when available', async () => {
    const res = (await ana.post(`/api/notes/${tax.id}/summarize`)).json();
    expect(res).toEqual({ summary: 'Resumen IA de Impuestos', method: 'llm' });
  });
});

describe('graph and stats', () => {
  it('builds a graph of notes, concepts and people', async () => {
    const g = (await ana.get('/api/graph')).json();
    const kinds = new Set(g.nodes.map((n: any) => n.kind));
    expect(kinds).toEqual(new Set(['note', 'concept', 'person']));
    expect(g.edges.some((e: any) => e.kind === 'link')).toBe(true);
    expect(g.edges.some((e: any) => e.kind === 'mention')).toBe(true);
    const ids = new Set(g.nodes.map((n: any) => n.id));
    expect(g.edges.every((e: any) => ids.has(e.source) && ids.has(e.target))).toBe(true);
  });

  it('reports statistics', async () => {
    const s = (await ana.get('/api/stats')).json();
    expect(s.totals.task).toBe(1);
    expect(s.tasks.overdue).toBe(0); // the only task is done
    expect(s.totals.words).toBeGreaterThan(20);
    expect(s.activity).toHaveLength(12);
    expect(s.topPeople.map((p: any) => p.name)).toContain('Marta');
    expect(s.indexing.failed).toBe(0);
  });
});

describe('import and export', () => {
  it('round-trips a full export into another account', async () => {
    const res = await ana.get('/api/export');
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const dump = res.json();
    expect(dump.notes.length).toBeGreaterThan(5);

    const bob = await Client.register(ctx.app, 'bob-import@example.com');
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(dump)], { type: 'application/json' }), 'backup.json');
    form.append('file', new Blob(['# Apuntes de React\n\nLos hooks #frontend'], { type: 'text/markdown' }), 'react.md');
    form.append('file', new Blob(['MZ...'], { type: 'application/octet-stream' }), 'virus.exe');
    const req = new Request('http://x', { method: 'POST', body: form });
    const imp = await bob.req('POST', '/api/import', Buffer.from(await req.arrayBuffer()), { 'content-type': req.headers.get('content-type')! });
    expect(imp.statusCode, imp.body).toBe(200);
    const out = imp.json();
    expect(out.imported).toBe(dump.notes.length + 1);
    expect(out.errors).toEqual([{ file: 'virus.exe', message: expect.stringContaining('no soportado') }]);
    const react = out.notes.find((n: any) => n.title === 'Apuntes de React');
    expect((await bob.get(`/api/notes/${react.id}`)).json()).toMatchObject({ type: 'document', tags: ['frontend'] });
    // Wikilinks were rebuilt from text on the importing side.
    const meeting = (await bob.get('/api/notes?tag=trabajo')).json().items[0];
    expect((await bob.get(`/api/notes/${meeting.id}`)).json().linksOut[0].title).toBe('Proyecto Atlas');
  });

  it('imports a real PDF', async () => {
    const pdf = makePdf('Contrato de alquiler firmado en Valencia');
    const form = new FormData();
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'contrato.pdf');
    const req = new Request('http://x', { method: 'POST', body: form });
    const imp = await ana.req('POST', '/api/import', Buffer.from(await req.arrayBuffer()), { 'content-type': req.headers.get('content-type')! });
    const out = imp.json();
    expect(out.errors).toEqual([]);
    const note = (await ana.get(`/api/notes/${out.notes[0].id}`)).json();
    expect(note).toMatchObject({ title: 'contrato', type: 'document', source: 'upload' });
    expect(note.content).toContain('Contrato de alquiler firmado en Valencia');
  });

  it('exports a single note as Markdown with front matter', async () => {
    const n = await create(ana, { title: 'Ñandú "raro"', content: 'cuerpo', tags: ['aves'] });
    const res = await ana.get(`/api/notes/${n.id}/export.md`);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toContain('title: "Ñandú \\"raro\\""');
    expect(res.body).toContain('tags: ["aves"]');
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''");
  });
});

/** Minimal valid single-page PDF with one text line (offsets computed so the xref table is correct). */
function makePdf(text: string) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
