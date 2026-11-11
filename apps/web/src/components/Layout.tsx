import { NavLink, Outlet } from 'react-router-dom';
import { useApi } from '../lib/api.ts';
import { useSession, useTheme, type ThemeChoice } from '../lib/session.tsx';
import { Icon } from './icons.tsx';

const LINKS = [
  { to: '/', label: 'Tableau de bord', short: 'Accueil', icon: Icon.home, end: true },
  { to: '/lives', label: 'Lives', short: 'Lives', icon: Icon.live },
  { to: '/commandes', label: 'Commandes', short: 'Commandes', icon: Icon.bag, badge: true },
  { to: '/clients', label: 'Clients', short: 'Clients', icon: Icon.users },
  { to: '/catalogue', label: 'Catalogue', short: 'Catalogue', icon: Icon.box },
];

export function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const opts: [ThemeChoice, string][] = [['auto', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']];
  return (
    <div className="seg" role="group" aria-label="Apparence" style={{ width: '100%' }}>
      {opts.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={theme === v} onClick={() => setTheme(v)} style={{ flex: 1 }}>{l}</button>
      ))}
    </div>
  );
}

export function Layout() {
  const { me, shop, selectShop, logout, sp } = useSession();
  const pending = useApi<{ total: number }>(shop ? sp('/orders?status=PENDING_CONFIRMATION&pageSize=1') : null, 30_000);
  const count = pending.data?.total ?? 0;

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Menu principal">
        <div className="brand"><span className="brand-mark"><Icon.logo /></span>Live Companion</div>
        {me && me.shops.length > 0 ? (
          <label className="shop-switch">
            <span className="muted small">Boutique</span>
            {me.shops.length > 1 ? (
              <select value={shop?.id} onChange={(e) => selectShop(e.target.value)}>
                {me.shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : <strong>{shop?.name}</strong>}
          </label>
        ) : null}
        {LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => `nav${isActive ? ' active' : ''}`}>
            <l.icon />{l.label}
            {l.badge && count > 0 ? <span className="count" aria-label={`${count} à confirmer`}>{count}</span> : null}
          </NavLink>
        ))}
        <div className="spacer" />
        <ThemeSwitch />
        <div className="row between" style={{ padding: '12px 4px 0' }}>
          <span className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{me?.fullName}</span>
          <button type="button" className="btn sm" onClick={logout}><Icon.logout />Quitter</button>
        </div>
      </nav>

      <main className="main" id="contenu">
        <Outlet />
      </main>

      <nav className="tabbar" aria-label="Menu">
        {LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <l.icon /><span>{l.short}{l.badge && count > 0 ? ` · ${count}` : ''}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
