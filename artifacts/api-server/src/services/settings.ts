import { asRate, type Lender, type ProductRule, type ReferralPartner, type Rep, type Team } from '@greystone/commission';
import { HttpError } from '../http-error.js';
import type { Repo, Settings, Thresholds } from '../repo.js';

const audit = (repo: Repo, actorRepId: string, action: 'settings.update' | 'team.update' | 'rep.update', path: string, detail: Record<string, unknown>) =>
  repo.writeAudit({ actorRepId, action, targetRepId: null, path, detail });

/** How many deals reference each lender / partner / product, and how many reps sit on each team. */
export interface Usage {
  lenders: Record<string, number>;
  partners: Record<string, number>;
  products: Record<string, number>;
  teams: Record<string, number>;
}

export async function usage(repo: Repo): Promise<Usage> {
  const [ctx, reps] = await Promise.all([repo.loadContext(), repo.listReps()]);
  const count = (keys: Array<string | null>) => keys.reduce<Record<string, number>>((m, k) => (k ? { ...m, [k]: (m[k] ?? 0) + 1 } : m), {});
  return {
    lenders: count(ctx.deals.map((d) => d.lender)),
    partners: count(ctx.deals.map((d) => d.referralPartner)),
    products: count(ctx.deals.map((d) => d.product)),
    teams: count(reps.map((r) => r.teamId)),
  };
}

function cleanName(v: unknown, what: string): string {
  const s = String(v ?? '').trim();
  if (!s) throw new HttpError(400, `${what} needs a name`);
  return s;
}

/** Exact-name uniqueness — the workbook deliberately carries both "NONE" and "None" as partners. */
function uniqueNames(items: Array<{ name: string }>, what: string) {
  const seen = new Set<string>();
  for (const x of items) {
    if (seen.has(x.name)) throw new HttpError(400, `Duplicate ${what} "${x.name}"`);
    seen.add(x.name);
  }
}

/** Removing something deals still reference is refused, with the count. */
function guardRemovals(before: string[], after: string[], used: Record<string, number>, what: string) {
  const kept = new Set(after);
  const blocked = before.filter((n) => !kept.has(n) && used[n]).map((n) => `${n} (${used[n]} deal${used[n] === 1 ? '' : 's'})`);
  if (blocked.length) throw new HttpError(400, `${what} in use cannot be removed: ${blocked.join(', ')}`);
}

export async function saveLenders(repo: Repo, input: unknown, actorRepId: string): Promise<Lender[]> {
  if (!Array.isArray(input)) throw new HttpError(400, 'lenders must be a list');
  const lenders: Lender[] = input.map((l: Record<string, unknown>) => {
    const terms = l.terms === 'weekly' ? 'weekly' : 'upfront';
    const weeks = terms === 'weekly' ? Math.round(Number(l.weeks) || 0) : 0;
    if (terms === 'weekly' && weeks < 1) throw new HttpError(400, `Weekly lender "${l.name}" needs a week count`);
    const lender: Lender = { name: cleanName(l.name, 'Lender'), terms, weeks };
    if (terms === 'weekly') {
      const up = Number(l.upfrontPct);
      if (Number.isFinite(up) && up > 0) lender.upfrontPct = asRate(up);
      if (l.remainder === 'at-end') lender.remainder = 'at-end';
      const cad = Math.round(Number(l.cadenceDays));
      if (Number.isFinite(cad) && cad > 0 && cad !== 7) lender.cadenceDays = cad;
    }
    return lender;
  });
  uniqueNames(lenders, 'lender');
  const [settings, u] = await Promise.all([repo.getSettings(), usage(repo)]);
  guardRemovals(settings.lenders.map((x) => x.name), lenders.map((x) => x.name), u.lenders, 'Lenders');
  await repo.putSetting('lenders', lenders);
  await audit(repo, actorRepId, 'settings.update', '/api/admin/settings/lenders', { count: lenders.length });
  return lenders;
}

export async function savePartners(repo: Repo, input: unknown, actorRepId: string): Promise<ReferralPartner[]> {
  if (!Array.isArray(input)) throw new HttpError(400, 'partners must be a list');
  const partners: ReferralPartner[] = input.map((p: Record<string, unknown>) => {
    const cap = p.monthlyCap === null || p.monthlyCap === '' || p.monthlyCap === undefined ? null : Number(p.monthlyCap);
    if (cap !== null && !(cap >= 0)) throw new HttpError(400, `Partner "${p.name}" has an invalid cap`);
    return { name: cleanName(p.name, 'Referral partner'), pct: asRate(Number(p.pct) || 0), monthlyCap: cap };
  });
  uniqueNames(partners, 'partner');
  const [settings, u] = await Promise.all([repo.getSettings(), usage(repo)]);
  guardRemovals(settings.partners.map((x) => x.name), partners.map((x) => x.name), u.partners, 'Referral partners');
  await repo.putSetting('partners', partners);
  await audit(repo, actorRepId, 'settings.update', '/api/admin/settings/partners', { count: partners.length });
  return partners;
}

