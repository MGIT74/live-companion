import { q } from './db.ts';
import { currentShopId, state, type Conversation, type Followed, type Intent, type LiveComment, type ProductComment, type Product, type SaleKind } from './store.ts';

/**
 * Statistiques de la boutique : lives archivés (table live_sessions) + live en cours.
 * Chiffre d'affaires = réservations confirmées (Messenger ou bouton « Confirmer »),
 * au prix figé à la confirmation (sinon prix du produit dans la session).
 */
interface Snapshot {
  summary: { id: string; name: string; archivedAt: string };
  activeLive?: { id: string; title?: string };
  followed?: Record<string, Followed>;
  productComments?: ProductComment[];
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
  sessionId: string; objectId: string; kind: SaleKind; picture?: string; permalink?: string; active: boolean;
  /** Live terminé (ou publication remplacée) dont la rediffusion est encore lue jusqu'à cette date. */
  replayUntil?: string;
  /** Terminée par le vendeur : ne prend plus de commandes. */
  closedAt?: string;
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
        summary: s.summary, activeLive: s.activeLive, followed: s.followed, productComments: s.productComments ?? [], products: s.products ?? [],
        comments: s.comments ?? {}, intents: s.intents ?? [], conversations: s.conversations ?? {},
      });
    }
  }
  return ids.map((r) => cache.get(`${shop}:${r.id}`)!).filter(Boolean);
}

function currentSnapshot(): Snapshot {
  return {
    summary: { id: 'en-cours', name: state.activeLive?.title || 'Live en cours', archivedAt: '' },
    activeLive: state.activeLive, followed: state.followed, productComments: state.productComments, products: state.products, comments: state.comments, intents: state.intents, conversations: state.conversations,
  };
}

function customerName(s: Snapshot, intent: Intent) {
  const conv = Object.values(s.conversations).find((c) => c.intentIds.includes(intent.id));
  return (conv?.customer.name || intent.authorName || 'Client').trim();
}

function salesOf(s: Snapshot, objectId?: string): Sale[] {
  const price = new Map(s.products.map((p) => [p.code, p]));
  return s.intents
    .filter((i) => i.code && ['RESERVED', 'CONFIRMED', 'CANCELLED'].includes(i.status) && (!objectId || i.liveVideoId === objectId))
    .map((i) => {
      const p = price.get(i.code!);
      return {
        sessionId: s.summary.id, at: i.createdAt, confirmedAt: i.confirmedAt, status: i.status,
        code: i.code!, name: p?.name ?? i.code!, variant: i.variant, quantity: i.quantity,
        amount: (i.unitPriceMga ?? p?.priceMga ?? 0) * i.quantity, customer: customerName(s, i),
      };
    });
}

/** Live ou publication suivi(e) dans une session : titre, type, image (avec repli pour les anciennes données). */
function objectInfo(s: Snapshot, objectId: string): Followed {
  const f = s.followed?.[objectId] ?? state.followed?.[objectId];
  if (f) return f;
  const title = s.activeLive?.id === objectId ? s.activeLive.title : undefined;
  const fallback = s.summary.id === 'en-cours' ? 'Vente sans titre' : s.summary.name;
  const t = title && !/^Publication\s*:\s*$/.test(title) ? title : title ? 'Publication sans texte' : fallback;
  return { id: objectId, kind: /^Publication/.test(t ?? '') ? 'post' : 'live', title: t || 'Vente', followedAt: '' };
}

/** Lives / publications d'une session (une « vente en ligne » chacun). */
function objectsOf(s: Snapshot, current: boolean): string[] {
  const ids = new Set<string>();
  for (const c of Object.values(s.comments)) if (c.liveVideoId) ids.add(c.liveVideoId);
  for (const i of s.intents) if (i.liveVideoId) ids.add(i.liveVideoId);
  if (current && s.activeLive?.id) ids.add(s.activeLive.id);
  return [...ids];
}

