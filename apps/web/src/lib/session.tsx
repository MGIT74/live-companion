import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getShopId, getToken, setShopId, setToken, setUnauthorizedHandler } from './api.ts';

export interface Shop { id: string; name: string; slug: string; city: string | null; role: string }
export interface Me { id: string; email: string; fullName: string; shops: Shop[] }

interface Session {
  me: Me | null;
  shop: Shop | null;
  ready: boolean;
  login: (token: string, me: Me) => void;
  logout: () => void;
  selectShop: (id: string) => void;
  /** Chemin d'API dans la boutique courante. */
  sp: (rest: string) => string;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [shopId, setShop] = useState<string | null>(getShopId());
  const [ready, setReady] = useState(false);

  const logout = useCallback(() => { setToken(null); setMe(null); }, []);
  useEffect(() => { setUnauthorizedHandler(logout); }, [logout]);

  useEffect(() => {
    if (!getToken()) { setReady(true); return; }
    api<Me>('/v1/me').then(setMe).catch(() => setToken(null)).finally(() => setReady(true));
  }, []);

  const shop = me ? (me.shops.find((s) => s.id === shopId) ?? me.shops[0] ?? null) : null;
  const value: Session = {
    me, shop, ready,
    login: (token, m) => { setToken(token); setMe(m); },
    logout,
    selectShop: (id) => { setShopId(id); setShop(id); },
    sp: (rest) => `/v1/shops/${shop?.id}${rest}`,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error('SessionProvider manquant');
  return s;
}

// ---------------------------------------------------------------- Apparence
export type ThemeChoice = 'auto' | 'light' | 'dark';
export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [t, setT] = useState<ThemeChoice>(() => {
    try { const v = localStorage.getItem('lc.theme'); return v === 'light' || v === 'dark' ? v : 'auto'; } catch { return 'auto'; }
  });
  const apply = (v: ThemeChoice) => {
    setT(v);
    if (v === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v;
    try { v === 'auto' ? localStorage.removeItem('lc.theme') : localStorage.setItem('lc.theme', v); } catch { /* ignoré */ }
  };
  return [t, apply];
}
