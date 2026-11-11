import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { db, pool } from './client.ts';

const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/** Applique les migrations SQL versionnées du dossier drizzle/. Idempotent. */
export async function runMigrations() {
  await migrate(db, { migrationsFolder: folder });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations()
    .then(() => { console.log('Migrations appliquées.'); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