function summarize(s: Snapshot, current: boolean, objectId: string): LiveSummary {
  const sales = salesOf(s, objectId);
  const confirmed = sales.filter((x) => x.status === 'CONFIRMED');
  const reserved = sales.filter((x) => x.status === 'RESERVED');
  const cancelled = sales.filter((x) => x.status === 'CANCELLED').length;
  const comments = Object.values(s.comments).filter((c) => c.liveVideoId === objectId);
  const intents = s.intents.filter((i) => i.liveVideoId === objectId);
  const times = [...comments.map((c) => c.createdTime ?? c.receivedAt), ...intents.map((i) => i.createdAt)].filter(Boolean).sort();
  const byProduct = new Map<string, { code: string; name: string; quantity: number }>();
  for (const x of confirmed) {
    const cur = byProduct.get(x.code) ?? { code: x.code, name: x.name, quantity: 0 };
    cur.quantity += x.quantity;
    byProduct.set(x.code, cur);
  }
  const decided = confirmed.length + cancelled;
  const info = objectInfo(s, objectId);
  return {
    id: `${s.summary.id}~${objectId}`, name: info.title, current,
    sessionId: s.summary.id, objectId, kind: info.kind, picture: info.picture, permalink: info.permalink,
    active: current && state.activeLive?.id === objectId && !info.closedAt,
    startedAt: times[0] ?? info.createdTime ?? (info.followedAt || undefined),
    endedAt: current ? info.endedAt : s.summary.archivedAt || times.at(-1),
    closedAt: info.closedAt,
    replayUntil: current && !info.closedAt && info.endedAt && Date.now() - new Date(info.endedAt).getTime() < 7 * 86_400_000
      ? new Date(new Date(info.endedAt).getTime() + 7 * 86_400_000).toISOString() : undefined,
    comments: comments.length,
    reservations: sales.length,
    confirmed: confirmed.length,
    cancelled,
    toValidate: intents.filter((i) => ['NEEDS_REVIEW', 'WAITLISTED'].includes(i.status)).length,
    revenueMga: confirmed.reduce((a, x) => a + x.amount, 0),
    pendingMga: reserved.reduce((a, x) => a + x.amount, 0),
    customers: new Set(confirmed.map((x) => x.customer.toLowerCase())).size,
    itemsSold: confirmed.reduce((a, x) => a + x.quantity, 0),
    confirmationRate: decided ? Math.round((confirmed.length / decided) * 1000) / 10 : null,
    topProduct: [...byProduct.values()].sort((a, b) => b.quantity - a.quantity)[0],
  };
}

/** Ventes en ligne : celles de la session en cours, puis les archivées, de la plus récente à la plus ancienne. */
export async function livesHistory(): Promise<LiveSummary[]> {
  const cur = currentSnapshot();
  const curList = objectsOf(cur, true).map((o) => summarize(cur, true, o));
  const old = (await archived()).flatMap((s) => {
    const objs = objectsOf(s, false);
    return objs.length ? objs.map((o) => summarize(s, false, o)) : [summarize(s, false, s.activeLive?.id ?? s.summary.id)];
  });
  const byStart = (a: LiveSummary, b: LiveSummary) => (b.startedAt ?? b.endedAt ?? '').localeCompare(a.startedAt ?? a.endedAt ?? '');
  return [...curList.sort((a, b) => Number(b.active) - Number(a.active) || byStart(a, b)), ...old.sort(byStart)];
}

