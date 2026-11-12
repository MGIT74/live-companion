import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { q } from './db.ts';
import { shopContext } from './bus.ts';

/**
 * Stockage de la PoC : un fichier JSON local (data/state.json).
 * La version produit utilisera MySQL + Prisma (packages/db). Ici, on garde
 * zéro dépendance d'infrastructure pour tester vite.
 */

export interface PageRecord { id: string; name: string; tokenEnc: string; tasks?: string[] }
export interface Variant { label: string; stock: number; reserved: number }
export interface Product { code: string; name: string; priceMga: number; variants: Variant[]; /** Chemin public de la photo (/photos/…). */ photo?: string }

export interface LiveComment {
  id: string;
  liveVideoId: string;
  message: string;
  /** Texte analysé, sans la mention ajoutée par « Répondre ». */
  parsedText?: string;
  fromId?: string;
  fromName?: string;
  parentId?: string;
  createdTime?: string;
  firstSource: Source;
  sources: Source[];
  receivedAt: string;
  latencyMs?: number;
  intentId?: string;
}
export type Source = 'SSE' | 'POLL' | 'WEBHOOK';

export type IntentStatus = 'RESERVED' | 'WAITLISTED' | 'NEEDS_REVIEW' | 'REJECTED' | 'CONFIRMED' | 'CANCELLED';
export interface Intent {
  id: string;
  commentId?: string;
  liveVideoId: string;
  code?: string;
  variant?: string;
  quantity: number;
  status: IntentStatus;
  reason?: string;
  matchMethod: 'CODE' | 'PARENT' | 'MANUAL';
  rawText: string;
  authorName?: string;
  privateReply?: { status: 'SENT' | 'FAILED'; psid?: string; messageId?: string; error?: string; at: string };
  createdAt: string;
  /** Confirmation (Messenger ou à la main) : date et prix unitaire figé pour le chiffre d'affaires. */
  confirmedAt?: string;
  unitPriceMga?: number;
}

export interface ProductComment { commentId: string; code: string; liveVideoId: string; objectId: string; at: string }

export interface Conversation {
  psid: string;
  step: 'AWAIT_CONFIRM' | 'ASK_NAME' | 'ASK_PHONE' | 'ASK_ADDRESS' | 'ASK_CITY' | 'ASK_PAYMENT' | 'DONE' | 'CANCELLED';
  intentIds: string[];
  customer: { name?: string; phone?: string; address?: string; city?: string; payment?: string };
  lastInboundAt?: string;
  updatedAt: string;
}

export type SaleKind = 'live' | 'photo' | 'video' | 'post';
export interface Followed {
  id: string; kind: SaleKind; title: string; picture?: string; permalink?: string; createdTime?: string; followedAt: string;
  /** Vidéo associée au live (les commentaires de la rediffusion y arrivent aussi). */
  videoId?: string;
  /** Live : fin détectée sur Facebook. Publication : moment où une autre vente a pris sa place. */
  endedAt?: string;
  /** Vente terminée par le vendeur : plus aucune commande n'est prise (commentaires seulement gardés). */
  closedAt?: string;
}

export type TestStatus = 'A_TESTER' | 'OK' | 'KO' | 'PARTIEL';
export interface TestResult { status: TestStatus; note: string; evidence: string[]; at?: string }

export interface State {
  userTokenEnc?: string;
  grantedScopes?: { permission: string; status: string }[];
  pages: PageRecord[];
  selectedPageId?: string;
  activeLive?: { id: string; videoId?: string; title?: string };
  /** Tout ce qui a été suivi (live, post photo, post vidéo) : type, titre, image, lien Facebook. */
  followed?: Record<string, Followed>;
  products: Product[];
  comments: Record<string, LiveComment>;
  intents: Intent[];
  productComments: ProductComment[];
  conversations: Record<string, Conversation>;
  tests: Record<string, TestResult>;
  settings: { autoPrivateReply: boolean };
  /** Dernière vérification de l'abonnement de la Page aux webhooks. */
  subscription?: { pageId?: string; active: boolean; missing: string[]; checkedAt: string; error?: string };
}

