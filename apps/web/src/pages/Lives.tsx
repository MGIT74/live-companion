import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/icons.tsx';
import { OrderDetail } from '../components/OrderDetail.tsx';
import { Empty, ErrorBox, Loading, Modal, Pill } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { ago, COMMENT_STATUS, date, LIVE_STATUS, mga, num, ORDER_STATUS, pl } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Product } from './Catalog.tsx';

interface LiveStats { orders: number; revenueMga: number; pending: number; cancelled: number; customers: number; comments: number }
interface LiveRow { id: string; title: string; status: string; createdAt: string; startedAt: string | null; endedAt: string | null; stats?: LiveStats }
interface LiveItem { id: string; productId: string; position: number; presentedAt: string | null; product: Product; commentText: string }
interface Live extends LiveRow { currentItemId: string | null; items: LiveItem[]; stats?: LiveStats }
interface Comment { id: string; authorName: string | null; message: string; parseStatus: string; reason: string | null; orderId: string | null; receivedAt: string; source: string }
interface OrderRow { id: string; number: string; status: string; totalMga: number; createdAt: string; itemsCount: number; customer: { fullName: string | null; phone: string | null } }

export function Lives() {
  const { sp } = useSession();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const list = useApi<LiveRow[]>(sp('/lives'));
  const creating = params.get('nouveau') === '1';
  const setCreating = (v: boolean) => { const p = new URLSearchParams(params); if (v) p.set('nouveau', '1'); else p.delete('nouveau'); setParams(p, { replace: true }); };

  return (
    <>
      <div className="page-head">
        <div><h1>Lives</h1><div className="page-sub">Préparez la liste des produits, puis lancez la régie pendant le live.</div></div>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}><Icon.plus />Préparer un live</button>
      </div>
      <ErrorBox error={list.error} />
      <section className="card">
        {!list.data ? <Loading /> : list.data.length === 0 ? <Empty>Aucun live pour l’instant. Préparez le premier.</Empty> : (
          <div className="table-wrap">
            <table className="list">
              <thead><tr><th>Live</th><th>Statut</th><th className="num">Commandes</th><th className="num hide-sm">À confirmer</th><th className="num hide-sm">Commentaires</th><th className="num">Ventes</th></tr></thead>
              <tbody>
                {list.data.map((l) => (
                  <tr key={l.id} className="click" onClick={() => nav(`/lives/${l.id}`)}>
                    <td><span className="strong">{l.title}</span><br /><span className="small muted">{date(l.startedAt ?? l.createdAt, true)}</span></td>
                    <td>{l.status === 'LIVE' ? <span className="live-badge">EN DIRECT</span> : <Pill tone={LIVE_STATUS[l.status]?.tone ?? 'gray'}>{LIVE_STATUS[l.status]?.label}</Pill>}</td>
                    <td className="num">{num(l.stats?.orders)}</td>
                    <td className="num hide-sm">{num(l.stats?.pending)}</td>
                    <td className="num hide-sm">{num(l.stats?.comments)}</td>
                    <td className="num strong">{mga(l.stats?.revenueMga)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating ? <LiveForm onClose={() => setCreating(false)} onSaved={(id) => nav(`/lives/${id}`)} /> : null}
    </>
  );
}

function LiveForm({ live, onClose, onSaved }: { live?: Live; onClose: () => void; onSaved: (id: string) => void }) {
  const { sp } = useSession();
  const products = useApi<Product[]>(sp('/products'));
  const [title, setTitle] = useState(live?.title ?? `Live du ${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}`);
  const [picked, setPicked] = useState<string[]>(live?.items.map((i) => i.productId) ?? []);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      if (live) {
        await api(sp(`/lives/${live.id}`), { method: 'PATCH', body: { title } });
        await api(sp(`/lives/${live.id}/items`), { method: 'PUT', body: { productIds: picked } });
        onSaved(live.id);
      } else {
        const r = await api<Live>(sp('/lives'), { body: { title, productIds: picked } });
        onSaved(r.id);
      }
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal title={live ? 'Produits du live' : 'Préparer un live'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">Titre<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
        <div className="field">Produits à présenter, dans l’ordre <span className="small muted">({picked.length} choisis)</span></div>
        {!products.data ? <Loading /> : products.data.length === 0 ? <span className="muted small">Ajoutez d’abord des produits dans le catalogue.</span> : (
          <div className="stack" style={{ gap: 6, maxHeight: 320, overflowY: 'auto' }}>
            {products.data.map((p) => {
              const pos = picked.indexOf(p.id);
              return (
                <label key={p.id} className="row" style={{ flexWrap: 'nowrap', padding: '8px 10px', borderRadius: 10, background: pos >= 0 ? 'var(--accent-soft)' : 'var(--fill)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={pos >= 0} onChange={() => toggle(p.id)} style={{ width: 20, height: 20 }} />
                  <span className="code">{p.code}</span>
                  <span style={{ flex: 1 }}>{p.name}<br /><span className="small muted">{mga(p.priceMga)} · {p.totalAvailable} dispo</span></span>
                  {pos >= 0 ? <span className="strong" style={{ color: 'var(--accent)' }}>{pos + 1}</span> : null}
                </label>
              );
            })}
          </div>
        )}
        <ErrorBox error={err} />
        <button className="btn primary" disabled={busy}>{live ? 'Enregistrer' : 'Créer et ouvrir la régie'}</button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Régie
export function Regie() {
  const { id } = useParams();
  const { sp } = useSession();
  const live = useApi<Live>(sp(`/lives/${id}`), 4000);
  const orders = useApi<{ total: number; items: OrderRow[] }>(sp(`/orders?liveSessionId=${id}&pageSize=200`), 4000);
  const review = useApi<Comment[]>(sp(`/lives/${id}/comments?status=NEEDS_REVIEW&limit=100`), 4000);
  const comments = useApi<Comment[]>(sp(`/lives/${id}/comments?limit=100`), 4000);
  const [tab, setTab] = useState<'orders' | 'review' | 'comments'>('orders');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const l = live.data;
  const refreshAll = () => { void live.reload(); void orders.reload(); void review.reload(); void comments.reload(); };
  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); refreshAll(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => { if (copied) { const t = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(t); } }, [copied]);

  if (!l) return live.error ? <ErrorBox error={live.error} /> : <Loading />;
  const cur = l.items.find((i) => i.id === l.currentItemId) ?? null;
  const idx = cur ? l.items.indexOf(cur) : -1;
  const next = l.items.length ? l.items[(idx + 1) % l.items.length] : null;
  const s = l.stats;
  const pendingReview = review.data?.length ?? 0;

  return (
    <>
      <Link to="/lives" className="row small" style={{ textDecoration: 'none', gap: 4 }}><Icon.back />Lives</Link>
      <div className="page-head">
        <div>
          <div className="row">{l.status === 'LIVE' ? <span className="live-badge">EN DIRECT</span> : <Pill tone={LIVE_STATUS[l.status]?.tone ?? 'gray'}>{LIVE_STATUS[l.status]?.label}</Pill>}<span className="muted small">{l.startedAt ? `depuis ${ago(l.startedAt).replace('il y a ', '')}` : ''}</span></div>
          <h1 style={{ marginTop: 6 }}>{l.title}</h1>
        </div>
        <div className="row">
          {l.status !== 'ENDED' ? <button type="button" className="btn" onClick={() => setEditing(true)}>Produits</button> : null}
          {l.status === 'DRAFT' ? <button type="button" className="btn primary" disabled={busy} onClick={() => act(() => api(sp(`/lives/${l.id}/start`), { body: {} }))}>Démarrer le live</button> : null}
          {l.status === 'LIVE' ? <button type="button" className="btn danger" disabled={busy} onClick={() => { if (confirm('Terminer ce live ? Les commandes restent dans votre suivi.')) void act(() => api(sp(`/lives/${l.id}/end`), { body: {} })); }}>Terminer</button> : null}
        </div>
      </div>
      <ErrorBox error={err} />

      <div className="grid kpis tight">
        <div className="card kpi"><span className="label">Commandes</span><span className="value">{num((s?.orders ?? 0) + (s?.pending ?? 0))}</span><span className="hint">{num(s?.pending)} à confirmer</span></div>
        <div className="card kpi"><span className="label">Ventes confirmées</span><span className="value">{mga(s?.revenueMga)}</span><span className="hint">{pl(s?.customers, 'client')}</span></div>
        <div className="card kpi"><span className="label">Commentaires</span><span className="value">{num(s?.comments)}</span><span className="hint">{pendingReview ? `${pendingReview} à valider` : 'rien à valider'}</span></div>
      </div>

      <div className="regie">
        <div className="stack" style={{ gap: 16 }}>
          <section className="card current" aria-labelledby="produit-en-cours">
            <div className="row between"><span className="muted small" id="produit-en-cours">Produit présenté</span>{l.items.length ? <span className="muted small">{idx + 1 > 0 ? idx + 1 : '–'} / {l.items.length}</span> : null}</div>
            {cur ? (
              <>
                <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                  <span className="code" style={{ fontSize: 16, padding: '4px 10px' }}>{cur.product.code}</span>
                  <div style={{ flex: 1 }}><div className="name">{cur.product.name}</div><div className="strong" style={{ fontSize: 18 }}>{mga(cur.product.priceMga)}</div></div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {cur.product.variants.map((v) => <span key={v.id} className={`vchip${v.available <= 0 ? ' out' : v.available <= 2 ? ' low' : ''}`}>{v.label} · {v.available}</span>)}
                </div>
                <div className="comment-text">{cur.commentText}</div>
                <button type="button" className="btn" onClick={() => { void navigator.clipboard?.writeText(cur.commentText); setCopied(true); }}><Icon.copy />{copied ? 'Copié ✓' : 'Copier le texte à publier'}</button>
              </>
            ) : <span className="muted">{l.items.length ? 'Aucun produit présenté pour l’instant.' : 'Ajoutez des produits avec « Produits ».'}</span>}
            {l.items.length && l.status !== 'ENDED' ? (
              <button type="button" className="btn primary big" disabled={busy} onClick={() => act(() => api(sp(`/lives/${l.id}/present`), { body: {} }))}>
                <Icon.next />{cur ? `Produit suivant${next && next.id !== cur.id ? ` : ${next.product.code}` : ''}` : `Présenter ${l.items[0].product.code}`}
              </button>
            ) : null}
          </section>

          {l.status !== 'ENDED' ? <QuickOrder liveId={l.id} onDone={refreshAll} defaultCode={cur?.product.code} /> : null}

          {l.items.length ? (
            <section className="card pad">
              <h2 style={{ marginBottom: 8 }}>Ordre de passage</h2>
              <ul className="list-plain">
                {l.items.map((i, n) => (
                  <li key={i.id} style={{ alignItems: 'center' }}>
                    <span className="row" style={{ flexWrap: 'nowrap' }}><span className="muted small" style={{ width: 18 }}>{n + 1}</span><span className="code">{i.product.code}</span><span>{i.product.name}</span></span>
                    {i.id === l.currentItemId ? <Pill tone="blue">En cours</Pill> : l.status !== 'ENDED' ? <button type="button" className="btn sm" disabled={busy} onClick={() => act(() => api(sp(`/lives/${l.id}/present`), { body: { itemId: i.id } }))}>{i.presentedAt ? 'Revenir' : 'Présenter'}</button> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <section className="card">
          <div style={{ padding: 16 }}>
            <div className="seg" role="tablist" aria-label="Suivi du live" style={{ width: '100%' }}>
              <button type="button" role="tab" aria-selected={tab === 'orders'} aria-pressed={tab === 'orders'} style={{ flex: 1 }} onClick={() => setTab('orders')}>Commandes · {orders.data?.total ?? 0}</button>
              <button type="button" role="tab" aria-selected={tab === 'review'} aria-pressed={tab === 'review'} style={{ flex: 1 }} onClick={() => setTab('review')}>À valider · {pendingReview}</button>
              <button type="button" role="tab" aria-selected={tab === 'comments'} aria-pressed={tab === 'comments'} style={{ flex: 1 }} onClick={() => setTab('comments')}>Commentaires</button>
            </div>
          </div>
          {tab === 'orders' ? (
            orders.data?.items.length ? (
              <ul className="list-plain" style={{ padding: '0 20px 8px' }}>
                {orders.data.items.map((o) => (
                  <li key={o.id} style={{ cursor: 'pointer' }} onClick={() => setOpenOrder(o.id)}>
                    <span><span className="strong">{o.customer.fullName ?? 'Client'}</span><br /><span className="small muted">{o.number} · {pl(o.itemsCount, 'article')} · {ago(o.createdAt)}</span></span>
                    <span style={{ textAlign: 'right' }}><span className="strong">{mga(o.totalMga)}</span><br /><Pill tone={ORDER_STATUS[o.status]?.tone ?? 'gray'}>{ORDER_STATUS[o.status]?.label}</Pill></span>
                  </li>
                ))}
              </ul>
            ) : <Empty>Les commandes apparaîtront ici dès les premiers « JP01 M ».</Empty>
          ) : tab === 'review' ? (
            review.data?.length ? (
              <ul className="list-plain" style={{ padding: '0 20px 8px' }}>
                {review.data.map((c) => <ReviewItem key={c.id} c={c} live={l} onDone={refreshAll} />)}
              </ul>
            ) : <Empty>Aucun commentaire à valider.</Empty>
          ) : (
            comments.data?.length ? (
              <ul className="list-plain" style={{ padding: '0 20px 8px' }}>
                {comments.data.map((c) => (
                  <li key={c.id}><span><span className="strong">{c.authorName ?? 'Anonyme'}</span> <span className="small muted">{ago(c.receivedAt)}</span><br />{c.message}{c.reason ? <><br /><span className="small muted">{c.reason}</span></> : null}</span>
                    <Pill tone={COMMENT_STATUS[c.parseStatus]?.tone ?? 'gray'}>{COMMENT_STATUS[c.parseStatus]?.label}</Pill></li>
                ))}
              </ul>
            ) : <Empty>Pas encore de commentaire.</Empty>
          )}
        </section>
      </div>

      {editing ? <LiveForm live={l} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refreshAll(); }} /> : null}
      {openOrder ? <OrderDetail orderId={openOrder} onClose={() => setOpenOrder(null)} onChanged={refreshAll} /> : null}
    </>
  );
}

function QuickOrder({ liveId, onDone, defaultCode }: { liveId: string; onDone: () => void; defaultCode?: string }) {
  const { sp } = useSession();
  const [f, setF] = useState({ text: '', name: '', phone: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      const r = await api<{ outcome: { status: string; reason?: string; merged?: boolean } }>(sp(`/lives/${liveId}/quick-order`), { body: { text: f.text, customer: { fullName: f.name || undefined, phone: f.phone || undefined } } });
      const o = r.outcome;
      if (o.status === 'ORDERED') { setMsg({ ok: true, text: o.merged ? 'Ajouté au panier du client.' : 'Commande créée.' }); setF({ text: '', name: '', phone: '' }); }
      else if (o.status === 'WAITLISTED') setMsg({ ok: false, text: `Plus de stock : ${o.reason ?? ''}` });
      else if (o.status === 'NEEDS_REVIEW') setMsg({ ok: false, text: `À préciser : ${o.reason ?? ''}` });
      else setMsg({ ok: false, text: 'Pas reconnu comme une commande. Écrivez par ex. « JP01 M » ou « JP01 2 L ».' });
      onDone();
    } catch (e2) { setMsg({ ok: false, text: (e2 as Error).message }); } finally { setBusy(false); }
  }
  return (
    <section className="card pad">
      <form className="stack" onSubmit={submit}>
        <h2>Saisie rapide</h2>
        <label className="field">Commande<input className="input" value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} placeholder={`${defaultCode ?? 'JP01'} M`} required autoComplete="off" /></label>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <label className="field" style={{ flex: 1 }}>Nom du client<input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
          <label className="field" style={{ flex: 1 }}>Téléphone<input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" /></label>
        </div>
        {msg ? <div className={msg.ok ? 'ok' : 'error'} role="status">{msg.text}</div> : null}
        <button className="btn primary" disabled={busy}>Ajouter la commande</button>
      </form>
    </section>
  );
}

function ReviewItem({ c, live, onDone }: { c: Comment; live: Live; onDone: () => void }) {
  const { sp } = useSession();
  const variants = live.items.flatMap((i) => i.product.variants.map((v) => ({ id: v.id, label: `${i.product.code} · ${v.label}`, available: v.available })));
  const [variantId, setVariantId] = useState(variants[0]?.id ?? '');
  const [qty, setQty] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function resolve(action: 'accept' | 'reject') {
    setBusy(true); setErr(null);
    try { await api(sp(`/lives/${live.id}/comments/${c.id}/resolve`), { body: action === 'accept' ? { action, variantId, quantity: qty } : { action } }); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <li style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <span><span className="strong">{c.authorName ?? 'Anonyme'}</span> <span className="small muted">{ago(c.receivedAt)}</span></span>
      <span style={{ fontSize: 16 }}>« {c.message} »</span>
      {c.reason ? <span className="small" style={{ color: 'var(--orange)' }}>{c.reason}</span> : null}
      <div className="row">
        <select className="select" style={{ flex: '1 1 160px', width: 'auto' }} value={variantId} onChange={(e) => setVariantId(e.target.value)} aria-label="Produit et taille">
          {variants.map((v) => <option key={v.id} value={v.id} disabled={v.available <= 0}>{v.label}{v.available <= 0 ? ' (épuisé)' : ''}</option>)}
        </select>
        <input className="input" style={{ width: 70 }} type="number" min={1} max={100} value={qty} onChange={(e) => setQty(Number(e.target.value) || 1)} aria-label="Quantité" />
        <button type="button" className="btn primary sm" disabled={busy || !variantId} onClick={() => resolve('accept')}>Valider</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => resolve('reject')}>Ignorer</button>
      </div>
      <ErrorBox error={err} />
    </li>
  );
}