/** Détail d'une vente en ligne : tout ce que montrait la régie (produits, commentaires, commandes, clients). */
export async function liveDetail(id: string) {
  const [sessionId, objectId] = id.split('~');
  const s = sessionId === 'en-cours' ? currentSnapshot() : (await archived()).find((x) => x.summary.id === sessionId);
  if (!s || !objectId) throw new Error('Vente introuvable');
  const current = sessionId === 'en-cours';
  const sales = salesOf(s, objectId);
  const confirmed = sales.filter((x) => x.status === 'CONFIRMED');
  const sold = new Map<string, { quantity: number; revenueMga: number; pending: number }>();
  const customers = new Map<string, { name: string; orders: number; quantity: number; revenueMga: number }>();
  for (const x of sales) {
    const p = sold.get(x.code) ?? { quantity: 0, revenueMga: 0, pending: 0 };
    if (x.status === 'CONFIRMED') { p.quantity += x.quantity; p.revenueMga += x.amount; } else if (x.status === 'RESERVED') p.pending += x.quantity;
    sold.set(x.code, p);
  }
  for (const x of confirmed) {
    const k = x.customer.toLowerCase();
    const c = customers.get(k) ?? { name: x.customer, orders: 0, quantity: 0, revenueMga: 0 };
    c.orders++; c.quantity += x.quantity; c.revenueMga += x.amount; customers.set(k, c);
  }
  const intents = s.intents.filter((i) => i.liveVideoId === objectId);
  const intentIds = new Set(intents.map((i) => i.id));
  const intentById = new Map(intents.map((i) => [i.id, i]));
  const published = new Set((s.productComments ?? []).filter((p) => p.liveVideoId === objectId).map((p) => p.code));
  // Produits mis en vente : ceux publiés dans cette vente ou commandés ; sinon tout le catalogue de la session.
  const involved = new Set([...published, ...sales.map((x) => x.code)]);
  const products = s.products
    .filter((p) => !involved.size || involved.has(p.code))
    .map((p) => ({
      code: p.code, name: p.name, priceMga: p.priceMga, photo: p.photo, published: published.has(p.code),
      variants: p.variants.map((v) => ({ label: v.label, stock: v.stock, available: v.stock - v.reserved })),
      sold: sold.get(p.code)?.quantity ?? 0, revenueMga: sold.get(p.code)?.revenueMga ?? 0, pending: sold.get(p.code)?.pending ?? 0,
    }));
  const comments = Object.values(s.comments)
    .filter((c) => c.liveVideoId === objectId)
    .sort((a, b) => (b.createdTime ?? b.receivedAt).localeCompare(a.createdTime ?? a.receivedAt))
    .map((c) => ({ id: c.id, from: c.fromName ?? 'Anonyme', message: c.message, at: c.createdTime ?? c.receivedAt, status: c.intentId ? intentById.get(c.intentId)?.status : undefined }));
  const conversations = Object.values(s.conversations)
    .filter((c) => c.intentIds.some((i) => intentIds.has(i)))
    .map((c) => ({ name: c.customer.name ?? 'Client', phone: c.customer.phone, city: c.customer.city, payment: c.customer.payment, step: c.step }));
  return {
    summary: summarize(s, current, objectId),
    products: products.sort((a, b) => b.revenueMga - a.revenueMga || Number(b.published) - Number(a.published)),
    customers: [...customers.values()].sort((a, b) => b.revenueMga - a.revenueMga),
    comments,
    conversations,
    sales: sales.sort((a, b) => a.at.localeCompare(b.at)),
  };
}

/**
 * Statistiques sur une période [from, to[ . `tzOffsetMin` = décalage du navigateur
 * (getTimezoneOffset) pour regrouper par jour et par heure dans l'heure locale du vendeur.
 */