export async function saveProducts(repo: Repo, input: unknown, actorRepId: string): Promise<ProductRule[]> {
  if (!Array.isArray(input)) throw new HttpError(400, 'products must be a list');
  const products: ProductRule[] = input.map((p: Record<string, unknown>) => {
    const basis = p.basis === 'draw' || p.basis === 'payback' ? p.basis : 'funded';
    const multiDraw = !!p.multiDraw;
    return {
      name: cleanName(p.name, 'Product'),
      basis,
      factor: !!p.factor,
      term: !!p.term,
      parent: !!p.parent || basis === 'draw',
      comm: asRate(Number(p.comm) || 0),
      clawback: !!p.clawback,
      renewal: !!p.renewal,
      multiDraw,
      drawInitial: multiDraw ? asRate(Number(p.drawInitial) || 0) : null,
      drawSubsequent: multiDraw ? asRate(Number(p.drawSubsequent) || 0) : null,
    };
  });
  uniqueNames(products, 'product');
  const [settings, u] = await Promise.all([repo.getSettings(), usage(repo)]);
  guardRemovals(settings.products.map((x) => x.name), products.map((x) => x.name), u.products, 'Products');
  await repo.putSetting('products', products);
  await audit(repo, actorRepId, 'settings.update', '/api/admin/settings/products', { count: products.length });
  return products;
}

