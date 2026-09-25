import { AccountPanel } from '../components/Account';
import { Shell } from '../components/Shell';

/** Password and two-factor for reps and team leads. Admins find the same panel under Settings › My account. */
export function Account() {
  return (
    <Shell eyebrow="My portal" title="My account">
      <AccountPanel />
    </Shell>
  );
}
