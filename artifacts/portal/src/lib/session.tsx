import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setViewAs as setApiViewAs, type AuthMe } from './api';
import type { Period } from './format';

interface Session {
  auth: AuthMe | null;
  loading: boolean;
  viewAs: string | null;
  setViewAs: (id: string | null) => void;
  period: Period;
  setPeriod: (p: Period) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  toast: string;
  notify: (msg: string) => void;
  /** Why the server ended the last session, shown once on the sign-in screen. */
  signedOutWhy: string;
  clearSignedOut: () => void;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [auth, setAuth] = useState<AuthMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewAs, setViewAsState] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('YTD');
  const [toast, setToast] = useState('');

  const refresh = useCallback(async () => {
    try {
      setAuth(await api<AuthMe>('/auth/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuth(null);
      else throw e;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // Server-side sign-outs (idle, password change, deactivation) land here from any API call.
  const [signedOutWhy, setSignedOutWhy] = useState('');
  useEffect(() => {
    const onOut = (e: Event) => {
      setSignedOutWhy(String((e as CustomEvent).detail ?? ''));
      setAuth(null);
      qc.clear();
    };
    window.addEventListener('gs:signed-out', onOut);
    return () => window.removeEventListener('gs:signed-out', onOut);
  }, [qc]);

  // Idle clock in the browser too, so a tab left open goes to the sign-in screen at the same moment the server would refuse it.
  useEffect(() => {
    const idle = auth?.idleMinutes ?? 0;
    if (!auth || idle <= 0) return;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    for (const ev of events) window.addEventListener(ev, bump, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - last > idle * 60_000) {
        window.dispatchEvent(new CustomEvent('gs:signed-out', { detail: `Signed out after ${idle >= 60 && idle % 60 === 0 ? `${idle / 60} hour${idle === 60 ? '' : 's'}` : `${idle} minutes`} of inactivity — sign in again` }));
        void api('/auth/logout', { method: 'POST' }).catch(() => undefined);
      }
    }, 30_000);
    return () => { for (const ev of events) window.removeEventListener(ev, bump); window.clearInterval(timer); };
  }, [auth]);

  const setViewAs = useCallback((id: string | null) => {
    setApiViewAs(id);
    setViewAsState(id);
    void qc.invalidateQueries();
  }, [qc]);

  const logout = useCallback(async () => {
    const r = await api<{ ok: boolean; redirect: string | null }>('/auth/logout', { method: 'POST' });
    setViewAs(null);
    setAuth(null);
    qc.clear();
    if (r.redirect) window.location.href = r.redirect;
  }, [qc, setViewAs]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2600);
  }, []);

  const value = useMemo(() => ({ auth, loading, viewAs, setViewAs, period, setPeriod, refresh, logout, toast, notify, signedOutWhy, clearSignedOut: () => setSignedOutWhy('') }), [auth, loading, viewAs, setViewAs, period, refresh, logout, toast, notify, signedOutWhy]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('SessionProvider missing');
  return s;
}
