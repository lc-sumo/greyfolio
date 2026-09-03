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

  const setViewAs = useCallback((id: string | null) => {
    setApiViewAs(id);
    setViewAsState(id);
    void qc.invalidateQueries();
  }, [qc]);

  const logout = useCallback(async () => {
    const r = await api<{ ok: boolean; redirect: string }>('/auth/logout', { method: 'POST' });
    setViewAs(null);
    setAuth(null);
    qc.clear();
    if (r.redirect && !r.redirect.startsWith(window.location.origin)) window.location.href = r.redirect;
  }, [qc, setViewAs]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2600);
  }, []);

  const value = useMemo(() => ({ auth, loading, viewAs, setViewAs, period, setPeriod, refresh, logout, toast, notify }), [auth, loading, viewAs, setViewAs, period, refresh, logout, toast, notify]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('SessionProvider missing');
  return s;
}
