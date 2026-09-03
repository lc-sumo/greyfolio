import { useQuery } from '@tanstack/react-query';
import { Shell } from '../components/Shell';
import { Loading, Pill, toneFor } from '../components/ui';
import { api, type RepStatement } from '../lib/api';
import { money } from '../lib/format';
import { useSession } from '../lib/session';

export function Statements() {
  const { viewAs } = useSession();
  const q = useQuery({ queryKey: ['statements', viewAs], queryFn: () => api<{ statements: RepStatement[] }>('/api/me/statements') });
  const rows = q.data?.statements ?? [];
  return (
    <Shell eyebrow="Rep portal" title="Statements">
      {!q.data ? (
        <Loading error={q.error} />
      ) : rows.length === 0 ? (
        <div className="note">No payout periods yet — a statement appears here for each payroll run that includes one of your deals.</div>
      ) : (
        <div className="stmts">
          {rows.map((s) => (
            <section className="card stmt" key={s.runId}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <div className="period">{s.period}</div>
                <Pill tone={toneFor(s.status)}>{s.status === 'paid' ? 'Paid' : s.status === 'approved' ? 'Approved' : 'Draft'}</Pill>
              </div>
              <div className="rows">
                <div><span className="muted">Deals</span><span className="num">{s.dealCount}</span></div>
                <div><span className="muted">Gross</span><span className="num">{money(s.grossPaid)}</span></div>
                <div><span className="muted">Clawbacks</span><span className={`num ${s.clawbacks ? 'neg' : ''}`}>{s.clawbacks ? money(-s.clawbacks) : '$0'}</span></div>
                <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: 6, fontWeight: 700 }}><span>Net paid</span><span className="num">{money(s.netPaid)}</span></div>
                <div><span className="muted">Method</span><span>ACH</span></div>
              </div>
            </section>
          ))}
        </div>
      )}
    </Shell>
  );
}
