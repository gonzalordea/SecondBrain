import { expect, it } from 'vitest';
import { makeApp } from '../helpers.ts';

// Guards the TEST_DB=pg mode: it must really go through node-postgres over TCP.
it('uses the driver selected by TEST_DB', async () => {
  const ctx = await makeApp();
  try {
    // openDb() picks node-postgres exactly when DATABASE_URL is set.
    expect(!!ctx.config.DATABASE_URL).toBe(process.env.TEST_DB === 'pg');
    const [row] = await ctx.db.query(`SELECT current_setting('server_version') AS v`);
    expect(String(row.v)).toMatch(/^1[6-9]/);
    const [{ ext }] = await ctx.db.query(`SELECT extversion AS ext FROM pg_extension WHERE extname = 'vector'`);
    expect(ext).toBeTruthy();
  } finally {
    await ctx.app.close();
  }
});
