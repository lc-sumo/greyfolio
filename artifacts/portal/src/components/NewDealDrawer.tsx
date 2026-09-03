import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, post, type AdminDealDetail, type MasterBoard, type RepOption, type Settings } from '../lib/api';
import { compact, fullDay, money, pct, todayIso } from '../lib/format';
import { addBusinessDays, liveMath, num } from '../lib/math';
import { useSession } from '../lib/session';
import { Drawer } from './ui';

type F = Record<string, string>;
const BASIS: Record<string, string> = { funded: 'funded amount', draw: 'draw amount', payback: 'payback amount' };

function Field({ label, hint, children, span }: { label: string; hint?: string; children: React.ReactNode; span?: boolean }) {
  return (
    <label className="field" style={span ? { gridColumn: '1 / -1' } : undefined}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="subtle" style={{ fontSize: 11 }}>{hint}</span>}
    </label>
  );
}

export function NewDealDrawer({ settings, board, onClose, onSaved }: { settings: Settings; board: MasterBoard; onClose: () => void; onSaved: (d: AdminDealDetail) => void }) {
  const { notify } = useSession();
  const qc = useQueryClient();
  const roster = useQuery({ queryKey: ['roster-reps'], queryFn: () => api<{ reps: Array<{ id: string; name: string; teamId: string | null; openerRate: number; closerRate: number; overrideRate: number | null; active: boolean }> }>('/api/admin/reps') });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<{ teams: Array<{ id: string; leaderRepId: string | null; overrideRate: number }> }>('/api/admin/teams').catch(() => ({ teams: [] })) });
  const first = settings.products[0];
  const [f, setF] = useState<F>({
    business: '', merchantContact: '', merchantEmail: '', merchantPhone: '', fundedDate: todayIso(), lender: '', product: first?.name ?? 'MCA', parentId: '',
    amount: '', termDays: '120', factor: '1.35', apr: '', frequency: 'Daily', commRate: String((first?.comm ?? 0.12) * 100), psfPct: '0', originationFee: '0',
    referralPartner: 'None', referralRate: '0', creditLine: '', drawInitialPct: '', drawSubsequentPct: '',
    openerId: '', openerRate: '', closerId: '', closerRate: '', overrideId: '', overrideRate: '',
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const rule = settings.products.find((p) => p.name === f.product);
  const partner = settings.partners.find((p) => p.name === f.referralPartner);
  const reps = roster.data?.reps ?? [];
  const assign: RepOption[] = board.repOptions.assign;

  // Product change → default rates and draw settings from the rule.
  useEffect(() => {
    if (!rule) return;
    setF((s) => ({ ...s, commRate: String((rule.multiDraw ? rule.drawInitial ?? rule.comm : rule.comm) * 100), drawInitialPct: rule.drawInitial ? String(rule.drawInitial * 100) : '', drawSubsequentPct: rule.drawSubsequent ? String(rule.drawSubsequent * 100) : '' }));
  }, [rule?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  // Partner change → prefill its rate.
  useEffect(() => { setF((s) => ({ ...s, referralRate: partner ? String(partner.pct * 100) : '0' })); }, [partner?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opener / closer → rates from profiles; override defaults from the opener's team leader.
  useEffect(() => {
    const o = reps.find((r) => r.id === f.openerId);
    const c = reps.find((r) => r.id === f.closerId);
    const team = teams.data?.teams.find((t) => t.id === o?.teamId);
    const leader = reps.find((r) => r.id === team?.leaderRepId);
    const overrideId = leader && leader.id !== o?.id && leader.id !== c?.id ? leader.id : '';
    setF((s) => ({
      ...s,
      openerRate: o ? String(o.openerRate * 100) : s.openerRate ?? '',
      closerRate: c ? String(c.closerRate * 100) : s.closerRate ?? '',
      overrideId: s.overrideId || overrideId,
      overrideRate: s.overrideRate || (leader ? String((leader.overrideRate ?? team?.overrideRate ?? 0) * 100) : ''),
    }));
  }, [f.openerId, f.closerId, reps.length, teams.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = useMemo(() => liveMath(f, rule, partner), [f, rule, partner]);
  const email = (f.merchantEmail ?? '').trim().toLowerCase();
  const priorDeals = useMemo(() => (email ? board.deals.filter((d) => d.merchantEmail && d.merchantEmail.toLowerCase() === email) : []), [board.deals, email]);
  const parents = board.deals.filter((d) => d.drawSubsequentPct || d.drawCount > 0);
  const renewal = rule?.renewal && m.termDays ? addBusinessDays(f.fundedDate ?? '', m.termDays * settings.thresholds.renewalMark) : null;
  const explainer = !rule
    ? ''
    : rule.basis === 'draw'
      ? `A draw attaches to its parent opportunity. Commission is earned on this draw only — no new factor rate or term, and draws are ${rule.clawback ? 'clawback eligible' : 'exempt from clawback'}.`
      : rule.factor
        ? `Payback is funding amount × factor rate. Commission is calculated on the ${BASIS[rule.basis]}, and the deal ${rule.renewal ? `enters the renewal tracker at the ${Math.round(settings.thresholds.renewalMark * 100)}% paid-in mark` : 'is not renewal tracked'}.`
        : `Amortizing product — no factor rate. Enter the APR and term; commission is a flat ${(rule.comm * 100).toFixed(0)}% of the ${BASIS[rule.basis]} by default and this product is ${rule.clawback ? 'clawback eligible' : 'exempt from clawback'}.`;

  async function save() {
    setErr('');
    setBusy(true);
    try {
      const saved = await post<AdminDealDetail>('/api/admin/deals', {
        business: f.business, merchantContact: f.merchantContact, merchantEmail: f.merchantEmail, merchantPhone: f.merchantPhone, fundedDate: f.fundedDate, lender: f.lender, product: f.product,
        parentId: f.parentId || null, amount: num(f.amount), termDays: rule?.term ? num(f.termDays) || null : null, factor: rule?.factor ? num(f.factor) || null : null, apr: rule && !rule.factor ? num(f.apr) || null : null,
        frequency: f.frequency, commRate: num(f.commRate), psfPct: num(f.psfPct), originationFee: num(f.originationFee), referralPartner: f.referralPartner === 'None' ? null : f.referralPartner, referralRate: num(f.referralRate),
        creditLine: rule?.multiDraw ? num(f.creditLine) || null : null, drawInitialPct: rule?.multiDraw ? num(f.drawInitialPct) : null, drawSubsequentPct: rule?.multiDraw ? num(f.drawSubsequentPct) : null,
        openerId: f.openerId || null, openerRate: num(f.openerRate), closerId: f.closerId || null, closerRate: num(f.closerRate), overrideId: f.overrideId || null, overrideRate: num(f.overrideRate),
        leadSource: priorDeals.length ? 'Existing client' : 'Direct',
      });
      await qc.invalidateQueries();
      notify(`${saved.id} saved — ${saved.roles.filter((r) => r.repId).length} rep portal(s) updated`);
      onSaved(saved);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const amountLabel = rule?.multiDraw ? 'Initial draw amount' : rule?.basis === 'draw' ? 'Draw amount' : 'Funded amount';
  return (
    <Drawer title="New deal" sub="Funded deals only — the funded date cannot be in the future." onClose={onClose}>
      <div className="form">
        <Field label="Product" span>
          <select value={f.product} onChange={set('product')}>{settings.products.map((p) => <option key={p.name}>{p.name}</option>)}</select>
          <span className="muted" style={{ fontSize: 12 }}>{explainer}</span>
        </Field>
        {rule?.parent && (
          <Field label="Parent opportunity" span>
            <select value={f.parentId} onChange={set('parentId')}>
              <option value="">— choose the opportunity this draw belongs to —</option>
              {parents.map((d) => <option key={d.id} value={d.id}>{d.id} · {d.business} · {compact(d.funded)}{d.drawCount ? ` · ${d.drawCount} draws` : ''}</option>)}
            </select>
          </Field>
        )}
        <Field label="Business name" span><input value={f.business} onChange={set('business')} placeholder="Northstar Dental Group" /></Field>
        <Field label="Merchant contact"><input value={f.merchantContact} onChange={set('merchantContact')} /></Field>
        <Field label="Merchant phone"><input value={f.merchantPhone} onChange={set('merchantPhone')} /></Field>
        <Field label="Merchant email" span hint={priorDeals.length ? `Existing merchant — ${priorDeals.length} prior deal(s) totalling ${compact(priorDeals.reduce((s, d) => s + d.funded, 0))} funded. This deal files under the same merchant record.` : 'All deals group by merchant email.'}>
          <input type="email" value={f.merchantEmail} onChange={set('merchantEmail')} />
        </Field>
        <Field label="Funded date"><input type="date" max={todayIso()} value={f.fundedDate} onChange={set('fundedDate')} /></Field>
        <Field label="Lender">
          <select value={f.lender} onChange={set('lender')}>
            <option value="">— select —</option>
            {settings.lenders.map((l) => <option key={l.name} value={l.name}>{l.name}{l.terms === 'weekly' ? ` · weekly ×${l.weeks}` : ''}</option>)}
          </select>
        </Field>
        <Field label={amountLabel}><input inputMode="decimal" value={f.amount} onChange={set('amount')} placeholder="125000" /></Field>
        {rule?.term && <Field label="Term length (business days)" hint="Mon–Fri only, excludes weekends"><input inputMode="numeric" value={f.termDays} onChange={set('termDays')} /></Field>}
        {rule?.factor ? <Field label="Factor rate"><input inputMode="decimal" value={f.factor} onChange={set('factor')} /></Field> : <Field label="Interest rate (APR %)"><input inputMode="decimal" value={f.apr} onChange={set('apr')} /></Field>}
        <Field label="Payment frequency"><select value={f.frequency} onChange={set('frequency')}>{settings.lists.frequencies.map((x) => <option key={x}>{x}</option>)}</select></Field>
        {rule?.multiDraw && (
          <>
            <Field label="Credit line"><input inputMode="decimal" value={f.creditLine} onChange={set('creditLine')} /></Field>
            <Field label="Initial draw %"><input inputMode="decimal" value={f.drawInitialPct} onChange={(e) => setF((s) => ({ ...s, drawInitialPct: e.target.value, commRate: e.target.value }))} /></Field>
            <Field label="Subsequent draw %"><input inputMode="decimal" value={f.drawSubsequentPct} onChange={set('drawSubsequentPct')} /></Field>
          </>
        )}
        <Field label="Commission %"><input inputMode="decimal" value={f.commRate} onChange={set('commRate')} /></Field>
        <Field label="PSF %"><input inputMode="decimal" value={f.psfPct} onChange={set('psfPct')} /></Field>
        <Field label="Total (comm + PSF)" hint="computed"><input readOnly value={money(m.commission + m.psf)} className="ro" /></Field>
        <Field label="Origination fee ($)"><input inputMode="decimal" value={f.originationFee} onChange={set('originationFee')} /></Field>
        <Field label="Referral partner"><select value={f.referralPartner} onChange={set('referralPartner')}>{settings.partners.map((p) => <option key={p.name}>{p.name}</option>)}</select></Field>
        <Field label="Referral fee %"><input inputMode="decimal" value={f.referralRate} onChange={set('referralRate')} /></Field>
        <Field label="Payback" hint="computed"><input readOnly className="ro" value={m.payback === null ? 'n/a for this product' : money(m.payback)} /></Field>
        <Field label="Est. renewal date" hint="computed"><input readOnly className="ro" value={renewal ? fullDay(renewal) : 'Not renewal tracked'} /></Field>

        <div className="label" style={{ gridColumn: '1 / -1', marginTop: 6 }}>Splits · active reps only</div>
        {(['opener', 'closer', 'override'] as const).map((role) => (
          <div key={role} className="split-row">
            <Field label={role === 'override' ? 'Override rep' : role[0]!.toUpperCase() + role.slice(1)}>
              <select value={f[`${role}Id`]} onChange={set(`${role}Id`)}>
                <option value="">— none —</option>
                {assign.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Rate %"><input inputMode="decimal" value={f[`${role}Rate`]} onChange={set(`${role}Rate`)} /></Field>
            <div><span className="label">Payout</span><div className="num" style={{ paddingTop: 8 }}>{money(role === 'opener' ? m.openerPayout : role === 'closer' ? m.closerPayout : m.overridePayout)}</div></div>
          </div>
        ))}
      </div>

      <section className="share">
        <div className="label" style={{ color: 'var(--navy-text-3)' }}>Live math</div>
        <dl className="kv navy">
          <dt>Commission $</dt><dd>{money(m.commission)}</dd>
          <dt>PSF $</dt><dd>{money(m.psf)}</dd>
          <dt>Origination fee</dt><dd>{money(m.originationFee)}</dd>
          <dt>Gross (comm + PSF + orig)</dt><dd>{money(m.gross)}</dd>
          <dt>Referral fee{m.referralCapped ? ' (capped)' : ''}</dt><dd style={{ color: 'var(--amber-bright)' }}>{money(-m.referralFee)}</dd>
          <dt>Net commission</dt><dd>{money(m.net)}</dd>
          <dt>Total rep payout</dt><dd style={{ color: 'var(--amber-bright)' }}>{money(m.totalRepPayout)}</dd>
          <dt>House net</dt><dd style={{ color: 'var(--teal-bright)' }}>{money(m.houseNet)}</dd>
        </dl>
      </section>
      {err && <div className="note" style={{ background: 'var(--red-light)', borderColor: 'var(--red-light-2)', color: 'var(--red)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 9 }}>
        <button className="btn primary big" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save deal & push to Sheets'}</button>
        <button className="btn big" onClick={onClose}>Cancel</button>
      </div>
      <div className="subtle" style={{ fontSize: 11 }}>Rates: {pct(0.2)} means 20 — type either.</div>
    </Drawer>
  );
}
