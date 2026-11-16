import { loadConfig } from '../server/config.ts';
import { buildApp } from '../server/app.ts';
import type { Llm } from '../server/assistant.ts';
import { localEmbedder, type Embedder } from '../server/processing.ts';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

// One model instance per test file (loading ONNX takes seconds).
let sharedEmbedder: Embedder | undefined;
export const embedder = () => (sharedEmbedder ??= localEmbedder('Xenova/paraphrase-multilingual-MiniLM-L12-v2', './.models'));

/**
 * TEST_DB=pg runs every integration test through the production node-postgres adapter, talking the
 * PostgreSQL wire protocol to a PGlite socket server (real Postgres + pgvector, no Docker needed).
 * Pool size 1: any query that escapes its transaction would deadlock and fail the test.
 */
async function pgSocket() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const lite = await PGlite.create({ extensions: { vector } });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = new PGLiteSocketServer({ db: lite, port, host: '127.0.0.1' });
  await server.start();
  return { url: `postgres://postgres@127.0.0.1:${port}/postgres`, stop: async () => { await server.stop(); await lite.close(); } };
}

export async function makeApp(env: Record<string, string> = {}, deps: { llm?: Llm | null } = {}) {
  const sock = process.env.TEST_DB === 'pg' ? await pgSocket() : null;
  const config = loadConfig({
    ...(sock && { DATABASE_URL: sock.url, DATABASE_POOL_MAX: '1' }),
    NODE_ENV: 'test', PGLITE_DIR: 'memory://', LOG_LEVEL: 'silent', SERVE_WEB: 'false',
    RATE_LIMIT_MAX: '10000', AUTH_RATE_LIMIT_MAX: '1000', AI_RATE_LIMIT_MAX: '1000', ENRICH_DELAY_SECONDS: '0', ...env,
  });
  const built = await buildApp(config, { embedder: embedder(), llm: deps.llm ?? null });
  if (sock) built.app.addHook('onClose', sock.stop);
  await built.app.ready();
  return { ...built, config };
}

/** A logged-in API client that carries its own cookie and CSRF token, like a browser tab. */
export class Client {
  app: FastifyInstance;
  cookie = '';
  csrf = '';
  user: any;
  constructor(app: FastifyInstance) { this.app = app; }

  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({
      method: method as any, url,
      headers: { ...(this.cookie && { cookie: this.cookie }), ...(this.csrf && { 'x-csrf-token': this.csrf }), ...headers },
      ...(body !== undefined && { payload: body as any }),
    });
    const set = res.cookies.find((c) => c.name === 'sb_session');
    if (set) this.cookie = set.value ? `sb_session=${set.value}` : '';
    return res;
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown) => this.req('POST', url, body ?? {});
  patch = (url: string, body: unknown) => this.req('PATCH', url, body);
  put = (url: string, body: unknown) => this.req('PUT', url, body);
  del = (url: string, body?: unknown) => this.req('DELETE', url, body);

  static async register(app: FastifyInstance, email: string, password = 'correct horse battery', displayName = email.split('@')[0]) {
    const c = new Client(app);
    const res = await c.post('/api/auth/register', { email, password, displayName });
    if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
    c.csrf = res.json().csrfToken;
    c.user = res.json().user;
    return c;
  }
}

/** Deterministic LLM double used at the network boundary: cites the first document it receives and records its inputs. */
export function fakeLlm() {
  const calls: Parameters<Llm['answer']>[0][] = [];
  const enrichCalls: string[] = [];
  const llm: Llm = {
    async answer(input, onText) {
      calls.push(input);
      const first = input.docs[0];
      const text = `Según tus notas: ${first.text.slice(0, 40)}`;
      onText(text);
      return { text, citations: [{ docIndex: 0, citedText: first.text.slice(0, 40), at: text.length }], refused: false };
    },
    // Behaves like a sloppy model: one real name, one invented name, duplicated and prefixed concepts.
    async enrich(title, content) {
      enrichCalls.push(title);
      const people = /Marta/.test(content) ? ['Marta', 'Persona Inventada'] : [];
      return { summary: `Resumen IA de ${title}`, people, concepts: ['Planificación', 'planificación', '#presupuesto'] };
    },
  };
  return { llm, calls, enrichCalls };
}

export function parseSse(body: string) {
  return body.trim().split('\n\n').map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? 'null');
    return { event, data };
  });
}
