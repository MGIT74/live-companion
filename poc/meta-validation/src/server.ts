import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { formatProductComment, parseOrder } from '@live-companion/order-parser';
import { config, SCOPES } from './config.ts';
import { encrypt } from './crypto.ts';
import { bus, emit, log } from './bus.ts';
import { saveEvidence } from './evidence.ts';
import { graph, GraphError, selectedPage, userToken } from './graph.ts';
import { ingestionStats, ingestionStatus, pollOnce, reparseComments, startPolling, startSse, stopPolling, stopSse } from './ingestion.ts';
import { handleParsed, parseOptions, resolveIntent, stockSnapshot, findProduct } from './reservations.ts';
import { sendManualMessage, sendPrivateReplyForIntent, sendSecondPrivateReply } from './messenger.ts';
import { receiveWebhook, verifyWebhook } from './webhooks.ts';
import { deleteProduct, moveProduct, removeProductPhoto, saveProduct, setProductPhoto } from './catalog.ts';
import { checkSubscription, ensureSubscription } from './subscription.ts';
import { allShopIds, archiveSession, currentShopId, flushAll, listSessions, loadShops, persist, recordTest, resetLiveData, runInShop, sessionSnapshot, shopForPage, state, TESTS, type TestStatus } from './store.ts';
import { changePassword, clearSession, login, requireAccount, signup, updateProfile, usersCount } from './accounts.ts';
import { migrate } from './db.ts';
import { liveDetail, livesHistory, periodStats } from './stats.ts';

const app = express();
app.set('trust proxy', true);

// ---------------------------------------------------------------- Webhooks (publics, signés)
app.get('/webhooks/meta', verifyWebhook);
app.post('/webhooks/meta', express.raw({ type: '*/*', limit: '2mb' }), receiveWebhook);
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------- OAuth callback (protégé par "state")
/** Jeton anti-falsification OAuth → boutique qui a lancé la connexion Facebook. */
const oauthStates = new Map<string, string>();
const redirectUri = () => `${config.baseUrl}/auth/callback`;

app.get('/auth/callback', async (req, res) => {
  const { code, state: st, error_description } = req.query as Record<string, string>;
  if (error_description) return res.status(400).send(`Connexion refusée : ${error_description}`);
  const shopId = st ? oauthStates.get(st) : undefined;
  if (!shopId) return res.status(400).send('Paramètre state invalide. Relancez la connexion.');
  oauthStates.delete(st);
  return runInShop(shopId, () => oauthCallback(code, res));
});

