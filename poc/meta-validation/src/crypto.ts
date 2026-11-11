import crypto from 'node:crypto';
import { config } from './config.ts';

function key(): Buffer {
  const k = Buffer.from(config.encryptionKey, 'hex');
  if (k.length !== 32) throw new Error('ENCRYPTION_KEY doit faire 32 octets (64 caractères hex).');
  return k;
}

/** Chiffre un secret (jeton Meta) en AES-256-GCM. Format : iv.tag.data en base64. */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Vérifie la signature X-Hub-Signature-256 d'un webhook Meta. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.appSecret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** appsecret_proof recommandé par Meta pour les appels serveur. */
export function appSecretProof(token: string): string {
  return crypto.createHmac('sha256', config.appSecret).update(token).digest('hex');
}
