import { graphBase } from './config.ts';
import { appSecretProof, decrypt } from './crypto.ts';
import { log } from './bus.ts';
import { state } from './store.ts';

export class GraphError extends Error {
  constructor(public status: number, public body: any) {
    super(body?.error?.message ?? `Graph API HTTP ${status}`);
  }
  get code(): number | undefined { return this.body?.error?.code; }
  get subcode(): number | undefined { return this.body?.error?.error_subcode; }
}

type Params = Record<string, string | number | boolean | undefined>;

/** Appel Graph API avec appsecret_proof, journalisation et erreurs typées. */
export async function graph<T = any>(
  method: 'GET' | 'POST' | 'DELETE',
  pathOrUrl: string,
  token: string,
  params: Params = {},
  body?: unknown,
): Promise<T> {
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : `${graphBase()}/${pathOrUrl.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  if (token && !url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
  const t = url.searchParams.get('access_token');
  if (t) url.searchParams.set('appsecret_proof', appSecretProof(t));

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok || json?.error) {
    const err = new GraphError(res.status, json);
    log('warn', `Graph ${method} ${url.pathname} → ${res.status} ${err.message}`);
    throw err;
  }
  return json as T;
}

export function userToken(): string {
  if (!state.userTokenEnc) throw new Error("Aucune connexion Facebook : lancez d'abord le test 1.");
  return decrypt(state.userTokenEnc);
}

export function selectedPage() {
  const page = state.pages.find((p) => p.id === state.selectedPageId);
  if (!page) throw new Error('Aucune Page sélectionnée.');
  return { ...page, token: decrypt(page.tokenEnc) };
}

/** Suit la pagination Graph jusqu'à `max` éléments. */
export async function graphAll<T = any>(path: string, token: string, params: Params = {}, max = 500): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined;
  let page = await graph<{ data: T[]; paging?: { next?: string } }>('GET', path, token, params);
  out.push(...page.data);
  next = page.paging?.next;
  while (next && out.length < max) {
    page = await graph('GET', next, token);
    out.push(...page.data);
    next = page.paging?.next;
  }
  return out;
}
