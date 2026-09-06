/**
 * Playbook rule shapes and the pure parts of evaluating them. No I/O here,
 * so the browser demo and the tests share the same logic as the scheduler.
 */
import type { RenewalBucket } from '@greystone/commission';

export type PlaybookTrigger =
  /** Percent of the term paid in (the renewal engine's paid-in figure), 0–100. */
  | { kind: 'paidInPct'; atLeast: number }
  | { kind: 'daysSinceFunding'; atLeast: number }
  | { kind: 'daysToMaturity'; atMost: number }
  | { kind: 'bucket'; in: RenewalBucket[] }
  /** Dollars of a line of credit not yet drawn. */
  | { kind: 'locUnused'; atLeast: number }
  | { kind: 'status'; in: string[] }
  /** Commission expected from the lender but not received past the lender's payment terms. */
  | { kind: 'lenderOverdue' }
  | { kind: 'clawbackWindowClosing'; withinDays: number }
  | { kind: 'noNoteDays'; atLeast: number };

export interface PlaybookFilters {
  lenders?: string[];
  products?: string[];
  teams?: string[];
  reps?: string[];
  minFunded?: number;
}

export type PlaybookAction =
  | { kind: 'emailRep'; subject: string; body: string }
  | { kind: 'emailAdmins'; subject: string; body: string }
  | { kind: 'task'; title: string; dueInDays: number }
  | { kind: 'setStatus'; status: string };

export interface PlaybookRule {
  trigger: PlaybookTrigger;
  filters: PlaybookFilters;
  actions: PlaybookAction[];
  /** Fire again this many days after the last firing while the condition holds; null = once per deal. */
  repeatDays: number | null;
}

export const TRIGGER_KINDS: Array<{ kind: PlaybookTrigger['kind']; label: string; param?: 'atLeast' | 'atMost' | 'withinDays' | 'in'; unit?: string }> = [
  { kind: 'paidInPct', label: 'Paid-in percent reaches', param: 'atLeast', unit: '%' },
  { kind: 'daysSinceFunding', label: 'Days since funding reaches', param: 'atLeast', unit: 'days' },
  { kind: 'daysToMaturity', label: 'Days to maturity drops to', param: 'atMost', unit: 'days' },
  { kind: 'bucket', label: 'Renewal stage is', param: 'in' },
  { kind: 'locUnused', label: 'Unused credit line is at least', param: 'atLeast', unit: '$' },
  { kind: 'status', label: 'Deal status is', param: 'in' },
  { kind: 'lenderOverdue', label: 'Lender payment is overdue' },
  { kind: 'clawbackWindowClosing', label: 'Clawback window closes within', param: 'withinDays', unit: 'days' },
  { kind: 'noNoteDays', label: 'No note on the deal for', param: 'atLeast', unit: 'days' },
];

export const TASK_OUTCOMES: Array<{ value: 'called' | 'no_answer' | 'app_submitted' | 'funded' | 'declined' | 'not_interested'; label: string; closes: boolean }> = [
  { value: 'called', label: 'Called, in progress', closes: false },
  { value: 'no_answer', label: 'No answer, try again', closes: false },
  { value: 'app_submitted', label: 'Application submitted', closes: true },
  { value: 'funded', label: 'Funded', closes: true },
  { value: 'declined', label: 'Declined by lender', closes: true },
  { value: 'not_interested', label: 'Merchant not interested', closes: true },
];

/** Everything a rule can look at for one deal, computed once per evaluation. */
export interface DealFacts {
  dealId: string;
  business: string;
  lender: string;
  product: string;
  funded: number;
  fundedDate: string;
  teamId: string | null;
  /** Who should act: the closer, else the opener. */
  ownerRepId: string | null;
  ownerFirst: string;
  paidInPct: number;
  daysSinceFunding: number;
  daysToMaturity: number | null;
  bucket: RenewalBucket;
  bucketLabel: string;
  locUnused: number;
  status: string;
  lenderOverdue: boolean;
  clawbackDaysLeft: number | null;
  daysSinceLastNote: number | null;
  estEligible: number;
  estRenewalGross: number;
  crmUrl: string | null;
  merchantContact: string;
  merchantEmail: string;
  merchantPhone: string;
}

export function triggerMatches(t: PlaybookTrigger, f: DealFacts): boolean {
  switch (t.kind) {
    case 'paidInPct':
      return f.paidInPct >= t.atLeast;
    case 'daysSinceFunding':
      return f.daysSinceFunding >= t.atLeast;
    case 'daysToMaturity':
      return f.daysToMaturity !== null && f.daysToMaturity >= 0 && f.daysToMaturity <= t.atMost;
    case 'bucket':
      return t.in.includes(f.bucket);
    case 'locUnused':
      return f.locUnused >= t.atLeast && f.locUnused > 0;
    case 'status':
      return t.in.includes(f.status);
    case 'lenderOverdue':
      return f.lenderOverdue;
    case 'clawbackWindowClosing':
      return f.clawbackDaysLeft !== null && f.clawbackDaysLeft >= 0 && f.clawbackDaysLeft <= t.withinDays;
    case 'noNoteDays':
      return f.daysSinceLastNote === null || f.daysSinceLastNote >= t.atLeast;
  }
}

export function filtersMatch(fl: PlaybookFilters, f: DealFacts): boolean {
  if (fl.lenders?.length && !fl.lenders.includes(f.lender)) return false;
  if (fl.products?.length && !fl.products.includes(f.product)) return false;
  if (fl.teams?.length && (!f.teamId || !fl.teams.includes(f.teamId))) return false;
  if (fl.reps?.length && (!f.ownerRepId || !fl.reps.includes(f.ownerRepId))) return false;
  if (fl.minFunded && f.funded < fl.minFunded) return false;
  return true;
}