export async function periodStats(from: Date, to: Date, tzOffsetMin: number) {
  const snaps = [currentSnapshot(), ...(await archived())];
  const all = snaps.flatMap((x) => salesOf(x));
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

// ---------------------------------------------------------------- Clients
/**
 * Fichier clients de la boutique, construit à partir de toutes les commandes (lives archivés + live en cours).
 * Un client = un nom Facebook (même personne d'un live à l'autre) ; coordonnées reprises de Messenger.
 */
interface CustomerRow {
  key: string; name: string; phone?: string; address?: string; city?: string; payment?: string; messenger: boolean;
  orders: number; confirmed: number; cancelled: number; revenueMga: number; pendingMga: number; itemsBought: number;
  firstOrderAt?: string; lastOrderAt?: string; lives: number;
}
interface HistoryRow { at: string; live: string; current: boolean; code: string; name: string; variant?: string; quantity: number; status: Intent['status']; amount: number }

async function customerIndex() {
  const snaps: [Snapshot, boolean][] = [[currentSnapshot(), true], ...(await archived()).map((s) => [s, false] as [Snapshot, boolean])];
  const map = new Map<string, CustomerRow & { history: HistoryRow[]; liveIds: Set<string>; products: Map<string, { code: string; name: string; quantity: number }> }>();
  for (const [s, current] of snaps) {
    const price = new Map(s.products.map((p) => [p.code, p]));
    for (const i of s.intents) {
      if (!i.code || !['RESERVED', 'CONFIRMED', 'CANCELLED'].includes(i.status)) continue;
      const conv = Object.values(s.conversations).find((c) => c.intentIds.includes(i.id));
      const name = (conv?.customer.name || i.authorName || 'Client').trim();
      const key = name.toLowerCase();
      let c = map.get(key);
      if (!c) {
        c = { key, name, messenger: false, orders: 0, confirmed: 0, cancelled: 0, revenueMga: 0, pendingMga: 0, itemsBought: 0, lives: 0, history: [], liveIds: new Set(), products: new Map() };
        map.set(key, c);
      }
      const p = price.get(i.code);
      const amount = (i.unitPriceMga ?? p?.priceMga ?? 0) * i.quantity;
      // Coordonnées : les plus récentes l'emportent.
      if (conv) {
        c.messenger = true;
        if (!c.lastOrderAt || i.createdAt >= c.lastOrderAt) {
          c.phone = conv.customer.phone || c.phone; c.address = conv.customer.address || c.address;
          c.city = conv.customer.city || c.city; c.payment = conv.customer.payment || c.payment;
        }
      }
      c.orders++;
      if (i.status === 'CONFIRMED') {
        c.confirmed++; c.revenueMga += amount; c.itemsBought += i.quantity;
        const fav = c.products.get(i.code) ?? { code: i.code, name: p?.name ?? i.code, quantity: 0 };
        fav.quantity += i.quantity; c.products.set(i.code, fav);
      } else if (i.status === 'RESERVED') c.pendingMga += amount;
      else c.cancelled++;
      if (!c.firstOrderAt || i.createdAt < c.firstOrderAt) c.firstOrderAt = i.createdAt;
      if (!c.lastOrderAt || i.createdAt > c.lastOrderAt) c.lastOrderAt = i.createdAt;
      c.liveIds.add(s.summary.id);
      c.history.push({ at: i.createdAt, live: objectInfo(s, i.liveVideoId).title, current, code: i.code, name: p?.name ?? i.code, variant: i.variant, quantity: i.quantity, status: i.status, amount });
    }
  }
  for (const c of map.values()) c.lives = c.liveIds.size;
  return map;
}

export async function listCustomers(search?: string, sort = 'recent') {
  const term = (search ?? '').trim().toLowerCase();
  const rows = [...(await customerIndex()).values()]
    .filter((c) => !term || c.name.toLowerCase().includes(term) || (c.phone ?? '').includes(term.replace(/\s/g, '')) || (c.city ?? '').toLowerCase().includes(term))
    .map(({ history, liveIds, products, ...c }) => c);
  const by: Record<string, (a: CustomerRow, b: CustomerRow) => number> = {
    recent: (a, b) => (b.lastOrderAt ?? '').localeCompare(a.lastOrderAt ?? ''),
    spent: (a, b) => b.revenueMga - a.revenueMga,
    orders: (a, b) => b.confirmed - a.confirmed || b.orders - a.orders,
    name: (a, b) => a.name.localeCompare(b.name, 'fr'),
  };
  return rows.sort(by[sort] ?? by.recent);
}

export async function customerDetail(key: string) {
  const c = (await customerIndex()).get(key.toLowerCase());
  if (!c) throw new Error('Client introuvable');
  const { history, liveIds, products, ...rest } = c;
  return {
    ...rest,
    averageBasketMga: c.confirmed ? Math.round(c.revenueMga / c.confirmed) : 0,
    favoriteProducts: [...products.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5),
    history: history.sort((a, b) => b.at.localeCompare(a.at)),
  };
}
