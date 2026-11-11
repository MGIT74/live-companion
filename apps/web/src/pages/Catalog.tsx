import { useState, type FormEvent } from 'react';
import { Icon } from '../components/icons.tsx';
import { Empty, ErrorBox, Loading, Modal, Pill, SearchBox, useDebounced } from '../components/ui.tsx';
import { api, useApi } from '../lib/api.ts';
import { ago, mga, pl } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';

export interface Variant { id: string; label: string; priceMga: number | null; stockOnHand: number; reserved: number; available: number }
export interface Product { id: string; code: string; name: string; description: string | null; priceMga: number; isPublished: boolean; variants: Variant[]; images: { url: string }[]; totalAvailable: number; soldQuantity: number }
interface Movement { id: string; type: string; quantity: number; note: string | null; createdAt: string; code: string; name: string; label: string }

const LOW = 2;
const MOVE: Record<string, string> = { RESTOCK: 'Réassort', ADJUST: 'Correction', RESERVE: 'Réservé', RELEASE: 'Libéré', SALE: 'Vendu', RETURN: 'Retour' };

export function Catalog() {
  const { sp } = useSession();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all');
  const [adding, setAdding] = useState(false);
  const [stockOf, setStockOf] = useState<Product | null>(null);
  const list = useApi<Product[]>(sp(`/products${dq.trim() ? `?q=${encodeURIComponent(dq.trim())}` : ''}`));
  const moves = useApi<Movement[]>(sp('/inventory/movements?limit=8'));

  const all = list.data ?? [];
  const out = all.filter((p) => p.totalAvailable <= 0);
  const low = all.filter((p) => p.totalAvailable > 0 && p.variants.some((v) => v.available <= LOW));
  const shown = filter === 'out' ? out : filter === 'low' ? low : all;
  const refresh = () => { void list.reload(); void moves.reload(); };

  return (
    <>
      <div className="page-head">
        <div><h1>Catalogue</h1><div className="page-sub">{list.data ? `${pl(all.length, 'produit')} · ${out.length} en rupture · ${low.length} bientôt ${low.length > 1 ? 'épuisés' : 'épuisé'}` : ' '}</div></div>
        <button type="button" className="btn primary" onClick={() => setAdding(true)}><Icon.plus />Ajouter un produit</button>
      </div>
      <div className="row">
        <SearchBox value={q} onChange={setQ} placeholder="Code (JP01) ou nom du produit" />
        <div className="seg" role="group" aria-label="Filtrer par stock">
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Tous</button>
          <button type="button" aria-pressed={filter === 'low'} onClick={() => setFilter('low')}>Stock bas</button>
          <button type="button" aria-pressed={filter === 'out'} onClick={() => setFilter('out')}>Rupture</button>
        </div>
      </div>
      <ErrorBox error={list.error} />

      {!list.data ? <Loading /> : shown.length === 0 ? <div className="card"><Empty>{all.length ? 'Aucun produit dans ce filtre.' : 'Ajoutez votre premier produit pour le présenter en live.'}</Empty></div> : (
        <div className="products">
          {shown.map((p) => {
            const isOut = p.totalAvailable <= 0;
            const isLow = !isOut && p.variants.some((v) => v.available <= LOW);
            return (
              <article key={p.id} className="card product">
                <div className="thumb" style={p.images[0] ? { backgroundImage: `url(${p.images[0].url})` } : { height: 64 }}>
                  <span className="code" style={{ fontSize: 14, padding: '4px 10px' }}>{p.code}</span>
                  {isOut ? <Pill tone="red">Rupture</Pill> : isLow ? <Pill tone="orange">Stock bas</Pill> : null}
                </div>
                <div className="body">
                  <div className="row between" style={{ alignItems: 'baseline', flexWrap: 'nowrap' }}><h2 style={{ fontSize: 16 }}>{p.name}</h2><strong style={{ whiteSpace: 'nowrap' }}>{mga(p.priceMga)}</strong></div>
                  <div className="row" style={{ gap: 6 }}>
                    {p.variants.map((v) => (
                      <span key={v.id} className={`vchip${v.available <= 0 ? ' out' : v.available <= LOW ? ' low' : ''}`}>{v.label} · {v.available}</span>
                    ))}
                  </div>
                  <span className="small muted">{pl(p.soldQuantity, 'vendu')} · {pl(p.totalAvailable, 'disponible')}{p.variants.some((v) => v.reserved) ? ` · ${pl(p.variants.reduce((a, v) => a + v.reserved, 0), 'réservé')}` : ''}</span>
                  <div style={{ flex: 1 }} />
                  <button type="button" className="btn sm" onClick={() => setStockOf(p)}>{isOut ? 'Réapprovisionner' : 'Gérer le stock'}</button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <section className="card pad" aria-labelledby="mvts">
        <h2 id="mvts" style={{ marginBottom: 8 }}>Derniers mouvements de stock</h2>
        {moves.data?.length ? (
          <ul className="list-plain">
            {moves.data.map((m) => {
              const n = m.quantity; // déjà signé (+ entrée, − sortie)
              return (
                <li key={m.id}><span><span className="strong">{m.code} · {m.label}</span> — {MOVE[m.type] ?? m.type}{m.note ? ` (${m.note})` : ''} <span className="small muted">{ago(m.createdAt)}</span></span>
                  <span className="strong" style={{ color: n < 0 ? 'var(--red)' : 'var(--green)' }}>{n > 0 ? `+${n}` : n}</span></li>
              );
            })}
          </ul>
        ) : <span className="muted small">Aucun mouvement.</span>}
      </section>

      {adding ? <ProductForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); }} /> : null}
      {stockOf ? <StockForm product={stockOf} onClose={() => setStockOf(null)} onSaved={() => { setStockOf(null); refresh(); }} /> : null}
    </>
  );
}

/** « S:4, M:6, L:2 » → variantes. Vide → une variante « Unique ». */
function parseVariants(s: string) {
  const parts = s.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  return parts.map((p) => {
    const m = p.match(/^(.+?)\s*[:=]\s*(\d+)$/) ?? p.match(/^(.+?)\s+(\d+)$/);
    return m ? { label: m[1].trim(), stock: Number(m[2]) } : { label: p, stock: 0 };
  });
}

function ProductForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { sp } = useSession();
  const [f, setF] = useState({ code: '', name: '', price: '', variants: '', stock: '', image: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const variants = parseVariants(f.variants) ?? [{ label: 'Unique', stock: Number(f.stock || 0) }];
    try {
      await api(sp('/products'), { body: { code: f.code, name: f.name, priceMga: Number(f.price.replace(/\D/g, '')), variants, images: f.image ? [f.image] : [] } });
      onSaved();
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Nouveau produit" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <label className="field" style={{ flex: 1 }}>Code<input className="input" value={f.code} onChange={set('code')} required placeholder="JP01" style={{ textTransform: 'uppercase' }} /></label>
          <label className="field" style={{ flex: 2 }}>Prix (Ar)<input className="input" value={f.price} onChange={set('price')} required inputMode="numeric" placeholder="35000" /></label>
        </div>
        <span className="small muted" style={{ marginTop: -6 }}>Le code est ce que les clients écrivent en commentaire : « JP01 M ».</span>
        <label className="field">Nom<input className="input" value={f.name} onChange={set('name')} required placeholder="Jean blanc slim" /></label>
        <label className="field">Tailles ou couleurs avec leur stock<input className="input" value={f.variants} onChange={set('variants')} placeholder="S:4, M:6, L:2  (laisser vide si taille unique)" /></label>
        {!f.variants.trim() ? <label className="field">Stock<input className="input" value={f.stock} onChange={set('stock')} inputMode="numeric" placeholder="10" /></label> : null}
        <label className="field">Photo (lien, facultatif)<input className="input" type="url" value={f.image} onChange={set('image')} placeholder="https://…" /></label>
        <ErrorBox error={err} />
        <button className="btn primary" disabled={busy}>Ajouter au catalogue</button>
      </form>
    </Modal>
  );
}

function StockForm({ product, onClose, onSaved }: { product: Product; onClose: () => void; onSaved: () => void }) {
  const { sp } = useSession();
  const [deltas, setDeltas] = useState<Record<string, string>>({});
  const [newV, setNewV] = useState({ label: '', stock: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      for (const [vid, d] of Object.entries(deltas)) {
        const n = Number(d);
        if (Number.isFinite(n) && n !== 0) await api(sp(`/variants/${vid}/stock`), { body: { delta: n, note: n > 0 ? 'Réassort' : 'Correction' } });
      }
      if (newV.label.trim()) await api(sp(`/products/${product.id}/variants`), { body: { label: newV.label.trim(), stock: Number(newV.stock || 0) } });
      onSaved();
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal title={`${product.code} · ${product.name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small" style={{ margin: 0 }}>Indiquez combien vous ajoutez (ex. 5) ou retirez (ex. −2).</p>
        {product.variants.map((v) => (
          <div key={v.id} className="row between" style={{ flexWrap: 'nowrap' }}>
            <span><span className="strong">{v.label}</span><br /><span className="small muted">{v.available} disponibles · {v.reserved} réservés</span></span>
            <input className="input" style={{ width: 110 }} inputMode="numeric" aria-label={`Ajouter au stock ${v.label}`} placeholder="+0" value={deltas[v.id] ?? ''} onChange={(e) => setDeltas({ ...deltas, [v.id]: e.target.value.replace(/[^\d-]/g, '') })} />
          </div>
        ))}
        <div className="row" style={{ alignItems: 'stretch', borderTop: '1px solid var(--sep)', paddingTop: 12 }}>
          <label className="field" style={{ flex: 2 }}>Nouvelle taille ou couleur<input className="input" value={newV.label} onChange={(e) => setNewV({ ...newV, label: e.target.value })} placeholder="XL" /></label>
          <label className="field" style={{ flex: 1 }}>Stock<input className="input" inputMode="numeric" value={newV.stock} onChange={(e) => setNewV({ ...newV, stock: e.target.value })} /></label>
        </div>
        <ErrorBox error={err} />
        <button className="btn primary" disabled={busy}>Enregistrer</button>
      </form>
    </Modal>
  );
}