export async function saveThresholds(repo: Repo, input: Record<string, unknown>, actorRepId: string): Promise<Thresholds> {
  const int = (v: unknown, what: string, lo: number, hi: number) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${what} must be between ${lo} and ${hi}`);
    return n;
  };
  const mark = asRate(Number(input.renewalMark));
  if (!(mark > 0 && mark < 1)) throw new HttpError(400, 'Renewal mark must be between 1% and 99%');
  const t: Thresholds = {
    clawbackWindowDays: int(input.clawbackWindowDays, 'Clawback window', 0, 365),
    paymentOverdueDays: int(input.paymentOverdueDays, 'Payment overdue', 0, 365),
    renewalMark: mark,
    additionalCapitalAfterDays: int(input.additionalCapitalAfterDays, 'Additional capital after', 0, 365),
  };
  await repo.putSetting('thresholds', t);
  await audit(repo, actorRepId, 'settings.update', '/api/admin/settings/thresholds', { ...t });
  return t;
}

export async function saveCrm(repo: Repo, input: Record<string, unknown>, actorRepId: string): Promise<Settings['crm']> {
  const urlTemplate = String(input.urlTemplate ?? '').trim();
  if (urlTemplate && !/^https?:\/\//i.test(urlTemplate)) throw new HttpError(400, 'CRM URL template must start with http:// or https://');
  const crm = { urlTemplate };
  await repo.putSetting('crm', crm);
  await audit(repo, actorRepId, 'settings.update', '/api/admin/settings/crm', crm);
  return crm;
}

export async function savePayroll(repo: Repo, input: Record<string, unknown>, actorRepId: string): Promise<Settings['payroll']> {
  const cycles = ['Weekly', 'Twice monthly', 'Monthly', 'Per deal on lender payment'];
  const cycle = String(input.cycle ?? '');
  if (!cycles.includes(cycle)) throw new HttpError(400, `Payout cycle must be one of: ${cycles.join(', ')}`);
  const payroll = { cycle };
  await repo.putSetting('payroll', payroll);
  await audit(repo, actorRepId, 'settings.update', '/api/admin/settings/payroll', payroll);
  return payroll;
}

/* ---------- teams ---------- */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export interface TeamInput {
  name?: string;
  leaderRepId?: string | null;
  overrideRate?: number | null;
}

async function applyLeader(repo: Repo, team: Team, leaderRepId: string | null) {
  if (!leaderRepId) return;
  const leader = await repo.findRep(leaderRepId);
  if (!leader) throw new HttpError(400, `Leader rep ${leaderRepId} does not exist`);
  // A leader belongs to the team they lead and gets team-lead access unless already an admin.
  await repo.updateRep(leader.id, { teamId: team.id, ...(leader.role === 'rep' ? { role: 'manager' as const } : {}) });
}

export async function createTeam(repo: Repo, input: TeamInput, actorRepId: string): Promise<Team> {
  const name = cleanName(input.name, 'Team');
  const teams = await repo.listTeams();
  if (teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, `A team named "${name}" already exists`);
  let id = `team-${slug(name)}`;
  while (teams.some((t) => t.id === id)) id += '-2';
  const team: Team = { id, name, leaderRepId: input.leaderRepId || null, overrideRate: asRate(input.overrideRate ?? 0.05) };
  await repo.insertTeam(team);
  await applyLeader(repo, team, team.leaderRepId);
  await audit(repo, actorRepId, 'team.update', `/api/admin/teams/${id}`, { created: name, leaderRepId: team.leaderRepId });
  return team;
}

export async function updateTeam(repo: Repo, id: string, input: TeamInput, actorRepId: string): Promise<Team> {
  const team = (await repo.listTeams()).find((t) => t.id === id);
  if (!team) throw new HttpError(404, `Team ${id} not found`);
  const patch: Partial<Omit<Team, 'id'>> = {};
  if (input.name !== undefined) patch.name = cleanName(input.name, 'Team');
  if (input.overrideRate !== undefined && input.overrideRate !== null) patch.overrideRate = asRate(input.overrideRate);
  if (input.leaderRepId !== undefined) patch.leaderRepId = input.leaderRepId || null;
  await repo.updateTeam(id, patch);
  const next = { ...team, ...patch };
  if (input.leaderRepId !== undefined) await applyLeader(repo, next, next.leaderRepId);
  await audit(repo, actorRepId, 'team.update', `/api/admin/teams/${id}`, patch);
  return next;
}

/** Refuses while reps are assigned — move them first. */
export async function deleteTeam(repo: Repo, id: string, actorRepId: string): Promise<void> {
  const team = (await repo.listTeams()).find((t) => t.id === id);
  if (!team) throw new HttpError(404, `Team ${id} not found`);
  const staffed = (await repo.listReps()).filter((r) => r.teamId === id);
  if (staffed.length) throw new HttpError(400, `${team.name} still has ${staffed.length} rep${staffed.length === 1 ? '' : 's'} assigned — move them first`);
  await repo.deleteTeam(id);
  await audit(repo, actorRepId, 'team.update', `/api/admin/teams/${id}`, { deleted: team.name });
}

/* ---------- reps ---------- */

export interface RepInput {
  name?: string;
  email?: string;
  teamId?: string | null;
  openerRate?: number | null;
  closerRate?: number | null;
  overrideRate?: number | null;
  role?: Rep['role'];
  active?: boolean;
}

const ROLES: Rep['role'][] = ['rep', 'manager', 'admin'];

export async function createRep(repo: Repo, input: RepInput, actorRepId: string): Promise<Rep> {
  const name = cleanName(input.name, 'Rep');
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'A valid email is required — it is how the rep signs in');
  if (await repo.findRepByEmail(email)) throw new HttpError(400, `${email} is already provisioned`);
  const reps = await repo.listReps();
  let id = `rep-${slug(name)}`;
  while (reps.some((r) => r.id === id)) id += '-2';
  if (input.teamId && !(await repo.listTeams()).some((t) => t.id === input.teamId)) throw new HttpError(400, `Team ${input.teamId} does not exist`);
  const rep: Rep = {
    id,
    name,
    email,
    role: input.role && ROLES.includes(input.role) ? input.role : 'rep',
    teamId: input.teamId || null,
    openerRate: asRate(input.openerRate ?? 0.2),
    closerRate: asRate(input.closerRate ?? 0.2),
    overrideRate: input.overrideRate === null || input.overrideRate === undefined || input.overrideRate === ('' as unknown) ? null : asRate(input.overrideRate),
    active: input.active ?? true,
  };
  await repo.insertRep(rep);
  await audit(repo, actorRepId, 'rep.update', `/api/admin/reps/${id}`, { created: name, email });
  return rep;
}

export async function updateRep(repo: Repo, id: string, input: RepInput, actorRepId: string): Promise<Rep> {
  const rep = await repo.findRep(id);
  if (!rep) throw new HttpError(404, `Rep ${id} not found`);
  const patch: Partial<Omit<Rep, 'id'>> = {};
  if (input.name !== undefined) patch.name = cleanName(input.name, 'Rep');
  if (input.email !== undefined) {
    const email = String(input.email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'A valid email is required');
    const other = await repo.findRepByEmail(email);
    if (other && other.id !== id) throw new HttpError(400, `${email} belongs to ${other.name}`);
    patch.email = email;
  }
  if (input.teamId !== undefined) {
    if (input.teamId && !(await repo.listTeams()).some((t) => t.id === input.teamId)) throw new HttpError(400, `Team ${input.teamId} does not exist`);
    patch.teamId = input.teamId || null;
  }
  if (input.openerRate !== undefined && input.openerRate !== null) patch.openerRate = asRate(input.openerRate);
  if (input.closerRate !== undefined && input.closerRate !== null) patch.closerRate = asRate(input.closerRate);
  if (input.overrideRate !== undefined) patch.overrideRate = input.overrideRate === null || (input.overrideRate as unknown) === '' ? null : asRate(input.overrideRate);
  if (input.role !== undefined) {
    if (!ROLES.includes(input.role)) throw new HttpError(400, `Access must be one of: ${ROLES.join(', ')}`);
    patch.role = input.role;
  }
  if (input.active !== undefined) patch.active = !!input.active;
  // Guards: never lock everyone out.
  if ((patch.role && patch.role !== 'admin' && rep.role === 'admin') || (patch.active === false && rep.role === 'admin')) {
    const admins = (await repo.listReps()).filter((r) => r.role === 'admin' && r.active && r.id !== id);
    if (!admins.length) throw new HttpError(400, `${rep.name} is the last active admin`);
  }
  if (id === actorRepId && (patch.active === false || (patch.role && patch.role !== 'admin'))) throw new HttpError(400, 'You cannot deactivate or demote yourself');
  await repo.updateRep(id, patch);
  await audit(repo, actorRepId, 'rep.update', `/api/admin/reps/${id}`, patch);
  return { ...rep, ...patch };
}
