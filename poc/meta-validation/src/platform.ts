import { q, pool } from './db.ts';
import { config } from './config.ts';
import { log, logSink } from './bus.ts';
import { allShopIds, runInShop, state } from './store.ts';
import { periodStats } from './stats.ts';

/**
 * Plateforme (super admin) : statut des comptes (en attente, actif, suspendu), abonnements payés
 * par Mobile Money, journal par boutique et réglages affichés sur l'écran de paiement.
 */
export type ShopStatus = 'pending' | 'active' | 'suspended';
export type Access = 'pending' | 'active' | 'suspended' | 'expired';

interface ShopAccess { status: ShopStatus; paidUntil: Date | null; reason: string | null; message: string | null }
const access = new Map<string, ShopAccess>();

export const PAY_METHODS = ['MVola', 'Orange Money', 'Airtel Money', 'Offert'] as const;
export const SUSPEND_REASONS = ['Abonnement non payé', 'Utilisation abusive', 'À la demande du vendeur', 'Autre'];

export interface PlatformSettings {
  priceMonthMga: number;
  price3MonthsMga: number;
  wallets: { method: 'MVola' | 'Orange Money' | 'Airtel Money'; number: string; holder: string; shown: boolean }[];
  supportWhatsapp: string;
  supportPhone: string;
  supportHours: string;
  lockMessage: string;
}
const DEFAULT_SETTINGS: PlatformSettings = {
  priceMonthMga: 50000,
  price3MonthsMga: 135000,
  wallets: [
    { method: 'MVola', number: '034 00 000 00', holder: 'DOKATEL SARL', shown: true },
    { method: 'Orange Money', number: '032 00 000 00', holder: 'DOKATEL SARL', shown: true },
    { method: 'Airtel Money', number: '033 00 000 00', holder: 'DOKATEL SARL', shown: true },
  ],
  supportWhatsapp: '034 00 000 00',
  supportPhone: '034 00 000 00',
  supportHours: 'Lun–sam, 8 h – 19 h',
  lockMessage: 'Payez l’abonnement par Mobile Money puis envoyez-nous la référence : votre compte est activé dans l’heure.',
};
let settings: PlatformSettings = DEFAULT_SETTINGS;

