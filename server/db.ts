import { mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

/** Minimal surface shared by node-postgres and PGlite. Every query is parameterised. */
export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDb(opts: { url?: string; pgliteDir: string; poolMax?: number }): Promise<Db> {
  const db = opts.url ? pgDb(opts.url, opts.poolMax ?? 10) : await pgliteDb(opts.pgliteDir);
  await migrate(db);
  return db;
}

function pgDb(url: string, max: number): Db {
  const pool = new pg.Pool({ connectionString: url, max });
  const wrap = (c: pg.Pool | pg.PoolClient, inTx: boolean): Db => ({
    query: async (sql, params) => (await c.query(sql, params as any[])).rows,
    tx: async (fn) => {
      if (inTx) return fn(wrap(c, true));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client, true));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  });
  return wrap(pool, false);
}

async function pgliteDb(dir: string): Promise<Db> {
  if (dir !== 'memory://') await mkdir(dir, { recursive: true }); // PGlite does not create parent folders
  const lite = dir === 'memory://' ? new PGlite({ extensions: { vector } }) : new PGlite(dir, { extensions: { vector } });
  const wrap = (c: PGlite | Transaction, inTx: boolean): Db => ({
    query: async (sql, params) => (await c.query<any>(sql, params)).rows,
    tx: (fn) => (inTx ? fn(wrap(c, true)) : lite.transaction((t) => fn(wrap(t, true)))),
    close: () => lite.close(),
  });
  return wrap(lite, false);
}

const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));

async function migrate(db: Db) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = await readFile(migrationsDir + file, 'utf8');
    await db.tx(async (t) => {
      for (const stmt of splitSql(sql)) await t.query(stmt);
      await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
  }
}

// Migrations contain no functions/dollar-quoting, so splitting on ';' at end of line is safe.
const splitSql = (sql: string) => sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean);

export const toVector = (v: number[]) => `[${v.join(',')}]`;
