import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { Config } from './config.ts';
import { openDb } from './db.ts';
import { HttpError } from './http.ts';
import { authPlugin } from './auth.ts';
import { notesRoutes } from './notes.ts';
import { createIndexer, localEmbedder, type Embedder } from './processing.ts';
import { searchRoutes } from './search.ts';
import { assistantRoutes, anthropicLlm, type Llm } from './assistant.ts';
import { insightsRoutes } from './insights.ts';
import { ioRoutes } from './io.ts';
import { adminRoutes } from './admin.ts';
import { createEnricher, enrichRoutes } from './enrich.ts';

export const UPLOAD_LIMIT = 10 * 1024 * 1024;

export async function buildApp(config: Config, deps: { embedder?: Embedder; llm?: Llm | null } = {}) {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Secrets never reach the logs.
      redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  const db = await openDb({ url: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR, poolMax: config.DATABASE_POOL_MAX });
  const embedder = deps.embedder ?? localEmbedder(config.EMBEDDING_MODEL, config.MODEL_CACHE_DIR);
  const llm = deps.llm !== undefined ? deps.llm : config.ANTHROPIC_API_KEY ? anthropicLlm(config) : null;
  const enricher = createEnricher(db, embedder, llm, app.log, {
    enabled: config.AUTO_ENRICH, delayMs: config.ENRICH_DELAY_SECONDS * 1000, minChars: config.ENRICH_MIN_CHARS,
  });
  const indexer = createIndexer(db, embedder, app.log, (id) => enricher.schedule(id));

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
        baseUri: ["'self'"], formAction: ["'self'"],
        upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null,
      },
    },
    hsts: config.NODE_ENV === 'production',
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => new HttpError(429, 'rate_limited', `Demasiadas peticiones. Reintenta en ${ctx.after}`),
  });
  await app.register(multipart, { limits: { fileSize: UPLOAD_LIMIT, files: 20, fields: 10 } });

  app.setErrorHandler((err: FastifyError | ZodError | HttpError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'validation', message: 'Datos no válidos', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    if (err instanceof HttpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    const status = (err as FastifyError).statusCode ?? 500;
    if (status < 500) {
      // Framework-level client errors (malformed JSON, payload too large, unsupported media type…)
      return reply.code(status).send({ error: { code: (err as FastifyError).code ?? 'bad_request', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Error interno. Lo hemos registrado.' } });
  });

  await authPlugin(app, { db, config });
  const enrichMin = config.AUTO_ENRICH ? config.ENRICH_MIN_CHARS : null;
  await notesRoutes(app, { db, indexer, coalesceSeconds: config.VERSION_COALESCE_SECONDS, enrichMin });
  await searchRoutes(app, { db, embedder });
  await assistantRoutes(app, { db, embedder, llm, config });
  await insightsRoutes(app, { db });
  await ioRoutes(app, { db, indexer, enrichMin });
  await adminRoutes(app, { db });
  await enrichRoutes(app, { db, enricher, aiRateLimit: config.AI_RATE_LIMIT_MAX });

  app.get('/api/health', async () => {
    await db.query('SELECT 1');
    return { ok: true, llm: !!llm };
  });

  const webDir = fileURLToPath(new URL('../dist/web/', import.meta.url));
  if (config.SERVE_WEB && existsSync(webDir)) {
    await app.register(fastifyStatic, {
      root: webDir,
      // Hashed bundles never change; index.html must always be revalidated so a deploy is picked up.
      setHeaders: (reply, path) => reply.header('cache-control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache'),
    });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0];
      // Only client-side routes get the SPA shell; a missing file or API route is a real 404.
      if (path.startsWith('/api/') || /\.[a-z0-9]+$/i.test(path) || req.method !== 'GET') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Ruta no encontrada' } });
      }
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Ruta no encontrada' } }));
  }

  // Background work: resume indexing interrupted by a restart, and purge old trash daily.
  app.addHook('onReady', async () => {
    // 'failed' too: a transient error (e.g. model download) should not leave a note unsearchable forever.
    for (const r of await db.query(`SELECT id FROM notes WHERE embedding_status <> 'ready'`)) indexer.enqueue(r.id);
    for (const r of await db.query(`SELECT id FROM notes WHERE enrich_status IN ('pending', 'failed') AND deleted_at IS NULL`)) enricher.schedule(r.id);
  });
  const purge = () => Promise.all([
    db.query(`DELETE FROM notes WHERE deleted_at < now() - $1 * interval '1 day'`, [config.TRASH_RETENTION_DAYS]),
    db.query('DELETE FROM sessions WHERE expires_at < now()'),
  ]).catch((err) => app.log.error({ err }, 'daily purge failed'));
  const timer = setInterval(purge, 86_400_000).unref();
  app.addHook('onReady', async () => { await purge(); });
  app.addHook('onClose', async () => { clearInterval(timer); enricher.stop(); await indexer.idle(); await enricher.idle(); await db.close(); });

  return { app, db, indexer, enricher, llm };
}
