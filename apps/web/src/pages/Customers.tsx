import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../components/icons.tsx';
import { OrderDetail } from '../components/OrderDetail.tsx';
import { Empty, ErrorBox, Kpi, Loading, Modal, Pill, SearchBox, useDebounced } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { ago, date, initials, mga, num, ORDER_STATUS, pl } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';

interface Row { id: string; fullName: string | null; phone: string | null; city: string | null; tags: string[] | null; isBlocked: boolean; ordersCount: number; totalSpentMga: number; lastOrderAt: string | null; cancelledCount: number }

function Avatar({ name, size = 40 }: { name: string | null; size?: number }) {
  return <span aria-hidden="true" style={{ width: size, height: size, borderRadius: '50%', background: 'var(--accent-soft)', color: 'var(--accent)', display: 'inline-grid', placeItems: 'center', fontWeight: 700, fontSize: size * 0.38, flex: 'none' }}>{initials(name)}</span>;
}

export function Customers() {
  const { sp } = useSession();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [sort, setSort] = useState('recent');
  const [adding, setAdding] = useState(false);
  const list = useApi<{ total: number; items: Row[] }>(sp(`/customers?sort=${sort}&pageSize=100${dq.trim() ? `&q=${encodeURIComponent(dq.trim())}` : ''}`));

  return (
    <>
      <div className="page-head">
        <div><h1>Clients</h1><div className="page-sub">{list.data ? `${pl(list.data.total, 'client')} dans votre fichier` : ' '}</div></div>
        <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon.plus />Ajouter un client</button>
      </div>
      <div className="row">
        <SearchBox value={q} onChange={setQ} placeholder="Nom ou téléphone" />
        <div className="seg" role="group" aria-label="Trier">
          {[['recent', 'Récents'], ['spent', 'Meilleurs'], ['orders', 'Fidèles'], ['name', 'A → Z']].map(([k, l]) => (
            <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}>{l}</button>
          ))}
        </div>
      </div>
      <ErrorBox error={list.error} />
      <section className="card">
        {!list.data ? <Loading /> : list.data.items.length === 0 ? <Empty>Aucun client trouvé.</Empty> : (
          <div className="table-wrap">
            <table className="list">
              <thead><tr><th>Client</th><th className="hide-sm">Ville</th><th className="num">Commandes</th><th className="num">Total acheté</th><th className="hide-sm">Dernier achat</th></tr></thead>
              <tbody>
                {list.data.items.map((c) => (
                  <tr key={c.id} className="click" onClick={() => nav(`/clients/${c.id}`)}>
                    <td><div className="row" style={{ flexWrap: 'nowrap' }}><Avatar name={c.fullName} /><span><span className="strong">{c.fullName ?? 'Client sans nom'}</span><br /><span className="small muted">{c.phone ?? 'pas de téléphone'}</span></span>
                      {c.isBlocked ? <Pill tone="red">Bloqué</Pill> : c.cancelledCount >= 2 ? <Pill tone="orange">{c.cancelledCount} annulations</Pill> : null}</div></td>
                    <td className="hide-sm">{c.city ?? '—'}</td>
                    <td className="num">{c.ordersCount}</td>
                    <td className="num strong">{mga(c.totalSpentMga)}</td>
                    <td className="hide-sm">{c.lastOrderAt ? ago(c.lastOrderAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {adding ? <CustomerForm onClose={() => setAdding(false)} onSaved={(id) => nav(`/clients/${id}`)} /> : null}
    </>
  );
}

interface Detail {
  id: string; fullName: string | null; phone: string | null; email: string | null; address: string | null; city: string | null; notes: string | null; tags: string[] | null; isBlocked: boolean; createdAt: string; messengerPsid: string | null;
  stats: { ordersCount: number; totalSpentMga: number; averageBasketMga: number; cancelledCount: number; unpaidMga: number; firstOrderAt: string | null; lastOrderAt: string | null };
  favoriteProducts: { code: string; name: string; quantity: number }[];
  lives: { id: string; title: string; startedAt: string | null }[];
  orders: { id: string; number: string; status: string; totalMga: number; paidMga: number; createdAt: string; items: { codeSnapshot: string; nameSnapshot: string; variantSnapshot: string; quantity: number }[] }[];
}

function CustomerForm({ initial, onClose, onSaved }: { initial?: Detail; onClose: () => void; onSaved: (id: string) => void }) {
  const { sp } = useSession();
  const [f, setF] = useState({ fullName: initial?.fullName ?? '', phone: initial?.phone ?? '', city: initial?.city ?? '', address: initial?.address ?? '', notes: initial?.notes ?? '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || (initial ? null : undefined)]));
    try {
      const r = initial ? await api<{ id: string }>(sp(`/customers/${initial.id}`), { method: 'PATCH', body }) : await api<{ id: string }>(sp('/customers'), { body });
      onSaved(r.id ?? initial!.id);
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal title={initial ? 'Modifier le client' : 'Nouveau client'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">Nom complet<input className="input" value={f.fullName} onChange={set('fullName')} required /></label>
        <label className="field">Téléphone<input className="input" value={f.phone} onChange={set('phone')} inputMode="tel" placeholder="034 00 000 00" /></label>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <label className="field" style={{ flex: 1 }}>Ville<input className="input" value={f.city} onChange={set('city')} /></label>
          <label className="field" style={{ flex: 2 }}>Adresse<input className="input" value={f.address} onChange={set('address')} /></label>
        </div>
        <label className="field">Notes<textarea className="textarea" rows={3} value={f.notes} onChange={set('notes')} placeholder="Ex. préfère être livrée le samedi" /></label>
        <ErrorBox error={err} />
        <button className="btn primary" disabled={busy}>Enregistrer</button>
      </form>
    </Modal>
  );
}

export function CustomerPage() {
  const { id } = useParams();
  const { sp } = useSession();
  const { data: c, error, reload } = useApi<Detail>(sp(`/customers/${id}`));
  const [edit, setEdit] = useState(false);
  const [openOrder, setOpenOrder] = useState<string | null>(null);

  if (!c) return error ? <ErrorBox error={error} /> : <Loading />;
  const s = c.stats;
  return (
    <>
      <Link to="/clients" className="row small" style={{ textDecoration: 'none', gap: 4 }}><Icon.back />Clients</Link>
      <div className="page-head">
        <div className="row" style={{ gap: 16 }}>
          <Avatar name={c.fullName} size={64} />
          <div>
            <h1>{c.fullName ?? 'Client sans nom'}</h1>
            <div className="page-sub">Cliente depuis {date(s.firstOrderAt ?? c.createdAt)}{c.city ? ` · ${c.city}` : ''}{c.messengerPsid ? ' · joignable sur Messenger' : ''}</div>
          </div>
        </div>
        <div className="row">
          {c.phone ? <a className="btn" href={`tel:${c.phone}`}>Appeler</a> : null}
          <button type="button" className="btn" onClick={() => setEdit(true)}>Modifier</button>
        </div>
      </div>

      <div className="grid kpis">
        <Kpi label="Total acheté" value={mga(s.totalSpentMga)} hint={pl(s.ordersCount, 'commande')} />
        <Kpi label="Panier moyen" value={mga(s.averageBasketMga)} />
        <Kpi label="Reste à payer" value={mga(s.unpaidMga)} />
        <Kpi label="Annulations" value={num(s.cancelledCount)} hint={s.cancelledCount >= 2 ? 'à surveiller' : 'cliente fiable'} />
      </div>

      <div className="grid two">
        <section className="card" aria-labelledby="historique">
          <div className="card-head" style={{ padding: '20px 20px 0' }}><h2 id="historique">Historique des commandes</h2></div>
          {c.orders.length ? (
            <div className="table-wrap">
              <table className="list">
                <thead><tr><th>Date</th><th>Articles</th><th>Statut</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {c.orders.map((o) => (
                    <tr key={o.id} className="click" onClick={() => setOpenOrder(o.id)}>
                      <td><span className="strong">{date(o.createdAt)}</span><br /><span className="small muted">{o.number}</span></td>
                      <td>{o.items.map((i) => `${i.codeSnapshot} ${i.variantSnapshot} × ${i.quantity}`).join(', ')}</td>
                      <td><Pill tone={ORDER_STATUS[o.status]?.tone ?? 'gray'}>{ORDER_STATUS[o.status]?.label}</Pill></td>
                      <td className="num strong">{mga(o.totalMga)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty>Pas encore de commande.</Empty>}
        </section>

        <div className="stack" style={{ gap: 16 }}>
          <section className="card pad">
            <h2 style={{ marginBottom: 12 }}>Coordonnées</h2>
            <dl className="kv">
              <dt>Téléphone</dt><dd>{c.phone ?? '—'}</dd>
              <dt>Adresse</dt><dd>{[c.address, c.city].filter(Boolean).join(', ') || '—'}</dd>
              {c.email ? <><dt>E-mail</dt><dd>{c.email}</dd></> : null}
            </dl>
          </section>
          <section className="card pad">
            <h2 style={{ marginBottom: 8 }}>Ce qu’elle achète</h2>
            {c.favoriteProducts.length ? (
              <ul className="list-plain">{c.favoriteProducts.map((p) => <li key={p.code}><span><span className="code">{p.code}</span> {p.name}</span><span className="muted">× {p.quantity}</span></li>)}</ul>
            ) : <span className="muted small">Rien pour l’instant.</span>}
          </section>
          <section className="card pad">
            <h2 style={{ marginBottom: 8 }}>Notes</h2>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }} className={c.notes ? '' : 'muted small'}>{c.notes ?? 'Aucune note. Ajoutez-en avec « Modifier ».'}</p>
          </section>
        </div>
      </div>

      {edit ? <CustomerForm initial={c} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); void reload(); }} /> : null}
      {openOrder ? <OrderDetail orderId={openOrder} onClose={() => setOpenOrder(null)} onChanged={() => void reload()} /> : null}
    </>
  );
}
