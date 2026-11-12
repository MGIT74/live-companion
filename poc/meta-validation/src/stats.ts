import { q } from './db.ts';
import { currentShopId, state, type Conversation, type Intent, type LiveComment, type Product } from './store.ts';

/**
 * Statistiques de la boutique : lives archivés (table live_sessions) + live en cours.
 * Chiffre d'affaires = réservations confirmées (Messenger ou bouton « Confirmer »),
 * au prix figé à la confirmation (sinon prix du produit dans la session).
 */
interface Snapshot {
  summary: { id: string; name: string; archivedAt: string };
  activeLive?: { id: string; title?: string };
  products: Product[];
  comments: Record<string, LiveComment>;
  intents: Intent[];
  conversations: Record<string, Conversation>;
}

export interface Sale {
  sessionId: string;
  at: string;          // heure de la réservation (commentaire)
  confirmedAt?: string;
  status: Intent['status'];
  code: string;
  name: string;
  variant?: string;
  quantity: number;
  amount: number;
  customer: string;
}

export interface LiveSummary {
  id: string; name: string; current: boolean;
  startedAt?: string; endedAt?: string;
  comments: number; reservations: number; confirmed: number; cancelled: number; toValidate: number;
  revenueMga: number; pendingMga: number; customers: number; itemsSold: number;
  confirmationRate: number | null; topProduct?: { code: string; name: string; quantity: number };
}

// Les sessions archivées ne changent plus : on garde leur lecture en mémoire.
const cache = new Map<string, Snapshot>();

async function archived(): Promise<Snapshot[]> {
  const shop = currentShopId()!;
  const ids = await q<{ id: string }>('SELECT id FROM live_sessions WHERE shop_id = ? ORDER BY archived_at DESC', [shop]);
  const missing = ids.filter((r) => !cache.has(`${shop}:${r.id}`)).map((r) => r.id);
  if (missing.length) {
    const rows = await q<{ id: string; snapshot: string }>(`SELECT id, snapshot FROM live_sessions WHERE shop_id = ? AND id IN (${missing.map(() => '?').join(',')})`, [shop, ...missing]);
    for (const r of rows) {
      const s = JSON.parse(r.snapshot);
      cache.set(`${shop}:${r.id}`, {
        summary: s.summary, activeLive: s.activeLive, products: s.products ?? [],
        comments: s.comments ?? {}, intents: s.intents ?? [], conversations: s.conversations ?? {},
      });
    }
  }
  return ids.map((r) => cache.get(`${shop}:${r.id}`)!).filter(Boolean);
}

function currentSnapshot(): Snapshot {
  return {
    summary: { id: 'en-cours', name: state.activeLive?.title || 'Live en cours', archivedAt: '' },
    activeLive: state.activeLive, products: state.products, comments: state.comments, intents: state.intents, conversations: state.conversations,
  };
}

function customerName(s: Snapshot, intent: Intent) {
  const conv = Object.values(s.conversations).find((c) => c.intentIds.includes(intent.id));
  return (conv?.customer.name || intent.authorName || 'Client').trim();
}

function salesOf(s: Snapshot): Sale[] {
  const price = new Map(s.products.map((p) => [p.code, p]));
  return s.intents
    .filter((i) => i.code && ['RESERVED', 'CONFIRMED', 'CANCELLED'].includes(i.status))
    .map((i) => {
      const p = price.get(i.code!);
      return {
        sessionId: s.summary.id, at: i.createdAt, confirmedAt: i.confirmedAt, status: i.status,
        code: i.code!, name: p?.name ?? i.code!, variant: i.variant, quantity: i.quantity,
        amount: (i.unitPriceMga ?? p?.priceMga ?? 0) * i.quantity, customer: customerName(s, i),
      };
    });
}

