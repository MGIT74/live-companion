import mysql from 'mysql2/promise';

/** Base de test dédiée, recréée à chaque lancement. */
export default async function globalSetup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'mysql://lc:lc@localhost:3306/lc_test');
  const conn = await mysql.createConnection({ host: url.hostname, port: Number(url.port || 3306), user: url.username, password: url.password });
  const name = url.pathname.slice(1);
  await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.end();
  process.env.DATABASE_URL = url.toString();
  const { runMigrations } = await import('../src/db/migrate.ts');
  await runMigrations();
  const { pool } = await import('../src/db/client.ts');
  await pool.end();
}
