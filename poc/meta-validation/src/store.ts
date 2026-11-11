import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

/**
 * Stockage de la PoC : un fichier JSON local (data/state.json).
 * La version produit utilisera MySQL + Prisma (packages/db). Ici, on garde
 * zéro dépendance d'infrastructure pour tester vite.
 */

export interface PageRecord { id: string; name: string; tokenEnc: string; tasks?: string[] }
export interface Variant { label: string; stock: number; reserved: number }
export interface Product { code: string; name: string; priceMga: number; variants: Variant[] }

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

export type TestStatus = 'A_TESTER' | 'OK' | 'KO' | 'PARTIEL';
export interface TestResult { status: TestStatus; note: string; evidence: string[]; at?: string }

export interface State {
  userTokenEnc?: string;
  grantedScopes?: { permission: string; status: string }[];
  pages: PageRecord[];
  selectedPageId?: string;
  activeLive?: { id: string; videoId?: string; title?: string };
  products: Product[];
  comments: Record<string, LiveComment>;
  intents: Intent[];
  productComments: ProductComment[];
  conversations: Record<string, Conversation>;
  tests: Record<string, TestResult>;
  settings: { autoPrivateReply: boolean };
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

const file = path.join(config.dataDir, 'state.json');

function loadProducts(): Product[] {
  const raw = JSON.parse(fs.readFileSync(config.productsFile, 'utf8')) as Array<Omit<Product, 'variants'> & { variants: { label: string; stock: number }[] }>;
  return raw.map((p) => ({ ...p, variants: p.variants.map((v) => ({ ...v, reserved: 0 })) }));
}

function initial(): State {
  return {
    pages: [],
    products: loadProducts(),
    comments: {},
    intents: [],
    productComments: [],
    conversations: {},
    tests: Object.fromEntries(Object.keys(TESTS).map((k) => [k, { status: 'A_TESTER', note: '', evidence: [] }])),
    settings: { autoPrivateReply: false },
  };
}

fs.mkdirSync(config.dataDir, { recursive: true });
export const state: State = fs.existsSync(file) ? { ...initial(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } : initial();

let timer: NodeJS.Timeout | undefined;
export function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFileSync(file, JSON.stringify(state, null, 2)), 200);
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

// ---------------------------------------------------------------- Sessions archivées
const sessionsDir = path.join(config.dataDir, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

export interface SessionSummary { id: string; name: string; archivedAt: string; live?: string; comments: number; intents: number; confirmed: number }

/** Archive la session en cours (data/sessions/<id>.json, dans le volume persistant). */
export function archiveSession(name: string): SessionSummary {
  const archivedAt = new Date().toISOString();
  const id = archivedAt.replace(/[:.]/g, '-');
  const summary: SessionSummary = {
    id,
    name: name || state.activeLive?.title || 'Session',
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
    products: state.products,
    comments: state.comments,
    intents: state.intents,
    productComments: state.productComments,
    conversations: state.conversations,
  };
  fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(snapshot, null, 2));
  return summary;
}

export function listSessions(): SessionSummary[] {
  return fs.readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')).summary as SessionSummary)
    .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

export function sessionFile(id: string): string | undefined {
  if (!/^[\w-]+$/.test(id)) return undefined;
  const file = path.join(sessionsDir, `${id}.json`);
  return fs.existsSync(file) ? file : undefined;
}

/** Réinitialise les données de live (commentaires, intentions, stock), garde la connexion Meta. */
export function resetLiveData() {
  state.comments = {};
  state.intents = [];
  state.productComments = [];
  state.conversations = {};
  state.products = loadProducts();
  persist();
}

export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
