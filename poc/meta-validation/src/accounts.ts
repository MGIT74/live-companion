import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.ts';
import { q } from './db.ts';
import { log } from './bus.ts';
import { isLocked, reloadAccess } from './platform.ts';
import { createShopState, importLegacySessions, legacyState, newState, retireLegacyState, runInShop } from './store.ts';

/**
 * Comptes vendeurs : e-mail + mot de passe, une boutique par compte (le propriétaire),
 * connexion gardée dans un cookie signé (30 jours).
 */
export interface Account { id: string; email: string; fullName: string; shopId: string; shopName: string; role: string; isAdmin: boolean; ownShopId: string; impersonating?: boolean }

const COOKIE = 'lc_session';
const MAX_AGE_S = 30 * 24 * 3600;
const newId = () => crypto.randomBytes(12).toString('hex');
const sessionKey = () => crypto.createHmac('sha256', Buffer.from(config.encryptionKey, 'hex')).update('lc-session-v1').digest();

// ---------------------------------------------------------------- Mots de passe (scrypt)
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function checkPassword(password: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(got, expected);
}

// ---------------------------------------------------------------- Cookie de session signé
function sign(userId: string, issuedAt: number) {
  const body = `${userId}.${issuedAt}`;
  return `${body}.${crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url')}`;
}
function readCookie(req: Request, name: string) {
  const raw = req.header('cookie') ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
function verify(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const [userId, issued, sig] = token.split('.');
  if (!userId || !issued || !sig) return undefined;
  const expected = crypto.createHmac('sha256', sessionKey()).update(`${userId}.${issued}`).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return undefined;
  if (Date.now() / 1000 - Number(issued) > MAX_AGE_S) return undefined;
  return userId;
}
function setSession(res: Response, userId: string) {
  const secure = config.baseUrl.startsWith('https://') ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(sign(userId, Math.floor(Date.now() / 1000)))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure}`);
}
export function clearSession(res: Response) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.append('Set-Cookie', 'lc_as=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

export async function loadAccount(userId: string): Promise<Account | undefined> {
  const rows = await q<{ id: string; email: string; full_name: string; shop_id: string; shop_name: string; role: string; is_admin: number }>(
    `SELECT u.id, u.email, u.full_name, u.is_admin, m.shop_id, s.name AS shop_name, m.role
       FROM users u JOIN shop_members m ON m.user_id = u.id JOIN shops s ON s.id = m.shop_id
      WHERE u.id = ? ORDER BY m.created_at LIMIT 1`, [userId]);
  const r = rows[0];
  return r && { id: r.id, email: r.email, fullName: r.full_name, shopId: r.shop_id, shopName: r.shop_name, role: r.role, isAdmin: Boolean(r.is_admin), ownShopId: r.shop_id };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { account?: Account } }
}

/** Middleware : charge le compte, puis exécute la suite DANS le contexte de sa boutique. */
export function requireAccount(opts: { page?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = verify(readCookie(req, COOKIE));
    const account = userId ? await loadAccount(userId).catch(() => undefined) : undefined;
    if (!account) {
      if (opts.page) return res.redirect('/connexion');
      return res.status(401).json({ error: 'Session expirée : reconnectez-vous.', login: true });
    }
    // Super admin qui regarde l'espace d'un vendeur (« Voir son espace »)
    const as = account.isAdmin ? verifyAs(readCookie(req, AS_COOKIE), account.id) : undefined;
    if (as && as !== account.shopId) {
      const [s] = await q<{ name: string }>('SELECT name FROM shops WHERE id = ?', [as]).catch(() => []);
      if (s) { account.shopId = as; account.shopName = s.name; account.impersonating = true; account.role = 'OWNER'; }
    }
    req.account = account;
    runInShop(account.shopId, () => next());
  };
}

/** Bloque l'application tant que le compte n'est pas payé (sauf profil, statut et déconnexion). */
const OPEN_WHEN_LOCKED = new Set(['/api/me', '/api/access', '/events']);
export function requireActive(req: Request, res: Response, next: NextFunction) {
  const a = req.account;
  if (!a || a.isAdmin || !isLocked(a.shopId) || OPEN_WHEN_LOCKED.has(req.baseUrl + req.path) || OPEN_WHEN_LOCKED.has(req.originalUrl.split('?')[0])) return next();
  res.status(423).json({ error: 'Compte non activé', locked: true });
}

// ---------------------------------------------------------------- « Voir son espace » (super admin)
const AS_COOKIE = 'lc_as';
function verifyAs(token: string | undefined, adminId: string) {
  if (!token) return undefined;
  const [shopId, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', sessionKey()).update(`as.${adminId}.${shopId}`).digest('base64url');
  return sig && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? shopId : undefined;
}
export function startImpersonation(res: Response, adminId: string, shopId: string) {
  const sig = crypto.createHmac('sha256', sessionKey()).update(`as.${adminId}.${shopId}`).digest('base64url');
  const secure = config.baseUrl.startsWith('https://') ? '; Secure' : '';
  res.append('Set-Cookie', `${AS_COOKIE}=${shopId}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${8 * 3600}${secure}`);
}
export function stopImpersonation(res: Response) {
  res.append('Set-Cookie', `${AS_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function usersCount() {
  const [r] = await q<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  return Number(r.n);
}

// ---------------------------------------------------------------- Inscription / connexion
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signup(res: Response, body: { fullName?: string; email?: string; password?: string; shopName?: string; accessCode?: string }) {
  const fullName = String(body.fullName ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const shopName = String(body.shopName ?? '').trim();
  if (fullName.length < 2) throw new Error('Indiquez votre nom');
  if (!EMAIL_RE.test(email)) throw new Error('Adresse e-mail invalide');
  if (password.length < 8) throw new Error('Mot de passe : 8 caractères minimum');
  if (shopName.length < 2) throw new Error('Indiquez le nom de votre boutique');

  const first = (await usersCount()) === 0;
  if (first) {
    // Le tout premier compte récupère les données existantes : il doit connaître le code d'accès actuel.
    if (String(body.accessCode ?? '') !== config.dashboardPassword) throw new Error('Code d’accès incorrect (c’est l’ancien mot de passe du tableau de bord)');
  } else if (!config.allowSignup) {
    throw new Error('Les inscriptions sont fermées pour le moment');
  }
  const exists = await q('SELECT id FROM users WHERE email = ?', [email]);
  if (exists.length) throw new Error('Un compte existe déjà avec cet e-mail');

  const userId = newId();
  const shopId = newId();
  const legacy = first ? legacyState() : undefined;
  await q('INSERT INTO users (id, email, password_hash, full_name, is_admin) VALUES (?, ?, ?, ?, ?)', [userId, email, hashPassword(password), fullName.slice(0, 120), first ? 1 : 0]);
  // Le tout premier compte (propriétaire de la plateforme) est actif et super admin ; les autres attendent leur paiement.
  await q('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)', [shopId, shopName.slice(0, 120), first ? 'active' : 'pending']);
  await q('INSERT INTO shop_members (shop_id, user_id, role) VALUES (?, ?, ?)', [shopId, userId, 'OWNER']);
  await createShopState(shopId, legacy ?? newState());
  await reloadAccess(shopId);
  runInShop(shopId, () => log('info', `Compte créé : ${fullName} (${email})`));
  if (legacy) {
    const n = await importLegacySessions(shopId);
    retireLegacyState();
    runInShop(shopId, () => log('info', `Données existantes reprises dans la boutique « ${shopName} » (${legacy.products.length} produits, ${n} sessions archivées).`));
  }
  setSession(res, userId);
  return loadAccount(userId);
}

export async function login(res: Response, body: { email?: string; password?: string }, req?: Request) {
  const email = String(body.email ?? '').trim().toLowerCase();
  const rows = await q<{ id: string; password_hash: string }>('SELECT id, password_hash FROM users WHERE email = ?', [email]);
  const u = rows[0];
  if (!u || !checkPassword(String(body.password ?? ''), u.password_hash)) {
    await new Promise((r) => setTimeout(r, 400)); // ralentit les essais en série
    throw new Error('E-mail ou mot de passe incorrect');
  }
  setSession(res, u.id);
  stopImpersonation(res);
  await q('UPDATE users SET last_login_at = NOW() WHERE id = ?', [u.id]);
  const account = await loadAccount(u.id);
  if (account) runInShop(account.shopId, () => log('info', `Connexion de ${account.fullName}${req ? ' · ' + describeClient(req) : ''}`));
  return account;
}
function describeClient(req: Request) {
  const ua = String(req.header('user-agent') ?? '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'navigateur';
  const device = /Mobi|Android|iPhone/i.test(ua) ? 'téléphone' : 'ordinateur';
  return `${browser} sur ${device}`;
}

// ---------------------------------------------------------------- Profil
export async function updateProfile(account: Account, body: { fullName?: string; email?: string; shopName?: string }) {
  const fullName = body.fullName !== undefined ? String(body.fullName).trim() : account.fullName;
  const email = body.email !== undefined ? String(body.email).trim().toLowerCase() : account.email;
  const shopName = body.shopName !== undefined ? String(body.shopName).trim() : account.shopName;
  if (fullName.length < 2) throw new Error('Indiquez votre nom');
  if (!EMAIL_RE.test(email)) throw new Error('Adresse e-mail invalide');
  if (shopName.length < 2) throw new Error('Indiquez le nom de votre boutique');
  if (email !== account.email && (await q('SELECT id FROM users WHERE email = ? AND id <> ?', [email, account.id])).length) throw new Error('Cet e-mail est déjà utilisé');
  await q('UPDATE users SET full_name = ?, email = ? WHERE id = ?', [fullName.slice(0, 120), email, account.id]);
  if (account.role === 'OWNER') await q('UPDATE shops SET name = ? WHERE id = ?', [shopName.slice(0, 120), account.shopId]);
  return loadAccount(account.id);
}

export async function changePassword(account: Account, body: { current?: string; next?: string }) {
  const [u] = await q<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [account.id]);
  if (!u || !checkPassword(String(body.current ?? ''), u.password_hash)) throw new Error('Mot de passe actuel incorrect');
  if (String(body.next ?? '').length < 8) throw new Error('Nouveau mot de passe : 8 caractères minimum');
  await q('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(String(body.next)), account.id]);
}