function summarize(s: Snapshot, current: boolean): LiveSummary {
  const sales = salesOf(s);
  const confirmed = sales.filter((x) => x.status === 'CONFIRMED');
  const reserved = sales.filter((x) => x.status === 'RESERVED');
  const cancelled = sales.filter((x) => x.status === 'CANCELLED').length;
  const times = [...Object.values(s.comments).map((c) => c.createdTime ?? c.receivedAt), ...s.intents.map((i) => i.createdAt)].filter(Boolean).sort();
  const byProduct = new Map<string, { code: string; name: string; quantity: number }>();
  for (const x of confirmed) {
    const cur = byProduct.get(x.code) ?? { code: x.code, name: x.name, quantity: 0 };
    cur.quantity += x.quantity;
    byProduct.set(x.code, cur);
  }
  const decided = confirmed.length + cancelled;
  return {
    id: s.summary.id, name: s.summary.name, current,
    startedAt: times[0], endedAt: current ? undefined : s.summary.archivedAt || times.at(-1),
    comments: Object.keys(s.comments).length,
    reservations: sales.length,
    confirmed: confirmed.length,
    cancelled,
    toValidate: s.intents.filter((i) => ['NEEDS_REVIEW', 'WAITLISTED'].includes(i.status)).length,
    revenueMga: confirmed.reduce((a, x) => a + x.amount, 0),
    pendingMga: reserved.reduce((a, x) => a + x.amount, 0),
    customers: new Set(confirmed.map((x) => x.customer.toLowerCase())).size,
    itemsSold: confirmed.reduce((a, x) => a + x.quantity, 0),
    confirmationRate: decided ? Math.round((confirmed.length / decided) * 1000) / 10 : null,
    topProduct: [...byProduct.values()].sort((a, b) => b.quantity - a.quantity)[0],
  };
}

/** Liste des lives : celui en cours (s'il a de l'activité) puis les archivés, du plus récent au plus ancien. */
export async function livesHistory(): Promise<LiveSummary[]> {
  const cur = currentSnapshot();
  const list = (await archived()).map((s) => summarize(s, false));
  const hasActivity = Object.keys(cur.comments).length || cur.intents.length;
  return hasActivity ? [summarize(cur, true), ...list] : list;
}

/** Détail d'un live : chiffres, produits vendus, clients, réservations. */
export async function liveDetail(id: string) {
  const s = id === 'en-cours' ? currentSnapshot() : (await archived()).find((x) => x.summary.id === id);
  if (!s) throw new Error('Live introuvable');
  const sales = salesOf(s);
  const confirmed = sales.filter((x) => x.status === 'CONFIRMED');
  const products = new Map<string, { code: string; name: string; quantity: number; revenueMga: number }>();
  const customers = new Map<string, { name: string; orders: number; quantity: number; revenueMga: number }>();
  for (const x of confirmed) {
    const p = products.get(x.code) ?? { code: x.code, name: x.name, quantity: 0, revenueMga: 0 };
    p.quantity += x.quantity; p.revenueMga += x.amount; products.set(x.code, p);
    const k = x.customer.toLowerCase();
    const c = customers.get(k) ?? { name: x.customer, orders: 0, quantity: 0, revenueMga: 0 };
    c.orders++; c.quantity += x.quantity; c.revenueMga += x.amount; customers.set(k, c);
  }
  return {
    summary: summarize(s, id === 'en-cours'),
    products: [...products.values()].sort((a, b) => b.revenueMga - a.revenueMga),
    customers: [...customers.values()].sort((a, b) => b.revenueMga - a.revenueMga),
    sales: sales.sort((a, b) => a.at.localeCompare(b.at)),
  };
}

/**
 * Statistiques sur une période [from, to[ . `tzOffsetMin` = décalage du navigateur
 * (getTimezoneOffset) pour regrouper par jour et par heure dans l'heure locale du vendeur.
 */