async function oauthCallback(code: string, res: Response) {
  try {
    // 1. code → jeton utilisateur court
    const short = await graph<{ access_token: string }>('GET', 'oauth/access_token', '', {
      client_id: config.appId, client_secret: config.appSecret, redirect_uri: redirectUri(), code,
    });
    // 2. jeton court → jeton longue durée (~60 j). Les jetons de Page obtenus avec lui n'expirent pas.
    const long = await graph<{ access_token: string; expires_in?: number }>('GET', 'oauth/access_token', '', {
      grant_type: 'fb_exchange_token', client_id: config.appId, client_secret: config.appSecret, fb_exchange_token: short.access_token,
    });
    state.userTokenEnc = encrypt(long.access_token);
    const f1 = saveEvidence('T1', 'oauth_long_lived', { expires_in: long.expires_in, token_type: 'user' });
    recordTest('T1', { status: 'OK', evidenceFile: f1, note: `Jeton utilisateur longue durée obtenu (expire dans ${long.expires_in ?? '?'} s), stocké chiffré.` });

    // 3. permissions + Pages (T2)
    const perms = await graph<{ data: { permission: string; status: string }[] }>('GET', 'me/permissions', long.access_token);
    const accounts = await graph<{ data: { id: string; name: string; access_token: string; tasks?: string[] }[] }>('GET', 'me/accounts', long.access_token, {
      fields: 'id,name,access_token,tasks', limit: 100,
    });
    state.grantedScopes = perms.data;
    state.pages = accounts.data.map((p) => ({ id: p.id, name: p.name, tasks: p.tasks, tokenEnc: encrypt(p.access_token) }));
    if (!state.selectedPageId && state.pages.length === 1 && !shopForPage(state.pages[0].id)) state.selectedPageId = state.pages[0].id;
    const missing = SCOPES.filter((s) => !perms.data.some((p) => p.permission === s && p.status === 'granted'));
    const f2 = saveEvidence('T2', 'permissions_and_pages', { permissions: perms.data, pages: accounts.data.map(({ access_token, ...p }) => p) });
    recordTest('T2', {
      status: missing.length === 0 && state.pages.length > 0 ? 'OK' : 'PARTIEL',
      evidenceFile: f2,
      note: `${state.pages.length} Page(s). ${missing.length ? 'Permissions manquantes : ' + missing.join(', ') : 'Toutes les permissions demandées sont accordées.'}`,
    });
    persist();
    log('info', `Connexion Facebook OK : ${state.pages.length} Page(s).`);
    if (state.selectedPageId) await ensureSubscription(); // Messenger activé sans bouton à cliquer
    res.redirect('/');
  } catch (e: any) {
    log('error', `OAuth : ${e.message}`);
    recordTest('T1', { status: 'KO', note: e.message });
    res.status(500).send(`Erreur OAuth : ${e.message}`);
  }
}

// ---------------------------------------------------------------- Comptes (pages publiques)
// Photos produits : publiques (noms aléatoires) pour pouvoir les envoyer aux clients plus tard.
app.use('/photos', express.static(config.photosDir, { maxAge: '7d', fallthrough: false }));
app.use(express.json({ limit: '6mb' }));

const pub = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
  try { res.json((await fn(req, res)) ?? { ok: true }); } catch (e: any) { res.status(400).json({ error: e.message }); }
};
app.get('/connexion', (_req, res) => res.sendFile('login.html', { root: config.publicDir }));
app.get('/compte/etat', pub(async () => ({ firstAccount: (await usersCount()) === 0, allowSignup: config.allowSignup })));
app.post('/compte/inscription', pub((req, res) => signup(res, req.body)));
app.post('/compte/connexion', pub((req, res) => login(res, req.body)));
app.post('/compte/deconnexion', (_req, res) => { clearSession(res); res.json({ ok: true }); });

// ---------------------------------------------------------------- Tableau de bord (compte requis, dans le contexte de sa boutique)
app.get(['/', '/index.html'], requireAccount({ page: true }), (_req, res) => res.sendFile('index.html', { root: config.publicDir }));
app.use(express.static(config.publicDir, { index: false }));
app.use(['/api', '/events', '/auth/login', '/report.md'], requireAccount());

app.get('/auth/login', (_req, res) => {
  const st = crypto.randomBytes(16).toString('hex');
  oauthStates.set(st, currentShopId()!);
  setTimeout(() => oauthStates.delete(st), 15 * 60_000).unref();
  const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', st);
  url.searchParams.set('response_type', 'code');
  if (config.loginConfigId) url.searchParams.set('config_id', config.loginConfigId);
  else url.searchParams.set('scope', SCOPES.join(','));
  res.redirect(url.toString());
});

// Flux d'événements vers le tableau de bord
app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const shopId = currentShopId();
  const onEvent = (e: { shopId?: string }) => { if (e.shopId === shopId) res.write(`data: ${JSON.stringify(e)}\n\n`); };
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { bus.off('event', onEvent); clearInterval(ping); });
});

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e: any) {
    const status = e instanceof GraphError ? 502 : 400;
    res.status(status).json({ error: e.message, meta: e instanceof GraphError ? e.body : undefined });
  }
};

