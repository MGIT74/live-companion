import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { OrderDetail } from '../components/OrderDetail.tsx';
import { Empty, ErrorBox, Loading, Pill, SearchBox, useDebounced } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { ago, CHANNEL, mga, ORDER_STATUS, pl } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';

interface Row { id: string; number: string; status: string; channel: string; totalMga: number; paidMga: number; createdAt: string; deliveryCity: string | null; itemsCount: number; customer: { id: string; fullName: string | null; phone: string | null } }

const TABS = [
  { key: 'pending', label: 'À confirmer', status: 'PENDING_CONFIRMATION' },
  { key: 'confirmed', label: 'Confirmées', status: 'CONFIRMED,PAID' },
  { key: 'preparing', label: 'À préparer', status: 'PREPARING' },
  { key: 'shipped', label: 'En livraison', status: 'SHIPPED' },
  { key: 'delivered', label: 'Livrées', status: 'DELIVERED' },
  { key: 'cancelled', label: 'Annulées', status: 'CANCELLED,RETURNED' },
  { key: 'all', label: 'Toutes', status: '' },
];

export function Orders() {
  const { sp } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.key === params.get('onglet')) ?? TABS[0];
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [unpaid, setUnpaid] = useState(false);
  const openId = params.get('ouvrir');
  const qs = new URLSearchParams({ pageSize: '100' });
  if (tab.status) qs.set('status', tab.status);
  if (dq.trim()) qs.set('q', dq.trim());
  if (unpaid) qs.set('unpaid', 'true');
  const list = useApi<{ total: number; items: Row[] }>(sp(`/orders?${qs}`), 20_000);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function loadCounts() {
    const entries = await Promise.all(TABS.filter((t) => t.status).map(async (t) => {
      try { return [t.key, (await api<{ total: number }>(sp(`/orders?status=${t.status}&pageSize=1`))).total] as const; } catch { return [t.key, 0] as const; }
    }));
    setCounts(Object.fromEntries(entries));
  }
  useEffect(() => { void loadCounts(); }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTab = (k: string) => { const p = new URLSearchParams(params); p.set('onglet', k); p.delete('ouvrir'); setParams(p, { replace: true }); };
  const open = (id: string | null) => { const p = new URLSearchParams(params); if (id) p.set('ouvrir', id); else p.delete('ouvrir'); setParams(p, { replace: true }); };

  async function quick(id: string, status: string) {
    setBusy(id); setErr(null);
    try { await api(sp(`/orders/${id}/status`), { body: { status } }); await list.reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Commandes</h1><div className="page-sub">{list.data ? pl(list.data.total, 'commande') : ' '}</div></div>
      </div>

      <div className="chips" role="tablist" aria-label="Étape des commandes">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" className="chip" aria-selected={t.key === tab.key} aria-pressed={t.key === tab.key} onClick={() => setTab(t.key)}>
            {t.label}{counts[t.key] ? <span className="n">{counts[t.key]}</span> : null}
          </button>
        ))}
      </div>

      <div className="row">
        <SearchBox value={q} onChange={setQ} placeholder="Nom, téléphone ou n° de commande" />
        <div className="seg" role="group" aria-label="Paiement">
          <button type="button" aria-pressed={!unpaid} onClick={() => setUnpaid(false)}>Toutes</button>
          <button type="button" aria-pressed={unpaid} onClick={() => setUnpaid(true)}>Non soldées</button>
        </div>
      </div>
      <ErrorBox error={list.error ?? err} />

      <section className="card">
        {!list.data ? <Loading /> : list.data.items.length === 0 ? <Empty>Aucune commande ici.</Empty> : (<>
          <ul className="list-plain sm-only" style={{ padding: '0 16px' }}>
            {list.data.items.map((r) => {
              const st = ORDER_STATUS[r.status];
              return (
                <li key={r.id} onClick={() => open(r.id)} style={{ cursor: 'pointer', alignItems: 'center' }}>
                  <span style={{ minWidth: 0 }}><span className="strong">{r.customer.fullName ?? 'Client sans nom'}</span><br /><span className="small muted">{r.number} · {ago(r.createdAt)}</span></span>
                  <span style={{ textAlign: 'right', flex: 'none' }}><span className="strong">{mga(r.totalMga)}</span><br /><Pill tone={st?.tone ?? 'gray'}>{st?.label ?? r.status}</Pill></span>
                </li>
              );
            })}
          </ul>
          <div className="table-wrap lg-only">
            <table className="list">
              <thead><tr><th>Commande</th><th>Client</th><th className="num hide-sm">Articles</th><th className="hide-sm">Origine</th><th>Statut</th><th className="num">Total</th><th><span className="sr-only">Action</span></th></tr></thead>
              <tbody>
                {list.data.items.map((r) => {
                  const st = ORDER_STATUS[r.status];
                  const due = r.totalMga - r.paidMga;
                  return (
                    <tr key={r.id} className="click" onClick={() => open(r.id)}>
                      <td><span className="strong">{r.number}</span><br /><span className="small muted">{ago(r.createdAt)}</span></td>
                      <td><span className="strong">{r.customer.fullName ?? 'Client sans nom'}</span><br /><span className="small muted">{[r.customer.phone, r.deliveryCity].filter(Boolean).join(' · ') || 'téléphone à demander'}</span></td>
                      <td className="num hide-sm">{r.itemsCount}</td>
                      <td className="hide-sm"><Pill tone="gray">{CHANNEL[r.channel] ?? r.channel}</Pill></td>
                      <td><Pill tone={st?.tone ?? 'gray'}>{st?.label ?? r.status}</Pill></td>
                      <td className="num"><span className="strong">{mga(r.totalMga)}</span>{due > 0 && !['PENDING_CONFIRMATION', 'CANCELLED', 'RETURNED'].includes(r.status) ? <><br /><span className="small" style={{ color: 'var(--orange)' }}>reste {mga(due)}</span></> : null}</td>
                      <td className="num" onClick={(e) => e.stopPropagation()}>
                        {r.status === 'PENDING_CONFIRMATION' ? <button type="button" className="btn primary sm" disabled={busy === r.id} onClick={() => quick(r.id, 'CONFIRMED')}>Confirmer</button>
                          : r.status === 'SHIPPED' ? <button type="button" className="btn sm" disabled={busy === r.id} onClick={() => quick(r.id, 'DELIVERED')}>Livrée</button>
                          : <button type="button" className="btn sm" onClick={() => open(r.id)}>Ouvrir</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>)}
      </section>

      {openId ? <OrderDetail orderId={openId} onClose={() => open(null)} onChanged={() => void list.reload()} /> : null}
    </>
  );
}
