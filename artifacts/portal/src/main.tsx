import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './lib/session';
import { Clawbacks } from './pages/Clawbacks';
import { Dashboard } from './pages/Dashboard';
import { Deals } from './pages/Deals';
import { Login } from './pages/Login';
import { Roster } from './pages/Roster';
import { Soon } from './pages/Soon';
import { Statements } from './pages/Statements';
import './styles.css';

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
      <Route path="/" element={repMode ? <Dashboard /> : <Roster />} />
      <Route path="/deals" element={repMode ? <Deals /> : <Navigate to="/soon/deals" replace />} />
      <Route path="/clawbacks" element={<Clawbacks />} />
      <Route path="/statements" element={<Statements />} />
      <Route path="/soon/:what" element={<Soon />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function LoginGate() {
  const [oidc, devAuth] = [Boolean(window.__GS_OIDC__), Boolean(window.__GS_DEV__)];
  return <Login oidc={oidc} devAuth={devAuth} />;
}

declare global {
  interface Window { __GS_OIDC__?: boolean; __GS_DEV__?: boolean }
}

// Ask the API which sign-in methods exist before rendering the login screen.
fetch('/auth/methods').then((r) => r.json()).catch(() => ({ oidc: false, devAuth: false })).then((m: { oidc: boolean; devAuth: boolean }) => {
  window.__GS_OIDC__ = m.oidc;
  window.__GS_DEV__ = m.devAuth;
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <SessionProvider>
            <App />
          </SessionProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
});
