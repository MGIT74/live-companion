import { Link, useNavigate } from 'react-router-dom';
import { Empty, ErrorBox, Kpi, Pill } from '../components/ui.tsx';
import { useApi } from '../lib/api.ts';
import { ago, date, LIVE_STATUS, mga, num, pl } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';

interface Overview { revenueMga: number; paidMga: number; unpaidMga: number; orders: number; averageBasketMga: number; itemsSold: number; pendingOrders: number; pendingAmountMga: number; confirmationRate: number | null; buyingCustomers: number; newCustomers: number; returningCustomers: number }
interface Day { day: string; orders: number; revenueMga: number }
interface OrderRow { id: string; number: string; status: string; totalMga: number; createdAt: string; customer: { fullName: string | null; phone: string | null }; itemsCount: number }
interface LiveStat { id: string; title: string; status: string; createdAt: string; orders: number; revenueMga: number; confirmationRate: number | null; customers: number }

function lastDays(n: number) {
  const days: string[] = [];
  const now = new Date(Date.now() + 3 * 3600_000); // jour de Madagascar
  for (let i = n - 1; i >= 0; i--) days.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  return days;
}

export function Dashboard() {
  const { sp, me } = useSession();
  const nav = useNavigate();
  const ov = useApi<Overview>(sp('/stats/overview'), 60_000);
  const from = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const days = useApi<Day[]>(sp(`/stats/sales-by-day?from=${from}`), 60_000);
  const pending = useApi<{ total: number; items: OrderRow[] }>(sp('/orders?status=PENDING_CONFIRMATION&pageSize=5'), 30_000);
  const unpaid = useApi<{ total: number }>(sp('/orders?unpaid=true&status=CONFIRMED,PREPARING,SHIPPED,DELIVERED&pageSize=1'), 60_000);
  const lives = useApi<LiveStat[]>(sp('/stats/lives'), 60_000);
  const topC = useApi<{ customerId: string; fullName: string | null; orders: number; revenueMga: number }[]>(sp('/stats/top-customers?limit=5'));
  const topP = useApi<{ productId: string; code: string; name: string; quantity: number; revenueMga: number }[]>(sp('/stats/top-products?limit=5'));

  const o = ov.data;
  const series = lastDays(14).map((d) => ({ d, v: days.data?.find((x) => x.day === d)?.revenueMga ?? 0 }));
  const max = Math.max(1, ...series.map((s) => s.v));
  const hello = new Date().getHours() < 18 ? 'Bonjour' : 'Bonsoir';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{hello} {me?.fullName.split(' ')[0]}</h1>
          <div className="page-sub">Les 30 derniers jours de votre boutique</div>
        </div>
        <Link className="btn primary" to="/lives?nouveau=1">Préparer un live</Link>
      </div>
      <ErrorBox error={ov.error} />

      <div className="grid kpis">
        <Kpi label="Chiffre d’affaires" value={o ? mga(o.revenueMga) : '…'} hint={o ? `${pl(o.orders, 'commande')} · panier moyen ${mga(o.averageBasketMga)}` : null} />
        <Kpi label="À confirmer" value={o ? num(o.pendingOrders) : '…'} hint={o ? `${mga(o.pendingAmountMga)} en attente` : null} />
        <Kpi label="Reste à encaisser" value={o ? mga(o.unpaidMga) : '…'} hint={unpaid.data ? `${pl(unpaid.data.total, 'commande non soldée', 'commandes non soldées')}` : null} />
        <Kpi label="Clients" value={o ? num(o.buyingCustomers) : '…'} hint={o ? `${pl(o.newCustomers, 'nouveau', 'nouveaux')} · ${pl(o.returningCustomers, 'fidèle')}` : null} />
      </div>

      <div className="grid two">
        <section className="card pad" aria-labelledby="ventes">
          <div className="card-head"><h2 id="ventes">Ventes des 14 derniers jours</h2><span className="muted small">{o?.confirmationRate != null ? `${o.confirmationRate} % confirmées` : ''}</span></div>
          <div className="bars" role="img" aria-label="Chiffre d’affaires par jour sur 14 jours">
            {series.map((s, i) => (
              <div key={s.d} className={`bar${i === series.length - 1 ? ' today' : ''}`} title={`${date(s.d)} : ${mga(s.v)}`}>
                <span className="b" style={{ height: `${Math.round((s.v / max) * 100)}%` }} />
                <span>{new Date(s.d).getDate()}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card pad" aria-labelledby="atraiter">
          <div className="card-head"><h2 id="atraiter">À traiter maintenant</h2><Link to="/commandes" className="small">Tout voir</Link></div>
          {pending.data?.items.length ? (
            <ul className="list-plain">
              {pending.data.items.map((r) => (
                <li key={r.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/commandes?ouvrir=${r.id}`)}>
                  <span><span className="strong">{r.customer.fullName ?? 'Client'}</span><br /><span className="small muted">{r.number} · {ago(r.createdAt)}</span></span>
                  <span className="strong">{mga(r.totalMga)}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>Rien en attente. Bien joué.</Empty>}
        </section>
      </div>

      <section className="card" aria-labelledby="derniers-lives">
        <div className="card-head" style={{ padding: '20px 20px 0' }}><h2 id="derniers-lives">Derniers lives</h2><Link to="/lives" className="small">Tous les lives</Link></div>
        {lives.data?.length ? (
          <div className="table-wrap">
            <table className="list">
              <thead><tr><th>Live</th><th>Statut</th><th className="num">Commandes</th><th className="num">Clients</th><th className="num hide-sm">Confirmées</th><th className="num">Ventes</th></tr></thead>
              <tbody>
                {lives.data.slice(0, 5).map((l) => (
                  <tr key={l.id} className="click" onClick={() => nav(`/lives/${l.id}`)}>
                    <td><span className="strong">{l.title}</span><br /><span className="small muted">{date(l.createdAt, true)}</span></td>
                    <td><Pill tone={LIVE_STATUS[l.status]?.tone ?? 'gray'}>{LIVE_STATUS[l.status]?.label ?? l.status}</Pill></td>
                    <td className="num">{num(l.orders)}</td>
                    <td className="num">{num(l.customers)}</td>
                    <td className="num hide-sm">{l.confirmationRate != null ? `${l.confirmationRate} %` : '—'}</td>
                    <td className="num strong">{mga(l.revenueMga)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>Aucun live sur la période.</Empty>}
      </section>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <section className="card pad" aria-labelledby="top-clients">
          <div className="card-head"><h2 id="top-clients">Meilleurs clients</h2><Link to="/clients" className="small">Tous</Link></div>
          {topC.data?.length ? (
            <ul className="list-plain">
              {topC.data.map((c) => (
                <li key={c.customerId}><Link to={`/clients/${c.customerId}`} className="strong" style={{ color: 'var(--text)', textDecoration: 'none' }}>{c.fullName ?? 'Client'}</Link><span><span className="muted small">{pl(c.orders, 'commande')} · </span><span className="strong">{mga(c.revenueMga)}</span></span></li>
              ))}
            </ul>
          ) : <Empty>Pas encore de ventes.</Empty>}
        </section>
        <section className="card pad" aria-labelledby="top-produits">
          <div className="card-head"><h2 id="top-produits">Produits les plus vendus</h2><Link to="/catalogue" className="small">Catalogue</Link></div>
          {topP.data?.length ? (
            <ul className="list-plain">
              {topP.data.map((p) => (
                <li key={p.productId}><span><span className="code">{p.code}</span> {p.name}</span><span><span className="muted small">{pl(p.quantity, 'vendu')} · </span><span className="strong">{mga(p.revenueMga)}</span></span></li>
              ))}
            </ul>
          ) : <Empty>Pas encore de ventes.</Empty>}
        </section>
      </div>
    </>
  );
}