// ---------------------------------------------------------------- Schéma
async function addColumn(table: string, col: string, def: string) {
  const r = await q<{ n: number }>('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, col]);
  if (!Number(r[0].n)) await q(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

export async function migratePlatform() {
  // Les boutiques existantes restent actives (sans limite) ; les nouvelles sont créées « en attente ».
  await addColumn('shops', 'status', "VARCHAR(16) NOT NULL DEFAULT 'active'");
  await addColumn('shops', 'paid_until', 'DATETIME NULL');
  await addColumn('shops', 'suspend_reason', 'VARCHAR(120) NULL');
  await addColumn('shops', 'suspend_message', 'VARCHAR(400) NULL');
  await addColumn('users', 'is_admin', 'TINYINT NOT NULL DEFAULT 0');
  await addColumn('users', 'last_login_at', 'DATETIME NULL');
  await q(`CREATE TABLE IF NOT EXISTS payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    shop_id VARCHAR(32) NOT NULL,
    method VARCHAR(32) NOT NULL,
    reference VARCHAR(120) NULL,
    amount_mga INT NOT NULL DEFAULT 0,
    months INT NOT NULL,
    paid_until DATETIME NOT NULL,
    created_by VARCHAR(32) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX payments_shop (shop_id, created_at)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await q(`CREATE TABLE IF NOT EXISTS shop_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    shop_id VARCHAR(32) NOT NULL,
    at DATETIME(3) NOT NULL,
    level VARCHAR(8) NOT NULL,
    source VARCHAR(24) NOT NULL,
    message VARCHAR(1000) NOT NULL,
    detail TEXT NULL,
    INDEX shop_logs_shop (shop_id, at),
    INDEX shop_logs_level (level, at)
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await q(`CREATE TABLE IF NOT EXISTS platform_settings (
    k VARCHAR(48) PRIMARY KEY,
    v LONGTEXT NOT NULL
  ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  // Le premier compte créé devient super admin s'il n'y en a pas encore.
  if (config.superAdminEmails.length) await q('UPDATE users SET is_admin = 1 WHERE email IN (?)', [config.superAdminEmails]);
  const admins = await q<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1');
  if (!Number(admins[0].n)) await q('UPDATE users SET is_admin = 1 ORDER BY created_at, id LIMIT 1');
  const s = await q<{ v: string }>("SELECT v FROM platform_settings WHERE k = 'settings'");
  if (s[0]) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(s[0].v) };
  await reloadAccess();
  logSink.write = queueLog;
  setInterval(() => { void flushLogs(); }, 2000).unref();
  setInterval(() => { void q('DELETE FROM shop_logs WHERE at < NOW() - INTERVAL 30 DAY').catch(() => {}); }, 6 * 3600_000).unref();
}

export async function reloadAccess(shopId?: string) {
  const rows = await q<{ id: string; status: ShopStatus; paid_until: Date | null; suspend_reason: string | null; suspend_message: string | null }>(
    `SELECT id, status, paid_until, suspend_reason, suspend_message FROM shops${shopId ? ' WHERE id = ?' : ''}`, shopId ? [shopId] : []);
  for (const r of rows) access.set(r.id, { status: r.status, paidUntil: r.paid_until, reason: r.suspend_reason, message: r.suspend_message });
}

export function accessOf(shopId: string): Access {
  const a = access.get(shopId);
  if (!a) return 'active';
  if (a.status !== 'active') return a.status;
  if (a.paidUntil && a.paidUntil.getTime() < Date.now()) return 'expired';
  return 'active';
}
export const isLocked = (shopId: string) => accessOf(shopId) !== 'active';

/** Ce que voit le vendeur : son statut, et (s'il est bloqué) comment payer. */
export function accessInfo(shopId: string) {
  const a = access.get(shopId);
  const st = accessOf(shopId);
  const paidUntil = a?.paidUntil?.toISOString() ?? null;
  const daysLeft = a?.paidUntil ? Math.ceil((a.paidUntil.getTime() - Date.now()) / 86400_000) : null;
  return {
    status: st, locked: st !== 'active', paidUntil, daysLeft,
    reason: st === 'suspended' ? a?.reason : null, message: st === 'suspended' ? a?.message : null,
    pay: st !== 'active' || (daysLeft !== null && daysLeft <= 5) ? publicSettings() : undefined,
  };
}
export function publicSettings() {
  const s = settings;
  return { priceMonthMga: s.priceMonthMga, price3MonthsMga: s.price3MonthsMga, wallets: s.wallets.filter((w) => w.shown && w.number), supportWhatsapp: s.supportWhatsapp, supportPhone: s.supportPhone, supportHours: s.supportHours, lockMessage: s.lockMessage };
}
export const getSettings = () => settings;
export async function saveSettings(body: Partial<PlatformSettings>) {
  const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : d);
  const str = (v: unknown, d: string, max = 120) => (v === undefined ? d : String(v).trim().slice(0, max));
  const next: PlatformSettings = {
    priceMonthMga: n(body.priceMonthMga, settings.priceMonthMga),
    price3MonthsMga: n(body.price3MonthsMga, settings.price3MonthsMga),
    wallets: Array.isArray(body.wallets)
      ? settings.wallets.map((w) => { const b = body.wallets!.find((x) => x?.method === w.method); return b ? { method: w.method, number: str(b.number, w.number, 30), holder: str(b.holder, w.holder, 80), shown: b.shown !== false } : w; })
      : settings.wallets,
    supportWhatsapp: str(body.supportWhatsapp, settings.supportWhatsapp, 30),
    supportPhone: str(body.supportPhone, settings.supportPhone, 30),
    supportHours: str(body.supportHours, settings.supportHours, 80),
    lockMessage: str(body.lockMessage, settings.lockMessage, 400),
  };
  await q("INSERT INTO platform_settings (k, v) VALUES ('settings', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify(next)]);
  settings = next;
  return settings;
}

// ---------------------------------------------------------------- Journal par boutique
const SOURCES: [RegExp, string][] = [
  [/messenger|message|conversation|psid/i, 'Messenger'],
  [/webhook|signature/i, 'Webhook'],
  [/connexion|connecté|inscri|mot de passe|compte|abonnement de la boutique|paiement/i, 'Compte'],
  [/jeton|token|page|facebook|graph|oauth|subscribed/i, 'Facebook'],
  [/commande|réserv|stock|intention/i, 'Commandes'],
  [/commentaire|lecture|polling|sse|rediffusion/i, 'Lecture'],
  [/live|vente|publication|post/i, 'Ventes'],
];
const sourceOf = (msg: string) => SOURCES.find(([re]) => re.test(msg))?.[1] ?? 'Système';
let buffer: unknown[][] = [];
function queueLog(shopId: string, level: string, message: string, extra?: unknown) {
  let detail: string | null = null;
  if (extra !== undefined && extra !== null && extra !== '') {
    try { detail = typeof extra === 'string' ? extra : JSON.stringify(extra); } catch { detail = String(extra); }
    detail = detail.slice(0, 8000);
  }
  buffer.push([shopId, new Date(), level, sourceOf(message), message.slice(0, 1000), detail]);
  if (buffer.length > 500) buffer = buffer.slice(-500);
}
async function flushLogs() {
  if (!buffer.length) return;
  const rows = buffer; buffer = [];
  await pool.query('INSERT INTO shop_logs (shop_id, at, level, source, message, detail) VALUES ?', [rows]).catch((e) => console.error('Journal non enregistré :', e.message));
}

// ---------------------------------------------------------------- Super admin : comptes
interface ShopRow { id: string; name: string; created_at: Date; status: ShopStatus; paid_until: Date | null; suspend_reason: string | null; owner_name: string | null; owner_email: string | null; owner_id: string | null; last_login_at: Date | null; updated_at: Date | null }
const SHOP_SQL = `SELECT s.id, s.name, s.created_at, s.status, s.paid_until, s.suspend_reason,
    u.full_name AS owner_name, u.email AS owner_email, u.id AS owner_id, u.last_login_at, st.updated_at
  FROM shops s
  LEFT JOIN shop_members m ON m.shop_id = s.id AND m.role = 'OWNER'
  LEFT JOIN users u ON u.id = m.user_id
  LEFT JOIN shop_state st ON st.shop_id = s.id`;

function pageName(shopId: string) {
  if (!allShopIds().includes(shopId)) return null;
  return runInShop(shopId, () => state.pages.find((p) => p.id === state.selectedPageId)?.name ?? null);
}
const latest = (...d: (Date | null | undefined)[]) => d.filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null;

function summary(r: ShopRow, errors: Map<string, number>) {
  return {
    id: r.id, name: r.name, createdAt: r.created_at, ownerName: r.owner_name, ownerEmail: r.owner_email,
    status: accessOf(r.id), paidUntil: r.paid_until, reason: r.suspend_reason,
    pageName: pageName(r.id), lastActivity: latest(r.last_login_at, r.updated_at), errors24h: errors.get(r.id) ?? 0,
  };
}

export async function adminOverview() {
  const rows = await q<ShopRow>(`${SHOP_SQL} ORDER BY s.created_at DESC`);
  const errs = await q<{ shop_id: string; n: number }>("SELECT shop_id, COUNT(*) AS n FROM shop_logs WHERE level = 'error' AND at > NOW() - INTERVAL 1 DAY GROUP BY shop_id");
  const errors = new Map(errs.map((e) => [e.shop_id, Number(e.n)]));
  const accounts = rows.map((r) => summary(r, errors));
  const [paid] = await q<{ total: number; n: number }>("SELECT COALESCE(SUM(amount_mga),0) AS total, COUNT(*) AS n FROM payments WHERE created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')");
  const week = Date.now() - 7 * 86400_000;
  const soon = (a: { status: Access; paidUntil: Date | null }) => a.status === 'active' && a.paidUntil && a.paidUntil.getTime() - Date.now() < 7 * 86400_000;
  return {
    counts: {
      all: accounts.length, newThisWeek: accounts.filter((a) => new Date(a.createdAt).getTime() > week).length,
      active: accounts.filter((a) => a.status === 'active').length,
      pending: accounts.filter((a) => a.status === 'pending').length,
      suspended: accounts.filter((a) => a.status === 'suspended' || a.status === 'expired').length,
      soon: accounts.filter(soon).length,
    },
    collectedThisMonthMga: Number(paid.total), paymentsThisMonth: Number(paid.n),
    accounts: accounts.map((a) => ({ ...a, expiresSoon: Boolean(soon(a)) })),
  };
}

export async function adminAccount(shopId: string, filter = 'problems') {
  const [r] = await q<ShopRow>(`${SHOP_SQL} WHERE s.id = ?`, [shopId]);
  if (!r) throw new Error('Compte introuvable');
  const [e] = await q<{ n: number; last: Date | null }>("SELECT COUNT(*) AS n, MAX(at) AS last FROM shop_logs WHERE shop_id = ? AND level = 'error' AND at > NOW() - INTERVAL 1 DAY", [shopId]);
  const payments = await q('SELECT id, method, reference, amount_mga AS amountMga, months, paid_until AS paidUntil, created_at AS createdAt FROM payments WHERE shop_id = ? ORDER BY created_at DESC', [shopId]);
  const users = await q('SELECT u.id, u.full_name AS name, u.email, m.role, u.last_login_at AS lastLoginAt, u.created_at AS createdAt FROM shop_members m JOIN users u ON u.id = m.user_id WHERE m.shop_id = ?', [shopId]);
  const loaded = allShopIds().includes(shopId);
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const usage = loaded ? await runInShop(shopId, async () => {
    const p = await periodStats(monthStart, new Date(Date.now() + 60_000), -180);
    return {
      sales: Object.keys(state.followed ?? {}).length, activeSale: state.activeLive?.title ?? null,
      ordersMonth: p.totals.reservations, revenueMonthMga: p.totals.revenueMga, products: state.products.length,
      pages: state.pages.map((pg) => ({ id: pg.id, name: pg.name, selected: pg.id === state.selectedPageId })),
      facebookConnected: Boolean(state.userTokenEnc), messenger: state.subscription ?? null,
    };
  }) : null;
  return {
    ...summary(r, new Map([[shopId, Number(e.n)]])), lastErrorAt: e.last, info: access.get(shopId),
    usage, payments, users, logs: await adminLogs({ shopId, filter, limit: 300 }),
  };
}

export async function adminLogs(o: { shopId?: string; filter?: string; days?: number; search?: string; limit?: number }) {
  const where: string[] = ['l.at > NOW() - INTERVAL ? DAY']; const params: unknown[] = [o.days ?? 30];
  if (o.shopId) { where.push('l.shop_id = ?'); params.push(o.shopId); }
  if (o.filter === 'problems') where.push("l.level IN ('error','warn')");
  else if (o.filter === 'error') where.push("l.level = 'error'");
  else if (o.filter === 'warn') where.push("l.level = 'warn'");
  else if (o.filter === 'orders') where.push("l.source = 'Commandes'");
  else if (o.filter === 'logins') where.push("l.source = 'Compte'");
  if (o.search) { where.push('(l.message LIKE ? OR s.name LIKE ?)'); params.push(`%${o.search}%`, `%${o.search}%`); }
  params.push(Math.min(o.limit ?? 200, 1000));
  return q(`SELECT l.id, l.shop_id AS shopId, s.name AS shopName, l.at, l.level, l.source, l.message, l.detail
      FROM shop_logs l LEFT JOIN shops s ON s.id = l.shop_id WHERE ${where.join(' AND ')} ORDER BY l.at DESC, l.id DESC LIMIT ?`, params);
}

export async function adminLogStats(days: number) {
  const rows = await q<{ level: string; n: number; shops: number }>('SELECT level, COUNT(*) AS n, COUNT(DISTINCT shop_id) AS shops FROM shop_logs WHERE at > NOW() - INTERVAL ? DAY GROUP BY level', [days]);
  const by = Object.fromEntries(rows.map((r) => [r.level, { n: Number(r.n), shops: Number(r.shops) }]));
  let disconnected = 0, messengerOff = 0;
  for (const id of allShopIds()) runInShop(id, () => {
    if (state.selectedPageId && !state.userTokenEnc) disconnected++;
    if (state.selectedPageId && state.subscription && !state.subscription.active) messengerOff++;
  });
  return { errors: by.error ?? { n: 0, shops: 0 }, warnings: by.warn ?? { n: 0, shops: 0 }, disconnected, messengerOff };
}

export async function adminPayments() {
  return q(`SELECT p.id, p.shop_id AS shopId, s.name AS shopName, p.method, p.reference, p.amount_mga AS amountMga, p.months, p.paid_until AS paidUntil, p.created_at AS createdAt
    FROM payments p LEFT JOIN shops s ON s.id = p.shop_id ORDER BY p.created_at DESC LIMIT 500`);
}

/** Enregistre un paiement (ou une période offerte) et ouvre le compte jusqu'à la nouvelle date. */
export async function activate(shopId: string, adminId: string, body: { method?: string; reference?: string; amountMga?: number; months?: number }) {
  const method = PAY_METHODS.find((m) => m === body.method);
  if (!method) throw new Error('Choisissez le moyen de paiement');
  const months = Math.round(Number(body.months));
  if (![1, 3, 6, 12].includes(months)) throw new Error('Durée invalide');
  const reference = String(body.reference ?? '').trim().slice(0, 120);
  if (method !== 'Offert' && reference.length < 3) throw new Error('Indiquez la référence de la transaction');
  const amount = Math.max(0, Math.round(Number(body.amountMga) || 0));
  const [shop] = await q<{ name: string; paid_until: Date | null }>('SELECT name, paid_until FROM shops WHERE id = ?', [shopId]);
  if (!shop) throw new Error('Compte introuvable');
  const from = shop.paid_until && shop.paid_until.getTime() > Date.now() ? new Date(shop.paid_until) : new Date();
  const until = new Date(from); until.setMonth(until.getMonth() + months);
  await q('INSERT INTO payments (shop_id, method, reference, amount_mga, months, paid_until, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [shopId, method, reference || null, amount, months, until, adminId]);
  await q("UPDATE shops SET status = 'active', paid_until = ?, suspend_reason = NULL, suspend_message = NULL WHERE id = ?", [until, shopId]);
  await reloadAccess(shopId);
  if (allShopIds().includes(shopId)) runInShop(shopId, () => log('info', `Compte activé jusqu’au ${until.toLocaleDateString('fr-FR')} (paiement ${method}${reference ? ' ' + reference : ''}).`));
  return { paidUntil: until };
}

export async function suspend(shopId: string, adminShopId: string, body: { reason?: string; message?: string }) {
  if (shopId === adminShopId) throw new Error('Vous ne pouvez pas suspendre votre propre boutique');
  const reason = SUSPEND_REASONS.includes(String(body.reason)) ? String(body.reason) : 'Autre';
  const message = String(body.message ?? '').trim().slice(0, 400) || null;
  await q("UPDATE shops SET status = 'suspended', suspend_reason = ?, suspend_message = ? WHERE id = ?", [reason, message, shopId]);
  await reloadAccess(shopId);
  if (allShopIds().includes(shopId)) runInShop(shopId, () => log('warn', `Compte suspendu : ${reason}${message ? ' — ' + message : ''}`));
}

/** Lève une suspension sans nouveau paiement (le compte reprend sa date de fin d'abonnement). */
export async function unsuspend(shopId: string) {
  await q("UPDATE shops SET status = 'active', suspend_reason = NULL, suspend_message = NULL WHERE id = ? AND status = 'suspended'", [shopId]);
  await reloadAccess(shopId);
  if (allShopIds().includes(shopId)) runInShop(shopId, () => log('info', 'Suspension levée.'));
}
