import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

fs.mkdirSync(config.evidenceDir, { recursive: true });

const TOKEN_RE = /(access_token=|"access_token"\s*:\s*")[^&"\s]+/g;

/** Masque les jetons avant d'écrire une preuve sur disque. */
export function redact<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(TOKEN_RE, '$1***')) as T;
}

/**
 * Archive une réponse brute de l'API Meta comme preuve d'un test.
 * Fichier : evidence/<AAAA-MM-JJTHH-MM-SS>_<test>_<label>.json
 */
export function saveEvidence(test: string, label: string, payload: unknown): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(config.evidenceDir, `${stamp}_${test}_${label.replace(/[^a-z0-9_-]/gi, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify(redact(payload), null, 2));
  return path.basename(file);
}
