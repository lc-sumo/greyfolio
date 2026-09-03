import { useParams } from 'react-router-dom';
import { Shell } from '../components/Shell';

const PHASES: Record<string, { title: string; phase: number }> = {
  deals: { title: 'Master deals', phase: 4 },
  payroll: { title: 'Run payroll', phase: 5 },
  renewals: { title: 'Renewals', phase: 6 },
  settings: { title: 'Settings', phase: 7 },
};

export function Soon() {
  const { what = '' } = useParams();
  const p = PHASES[what] ?? { title: 'Coming soon', phase: 4 };
  return (
    <Shell eyebrow="Admin" title={p.title}>
      <div className="note">This screen is built in Phase {p.phase} of the build order. The rep portal (Phase 3) is complete — use <b>View as</b> to open any rep.</div>
    </Shell>
  );
}
