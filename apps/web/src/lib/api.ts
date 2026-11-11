import { useCallback, useEffect, useRef, useState } from 'react';

const TOKEN_KEY = 'lc.token';
const SHOP_KEY = 'lc.shop';

export function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
export function setToken(t: string | null) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* stockage indisponible */ } }
export function getShopId() { try { return localStorage.getItem(SHOP_KEY); } catch { return null; } }
export function setShopId(id: string) { try { localStorage.setItem(SHOP_KEY, id); } catch { /* stockage indisponible */ } }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Connexion impossible. Vérifiez votre connexion internet.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    const detail = Array.isArray(data?.details) && data.details[0]?.message ? ` : ${data.details[0].message}` : '';
    throw new ApiError(res.status, data?.error ?? 'ERROR', (data?.message ?? `Erreur ${res.status}`) + detail);
  }
  return data as T;
}

/** Chemin d'une ressource de la boutique courante. */
export function shopPath(shopId: string, rest: string) { return `/v1/shops/${shopId}${rest}`; }

/** Charge une ressource et la recharge quand `path` change (ou toutes les `refreshMs`). */
export function useApi<T>(path: string | null, refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async (quiet = false) => {
    if (!path) return;
    const n = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const d = await api<T>(path);
      if (n === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);
  return { data, error, loading, reload: () => load(true), setData };
}
