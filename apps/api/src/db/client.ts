import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.ts';
import { env } from '../lib/env.ts';

export const pool = mysql.createPool({
  uri: env.DATABASE_URL,
  connectionLimit: 10,
  timezone: 'Z',
  dateStrings: false,
});

export const db = drizzle(pool, { schema, mode: 'default' });
export type DB = typeof db;
/** Type d'une transaction Drizzle (même interface que db). */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export { schema };
