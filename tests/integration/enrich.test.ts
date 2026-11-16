import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, fakeLlm, makeApp } from '../helpers.ts';
import type { Llm } from '../../server/assistant.ts';

// Long enough to pass ENRICH_MIN_CHARS (300).
const LONG = (extra: string) =>
  `Reunión de planificación del trimestre con Marta. ${extra} ` +
  'Revisamos el presupuesto de marketing, las contrataciones previstas y el calendario de lanzamientos. ' +
  'Acordamos recortar un diez por ciento en publicidad pagada y reforzar el contenido orgánico. ' +
  'Queda pendiente cerrar la fecha de la feria de abril y confirmar al proveedor de diseño.';

describe('automatic enrichment with an LLM', () => {
  const fake = fakeLlm();
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  let u: Client;
  const settle = async () => { await ctx.indexer.idle(); await ctx.enricher.idle(); };

  beforeAll(async () => {
    ctx = await makeApp({}, { llm: fake.llm });
    u = await Client.register(ctx.app, 'enrich@example.com');
  });
  afterAll(() => ctx.app.close());

  it('summarizes and extracts people and concepts once the note is saved and indexed', async () => {
    const n = (await u.post('/api/notes', { title: 'Plan Q2', content: LONG('') })).json();
    expect(n.enrichStatus).toBe('pending'); // long enough: marked at save time, so the UI can say so
    await settle();
    const after = (await u.get(`/api/notes/${n.id}`)).json();
    expect(after).toMatchObject({ summary: 'Resumen IA de Plan Q2', summaryMethod: 'llm', enrichStatus: 'done' });
    expect(after.aiPeople).toEqual(['Marta']); // the invented name is not in the text, so it is dropped
    expect(after.people).toEqual(['Marta']);
    expect(after.concepts).toEqual(['Planificación', 'presupuesto']); // deduped, '#' stripped
    expect(after.tags).toEqual([]); // AI concepts never pollute the user's own tags

    const g = (await u.get('/api/graph?similar=0')).json();
    const concept = g.nodes.find((x: any) => x.label === 'Planificación');
    expect(concept).toMatchObject({ kind: 'concept', isTag: false });
    expect(g.edges.some((e: any) => e.kind === 'concept' && e.target === concept.id)).toBe(true);
  });

  it('re-runs only when the text changes, not on metadata edits', async () => {
    const n = (await u.post('/api/notes', { title: 'Plan Q3', content: LONG('') })).json();
    await settle();
    const before = fake.enrichCalls.length;
    await u.patch(`/api/notes/${n.id}`, { version: 1, category: 'Trabajo' });
    await settle();
    expect(fake.enrichCalls.length).toBe(before);
    await u.patch(`/api/notes/${n.id}`, { version: 2, content: LONG('Añadimos un punto sobre formación.') });
    await settle();
    expect(fake.enrichCalls.length).toBe(before + 1);
  });

  it('keeps @mentions as the user wrote them when the AI runs again', async () => {
    const n = (await u.post('/api/notes', { title: 'Con mención', content: LONG('Lo hablé con @Marta ayer.') })).json();
    await settle();
    const after = (await u.get(`/api/notes/${n.id}`)).json();
    expect(after.people).toEqual(['Marta']);
    expect(after.aiPeople).toEqual([]); // already a 'text' mention, so not duplicated as AI
    await u.post(`/api/notes/${n.id}/summarize`);
    expect((await u.get(`/api/notes/${n.id}`)).json().people).toEqual(['Marta']);
  });

  it('skips short notes, but the manual button still works on them', async () => {
    const before = fake.enrichCalls.length;
    const n = (await u.post('/api/notes', { title: 'Corta', content: 'Comprar pan.' })).json();
    await settle();
    expect(fake.enrichCalls.length).toBe(before);
    expect((await u.get(`/api/notes/${n.id}`)).json()).toMatchObject({ enrichStatus: 'none', summary: null });
    expect((await u.post(`/api/notes/${n.id}/summarize`)).json()).toEqual({ summary: 'Resumen IA de Corta', method: 'llm' });
  });

  it('never enriches other users\' notes through the manual endpoint', async () => {
    const n = (await u.post('/api/notes', { title: 'Privada', content: 'x' })).json();
    const eve = await Client.register(ctx.app, 'eve-enrich@example.com');
    expect((await eve.post(`/api/notes/${n.id}/summarize`)).statusCode).toBe(404);
  });
});

describe('automatic enrichment without an LLM', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  afterAll(() => ctx.app.close());

  it('writes an extractive summary and no AI entities', async () => {
    ctx = await makeApp({}, { llm: null });
    const u = await Client.register(ctx.app, 'offline@example.com');
    const n = (await u.post('/api/notes', { title: 'Plan', content: LONG('') })).json();
    await ctx.indexer.idle(); await ctx.enricher.idle();
    const after = (await u.get(`/api/notes/${n.id}`)).json();
    expect(after).toMatchObject({ summaryMethod: 'extractive', enrichStatus: 'done', aiPeople: [], concepts: [] });
    expect(after.summary.length).toBeGreaterThan(40);
  });
});

describe('enrichment failures', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  afterAll(() => ctx.app.close());

  it('marks the note as failed and keeps it usable', async () => {
    const broken: Llm = { ...fakeLlm().llm, enrich: async () => { throw new Error('upstream down'); } };
    ctx = await makeApp({}, { llm: broken });
    const u = await Client.register(ctx.app, 'broken@example.com');
    const n = (await u.post('/api/notes', { title: 'Plan', content: LONG('') })).json();
    await ctx.indexer.idle(); await ctx.enricher.idle();
    const after = (await u.get(`/api/notes/${n.id}`)).json();
    expect(after).toMatchObject({ enrichStatus: 'failed', summary: null, embeddingStatus: 'ready' });
    expect((await u.post(`/api/notes/${n.id}/summarize`)).statusCode).toBe(502);
  });
});
