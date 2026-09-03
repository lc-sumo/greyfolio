import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api, DEMO } from './lib/api';
import './lib/theme';
import { SessionProvider, useSession } from './lib/session';
import { Clawbacks } from './pages/Clawbacks';
import { Dashboard } from './pages/Dashboard';
import { Deals } from './pages/Deals';
import { Login } from './pages/Login';
import { MasterDeals } from './pages/MasterDeals';
import { Merchants } from './pages/Merchants';
import { Overview } from './pages/Overview';
import { Payroll } from './pages/Payroll';
import { Roster } from './pages/Roster';
import { Settings } from './pages/Settings';
import { Soon } from './pages/Soon';
import { PayHistory } from './pages/PayHistory';
import { Renewals } from './pages/Renewals';
import './styles.css';

// The hosted demo runs at an arbitrary path, so it routes by hash.
const Router = DEMO ? HashRouter : BrowserRouter;

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: false } } });

function App() {
  const { auth, loading, viewAs } = useSession();
  if (loading) return <div className="empty">Loading…</div>;
  if (!auth) {
    return (
      <Routes>
        <Route path="*" element={<LoginGate />} />
      </Routes>
    );
  }
  const repMode = auth.user.role === 'rep' || !!viewAs;
  return (
    <Routes>
      <Route path="/" element={repMode ? <Dashboard /> : auth.user.role === 'admin' ? <Overview /> : <Roster />} />
      <Route path="/roster" element={!repMode ? <Roster /> : <Navigate to="/" replace />} />
      <Route path="/merchants" element={!repMode && auth.user.role === 'admin' ? <Merchants /> : <Navigate to="/" replace />} />
      <Route path="/deals" element={repMode ? <Deals /> : auth.user.role === 'admin' ? <MasterDeals /> : <Navigate to="/" replace />} />
      <Route path="/payroll" element={!repMode && auth.user.role === 'admin' ? <Payroll /> : <Navigate to="/" replace />} />
      <Route path="/clawbacks" element={repMode ? <Clawbacks /> : <Navigate to="/" replace />} />
      <Route path="/payments" element={repMode ? <PayHistory /> : <Navigate to="/" replace />} />
      <Route path="/statements" element={<Navigate to="/payments" replace />} />
      <Route path="/renewals" element={repMode ? <Renewals admin={false} /> : auth.user.role === 'admin' ? <Renewals admin /> : <Navigate to="/" replace />} />
      <Route path="/settings" element={!repMode && auth.user.role === 'admin' ? <Settings /> : <Navigate to="/" replace />} />
      <Route path="/soon/:what" element={<Soon />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function LoginGate() {
  const [oidc, devAuth, password] = [Boolean(window.__GS_OIDC__), Boolean(window.__GS_DEV__), window.__GS_PW__ !== false];
  return <Login oidc={oidc} devAuth={devAuth} password={password} />;
}

declare global {
  interface Window { __GS_OIDC__?: boolean; __GS_DEV__?: boolean; __GS_PW__?: boolean }
}

// Ask the API which sign-in methods exist before rendering the login screen.
api<{ oidc: boolean; devAuth: boolean; password?: boolean }>('/auth/methods').catch(() => ({ oidc: false, devAuth: false, password: false })).then((m) => {
  window.__GS_OIDC__ = m.oidc;
  window.__GS_DEV__ = m.devAuth;
  window.__GS_PW__ = m.password !== false;
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <Router>
          <SessionProvider>
            <App />
          </SessionProvider>
        </Router>
      </QueryClientProvider>
    </StrictMode>,
  );
});
