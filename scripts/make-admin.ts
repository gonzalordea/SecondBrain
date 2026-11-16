// Usage: npm run make-admin -- user@example.com
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';

const email = process.argv[2]?.toLowerCase();
if (!email) { console.error('Usage: npm run make-admin -- <email>'); process.exit(1); }
const config = loadConfig();
const db = await openDb({ url: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR });
const rows = await db.query(`UPDATE users SET role = 'admin' WHERE lower(email) = $1 RETURNING id`, [email]);
await db.close();
if (!rows.length) { console.error(`No user with email ${email}`); process.exit(1); }
console.log(`${email} is now an admin`);