export async function periodStats(from: Date, to: Date, tzOffsetMin: number) {
  const snaps = [currentSnapshot(), ...(await archived())];
  const all = snaps.flatMap(salesOf);
  // Une vente compte à la date de sa confirmation (à défaut, de la réservation).
  const when = (x: Sale) => new Date(x.confirmedAt ?? x.at);
  const inRange = all.filter((x) => { const t = when(x).getTime(); return t >= from.getTime() && t < to.getTime(); });
  const confirmed = inRange.filter((x) => x.status === 'CONFIRMED');
  const reserved = inRange.filter((x) => x.status === 'RESERVED');
  const cancelled = inRange.filter((x) => x.status === 'CANCELLED');
  const local = (d: Date) => new Date(d.getTime() - tzOffsetMin * 60_000);

  const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
  const byHourMode = spanDays <= 1.01;
  const byMonthMode = spanDays > 92; // longues périodes : un bâton par mois
  const buckets = new Map<string, { label: string; revenueMga: number; orders: number }>();
  if (byHourMode) {
    for (let h = 0; h < 24; h++) buckets.set(String(h), { label: `${h} h`, revenueMga: 0, orders: 0 });
  } else if (byMonthMode) {
    const a = local(from), b = local(to);
    for (let y = a.getUTCFullYear(), m = a.getUTCMonth(); y < b.getUTCFullYear() || (y === b.getUTCFullYear() && m <= b.getUTCMonth()); m === 11 ? (y++, m = 0) : m++) {
      const key = `${y}-${String(m + 1).padStart(2, '0')}`;
      buckets.set(key, { label: key, revenueMga: 0, orders: 0 });
    }
  } else {
    for (let t = local(from).getTime(); t < local(to).getTime(); t += 86_400_000) {
      const key = new Date(t).toISOString().slice(0, 10);
      buckets.set(key, { label: key, revenueMga: 0, orders: 0 });
    }
  }
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, revenueMga: 0, orders: 0 }));
  const products = new Map<string, { code: string; name: string; quantity: number; revenueMga: number }>();
  const customers = new Map<string, { name: string; orders: number; revenueMga: number }>();
  for (const x of confirmed) {
    const l = local(when(x));
    const key = byHourMode ? String(l.getUTCHours()) : byMonthMode ? l.toISOString().slice(0, 7) : l.toISOString().slice(0, 10);
    const b = buckets.get(key);
    if (b) { b.revenueMga += x.amount; b.orders++; }
    const hr = hours[new Date(local(new Date(x.at)).getTime()).getUTCHours()];
    hr.revenueMga += x.amount; hr.orders++;
    const p = products.get(x.code) ?? { code: x.code, name: x.name, quantity: 0, revenueMga: 0 };
    p.quantity += x.quantity; p.revenueMga += x.amount; products.set(x.code, p);
    const k = x.customer.toLowerCase();
    const c = customers.get(k) ?? { name: x.customer, orders: 0, revenueMga: 0 };
    c.orders++; c.revenueMga += x.amount; customers.set(k, c);
  }
  const revenue = confirmed.reduce((a, x) => a + x.amount, 0);
  const decided = confirmed.length + cancelled.length;
  const lives = (await livesHistory()).filter((l) => {
    const t = new Date(l.startedAt ?? l.endedAt ?? 0).getTime();
    return t >= from.getTime() && t < to.getTime();
  });
  return {
    from, to,
    totals: {
      revenueMga: revenue,
      pendingMga: reserved.reduce((a, x) => a + x.amount, 0),
      orders: confirmed.length,
      itemsSold: confirmed.reduce((a, x) => a + x.quantity, 0),
      customers: customers.size,
      averageBasketMga: customers.size ? Math.round(revenue / customers.size) : 0,
      reservations: inRange.length,
      cancelled: cancelled.length,
      confirmationRate: decided ? Math.round((confirmed.length / decided) * 1000) / 10 : null,
      lives: lives.length,
    },
    series: { unit: byHourMode ? 'hour' : byMonthMode ? 'month' : 'day', points: [...buckets.values()] },
    byHour: hours,
    topProducts: [...products.values()].sort((a, b) => b.revenueMga - a.revenueMga).slice(0, 8),
    topCustomers: [...customers.values()].sort((a, b) => b.revenueMga - a.revenueMga).slice(0, 8),
    lives,
  };
}
