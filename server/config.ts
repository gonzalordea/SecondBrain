import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(3000),
  // Postgres connection string. Without it, an embedded PGlite (real Postgres in WASM) is used.
  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
  PGLITE_DIR: z.string().default('./data/pglite'),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('claude-opus-5-5'),
  EMBEDDING_MODEL: z.string().default('Xenova/paraphrase-multilingual-MiniLM-L12-v2'),
  MODEL_CACHE_DIR: z.string().default('./.models'),
  SESSION_TTL_DAYS: z.coerce.number().positive().default(30),
  COOKIE_SECURE: bool.optional(),
  TRUST_PROXY: bool.default(false),
  RAG_MIN_SCORE: z.coerce.number().min(-1).max(1).default(0.3),
  RAG_TOP_K: z.coerce.number().int().min(1).max(30).default(8),
  // Autosaves by the same person within this window update one history entry instead of adding one each.
  VERSION_COALESCE_SECONDS: z.coerce.number().int().min(0).default(120),
  // Automatic summary + people/concepts after edits have been quiet for ENRICH_DELAY_SECONDS.
  AUTO_ENRICH: bool.default(true),
  ENRICH_DELAY_SECONDS: z.coerce.number().min(0).default(45),
  ENRICH_MIN_CHARS: z.coerce.number().int().min(0).default(300),
  TRASH_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AI_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  LOG_LEVEL: z.string().default('info'),
  SERVE_WEB: bool.default(true),
});

export type Config = z.infer<typeof schema> & { cookieSecure: boolean };

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.parse(env);
  return { ...parsed, cookieSecure: parsed.COOKIE_SECURE ?? parsed.NODE_ENV === 'production' };
}
