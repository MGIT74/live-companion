import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../lib/api.ts';
import { CHANNEL, date, mga, ORDER_ACTIONS, ORDER_STATUS, PAYMENT_METHOD, PAYMENT_STATUS, SHIP_METHOD } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import { Drawer, ErrorBox, Loading, Pill } from './ui.tsx';

export interface Order {
  id: string; number: string; status: string; channel: string; liveSessionId: string | null;
  subtotalMga: number; shippingMga: number; discountMga: number; totalMga: number; paidMga: number;
  deliveryAddress: string | null; deliveryCity: string | null; notes: string | null;
  createdAt: string; confirmedAt: string | null; cancelledAt: string | null; expiresAt: string | null;
  customer: { id: string; fullName: string | null; phone: string | null; city: string | null; address: string | null };
  items: { id: string; codeSnapshot: string; nameSnapshot: string; variantSnapshot: string; quantity: number; unitPriceMga: number }[];
  payments: { id: string; method: string; amountMga: number; status: string; providerRef: string | null; createdAt: string }[];
  shipments: { id: string; method: string; carrierName: string | null; trackingNote: string | null; status: string; shippedAt: string | null; deliveredAt: string | null }[];
}

const STEPS = [
  { label: 'Réservée', reached: () => true },
  { label: 'Confirmée', reached: (o: Order) => !!o.confirmedAt || ['CONFIRMED', 'PAID', 'PREPARING', 'SHIPPED', 'DELIVERED', 'RETURNED'].includes(o.status) },
  { label: 'Payée', reached: (o: Order) => o.paidMga >= o.totalMga && o.totalMga > 0 },
  { label: 'Expédiée', reached: (o: Order) => ['SHIPPED', 'DELIVERED', 'RETURNED'].includes(o.status) },
  { label: 'Livrée', reached: (o: Order) => ['DELIVERED'].includes(o.status) },
];