export function ruleMatches(rule: PlaybookRule, f: DealFacts): boolean {
  return filtersMatch(rule.filters ?? {}, f) && triggerMatches(rule.trigger, f);
}

/** Days between two YYYY-MM-DD dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/** Merge fields available in subjects, bodies and merchant templates. */
export function mergeFields(f: DealFacts, extra: { link: string; repName?: string; company?: string } = { link: '' }): Record<string, string> {
  return {
    merchant: f.business,
    contact: f.merchantContact || 'there',
    'rep.first': f.ownerFirst,
    'rep.name': extra.repName ?? f.ownerFirst,
    company: extra.company ?? '',
    lender: f.lender,
    product: f.product,
    funded: money(f.funded),
    fundedDate: f.fundedDate,
    paidIn: `${Math.round(f.paidInPct)}%`,
    daysSinceFunding: String(f.daysSinceFunding),
    daysToMaturity: f.daysToMaturity === null ? '—' : String(f.daysToMaturity),
    stage: f.bucketLabel,
    unusedLine: money(f.locUnused),
    eligible: money(f.estEligible),
    estCommission: money(f.estRenewalGross),
    status: f.status,
    crm: f.crmUrl ?? '',
    link: extra.link,
  };
}

/** `{{field}}` substitution; unknown fields are left visible so a typo shows up in the dry run. */
export function renderTemplate(text: string, fields: Record<string, string>): string {
  return String(text ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k: string) => (k in fields ? fields[k]! : m));
}

export const MERGE_FIELD_HELP = ['merchant', 'contact', 'rep.first', 'rep.name', 'company', 'lender', 'product', 'funded', 'fundedDate', 'paidIn', 'daysSinceFunding', 'daysToMaturity', 'stage', 'unusedLine', 'eligible', 'estCommission', 'status', 'crm', 'link'];

/** Validate a rule from the settings form. Throws a readable message. */
export function normalizeRule(input: unknown): PlaybookRule {
  const r = (input ?? {}) as Partial<PlaybookRule>;
  const t = (r.trigger ?? {}) as Record<string, unknown>;
  const num = (v: unknown, what: string, min = 0) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) throw new Error(`${what} must be a number ≥ ${min}`);
    return n;
  };
  const strs = (v: unknown, what: string) => {
    const out = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
    if (!out.length) throw new Error(`${what} needs at least one value`);
    return out;
  };
  let trigger: PlaybookTrigger;
  switch (t.kind) {
    case 'paidInPct':
      trigger = { kind: 'paidInPct', atLeast: num(t.atLeast, 'Paid-in percent') };
      break;
    case 'daysSinceFunding':
      trigger = { kind: 'daysSinceFunding', atLeast: num(t.atLeast, 'Days since funding') };
      break;
    case 'daysToMaturity':
      trigger = { kind: 'daysToMaturity', atMost: num(t.atMost, 'Days to maturity') };
      break;
    case 'bucket':
      trigger = { kind: 'bucket', in: strs(t.in, 'Renewal stage') as RenewalBucket[] };
      break;
    case 'locUnused':
      trigger = { kind: 'locUnused', atLeast: num(t.atLeast, 'Unused line') };
      break;
    case 'status':
      trigger = { kind: 'status', in: strs(t.in, 'Deal status') };
      break;
    case 'lenderOverdue':
      trigger = { kind: 'lenderOverdue' };
      break;
    case 'clawbackWindowClosing':
      trigger = { kind: 'clawbackWindowClosing', withinDays: num(t.withinDays, 'Days before the window closes') };
      break;
    case 'noNoteDays':
      trigger = { kind: 'noNoteDays', atLeast: num(t.atLeast, 'Days without a note', 1) };
      break;
    default:
      throw new Error('Pick a trigger');
  }
  const fl = (r.filters ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const filters: PlaybookFilters = {};
  if (list(fl.lenders).length) filters.lenders = list(fl.lenders);
  if (list(fl.products).length) filters.products = list(fl.products);
  if (list(fl.teams).length) filters.teams = list(fl.teams);
  if (list(fl.reps).length) filters.reps = list(fl.reps);
  if (fl.minFunded !== undefined && fl.minFunded !== null && fl.minFunded !== '') filters.minFunded = num(fl.minFunded, 'Minimum funded');
  const actions: PlaybookAction[] = [];
  for (const a of Array.isArray(r.actions) ? (r.actions as Array<Record<string, unknown>>) : []) {
    const text = (v: unknown, what: string, max: number) => {
      const s = String(v ?? '').trim();
      if (!s) throw new Error(`${what} is required`);
      return s.slice(0, max);
    };
    if (a.kind === 'emailRep' || a.kind === 'emailAdmins') actions.push({ kind: a.kind, subject: text(a.subject, 'Email subject', 160), body: text(a.body, 'Email body', 4000) });
    else if (a.kind === 'task') actions.push({ kind: 'task', title: text(a.title, 'Task title', 160), dueInDays: num(a.dueInDays ?? 3, 'Due in days') });
    else if (a.kind === 'setStatus') actions.push({ kind: 'setStatus', status: text(a.status, 'Status', 60) });
    else throw new Error('Unknown action');
  }
  if (!actions.length) throw new Error('Add at least one action');
  const repeatDays = r.repeatDays === null || r.repeatDays === undefined || (r.repeatDays as unknown) === '' ? null : num(r.repeatDays, 'Repeat every', 1);
  return { trigger, filters, actions, repeatDays };
}
