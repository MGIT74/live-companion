/* Super admin : comptes, paiements Mobile Money, journal, réglages. Mobile d'abord. */
const q = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mga = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' Ar';
const initials = (s) => String(s || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const dateFr = (d, y = true) => (d ? new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', ...(y ? { year: 'numeric' } : {}) }) : '—');
const timeFr = (d) => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dtFr = (d) => `${dateFr(d, false)}, ${timeFr(d)}`;
const ago = (d) => {
  if (!d) return '—';
  const s = Math.round((Date.now() - new Date(d)) / 1000);
  return s < 60 ? 'à l’instant' : s < 3600 ? `il y a ${Math.floor(s / 60)} min` : s < 86400 ? `il y a ${Math.floor(s / 3600)} h` : s < 172800 ? 'hier' : `il y a ${Math.floor(s / 86400)} j`;
};
let toastT;
function toast(msg, bad) { const el = q('#toast'); el.textContent = msg; el.className = 'toast show' + (bad ? ' bad' : ''); clearTimeout(toastT); toastT = setTimeout(() => { el.className = 'toast'; }, bad ? 5000 : 2600); }
async function call(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 401) { location.href = '/connexion'; throw new Error('Session expirée'); }
  if (r.status === 403) { location.href = '/'; throw new Error('Réservé au super admin'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Erreur');
  return j;
}

const STATUS = { active: ['c-green', 'Actif'], pending: ['c-orange', 'En attente'], suspended: ['c-red', 'Suspendu'], expired: ['c-red', 'Expiré'] };
const chip = (st) => `<span class="chip ${STATUS[st][0]}">${STATUS[st][1]}</span>`;
const LEVEL = { error: ['c-red', 'Erreur'], warn: ['c-orange', 'Alerte'], info: ['c-gray', 'Info'] };
const lvChip = (l) => `<span class="chip ${(LEVEL[l] || LEVEL.info)[0]}">${(LEVEL[l] || LEVEL.info)[1]}</span>`;
const mmKey = (m) => String(m).split(' ')[0];
const MM_TAG = { MVola: 'MV', Orange: 'OM', Airtel: 'AM', Offert: '🎁' };
const mmIcon = (m) => `<span class="mm ${mmKey(m)}">${MM_TAG[mmKey(m)] || ''}</span>`;
const until = (a) => (a.paidUntil ? (a.status === 'expired' ? `expiré le ${dateFr(a.paidUntil, false)}` : dateFr(a.paidUntil)) : a.status === 'active' ? 'Sans limite' : '—');

// ---------------------------------------------------------------- Navigation
let OV = null, accFilter = 'all', accSearch = '', CUR = null, curTab = 'logs', curFilter = 'problems', logFilter = 'error', logDays = 1, logSearch = '', CONF = null;
function route() {
  const [r, id] = location.hash.replace(/^#\/?/, '').split('/');
  const base = r === 'compte' ? 'comptes' : r || 'comptes';
  document.querySelectorAll('[data-r]').forEach((a) => { if (a.dataset.r === base) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  closeSheet();
  window.scrollTo({ top: 0 });
  if (r === 'compte' && id) return openAccount(id);
  if (base === 'paiements') return viewPayments();
  if (base === 'journal') return viewLogs();
  if (base === 'reglages') return viewSettings();
  return viewAccounts();
}
window.addEventListener('hashchange', route);
function badges(ov) {
  document.querySelectorAll('[data-badge="pending"]').forEach((b) => { b.textContent = ov.counts.pending || ''; });
  const errs = ov.accounts.reduce((a, x) => a + x.errors24h, 0);
  document.querySelectorAll('[data-badge="errors"]').forEach((b) => { b.textContent = errs || ''; });
}

// ---------------------------------------------------------------- Comptes
async function viewAccounts() {
  OV = await call('/api/admin/overview'); badges(OV);
  const c = OV.counts;
  q('#view').innerHTML = `<div style="display:flex;flex-direction:column;gap:16px">
    <div><h1>Comptes</h1><div class="sub">Toutes les boutiques inscrites sur Live Companion</div></div>
    <div class="card stats">
      <div class="stat"><span class="l">Comptes</span><span class="v">${c.all}</span><span class="h">+${c.newThisWeek} cette semaine</span></div>
      <div class="stat"><span class="l">Actifs</span><span class="v" style="color:var(--green)">${c.active}</span><span class="h">peuvent travailler</span></div>
      <div class="stat"><span class="l">En attente</span><span class="v" style="color:var(--orange)">${c.pending}</span><span class="h">à activer</span></div>
      <div class="stat"><span class="l">Suspendus</span><span class="v" style="color:var(--red)">${c.suspended}</span><span class="h">non payé ou bloqué</span></div>
      <div class="stat"><span class="l">Encaissé ce mois</span><span class="v">${mga(OV.collectedThisMonthMga)}</span><span class="h">${OV.paymentsThisMonth} paiement${OV.paymentsThisMonth > 1 ? 's' : ''}</span></div>
    </div>
    <label class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="accQ" type="search" placeholder="Boutique, nom, e-mail…" value="${esc(accSearch)}" aria-label="Rechercher un compte"></label>
    <div class="chips" role="group" aria-label="Filtrer les comptes" id="accChips">
      ${[['all', 'Tous', c.all], ['pending', 'En attente', c.pending], ['active', 'Actifs', c.active], ['suspended', 'Suspendus', c.suspended], ['soon', 'Expirent bientôt', c.soon]].map(([k, l, n]) => `<button aria-pressed="${accFilter === k}" data-k="${k}">${l} · ${n}</button>`).join('')}
    </div>
    <div class="card"><div class="ahead"><span>Boutique</span><span>Page Facebook</span><span>Statut</span><span>Payé jusqu’au</span><span>Activité</span><span>Erreurs 24h</span><span></span><span></span></div><div class="list" id="accList"></div></div>
  </div>`;
  q('#accQ').oninput = (e) => { accSearch = e.target.value; renderAccList(); };
  q('#accChips').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; accFilter = b.dataset.k; q('#accChips').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); renderAccList(); };
  renderAccList();
}
function renderAccList() {
  const s = accSearch.trim().toLowerCase();
  const list = OV.accounts.filter((a) => (accFilter === 'all' || (accFilter === 'suspended' ? ['suspended', 'expired'].includes(a.status) : accFilter === 'soon' ? a.expiresSoon : a.status === accFilter))
    && (!s || [a.name, a.ownerName, a.ownerEmail, a.pageName].some((x) => String(x || '').toLowerCase().includes(s))));
  q('#accList').innerHTML = list.map((a) => {
    const act = a.status === 'pending' ? `<button class="sm primary" data-act="activate" data-id="${esc(a.id)}">Activer</button>`
      : a.status === 'active' ? '<button class="sm">Ouvrir</button>' : `<button class="sm" data-act="${a.status === 'suspended' ? 'reactivate' : 'activate'}" data-id="${esc(a.id)}">Réactiver</button>`;
    return `<div class="acc" data-open="${esc(a.id)}" tabindex="0" role="link" aria-label="Ouvrir ${esc(a.name)}">
      <span class="sq av">${esc(initials(a.name))}</span>
      <span class="who"><span class="sq" style="display:none"></span><span style="min-width:0"><b>${esc(a.name)}</b><span class="s">${esc(a.ownerName || '—')} · ${esc(a.ownerEmail || '')}</span></span></span>
      <span class="pg">${esc(a.pageName || '—')}</span>
      <span class="st">${chip(a.status)}</span>
      <span class="until">${esc(until(a))}</span>
      <span class="last s">${ago(a.lastActivity)}</span>
      <span class="err ${a.errors24h ? 'errn' : 's'}">${a.errors24h || '—'}</span>
      <span class="meta">${a.status === 'active' ? (a.paidUntil ? `Payé jusqu’au ${esc(until(a))}` : 'Sans limite') : a.status === 'pending' ? `Inscrit ${ago(a.createdAt)}` : esc(until(a))}${a.errors24h ? ` · <span class="errn">${a.errors24h} erreur${a.errors24h > 1 ? 's' : ''}</span>` : ''}</span>
      <span class="act">${act}</span>
      <span class="chev">›</span>
    </div>`;
  }).join('') || '<div class="empty">Aucun compte.</div>';
  // Sur ordinateur, l'initiale est affichée à gauche du nom
  if (matchMedia('(min-width: 1000px)').matches) q('#accList').querySelectorAll('.who .sq').forEach((x, i) => { x.style.display = 'grid'; x.textContent = initials(list[i].name); });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) { e.stopPropagation(); const a = (OV?.accounts || []).find((x) => x.id === b.dataset.id) || CUR; if (b.dataset.act === 'activate') activateSheet(a); else reactivate(a); return; }
  const o = e.target.closest('[data-open]');
  if (o) location.hash = `#compte/${o.dataset.open}`;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
  if (e.key === 'Enter' && e.target.matches?.('[data-open]')) location.hash = `#compte/${e.target.dataset.open}`;
});

// ---------------------------------------------------------------- Fiche d'un compte
async function openAccount(id, keepTab) {
  if (!keepTab) { curTab = 'logs'; curFilter = 'problems'; }
  CUR = await call(`/api/admin/accounts/${encodeURIComponent(id)}?filter=${curFilter}`);
  const a = CUR, u = a.usage || {};
  const daysLeft = a.paidUntil ? Math.ceil((new Date(a.paidUntil) - Date.now()) / 86400000) : null;
  const acts = [];
  acts.push(`<button data-view-as="${esc(a.id)}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>Voir son espace</button>`);
  acts.push(`<button class="${a.status === 'pending' ? 'primary' : ''}" data-act="activate" data-id="${esc(a.id)}">${a.status === 'pending' ? 'Activer le compte' : 'Enregistrer un paiement'}</button>`);
  if (a.status === 'suspended') acts.push(`<button class="wide" data-act="reactivate" data-id="${esc(a.id)}">Lever la suspension</button>`);
  else acts.push(`<button class="danger wide" onclick="suspendSheet()">Suspendre</button>`);
  q('#view').innerHTML = `<div style="display:flex;flex-direction:column;gap:16px">
    <a class="btn back" href="#comptes">‹ Comptes</a>
    <div class="dhead" style="flex-wrap:wrap">
      <span class="sq">${esc(initials(a.name))}</span>
      <div style="flex:1;min-width:0"><div style="display:flex;gap:6px;flex-wrap:wrap">${chip(a.status)}${a.paidUntil ? `<span class="chip c-gray">${a.status === 'expired' ? 'Expiré le' : 'Payé jusqu’au'} ${dateFr(a.paidUntil)}</span>` : a.status === 'active' ? '<span class="chip c-gray">Sans limite</span>' : ''}</div>
        <h1>${esc(a.name)}</h1><div class="sub">${esc(a.ownerName || '')} · ${esc(a.ownerEmail || '')}<br>Inscrit le ${dateFr(a.createdAt)}${a.pageName ? ` · Page « ${esc(a.pageName)} »` : ' · Facebook pas encore connecté'}</div></div>
      <div class="dacts" style="width:100%">${acts.join('')}</div>
    </div>
    ${a.status === 'suspended' && a.reason ? `<div class="card" style="padding:12px 16px;color:var(--red)">Suspendu : ${esc(a.reason)}${a.info?.message ? ' — « ' + esc(a.info.message) + ' »' : ''}</div>` : ''}
    <div class="card stats">
      <div class="stat"><span class="l">Abonnement</span><span class="v">${daysLeft === null ? (a.status === 'active' ? 'Illimité' : '—') : daysLeft > 0 ? `${daysLeft} jour${daysLeft > 1 ? 's' : ''}` : 'Expiré'}</span><span class="h">${daysLeft !== null && daysLeft > 0 ? 'restants' : a.status === 'pending' ? 'pas encore payé' : ''}</span></div>
      <div class="stat"><span class="l">Ventes en ligne</span><span class="v">${u.sales ?? 0}</span><span class="h">${u.activeSale ? 'dont 1 en cours' : `${u.products ?? 0} produits`}</span></div>
      <div class="stat"><span class="l">Commandes</span><span class="v">${u.ordersMonth ?? 0}</span><span class="h">ce mois</span></div>
      <div class="stat"><span class="l">Chiffre traité</span><span class="v">${mga(u.revenueMonthMga)}</span><span class="h">ce mois</span></div>
      <div class="stat"><span class="l">Erreurs 24 h</span><span class="v" style="${a.errors24h ? 'color:var(--red)' : ''}">${a.errors24h}</span><span class="h">${a.lastErrorAt ? 'dernière à ' + timeFr(a.lastErrorAt) : 'aucune'}</span></div>
    </div>
    <div class="tabs" role="tablist" id="accTabs">
      ${[['logs', 'Journal', a.errors24h, 'r'], ['payments', 'Paiements', a.payments.length], ['pages', 'Pages Facebook', (u.pages || []).length], ['users', 'Utilisateurs', a.users.length]].map(([k, l, n, r]) => `<button role="tab" aria-selected="${curTab === k}" data-tab="${k}">${l} <span class="n ${r && n ? r : ''}">${n}</span></button>`).join('')}
    </div>
    <div id="accPanel"></div>
  </div>`;
  q('#accTabs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; curTab = b.dataset.tab; q('#accTabs').querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', String(x === b))); renderAccPanel(); };
  document.querySelectorAll('[data-view-as]').forEach((b) => { b.onclick = () => viewAs(b.dataset.viewAs); });
  renderAccPanel();
}
function logRow(l, withShop) {
  return `<div class="log${withShop ? ' g' : ''}" data-log="${esc(l.id)}" tabindex="0">
    <span class="at">${withShop ? timeFr(l.at) : dtFr(l.at)}</span>${withShop ? `<span class="shop">${esc(l.shopName || '—')}</span>` : ''}<span class="lv">${lvChip(l.level)}</span><span class="src">${esc(l.source)}</span><span class="msg">${esc(l.message)}</span><span class="chev">›</span></div>`;
}
let LOGS = [];
function renderAccPanel() {
  const a = CUR, u = a.usage || {}, el = q('#accPanel');
  if (curTab === 'logs') {
    LOGS = a.logs;
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px">
      <div class="chips" id="lgChips">${[['problems', 'Erreurs et alertes'], ['all', 'Tout'], ['orders', 'Commandes'], ['logins', 'Connexions']].map(([k, l]) => `<button aria-pressed="${curFilter === k}" data-f="${k}">${l}</button>`).join('')}</div>
      <div class="card list">${a.logs.map((l) => logRow(l)).join('') || '<div class="empty">Rien dans le journal sur 30 jours.</div>'}</div>
      ${a.logs.length ? '<div class="s" style="text-align:center">Touchez une ligne pour voir le détail technique (réponse de Facebook…).</div>' : ''}</div>`;
    q('#lgChips').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; curFilter = b.dataset.f; openAccount(a.id, true); };
  } else if (curTab === 'payments') {
    el.innerHTML = `<div class="card list">${a.payments.map((p) => `<div class="row2"><span style="display:flex;gap:12px;align-items:center;min-width:0">${mmIcon(p.method)}<span style="min-width:0"><b>${esc(p.method)}</b> · ${p.months} mois<br><span class="s">${dateFr(p.createdAt)}${p.reference ? ' · ' + esc(p.reference) : ''}</span></span></span><span style="text-align:right"><b>${mga(p.amountMga)}</b><br><span class="s">jusqu’au ${dateFr(p.paidUntil, false)}</span></span></div>`).join('') || '<div class="empty">Aucun paiement enregistré.</div>'}</div>`;
  } else if (curTab === 'pages') {
    el.innerHTML = `<div class="card list">${(u.pages || []).map((p) => `<div class="row2"><span><b>${esc(p.name)}</b><br><span class="s">${esc(p.id)}</span></span>${p.selected ? '<span class="chip c-green">Utilisée</span>' : ''}</div>`).join('') || '<div class="empty">Facebook n’est pas encore connecté.</div>'}
      ${u.pages?.length ? `<div class="row2"><span>Facebook</span><span class="chip ${u.facebookConnected ? 'c-green' : 'c-red'}">${u.facebookConnected ? 'Connecté' : 'Déconnecté'}</span></div><div class="row2"><span>Messenger</span><span class="chip ${u.messenger?.active ? 'c-green' : 'c-orange'}">${u.messenger?.active ? 'Actif' : 'Inactif'}</span></div>` : ''}</div>`;
  } else {
    el.innerHTML = `<div class="card list">${a.users.map((x) => `<div class="row2"><span style="display:flex;gap:12px;align-items:center;min-width:0"><span class="sq" style="width:38px;height:38px;border-radius:50%">${esc(initials(x.name))}</span><span style="min-width:0"><b>${esc(x.name)}</b><br><span class="s">${esc(x.email)}</span></span></span><span style="text-align:right"><span class="chip c-gray">${x.role === 'OWNER' ? 'Propriétaire' : 'Assistant'}</span><br><span class="s">${x.lastLoginAt ? 'vu ' + ago(x.lastLoginAt) : 'jamais connecté'}</span></span></div>`).join('')}</div>`;
  }
}
document.addEventListener('click', (e) => { const r = e.target.closest('[data-log]'); if (r) logSheet(LOGS.find((l) => String(l.id) === r.dataset.log)); });
async function viewAs(id) { await call(`/api/admin/accounts/${encodeURIComponent(id)}/view`, {}); location.href = '/'; }

// ---------------------------------------------------------------- Fenêtres (feuille du bas sur téléphone)
function openSheet(html) { q('#sheetCard').innerHTML = html; q('#sheet').hidden = false; document.body.style.overflow = 'hidden'; q('#sheetCard').querySelector('input,button')?.focus(); }
function closeSheet() { q('#sheet').hidden = true; document.body.style.overflow = ''; }
q('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

function logSheet(l) {
  if (!l) return;
  let detail = l.detail;
  try { detail = JSON.stringify(JSON.parse(l.detail), null, 2); } catch (e) {}
  openSheet(`<div style="display:flex;gap:8px;align-items:center">${lvChip(l.level)}<b>${esc(l.source)}</b><span class="s" style="margin-left:auto">${dtFr(l.at)}</span></div>
    ${l.shopName ? `<div class="s">${esc(l.shopName)}</div>` : ''}<h2 style="font-size:17px;font-weight:600">${esc(l.message)}</h2>
    ${detail ? `<pre class="detail">${esc(detail)}</pre>` : '<div class="s">Pas de détail technique pour cette ligne.</div>'}
    <div class="sheet-acts">${l.shopId && !CUR ? `<a class="btn" href="#compte/${esc(l.shopId)}">Ouvrir le compte</a>` : ''}<button onclick="closeSheet()">Fermer</button></div>`);
}

async function activateSheet(a) {
  if (!CONF) CONF = await call('/api/admin/settings');
  const st = CONF.settings, S = { method: 'MVola', months: 1 };
  const price = (m) => (m === 3 && st.price3MonthsMga ? st.price3MonthsMga : st.priceMonthMga * m);
  const endDate = () => { const from = a.paidUntil && new Date(a.paidUntil) > new Date() ? new Date(a.paidUntil) : new Date(); from.setMonth(from.getMonth() + S.months); return from; };
  openSheet(`<h2>${a.status === 'pending' ? 'Activer' : 'Paiement pour'} « ${esc(a.name)} »</h2><div class="s" style="margin-top:-8px">${esc(a.ownerName || '')} · ${esc(a.ownerEmail || '')}</div>
    <label class="f">Payé avec<div class="opts" id="pMeth">${CONF.methods.map((m) => `<button type="button" class="opt" aria-pressed="${m === S.method}" data-m="${esc(m)}">${mmIcon(m)}${esc(m === 'Orange Money' ? 'Orange' : m === 'Airtel Money' ? 'Airtel' : m)}</button>`).join('')}</div></label>
    <div class="grid2"><label class="f" id="pRefL">Référence de la transaction<input id="pRef" autocomplete="off" placeholder="ex. MP261112.1542.A12345"></label><label class="f">Montant reçu (Ar)<input id="pAmt" type="number" inputmode="numeric" min="0" value="${price(1)}"></label></div>
    <label class="f">Durée<div class="seg4" id="pMonths">${[1, 3, 6, 12].map((m) => `<button type="button" aria-pressed="${m === 1}" data-n="${m}">${m} mois</button>`).join('')}</div></label>
    <div class="okline" id="pEnd"></div><div class="err-t" id="pErr"></div>
    <div class="sheet-acts"><button onclick="closeSheet()">Annuler</button><button class="primary" id="pGo">${a.status === 'pending' ? 'Activer le compte' : 'Enregistrer'}</button></div>`);
  const upd = () => {
    q('#pEnd').textContent = `Le compte sera ouvert jusqu’au ${dateFr(endDate())}. Le vendeur le voit aussitôt.`;
    q('#pRefL').style.display = S.method === 'Offert' ? 'none' : '';
  };
  q('#pMeth').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.method = b.dataset.m; q('#pMeth').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); if (S.method === 'Offert') q('#pAmt').value = 0; else if (q('#pAmt').value === '0') q('#pAmt').value = price(S.months); upd(); };
  q('#pMonths').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.months = Number(b.dataset.n); q('#pMonths').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); if (S.method !== 'Offert') q('#pAmt').value = price(S.months); upd(); };
  q('#pGo').onclick = async () => {
    q('#pErr').textContent = ''; q('#pGo').disabled = true;
    try {
      await call(`/api/admin/accounts/${encodeURIComponent(a.id)}/activate`, { method: S.method, reference: q('#pRef').value, amountMga: Number(q('#pAmt').value), months: S.months });
      closeSheet(); toast(`« ${a.name} » est ouvert jusqu’au ${dateFr(endDate())}`); refreshCurrent();
    } catch (e) { q('#pErr').textContent = e.message; q('#pGo').disabled = false; }
  };
  upd();
}
async function suspendSheet() {
  if (!CONF) CONF = await call('/api/admin/settings');
  const a = CUR; let reason = CONF.reasons[0];
  openSheet(`<span style="width:48px;height:48px;border-radius:14px;display:grid;place-items:center;background:var(--red-bg);color:var(--red)"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg></span>
    <h2>Suspendre « ${esc(a.name)} » ?</h2>
    <div class="s" style="font-size:14px">Le vendeur ne pourra plus utiliser l’application : il verra l’écran de paiement. Aucune donnée n’est supprimée, et vous pouvez le réactiver à tout moment.</div>
    <label class="f">Motif<div class="opts col" id="sReason">${CONF.reasons.map((r, i) => `<button type="button" class="opt" aria-pressed="${i === 0}" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div></label>
    <label class="f">Message affiché au vendeur (facultatif)<input id="sMsg" maxlength="400" placeholder="Ex. : merci de régulariser le paiement de novembre"></label>
    <div class="err-t" id="sErr"></div>
    <div class="sheet-acts"><button onclick="closeSheet()">Annuler</button><button class="danger solid" id="sGo">Suspendre le compte</button></div>`);
  q('#sReason').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; reason = b.dataset.r; q('#sReason').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); };
  q('#sGo').onclick = async () => {
    try { await call(`/api/admin/accounts/${encodeURIComponent(a.id)}/suspend`, { reason, message: q('#sMsg').value }); closeSheet(); toast('Compte suspendu'); refreshCurrent(); }
    catch (e) { q('#sErr').textContent = e.message; }
  };
}
async function reactivate(a) {
  // Suspension levée : le compte reprend sa date d'abonnement (s'il a expiré entre-temps, il faudra un paiement).
  await call(`/api/admin/accounts/${encodeURIComponent(a.id)}/unsuspend`, {});
  toast('Suspension levée'); refreshCurrent();
}
function refreshCurrent() { if (location.hash.startsWith('#compte/') && CUR) openAccount(CUR.id, true); else route(); }

// ---------------------------------------------------------------- Paiements
async function viewPayments() {
  const list = await call('/api/admin/payments');
  const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
  const thisMonth = list.filter((p) => new Date(p.createdAt) >= month);
  const total = thisMonth.reduce((a, p) => a + p.amountMga, 0);
  const byMethod = {};
  thisMonth.forEach((p) => { byMethod[p.method] = (byMethod[p.method] || 0) + p.amountMga; });
  q('#view').innerHTML = `<div style="display:flex;flex-direction:column;gap:16px">
    <div><h1>Paiements</h1><div class="sub">Abonnements reçus par Mobile Money</div></div>
    <div class="card stats s4">
      <div class="stat"><span class="l">Encaissé ce mois</span><span class="v">${mga(total)}</span><span class="h">${thisMonth.length} paiement${thisMonth.length > 1 ? 's' : ''}</span></div>
      ${['MVola', 'Orange Money', 'Airtel Money'].map((m) => `<div class="stat"><span class="l">${m}</span><span class="v">${mga(byMethod[m] || 0)}</span><span class="h">ce mois</span></div>`).join('')}
    </div>
    <div class="card list">${list.map((p) => `<div class="row2" style="cursor:pointer" data-open="${esc(p.shopId)}"><span style="display:flex;gap:12px;align-items:center;min-width:0">${mmIcon(p.method)}<span style="min-width:0"><b>${esc(p.shopName || '—')}</b><br><span class="s">${dateFr(p.createdAt)} · ${esc(p.method)}${p.reference ? ' · ' + esc(p.reference) : ''}</span></span></span><span style="text-align:right;flex:none"><b>${mga(p.amountMga)}</b><br><span class="s">${p.months} mois · jusqu’au ${dateFr(p.paidUntil, false)}</span></span></div>`).join('') || '<div class="empty">Aucun paiement enregistré pour l’instant.</div>'}</div>
  </div>`;
}

// ---------------------------------------------------------------- Journal global
async function viewLogs() {
  CUR = null;
  const d = await call(`/api/admin/logs?filter=${logFilter}&days=${logDays}&q=${encodeURIComponent(logSearch)}`);
  LOGS = d.logs; const s = d.stats;
  if (!OV) call('/api/admin/overview').then((o) => { OV = o; badges(o); }).catch(() => {});
  q('#view').innerHTML = `<div style="display:flex;flex-direction:column;gap:16px">
    <div><h1>Journal</h1><div class="sub">Ce qui se passe sur tous les comptes, les erreurs en premier</div></div>
    <div class="card stats s4">
      <div class="stat"><span class="l">Erreurs</span><span class="v" style="color:var(--red)">${s.errors.n}</span><span class="h">sur ${s.errors.shops} compte${s.errors.shops > 1 ? 's' : ''}</span></div>
      <div class="stat"><span class="l">Alertes</span><span class="v" style="color:var(--orange)">${s.warnings.n}</span><span class="h">à surveiller</span></div>
      <div class="stat"><span class="l">Facebook déconnecté</span><span class="v">${s.disconnected}</span><span class="h">compte${s.disconnected > 1 ? 's' : ''}</span></div>
      <div class="stat"><span class="l">Messenger inactif</span><span class="v">${s.messengerOff}</span><span class="h">à rétablir</span></div>
    </div>
    <label class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="lgQ" type="search" placeholder="Boutique ou message…" value="${esc(logSearch)}" aria-label="Filtrer le journal"></label>
    <div class="chips" id="lgF">${[['error', 'Erreurs'], ['warn', 'Alertes'], ['all', 'Tout']].map(([k, l]) => `<button aria-pressed="${logFilter === k}" data-f="${k}">${l}</button>`).join('')}<span style="width:8px;flex:none"></span>${[[1, 'Aujourd’hui'], [7, '7 jours'], [30, '30 jours']].map(([k, l]) => `<button aria-pressed="${logDays === k}" data-d="${k}">${l}</button>`).join('')}</div>
    <div class="card list">${d.logs.map((l) => logRow(l, true)).join('') || '<div class="empty">Rien à signaler sur la période. 👌</div>'}</div>
  </div>`;
  let t; q('#lgQ').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { logSearch = e.target.value; viewLogs().then(() => { const i = q('#lgQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 350); };
  q('#lgF').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.f) logFilter = b.dataset.f; if (b.dataset.d) logDays = Number(b.dataset.d); viewLogs(); };
}

// ---------------------------------------------------------------- Réglages
async function viewSettings() {
  CONF = await call('/api/admin/settings');
  const s = CONF.settings;
  q('#view').innerHTML = `<form id="setForm" style="display:flex;flex-direction:column;gap:16px">
    <div class="top"><div><h1>Réglages</h1><div class="sub">Ce que voient les comptes à activer pour payer</div></div><button class="primary hide-m" type="submit">Enregistrer</button></div>
    <div class="card" style="padding:18px;display:flex;flex-direction:column;gap:12px"><h2>Abonnement</h2>
      <div class="grid2"><label class="f">Prix par mois (Ar)<input name="priceMonthMga" type="number" inputmode="numeric" min="0" value="${s.priceMonthMga}"></label><label class="f">Prix pour 3 mois (Ar)<input name="price3MonthsMga" type="number" inputmode="numeric" min="0" value="${s.price3MonthsMga}"></label></div></div>
    <div class="card"><h2 style="padding:18px 18px 4px">Numéros Mobile Money</h2><div class="list">
      ${s.wallets.map((w, i) => `<div class="wal" data-w="${esc(w.method)}">${mmIcon(w.method)}<b>${esc(w.method)}</b><div class="fields"><label class="f">Numéro<input name="num${i}" inputmode="tel" value="${esc(w.number)}"></label><label class="f">Au nom de<input name="hold${i}" value="${esc(w.holder)}"></label><label class="switch"><input type="checkbox" name="shown${i}" ${w.shown ? 'checked' : ''}>Affiché</label></div></div>`).join('')}
    </div></div>
    <div class="card" style="padding:18px;display:flex;flex-direction:column;gap:12px"><h2>Contact du support</h2>
      <div class="grid2"><label class="f">WhatsApp<input name="supportWhatsapp" inputmode="tel" value="${esc(s.supportWhatsapp)}"></label><label class="f">Téléphone<input name="supportPhone" inputmode="tel" value="${esc(s.supportPhone)}"></label></div>
      <label class="f">Horaires<input name="supportHours" value="${esc(s.supportHours)}"></label>
      <label class="f">Message affiché sur l’écran verrouillé<textarea name="lockMessage" maxlength="400">${esc(s.lockMessage)}</textarea></label></div>
    <button class="primary" type="submit" style="min-height:48px">Enregistrer</button>
  </form>`;
  q('#setForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await call('/api/admin/settings', {
        priceMonthMga: Number(f.get('priceMonthMga')), price3MonthsMga: Number(f.get('price3MonthsMga')),
        wallets: s.wallets.map((w, i) => ({ method: w.method, number: f.get(`num${i}`), holder: f.get(`hold${i}`), shown: f.get(`shown${i}`) === 'on' })),
        supportWhatsapp: f.get('supportWhatsapp'), supportPhone: f.get('supportPhone'), supportHours: f.get('supportHours'), lockMessage: f.get('lockMessage'),
      });
      toast('Réglages enregistrés'); CONF = null;
    } catch (err) { toast(err.message, true); }
  };
}

route();
