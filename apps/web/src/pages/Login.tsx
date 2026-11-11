import { useState, type FormEvent } from 'react';
import { ThemeSwitch } from '../components/Layout.tsx';
import { Icon } from '../components/icons.tsx';
import { ErrorBox } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { useSession, type Me } from '../lib/session.tsx';

export function Login() {
  const { login } = useSession();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({ email: '', password: '', fullName: '', shopName: '', city: '', phone: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = mode === 'login' ? { email: f.email, password: f.password } : { ...f, city: f.city || undefined, phone: f.phone || undefined };
      const r = await api<{ token: string; user: Me }>(`/v1/auth/${mode}`, { body });
      login(r.token, r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="auth">
      <form className="card" onSubmit={submit}>
        <div className="row"><span className="brand-mark"><Icon.logo /></span><strong style={{ fontSize: 20 }}>Live Companion</strong></div>
        <div>
          <h1 style={{ fontSize: 26 }}>{mode === 'login' ? 'Connexion' : 'Créer ma boutique'}</h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>{mode === 'login' ? 'Vos lives, commandes et clients au même endroit.' : 'Gratuit, en une minute.'}</p>
        </div>
        {mode === 'register' ? (
          <>
            <label className="field">Votre nom<input className="input" required minLength={2} value={f.fullName} onChange={set('fullName')} autoComplete="name" /></label>
            <label className="field">Nom de la boutique<input className="input" required minLength={2} value={f.shopName} onChange={set('shopName')} /></label>
            <div className="row" style={{ alignItems: 'stretch' }}>
              <label className="field" style={{ flex: 1 }}>Ville<input className="input" value={f.city} onChange={set('city')} /></label>
              <label className="field" style={{ flex: 1 }}>Téléphone<input className="input" value={f.phone} onChange={set('phone')} inputMode="tel" autoComplete="tel" /></label>
            </div>
          </>
        ) : null}
        <label className="field">E-mail<input className="input" type="email" required value={f.email} onChange={set('email')} autoComplete="email" /></label>
        <label className="field">Mot de passe<input className="input" type="password" required minLength={mode === 'register' ? 8 : 1} value={f.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
        <ErrorBox error={error} />
        <button className="btn primary big" disabled={busy}>{busy ? 'Un instant…' : mode === 'login' ? 'Se connecter' : 'Créer ma boutique'}</button>
        <button type="button" className="btn" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}>
          {mode === 'login' ? 'Nouveau ? Créer une boutique' : 'J’ai déjà un compte'}
        </button>
        <ThemeSwitch />
      </form>
    </div>
  );
}