app.get('/api/state', wrap(() => ({
  connected: Boolean(state.userTokenEnc),
  scopes: state.grantedScopes,
  pages: state.pages.map(({ tokenEnc, ...p }) => p),
  selectedPageId: state.selectedPageId,
  activeLive: state.activeLive,
  products: state.products,
  stock: stockSnapshot(),
  comments: Object.values(state.comments).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).slice(-300),
  intents: state.intents.slice(-300),
  productComments: state.productComments,
  conversations: Object.values(state.conversations),
  tests: Object.entries(TESTS).map(([id, label]) => ({ id, label, ...state.tests[id] })),
  settings: state.settings,
  subscription: state.subscription,
  ingestion: { ...ingestionStatus(), stats: ingestionStats() },
  webhookUrl: `${config.baseUrl}/webhooks/meta`,
  redirectUri: redirectUri(),
})));

app.post('/api/pages/select', wrap((req) => {
  if (!state.pages.some((p) => p.id === req.body.pageId)) throw new Error('Page inconnue');
  const owner = shopForPage(req.body.pageId);
  if (owner && owner !== currentShopId()) throw new Error('Cette Page est déjà reliée à une autre boutique Live Companion.');
  state.selectedPageId = req.body.pageId;
  persist();
  return ensureSubscription();
}));

// Abonne la Page aux webhooks de l'app (messages, postbacks, feed)
app.post('/api/pages/subscribe', wrap(async () => {
  const s = await ensureSubscription(true);
  saveEvidence('T10', 'page_subscribed_apps', s);
  if (!s.active) throw new Error(`Activation impossible : ${s.error ?? 'champs manquants ' + s.missing.join(', ')}`);
  return s;
}));
// Vérifie l'abonnement (et le refait s'il a été perdu)
app.post('/api/pages/subscription/check', wrap(() => ensureSubscription()));

// T3 — live actif
app.get('/api/lives', wrap(async () => {
  const page = selectedPage();
  void ensureSubscription(); // avant un live : Messenger doit être actif
  const res = await graph<{ data: any[] }>('GET', `${page.id}/live_videos`, page.token, {
    broadcast_status: '["LIVE"]', fields: 'id,title,status,video{id},permalink_url,creation_time',
  });
  const file = saveEvidence('T3', 'live_videos', res);
  recordTest('T3', {
    status: res.data.length ? 'OK' : undefined,
    evidenceFile: file,
    note: res.data.length ? `${res.data.length} live(s) actif(s) détecté(s).` : 'Aucun live actif au moment de l’appel.',
  });
  if (res.data.length === 1 && !state.activeLive) {
    state.activeLive = { id: res.data[0].id, videoId: res.data[0].video?.id, title: res.data[0].title };
    persist();
  }
  return res;
}));

// Repli sans live : dernières publications de la Page (les tests T4, T6–T10 marchent aussi sur un post)
app.get('/api/posts', wrap(async () => {
  const page = selectedPage();
  return graph<{ data: any[] }>('GET', `${page.id}/posts`, page.token, {
    fields: 'id,message,created_time,permalink_url', limit: 5,
  });
}));

app.post('/api/lives/select', wrap((req) => {
  const { id, videoId, title } = req.body;
  if (!id) throw new Error('id requis');
  state.activeLive = { id, videoId, title };
  persist();
  return state.activeLive;
}));

// T4 / T5 — ingestion
const targetId = (which?: string) => {
  if (!state.activeLive) throw new Error('Sélectionnez d’abord un live.');
  return which === 'video' && state.activeLive.videoId ? state.activeLive.videoId : state.activeLive.id;
};
app.post('/api/ingestion/poll/once', wrap((req) => pollOnce(targetId(req.body.target))));
app.post('/api/ingestion/poll/start', wrap((req) => startPolling(targetId(req.body.target), Number(req.body.intervalMs) || 5000)));
app.post('/api/ingestion/poll/stop', wrap(() => stopPolling()));
app.post('/api/ingestion/sse/start', wrap((req) => startSse(targetId(req.body.target))));
app.post('/api/ingestion/sse/stop', wrap(() => stopSse()));
// Statistiques et lives passés
app.get('/api/stats', wrap((req) => {
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 30 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new Error('Période invalide');
  if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new Error('Période trop longue (400 jours maximum)');
  return periodStats(from, to, Number(req.query.tz ?? 0) || 0);
}));
app.get('/api/lives/history', wrap(() => livesHistory()));
app.get('/api/lives/history/:id', wrap((req) => liveDetail(req.params.id)));