export const TESTS: Record<string, string> = {
  T1: 'Connexion OAuth',
  T2: 'Pages et permissions',
  T3: 'Live actif détecté',
  T4: 'Lecture des commentaires (polling)',
  T5: 'Commentaires en temps réel (SSE)',
  T6: 'Publication au nom de la Page',
  T7: 'Commentaire parent des réponses +1',
  T8: 'Reconnaissance des commandes',
  T9: 'Réponse privée Messenger',
  T10: 'Parcours de confirmation Messenger',
};

// ---------------------------------------------------------------- Une boutique = ses propres données
/**
 * Chaque boutique a son propre « state » (Page Facebook, produits, réservations, conversations…),
 * gardé en mémoire et enregistré dans la table shop_state. Le code métier continue d'écrire
 * `state.xxx` : `state` désigne automatiquement la boutique de la requête en cours
 * (AsyncLocalStorage), y compris dans les minuteries lancées depuis cette requête.
 */
const shops = new Map<string, State>();
const ctx = new AsyncLocalStorage<string>();

export function newState(products: Product[] = []): State {
  return {
    pages: [],
    products,
    comments: {},
    intents: [],
    productComments: [],
    conversations: {},
    tests: Object.fromEntries(Object.keys(TESTS).map((k) => [k, { status: 'A_TESTER', note: '', evidence: [] }])),
    settings: { autoPrivateReply: false },
  };
}

/** Exécute `fn` dans le contexte d'une boutique. */
export function runInShop<T>(shopId: string, fn: () => T): T {
  if (!shops.has(shopId)) throw new Error('Boutique introuvable');
  return ctx.run(shopId, fn);
}
export function currentShopId(): string | undefined { return ctx.getStore(); }
shopContext.current = currentShopId;
export function allShopIds(): string[] { return [...shops.keys()]; }
export function shopState(shopId: string): State | undefined { return shops.get(shopId); }
/** Boutique qui a choisi cette Page Facebook (une Page ne peut être reliée qu'à une boutique). */
export function shopForPage(pageId: string): string | undefined {
  for (const [id, s] of shops) if (s.selectedPageId === pageId) return id;
  return undefined;
}

function current(): State {
  const id = ctx.getStore();
  const s = id ? shops.get(id) : undefined;
  if (!s) throw new Error('Aucune boutique active pour cette opération');
  return s;
}

export const state: State = new Proxy({} as State, {
  get: (_t, k) => (current() as any)[k],
  set: (_t, k, v) => { (current() as any)[k] = v; return true; },
  has: (_t, k) => k in current(),
  ownKeys: () => Reflect.ownKeys(current()),
  getOwnPropertyDescriptor: (_t, k) => ({ ...Reflect.getOwnPropertyDescriptor(current(), k), configurable: true }),
});

/** Charge toutes les boutiques au démarrage (quelques centaines de boutiques tiennent sans problème en mémoire). */
export async function loadShops() {
  const rows = await q<{ shop_id: string; data: string }>('SELECT shop_id, data FROM shop_state');
  for (const r of rows) shops.set(r.shop_id, { ...newState(), ...JSON.parse(r.data) });
}

export async function createShopState(shopId: string, initial: State) {
  shops.set(shopId, initial);
  await q('INSERT INTO shop_state (shop_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)', [shopId, JSON.stringify(initial)]);
}

const timers = new Map<string, NodeJS.Timeout>();
async function flush(shopId: string) {
  const s = shops.get(shopId);
  if (!s) return;
  await q('UPDATE shop_state SET data = ?, updated_at = NOW() WHERE shop_id = ?', [JSON.stringify(s), shopId]);
}
/** Enregistre (200 ms après la dernière modification) les données de la boutique en cours. */
export function persist() {
  const id = ctx.getStore();
  if (!id) return;
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { timers.delete(id); flush(id).catch((e) => console.error('Enregistrement impossible', e)); }, 200));
}
/** Enregistre tout immédiatement (arrêt du serveur). */
export async function flushAll() {
  for (const [id, t] of timers) { clearTimeout(t); await flush(id); }
  timers.clear();
}

