import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// .env du dossier PoC en priorité, puis celui de la racine du dépôt (hébergement xCloud).
dotenv.config({ path: [path.join(root, '.env'), path.join(root, '..', '..', '.env')] });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variable d'environnement manquante : ${name} (voir .env.example)`);
  return v;
}

export const config = {
  appId: required('META_APP_ID'),
  appSecret: required('META_APP_SECRET'),
  graphVersion: process.env.META_GRAPH_VERSION || 'v25.0',
  loginConfigId: process.env.META_LOGIN_CONFIG_ID || '',
  port: Number(process.env.PORT || 3000),
  baseUrl: required('BASE_URL').replace(/\/$/, ''),
  webhookVerifyToken: required('WEBHOOK_VERIFY_TOKEN'),
  encryptionKey: required('ENCRYPTION_KEY'),
  /** Code demandé une seule fois : à la création du premier compte (qui récupère les données existantes). */
  dashboardPassword: required('DASHBOARD_PASSWORD'),
  databaseUrl: required('DATABASE_URL'),
  allowSignup: process.env.ALLOW_SIGNUP !== 'false',
  dataDir: path.join(root, 'data'),
  photosDir: path.join(root, 'data', 'photos'),
  evidenceDir: path.join(root, 'evidence'),
  publicDir: path.join(root, 'public'),
  productsFile: path.join(root, 'products.json'),
};

export const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_engagement',
  'pages_manage_metadata',
  'pages_messaging',
];

export const graphBase = () => `https://graph.facebook.com/${config.graphVersion}`;
export const streamingBase = 'https://streaming-graph.facebook.com';