// Mon compte
app.get('/api/me', wrap((req) => req.account));
app.post('/api/me', wrap((req) => updateProfile(req.account!, req.body)));
app.post('/api/me/password', wrap((req) => changePassword(req.account!, req.body)));
// Déconnecter Facebook : oublie les jetons et la Page de cette boutique (produits et sessions gardés)
app.post('/api/facebook/disconnect', wrap(() => {
  stopPolling(); stopSse();
  state.userTokenEnc = undefined; state.grantedScopes = undefined; state.pages = []; state.selectedPageId = undefined;
  state.subscription = undefined; state.activeLive = undefined;
  persist();
  log('info', 'Facebook déconnecté pour cette boutique.');
}));

app.get('/api/ingestion/stats', wrap(() => ingestionStats()));
app.post('/api/comments/reparse', wrap(() => reparseComments()));

// Catalogue : ajout, modification, suppression, ordre de passage
app.post('/api/products', wrap((req) => saveProduct(req.body)));
app.post('/api/products/:code/delete', wrap((req) => { deleteProduct(req.params.code); }));
app.post('/api/products/:code/photo', wrap((req) => setProductPhoto(req.params.code, req.body.dataUrl)));
app.post('/api/products/:code/photo/delete', wrap((req) => removeProductPhoto(req.params.code)));
app.post('/api/products/:code/move', wrap((req) => { moveProduct(req.params.code, req.body.dir === 'up' ? 'up' : 'down'); }));

// Produits / commentaire produit
app.get('/api/products/:code/comment', wrap((req) => {
  const p = findProduct(req.params.code);
  if (!p) throw new Error('Produit inconnu');
  return { text: formatProductComment(p) };
}));

// T6 — publication au nom de la Page (sur l'id du live, puis sur l'id vidéo en repli)
app.post('/api/products/:code/publish', wrap(async (req) => {
  const p = findProduct(req.params.code);
  if (!p) throw new Error('Produit inconnu');
  if (!state.activeLive) throw new Error('Sélectionnez d’abord un live.');
  const page = selectedPage();
  const message = formatProductComment(p);
  const targets = [state.activeLive.id, state.activeLive.videoId].filter(Boolean) as string[];
  const attempts: any[] = [];
  for (const objectId of targets) {
    try {
      const res = await graph<{ id: string }>('POST', `${objectId}/comments`, page.token, {}, { message });
      attempts.push({ objectId, ok: true, res });
      state.productComments.push({ commentId: res.id, code: p.code, liveVideoId: state.activeLive.id, objectId, at: new Date().toISOString() });
      persist();
      const file = saveEvidence('T6', `publish_${p.code}`, { attempts });
      recordTest('T6', { status: 'OK', evidenceFile: file, note: `Commentaire ${p.code} publié via l’objet ${objectId === state.activeLive.id ? 'live_video' : 'video'}. Vérifier qu’il apparaît dans le live, signé par la Page.` });
      emit('productComment', state.productComments.at(-1));
      return { commentId: res.id, objectId, attempts };
    } catch (e: any) {
      attempts.push({ objectId, ok: false, error: e.body ?? e.message });
    }
  }
  const file = saveEvidence('T6', `publish_failed_${p.code}`, { attempts });
  recordTest('T6', { status: 'KO', evidenceFile: file, note: 'Publication refusée sur live_video et video. Repli : copier-coller manuel.' });
  throw new Error(`Publication impossible : ${attempts.map((a) => a.error?.error?.message ?? a.error).join(' | ')}`);
}));

