/* Types mirror artifacts/api-server/src/scope.ts. */
export type Role = 'Opener' | 'Closer' | 'Override';
export type CommissionStatus = 'Waiting for payment' | 'Invoice Sent' | 'Partially Paid' | 'YES - Paid In Full';
export type PayoutStatus = 'Paid' | 'Partially paid' | 'Owed';

export interface SessionUser { repId: string; email: string; name: string; role: 'rep' | 'manager' | 'admin' }
export interface AuthMe { user: SessionUser; canViewAs: boolean; oidc: boolean; devAuth: boolean }
export interface RepRoleLine { role: Role; rate: number; amount: number; segment: string; segmentKey: string; paid: boolean }
export interface RepDealView {
  id: string; date: string; business: string; lender: string; product: string; funded: number; drawCount: number;
  roles: Role[]; lines: RepRoleLine[]; share: number; paid: number; owed: number; payoutStatus: PayoutStatus;
  commissionStatus: CommissionStatus; lenderPaidLabel: string; dealStatus: string; repPaid: string | null;
  clawback: { amount: number; remaining: number; status: 'open' | 'recovered' } | null;
}
export interface RepDealDetail extends RepDealView { payments: Array<{ role: string; segmentKey: string | null; amount: number; paidAt: string; runId: string | null }> }
export interface RepWallet { earned: number; paid: number; cash: number; held: number; recovered: number; owed: number; dealCount: number; awaitingLender: number }
export interface LeaderboardRow { rank: number; label: string; isMe: boolean; commission: number }
export interface RepDashboard {
  wallet: RepWallet;
  nextPayout: { date: string | null; runLabel: string | null; cycle: string };
  period: { from: string; to: string; earned: number; paid: number; recovered: number; owed: number; funded: number; dealCount: number; rank: number | null; repCount: number };
  monthly: Array<{ month: string; earned: number; paid: number }>;
  leaderboard: LeaderboardRow[];
  owedToMe: RepDealView[];
}
export interface RepClawbackView { id: string; dealId: string; date: string; business: string; dealClawback: number; chargedToMe: number; recovered: number; remaining: number; reason: string; status: 'open' | 'recovered' }
export interface RepStatement { runId: string; period: string; status: 'draft' | 'approved' | 'paid'; dealCount: number; grossPaid: number; clawbacks: number; netPaid: number }
export interface MeInfo { rep: { id: string; name: string; email: string; role: string; active: boolean }; viewAs: boolean; actor: { id: string; name: string; role: string } | null }
export interface RosterRep { id: string; name: string; email: string; role: string; team: string | null; openerRate: number; closerRate: number; overrideRate: number | null; active: boolean; earned: number; paid: number; held: number; owed: number; dealCount: number }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let viewAs: string | null = null;
export function setViewAs(id: string | null) { viewAs = id; }
export function getViewAs() { return viewAs; }

/** Demo build: the API runs in the browser over the demo board (see demo-api.ts). */
export const DEMO = import.meta.env.VITE_DEMO === '1';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (DEMO) {
    const { demoFetch } = await import('./demo-api');
    return demoFetch<T>(path, init, viewAs);
  }
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers as Record<string, string>) };
  if (viewAs) headers['X-View-As'] = viewAs;
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (body && body.error) || res.statusText);
  return body as T;
}

export const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
