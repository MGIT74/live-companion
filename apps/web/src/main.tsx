import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout.tsx';
import { Loading } from './components/ui.tsx';
import { SessionProvider, useSession } from './lib/session.tsx';
import { Catalog } from './pages/Catalog.tsx';
import { CustomerPage, Customers } from './pages/Customers.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Lives, Regie } from './pages/Lives.tsx';
import { Login } from './pages/Login.tsx';
import { Orders } from './pages/Orders.tsx';
import './styles.css';

function App() {
  const { ready, me, shop } = useSession();
  if (!ready) return <Loading />;
  if (!me) return <Login />;
  if (!shop) return <div className="auth"><div className="card"><h1>Aucune boutique</h1><p className="muted">Votre compte n’est rattaché à aucune boutique. Demandez une invitation au propriétaire.</p></div></div>;
  return (
    <Routes key={shop.id}>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="lives" element={<Lives />} />
        <Route path="lives/:id" element={<Regie />} />
        <Route path="commandes" element={<Orders />} />
        <Route path="clients" element={<Customers />} />
        <Route path="clients/:id" element={<CustomerPage />} />
        <Route path="catalogue" element={<Catalog />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