// Commentaire produit publié à la main : l'assistant colle son id (ou l'URL) pour activer les "+1" en réponse.
app.post('/api/products/:code/register-comment', wrap((req) => {
  const p = findProduct(req.params.code);
  if (!p || !state.activeLive) throw new Error('Produit ou live manquant');
  const raw = String(req.body.commentId ?? '').trim();
  const commentId = raw.match(/comment_id=(\d+)/)?.[1] ? `${state.activeLive.videoId ?? state.activeLive.id}_${raw.match(/comment_id=(\d+)/)![1]}` : raw;
  if (!commentId) throw new Error('Identifiant de commentaire requis');
  state.productComments.push({ commentId, code: p.code, liveVideoId: state.activeLive.id, objectId: 'manual', at: new Date().toISOString() });
  persist();
  return state.productComments.at(-1);
}));

// T7 — analyse des parents des réponses
app.post('/api/report/parents', wrap(() => {
  const comments = Object.values(state.comments);
  const productIds = new Set(state.productComments.map((p) => p.commentId));
  const plusReplies = comments.filter((c) => parseOrder(c.parsedText ?? c.message, parseOptions()).type === 'plus');
  const rows = plusReplies.map((c) => ({
    id: c.id, message: c.message, parentId: c.parentId ?? null, sources: c.sources,
    parentIsProductComment: c.parentId ? productIds.has(c.parentId) : false,
  }));
  const matched = rows.filter((r) => r.parentIsProductComment).length;
  const bySource = (['SSE', 'POLL', 'WEBHOOK'] as const).map((s) => ({
    source: s,
    total: plusReplies.filter((c) => c.sources.includes(s)).length,
  }));
  const result = { productComments: state.productComments, plusReplies: rows.length, matched, bySource, rows };
  const file = saveEvidence('T7', 'parents_report', result);
  recordTest('T7', {
    status: rows.length === 0 ? undefined : matched === rows.length ? 'OK' : matched > 0 ? 'PARTIEL' : 'KO',
    evidenceFile: file,
    note: `${matched}/${rows.length} réponses "+1" reliées à un commentaire produit via leur parent.`,
  });
  return result;
}));

// T8 — parseur
app.get('/api/parser', wrap((req) => parseOrder(String(req.query.text ?? ''), parseOptions())));
app.post('/api/report/parser', wrap(() => {
  const comments = Object.values(state.comments);
  const result = comments.map((c) => ({ message: c.message, parsed: parseOrder(c.parsedText ?? c.message, parseOptions()), intent: state.intents.find((i) => i.id === c.intentId)?.status }));
  const file = saveEvidence('T8', 'parser_on_live_comments', result);
  recordTest('T8', { evidenceFile: file, note: `${result.length} commentaires analysés. Vérifier à la main les faux positifs/négatifs puis marquer OK/KO.` });
  return result;
}));

// Intentions / réservations
app.post('/api/intents/manual', wrap((req) => {
  if (!state.activeLive) throw new Error('Sélectionnez d’abord un live (ou saisissez un id quelconque).');
  const text = String(req.body.text ?? '');
  const parsed = parseOrder(text, parseOptions());
  const intent = handleParsed(undefined, state.activeLive.id, text, parsed, 'MANUAL');
  if (intent && req.body.name) { intent.authorName = req.body.name; persist(); }
  return intent ?? { info: 'Aucune commande reconnue', parsed };
}));
app.post('/api/intents/:id/resolve', wrap((req) => resolveIntent(req.params.id, req.body.action, req.body)));
app.post('/api/intents/:id/private-reply', wrap((req) => sendPrivateReplyForIntent(req.params.id)));
app.post('/api/comments/:id/second-reply', wrap((req) => sendSecondPrivateReply(req.params.id)));

// Messenger
app.post('/api/conversations/:psid/message', wrap((req) => sendManualMessage(req.params.psid, String(req.body.text ?? ''))));

