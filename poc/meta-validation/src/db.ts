import mysql from 'mysql2/promise';
import { config } from './config.ts';

/**
 * Base MySQL (ou MariaDB) : comptes, boutiques, données de chaque boutique, sessions archivées.
 * Une boutique = un « tiroir » : rien n'est jamais lu sans son identifiant de boutique.
 */
export const pool = mysql.createPool({ uri: config.databaseUrl, connectionLimit: 10, charset: 'utf8mb4', dateStrings: false, timezone: 'Z' });

const TABLES = [
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(32) PRIMARY KEY,
    email VARCHAR(191) NOT NULL UNIQUE,
    password_hash VARCHAR(200) NOT NULL,
    full_name VARCHAR(120) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS shops (
    id VARCHAR(32) PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS shop_members (
    shop_id VARCHAR(32) NOT NULL,
    user_id VARCHAR(32) NOT NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'OWNER',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (shop_id, user_id),
    INDEX shop_members_user (user_id)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS shop_state (
    shop_id VARCHAR(32) PRIMARY KEY,
    data LONGTEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS live_sessions (
    id VARCHAR(48) NOT NULL,
    shop_id VARCHAR(32) NOT NULL,
    name VARCHAR(120) NOT NULL,
    archived_at DATETIME NOT NULL,
    summary LONGTEXT NOT NULL,
    snapshot LONGTEXT NOT NULL,
    PRIMARY KEY (shop_id, id),
    INDEX live_sessions_shop (shop_id, archived_at)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];

export async function migrate() {
  for (let attempt = 1; ; attempt++) {
    try {
      for (const sql of TABLES) await pool.query(sql);
      return;
    } catch (e) {
      // Au premier démarrage, MySQL peut mettre quelques secondes à accepter les connexions.
      if (attempt >= 30) throw e;
      console.log(`Base de données pas encore prête (${(e as Error).message}), nouvel essai…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}