export function OrderDetail({ orderId, onClose, onChanged }: { orderId: string; onClose: () => void; onChanged?: () => void }) {
  const { sp } = useSession();
  const { data: o, error, setData } = useApi<Order>(sp(`/orders/${orderId}`));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pay, setPay] = useState<{ method: string; amount: string; ref: string } | null>(null);
  const [ship, setShip] = useState<{ method: string; carrier: string; note: string } | null>(null);

  async function run(fn: () => Promise<Order>) {
    setBusy(true); setErr(null);
    try { setData(await fn()); onChanged?.(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const go = (status: string) => run(() => api<Order>(sp(`/orders/${orderId}/status`), { body: { status } }));

  if (!o) return <Drawer title="Commande" onClose={onClose}>{error ? <ErrorBox error={error} /> : <Loading />}</Drawer>;
  const st = ORDER_STATUS[o.status];
  const due = Math.max(o.totalMga - o.paidMga, 0);
  const closed = ['CANCELLED', 'RETURNED'].includes(o.status);

  function submitPay(e: FormEvent) {
    e.preventDefault();
    if (!pay) return;
    void run(() => api<Order>(sp(`/orders/${orderId}/payments`), { body: { method: pay.method, amountMga: Number(pay.amount.replace(/\D/g, '')), providerRef: pay.ref || undefined, confirmed: true } })).then(() => setPay(null));
  }
  function submitShip(e: FormEvent) {
    e.preventDefault();
    if (!ship) return;
    void run(() => api<Order>(sp(`/orders/${orderId}/shipments`), { body: { method: ship.method, carrierName: ship.carrier || undefined, trackingNote: ship.note || undefined } })).then(() => setShip(null));
  }

  return (
    <Drawer title={o.number} onClose={onClose}>
      <div className="row"><Pill tone={st?.tone ?? 'gray'}>{st?.label ?? o.status}</Pill><span className="muted small">{CHANNEL[o.channel] ?? o.channel} · {date(o.createdAt, true)}</span></div>
      <ErrorBox error={err} />

      <ol className="steps" aria-label="Étapes de la commande">
        {STEPS.map((s) => <li key={s.label} className={o.status === 'CANCELLED' ? 'cancel' : s.reached(o) ? 'done' : ''}><strong>{s.label}</strong></li>)}
      </ol>

      {ORDER_ACTIONS[o.status]?.length ? (
        <div className="row">
          {ORDER_ACTIONS[o.status].map((a) => (
            <button key={a.to} type="button" disabled={busy} className={`btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`} onClick={() => go(a.to)}>{a.label}</button>
          ))}
        </div>
      ) : null}

      <section className="card pad stack">
        <div className="row between"><h2>Client</h2><Link to={`/clients/${o.customer.id}`} className="small">Voir la fiche</Link></div>
        <dl className="kv">
          <dt>Nom</dt><dd>{o.customer.fullName ?? '—'}</dd>
          <dt>Téléphone</dt><dd>{o.customer.phone ? <a href={`tel:${o.customer.phone}`}>{o.customer.phone}</a> : '—'}</dd>
          <dt>Livraison</dt><dd>{[o.deliveryAddress ?? o.customer.address, o.deliveryCity ?? o.customer.city].filter(Boolean).join(', ') || '—'}</dd>
          {o.notes ? <><dt>Note</dt><dd>{o.notes}</dd></> : null}
        </dl>
      </section>

      <section className="card pad">
        <h2 style={{ marginBottom: 8 }}>Articles</h2>
        <ul className="list-plain">
          {o.items.map((i) => (
            <li key={i.id}><span><span className="code">{i.codeSnapshot}</span> {i.nameSnapshot} · {i.variantSnapshot} × {i.quantity}</span><span>{mga(i.unitPriceMga * i.quantity)}</span></li>
          ))}
          {o.shippingMga ? <li><span className="muted">Livraison</span><span>{mga(o.shippingMga)}</span></li> : null}
          {o.discountMga ? <li><span className="muted">Remise</span><span>− {mga(o.discountMga)}</span></li> : null}
          <li><span className="strong">Total</span><span className="strong">{mga(o.totalMga)}</span></li>
        </ul>
      </section>

      <section className="card pad stack">
        <div className="row between">
          <h2>Paiement</h2>
          {due > 0 ? <Pill tone="orange">Reste {mga(due)}</Pill> : <Pill tone="green">Soldée</Pill>}
        </div>
        {o.payments.length ? (
          <ul className="list-plain">
            {o.payments.map((p) => (
              <li key={p.id}><span>{PAYMENT_METHOD[p.method] ?? p.method}{p.providerRef ? <span className="muted small"> · réf. {p.providerRef}</span> : null}<br /><span className="small muted">{date(p.createdAt, true)}</span></span>
                <span className="row"><Pill tone={PAYMENT_STATUS[p.status]?.tone ?? 'gray'}>{PAYMENT_STATUS[p.status]?.label}</Pill><span className="strong">{mga(p.amountMga)}</span></span></li>
            ))}
          </ul>
        ) : <span className="muted small">Aucun paiement enregistré.</span>}
        {!closed && due > 0 && !pay ? <button type="button" className="btn" onClick={() => setPay({ method: 'MVOLA', amount: String(due), ref: '' })}>Enregistrer un paiement</button> : null}
        {pay ? (
          <form className="stack" onSubmit={submitPay}>
            <div className="row" style={{ alignItems: 'stretch' }}>
              <label className="field" style={{ flex: 1 }}>Moyen
                <select className="select" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                  {Object.entries(PAYMENT_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="field" style={{ flex: 1 }}>Montant (Ar)<input className="input" inputMode="numeric" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} required /></label>
            </div>
            <label className="field">Référence de transaction (facultatif)<input className="input" value={pay.ref} onChange={(e) => setPay({ ...pay, ref: e.target.value })} placeholder="Ex. référence MVola" /></label>
            <div className="row"><button className="btn primary" disabled={busy}>Valider le paiement reçu</button><button type="button" className="btn" onClick={() => setPay(null)}>Annuler</button></div>
          </form>
        ) : null}
      </section>

      <section className="card pad stack">
        <h2>Livraison</h2>
        {o.shipments.length ? (
          <ul className="list-plain">
            {o.shipments.map((s) => (
              <li key={s.id}><span>{SHIP_METHOD[s.method] ?? s.method}{s.carrierName ? ` · ${s.carrierName}` : ''}{s.trackingNote ? <><br /><span className="small muted">{s.trackingNote}</span></> : null}</span>
                <span className="small muted">{s.deliveredAt ? `livrée ${date(s.deliveredAt)}` : s.shippedAt ? `partie ${date(s.shippedAt)}` : 'à organiser'}</span></li>
            ))}
          </ul>
        ) : <span className="muted small">Pas encore organisée.</span>}
        {!closed && !o.shipments.length && !ship ? <button type="button" className="btn" onClick={() => setShip({ method: 'COURIER', carrier: '', note: '' })}>Organiser la livraison</button> : null}
        {ship ? (
          <form className="stack" onSubmit={submitShip}>
            <div className="row" style={{ alignItems: 'stretch' }}>
              <label className="field" style={{ flex: 1 }}>Mode
                <select className="select" value={ship.method} onChange={(e) => setShip({ ...ship, method: e.target.value })}>
                  {Object.entries(SHIP_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="field" style={{ flex: 1 }}>Livreur ou transporteur<input className="input" value={ship.carrier} onChange={(e) => setShip({ ...ship, carrier: e.target.value })} /></label>
            </div>
            <label className="field">Note (facultatif)<input className="input" value={ship.note} onChange={(e) => setShip({ ...ship, note: e.target.value })} placeholder="Ex. départ taxi-brousse 14 h" /></label>
            <div className="row"><button className="btn primary" disabled={busy}>Enregistrer</button><button type="button" className="btn" onClick={() => setShip(null)}>Annuler</button></div>
          </form>
        ) : null}
      </section>
    </Drawer>
  );
}