/** Données de l'ancienne version (un seul vendeur, fichier data/state.json) : reprises par le premier compte. */
const legacyFile = path.join(config.dataDir, 'state.json');
export function legacyState(): State | undefined {
  if (!fs.existsSync(legacyFile)) return undefined;
  return { ...newState(), ...JSON.parse(fs.readFileSync(legacyFile, 'utf8')) };
}
export function retireLegacyState() {
  if (fs.existsSync(legacyFile)) fs.renameSync(legacyFile, legacyFile + '.migre');
}

export function recordTest(id: string, patch: Partial<TestResult> & { evidenceFile?: string }) {
  const t = state.tests[id] ?? { status: 'A_TESTER', note: '', evidence: [] };
  if (patch.status) t.status = patch.status;
  if (patch.note !== undefined) t.note = patch.note;
  if (patch.evidenceFile) t.evidence = [...t.evidence, patch.evidenceFile].slice(-20);
  t.at = new Date().toISOString();
  state.tests[id] = t;
  persist();
}

// ---------------------------------------------------------------- Sessions archivées (table live_sessions)
export interface SessionSummary { id: string; name: string; archivedAt: string; live?: string; comments: number; intents: number; confirmed: number }

/** Archive la session en cours de la boutique. */
export async function archiveSession(name: string): Promise<SessionSummary> {
  const shopId = currentShopId()!;
  const archivedAt = new Date().toISOString();
  const id = archivedAt.replace(/[:.]/g, '-');
  const summary: SessionSummary = {
    id,
    name: (name || state.activeLive?.title || 'Session').slice(0, 120),
    archivedAt,
    live: state.activeLive?.id,
    comments: Object.keys(state.comments).length,
    intents: state.intents.length,
    confirmed: state.intents.filter((i) => i.status === 'CONFIRMED').length,
  };
  const snapshot = {
    summary,
    pageId: state.selectedPageId,
    activeLive: state.activeLive,
    followed: state.followed,
    products: state.products,
    comments: state.comments,
    intents: state.intents,
    productComments: state.productComments,
    conversations: state.conversations,
  };
  await saveSession(shopId, summary, snapshot);
  return summary;
}

export async function saveSession(shopId: string, summary: SessionSummary, snapshot: unknown) {
  await q('INSERT INTO live_sessions (id, shop_id, name, archived_at, summary, snapshot) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE summary = VALUES(summary)',
    [summary.id, shopId, summary.name.slice(0, 120), new Date(summary.archivedAt), JSON.stringify(summary), JSON.stringify(snapshot)]);
}

export async function listSessions(): Promise<SessionSummary[]> {
  const rows = await q<{ summary: string }>('SELECT summary FROM live_sessions WHERE shop_id = ? ORDER BY archived_at DESC', [currentShopId()]);
  return rows.map((r) => JSON.parse(r.summary));
}

export async function sessionSnapshot(id: string): Promise<string | undefined> {
  const rows = await q<{ snapshot: string }>('SELECT snapshot FROM live_sessions WHERE shop_id = ? AND id = ?', [currentShopId(), id]);
  return rows[0]?.snapshot;
}

/** Anciennes sessions (fichiers data/sessions/*.json) : rattachées à la boutique qui reprend les données. */
export async function importLegacySessions(shopId: string) {
  const dir = path.join(config.dataDir, 'sessions');
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const snap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!snap.summary?.id) continue;
    await saveSession(shopId, snap.summary, snap);
    n++;
  }
  fs.renameSync(dir, dir + '.migre');
  return n;
}

/**
 * Réinitialise les données de live (commentaires, intentions), garde la connexion Meta et le catalogue.
 * commitSales : les réservations confirmées sont vendues (retirées du stock) ; les autres sont libérées.
 */
export function resetLiveData(opts: { commitSales?: boolean } = {}) {
  if (opts.commitSales) {
    for (const i of state.intents) {
      if (i.status !== 'CONFIRMED' || !i.code) continue;
      const v = state.products.find((p) => p.code === i.code)?.variants.find((x) => x.label === i.variant);
      if (v) v.stock = Math.max(0, v.stock - i.quantity);
    }
  }
  for (const p of state.products) for (const v of p.variants) v.reserved = 0;
  state.comments = {};
  state.intents = [];
  state.productComments = [];
  state.conversations = {};
  persist();
}

export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