// Résultats de tests saisis par l'opérateur
app.post('/api/tests/:id', wrap((req) => {
  if (!TESTS[req.params.id]) throw new Error('Test inconnu');
  recordTest(req.params.id, { status: req.body.status as TestStatus, note: req.body.note });
  return state.tests[req.params.id];
}));

app.post('/api/settings', wrap((req) => {
  if (typeof req.body.autoPrivateReply === 'boolean') state.settings.autoPrivateReply = req.body.autoPrivateReply;
  persist();
  return state.settings;
}));

app.post('/api/reset-live', wrap(() => { stopPolling(); stopSse(); resetLiveData(); state.activeLive = undefined; persist(); }));

// Nouvelle session : archive la session en cours puis repart à zéro (connexion Facebook et tests conservés)
app.post('/api/sessions/new', wrap(async (req) => {
  const summary = await archiveSession(String(req.body.name ?? '').slice(0, 80));
  stopPolling(); stopSse(); resetLiveData({ commitSales: true }); state.activeLive = undefined; persist();
  log('info', `Session « ${summary.name} » archivée (${summary.comments} commentaires, ${summary.intents} réservations). Nouvelle session prête.`);
  return summary;
}));
app.get('/api/sessions', wrap(() => listSessions()));
app.get('/api/sessions/:id/download', async (req, res) => {
  const snap = await sessionSnapshot(req.params.id);
  if (!snap) return res.status(404).json({ error: 'Session introuvable' });
  res.setHeader('Content-Disposition', `attachment; filename="live-companion-session-${req.params.id.replace(/[^\w-]/g, '')}.json"`);
  res.type('application/json').send(snap);
});

// Rapport Markdown à coller dans docs/meta-capabilities.md
app.get('/report.md', (_req, res) => {
  const label: Record<string, string> = { A_TESTER: 'À tester', OK: 'Testé OK', KO: 'Testé KO', PARTIEL: 'Partiel' };
  const s = ingestionStats();
  const lines = [
    `# Résultats PoC Meta — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Graph API ${config.graphVersion} · Page : ${state.pages.find((p) => p.id === state.selectedPageId)?.name ?? '—'}`,
    '',
    '| # | Test | Résultat | Note | Preuves |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(TESTS).map(([id, name]) => {
      const t = state.tests[id];
      return `| ${id} | ${name} | ${label[t.status]} | ${(t.note || '').replace(/\|/g, '/')} | ${t.evidence.length} |`;
    }),
    '',
    '## Ingestion',
    '',
    `- Commentaires uniques : ${s.total}`,
    `- SSE : ${s.SSE.received} reçus, ${s.SSE.new} nouveaux, from présent ${s.SSE.withFrom}, parent présent ${s.SSE.withParent}, latence médiane ${s.SSE.medianLatencyMs ?? '—'} ms`,
    `- Polling : ${s.POLL.received} reçus, ${s.POLL.new} nouveaux, from présent ${s.POLL.withFrom}, parent présent ${s.POLL.withParent}`,
    `- Webhook : ${s.WEBHOOK.received} reçus, ${s.WEBHOOK.new} nouveaux, parent présent ${s.WEBHOOK.withParent}`,
  ];
  res.type('text/markdown').send(lines.join('\n'));
});

await migrate();
await loadShops();
for (const id of allShopIds()) {
  // Vérification Messenger au démarrage, boutique par boutique.
  runInShop(id, () => { if (state.selectedPageId && state.pages.length) void ensureSubscription(); });
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { flushAll().finally(() => process.exit(0)); });

app.listen(config.port, () => {
  log('info', `PoC Live Companion sur http://localhost:${config.port} (public : ${config.baseUrl})`);
  log('info', `URL de redirection OAuth à déclarer chez Meta : ${redirectUri()}`);
  log('info', `URL de webhook à déclarer chez Meta : ${config.baseUrl}/webhooks/meta`);
});
