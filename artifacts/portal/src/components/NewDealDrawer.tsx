import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useMemo, useState } from 'react';
import { api, post, type AdminDealDetail, type MasterBoard, type RepOption, type Settings } from '../lib/api';
import { compact, day, fullDay, money, pct, todayIso } from '../lib/format';
import { addBusinessDays, liveMath, num } from '../lib/math';
import { useSession } from '../lib/session';
import { Drawer, Pill, toneFor } from './ui';

type F = Record<string, string>;
const BASIS: Record<string, string> = { funded: 'funded amount', draw: 'draw amount', payback: 'payback amount' };

function Field({ label, hint, children, span }: { label: React.ReactNode; hint?: string; children: React.ReactNode; span?: boolean }) {
  return (
    <label className="field" style={span ? { gridColumn: '1 / -1' } : undefined}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="subtle" style={{ fontSize: 13 }}>{hint}</span>}
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
    business: '', crmId: '', merchantContact: '', merchantEmail: '', merchantPhone: '', fundedDate: todayIso(), lender: '', product: first?.name ?? 'MCA', parentId: '',
    amount: '', termDays: '120', factor: '1.35', apr: '', frequency: 'Daily', commRate: String((first?.comm ?? 0.12) * 100), psfPct: '0', psfMode: '%', psfDollars: '', originationFee: '0',
    referralPartner: 'None', referralRate: '0', creditLine: '', drawInitialPct: '', drawSubsequentPct: '',
    openerId: '', openerRate: '', closerId: '', closerRate: '', overrideId: '', overrideRate: '',
    payout: 'lender', commIncrements: '', commUpfrontPct: '', commRemainder: 'spread', commCadenceDays: '7', commStartDate: '',
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const rule = settings.products.find((p) => p.name === f.product);
  const lender = settings.lenders.find((l) => l.name === f.lender);
  // Increments are a consolidation thing: the structure block only shows (and only saves) on incremental products.
  const canIncrement = !!rule?.incremental;
  const incremental = canIncrement && (f.payout === 'increments' || (f.payout === 'lender' && lender?.terms === 'weekly'));
  const partner = settings.partners.find((p) => p.name === f.referralPartner);
  const reps = roster.data?.reps ?? [];
  const assign: RepOption[] = board.repOptions.assign;

  // Product change → default rates and draw settings from the rule.
  useEffect(() => {
    if (!rule) return;
    setF((s) => ({ ...s, commRate: String((rule.multiDraw ? rule.drawInitial ?? rule.comm : rule.comm) * 100), drawInitialPct: rule.drawInitial ? String(rule.drawInitial * 100) : '', drawSubsequentPct: rule.drawSubsequent ? String(rule.drawSubsequent * 100) : '' }));
  }, [rule?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  // Lender change → seed the payout structure from the lender's defaults.
  useEffect(() => {
    if (!lender) return;
    setF((s) => ({ ...s, commIncrements: lender.terms === 'weekly' ? String(lender.weeks) : s.commIncrements ?? '', commUpfrontPct: lender.upfrontPct ? String(lender.upfrontPct * 100) : s.payout === 'lender' ? '' : s.commUpfrontPct ?? '', commRemainder: lender.remainder ?? 'spread', commCadenceDays: String(lender.cadenceDays ?? 7) }));
  }, [lender?.name]); // eslint-disable-line react-hooks/exhaustive-deps
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

  // Referral fees already owed to this partner on deals funded the same month — the monthly cap nets against them.
  const referralPaidThisMonth = useMemo(() => {
    if (!partner || partner.name === 'None') return 0;
    const month = (f.fundedDate ?? '').slice(0, 7);
    return board.deals.filter((d) => d.referralPartner === partner.name && d.date.startsWith(month)).reduce((s, d) => s + d.referralFee, 0);
  }, [board.deals, partner, f.fundedDate]);
  const m = useMemo(() => liveMath(f, rule, partner, referralPaidThisMonth), [f, rule, partner, referralPaidThisMonth]);
  const email = (f.merchantEmail ?? '').trim().toLowerCase();
  const priorDeals = useMemo(() => (email ? board.deals.filter((d) => d.merchantEmail && d.merchantEmail.toLowerCase() === email).sort((a, b) => b.date.localeCompare(a.date)) : []), [board.deals, email]);
  const client = priorDeals[0];
  // Existing client: the email matched an account → pull its profile in and link the deal to it.
  // Fields we filled from the profile are remembered, so they clear again if the email stops matching.
  const [auto, setAuto] = useState<Partial<F>>({});
  useEffect(() => {
    const next: Partial<F> = client ? { business: client.business, merchantContact: client.merchantContact, merchantPhone: client.merchantPhone } : {};
    setF((s) => {
      const out = { ...s };
      for (const k of ['business', 'merchantContact', 'merchantPhone'] as const) {
        const untouched = !s[k] || s[k] === auto[k];
        if (untouched) out[k] = next[k] ?? '';
      }
      return out;
    });
    setAuto(next);
  }, [client?.merchantEmail]); // eslint-disable-line react-hooks/exhaustive-deps
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
        business: f.business, crmId: f.crmId || null, merchantContact: f.merchantContact, merchantEmail: f.merchantEmail, merchantPhone: f.merchantPhone, fundedDate: f.fundedDate, lender: f.lender, product: f.product,
        parentId: f.parentId || null, amount: num(f.amount), termDays: rule?.term ? num(f.termDays) || null : null, factor: rule?.factor ? num(f.factor) || null : null, apr: rule && !rule.factor ? num(f.apr) || null : null,
        frequency: f.frequency, commRate: num(f.commRate), psfPct: m.psfRate * 100, originationFee: num(f.originationFee), referralPartner: f.referralPartner === 'None' ? null : f.referralPartner,
        creditLine: rule?.multiDraw ? num(f.creditLine) || null : null, drawInitialPct: rule?.multiDraw ? num(f.drawInitialPct) : null, drawSubsequentPct: rule?.multiDraw ? num(f.drawSubsequentPct) : null,
        openerId: f.openerId || null, openerRate: num(f.openerRate), closerId: f.closerId || null, closerRate: num(f.closerRate), overrideId: f.overrideId || null, overrideRate: num(f.overrideRate),
        leadSource: priorDeals.length ? 'Existing client' : 'Direct',
        commIncrements: f.payout === 'upfront' ? 0 : incremental ? num(f.commIncrements) || null : null,
        commUpfrontPct: incremental ? num(f.commUpfrontPct) : null,
        commRemainder: incremental ? (f.commRemainder as 'spread' | 'at-end') : null,
        commCadenceDays: incremental ? num(f.commCadenceDays) || 7 : null,
        commStartDate: incremental && f.commStartDate ? f.commStartDate : null,
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
      <div className="drawer-cols">
      <div className="form">
        <Field label="Product" span>
          <select value={f.product} onChange={set('product')}>{settings.products.map((p) => <option key={p.name}>{p.name}</option>)}</select>
          <span className="muted" style={{ fontSize: 14 }}>{explainer}</span>
        </Field>
        {rule?.parent && (
          <Field label="Parent opportunity" span>
            <select value={f.parentId} onChange={set('parentId')}>
              <option value="">— choose the opportunity this draw belongs to —</option>
              {parents.map((d) => <option key={d.id} value={d.id}>{d.id} · {d.business} · {compact(d.funded)}{d.drawCount ? ` · ${d.drawCount} draws` : ''}</option>)}
            </select>
          </Field>
        )}
        <Field label="Business name"><input value={f.business} onChange={set('business')} placeholder="Northstar Dental Group" /></Field>
        <Field label="Deal ID (CRM)" hint="The sheet row number is assigned automatically"><input value={f.crmId} onChange={set('crmId')} placeholder="OPP-48213" /></Field>
        <Field label="Merchant contact"><input value={f.merchantContact} onChange={set('merchantContact')} /></Field>
        <Field label="Merchant phone"><input value={f.merchantPhone} onChange={set('merchantPhone')} /></Field>
        <Field label="Merchant email" hint={client ? 'Existing client — profile pulled in below.' : 'Type the email first: an existing client\u2019s profile fills in automatically.'}>
          <input type="email" value={f.merchantEmail} onChange={set('merchantEmail')} placeholder="owner@business.com" />
        </Field>
        {client && (
          <div className="client" data-testid="client-profile">
            <div className="head">
              <div><Pill tone="teal">Existing client</Pill> <b style={{ marginLeft: 8 }}>{client.business}</b><span className="subtle"> · {client.merchantContact || 'no contact on file'}{client.merchantPhone ? ` · ${client.merchantPhone}` : ''}</span></div>
              <span className="subtle">{priorDeals.length} deal{priorDeals.length === 1 ? '' : 's'} · {compact(priorDeals.reduce((s, d) => s + d.funded, 0))} funded · this deal links to the same account</span>
            </div>
            <div className="deals">
              <div className="h"><span>Deal ID</span><span>Funded</span><span>Lender · product</span><span>Amount</span><span>Lender paid</span><span>Status</span></div>
              {priorDeals.map((d) => (
                <div key={d.id}>
                  <span className="num">{d.crmId ?? d.id}</span>
                  <span className="num">{day(d.date)}</span>
                  <span className="ellipsis">{d.lender} · {d.product}{d.drawCount ? ` · ${d.drawCount} draw${d.drawCount > 1 ? 's' : ''}` : ''}</span>
                  <span className="num">{money(d.funded)}</span>
                  <span className="num subtle">{d.lenderPaidLabel}</span>
                  <span><Pill tone={toneFor(d.dealStatus)}>{d.dealStatus}</Pill></span>
                </div>
              ))}
            </div>
          </div>
        )}
        <Field label="Funded date"><input type="date" max={todayIso()} value={f.fundedDate} onChange={set('fundedDate')} /></Field>
        <Field label="Lender">
          <select value={f.lender} onChange={set('lender')}>
            <option value="">— select —</option>
            {settings.lenders.filter((l) => !l.products?.length || l.products.includes(f.product ?? '')).map((l) => <option key={l.name} value={l.name}>{l.name}{canIncrement && l.terms === 'weekly' ? ` · ${l.weeks} increments` : ''}{l.clawback ? l.clawback.basis === 'none' ? ' · no clawback' : ` · clawback ${l.clawback.count} ${l.clawback.basis}` : ''}</option>)}
          </select>
          <span className="subtle" style={{ fontSize: 13 }}>Only lenders set up for {f.product} (Settings › Lenders).</span>
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
        <Field label={<span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>PSF <span className="seg" role="group" aria-label="PSF entry mode"><button type="button" className={f.psfMode === '%' ? 'on' : ''} onClick={() => setF((s) => ({ ...s, psfMode: '%', psfPct: s.psfMode === '$' ? String(Math.round(m.psfRate * 10000) / 100) : s.psfPct ?? '' }))}>%</button><button type="button" className={f.psfMode === '$' ? 'on' : ''} onClick={() => setF((s) => ({ ...s, psfMode: '$', psfDollars: s.psfMode === '%' ? String(Math.round(m.psf)) : s.psfDollars ?? '' }))}>$</button></span></span>} hint={f.psfMode === '$' ? `= ${(m.psfRate * 100).toFixed(2)}% of the funded amount` : `= ${money(m.psf)}`}>
          {f.psfMode === '$' ? <input inputMode="decimal" value={f.psfDollars} onChange={set('psfDollars')} placeholder="2500" /> : <input inputMode="decimal" value={f.psfPct} onChange={set('psfPct')} />}
        </Field>
        <Field label="Total (comm + PSF)" hint="computed"><input readOnly value={money(m.commission + m.psf)} className="ro" /></Field>
        <Field label="Origination fee ($)"><input inputMode="decimal" value={f.originationFee} onChange={set('originationFee')} /></Field>
        <Field label="Referral partner"><select value={f.referralPartner} onChange={set('referralPartner')}>{settings.partners.map((p) => <option key={p.name}>{p.name}</option>)}</select></Field>
        <Field label="Referral fee %" hint={partner && partner.name !== 'None' ? (partner.monthlyCap ? `Cap ${money(partner.monthlyCap)}/month · ${money(referralPaidThisMonth)} already owed this month${m.referralExcess ? ` · ${money(m.referralExcess)} over the cap is excess we do not pay` : ''}` : 'No cap') : 'Locked — set in Settings › Referral partners'}>
          <input readOnly className="ro" value={partner && partner.name !== 'None' ? `${(partner.pct * 100).toFixed(partner.pct * 100 % 1 ? 2 : 0)}%` : '—'} title="Locked — change it in Settings › Referral partners" />
        </Field>
        <div className="label" style={{ gridColumn: '1 / -1', marginTop: 6 }}>Commission payout from the lender</div>
        {!canIncrement && rule && <div className="note" style={{ gridColumn: '1 / -1' }}>{rule.name} commission is paid upfront by the lender. Increment structures (upfront share, number of increments, cadence) apply to consolidations only — not LOCs or LOC draws.</div>}
        {canIncrement && <Field label="Payout structure" span>
          <select value={f.payout} onChange={set('payout')}>
            <option value="lender">{lender ? (lender.terms === 'weekly' ? `Lender default — ${lender.weeks} increments${lender.upfrontPct ? `, ${Math.round(lender.upfrontPct * 100)}% upfront` : ''}${lender.remainder === 'at-end' ? ', rest when done' : ''}` : 'Lender default — all upfront at funding') : 'Lender default'}</option>
            <option value="upfront">All upfront at funding</option>
            <option value="increments">In increments (consolidation-style)</option>
          </select>
        </Field>}
        {incremental && (
          <>
            <Field label="Upfront share %" hint="e.g. 50 → half at funding, the rest per the structure below"><input inputMode="decimal" placeholder="0" value={f.commUpfrontPct} onChange={set('commUpfrontPct')} /></Field>
            <Field label="Number of increments"><input inputMode="numeric" value={f.commIncrements} onChange={set('commIncrements')} /></Field>
            <Field label="Remainder">
              <select value={f.commRemainder} onChange={set('commRemainder')}>
                <option value="spread">Spread evenly across the increments</option>
                <option value="at-end">Paid once, when the increments are done</option>
              </select>
            </Field>
            <Field label="Increment cadence">
              <select value={f.commCadenceDays} onChange={set('commCadenceDays')}><option value="7">Weekly</option><option value="14">Bi-weekly</option><option value="30">Monthly</option></select>
            </Field>
            <Field label="First increment expected" hint="defaults to one cadence after funding"><input type="date" value={f.commStartDate} onChange={set('commStartDate')} /></Field>
            <div className="note" style={{ gridColumn: '1 / -1' }}>{structureNote(m.gross, f)}</div>
          </>
        )}
        <Field label="Payback" hint="computed"><input readOnly className="ro" value={m.payback === null ? 'n/a for this product' : money(m.payback)} /></Field>
        <Field label={`Payment (${f.frequency || 'Daily'})`} hint={m.payment === null ? 'needs amount, rate and term' : `payback ÷ ${f.frequency === 'Weekly' ? 'weeks' : f.frequency === 'Bi-Weekly' ? 'two-week periods' : f.frequency === 'Monthly' ? 'months' : 'business days'} in the term`}><input readOnly className="ro" value={m.payment === null ? '—' : money(m.payment)} /></Field>
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

      <section className="share" style={{ position: 'sticky', top: 0 }}>
        <div className="label" style={{ color: 'var(--navy-text-3)' }}>Live math</div>
        <dl className="kv navy big-kv">
          <dt className="grp">Merchant</dt><dd />
          <dt>Funded</dt><dd>{money(num(f.amount))}</dd>
          <dt>Payback{rule?.factor && num(f.factor) ? ` (×${num(f.factor)})` : ''}</dt><dd>{m.payback === null ? '—' : money(m.payback)}</dd>
          <dt>Payment · {f.frequency || 'Daily'}</dt><dd>{m.payment === null ? '—' : money(m.payment)}</dd>
          <dt>Term</dt><dd>{m.termDays ? `${m.termDays} business days` : '—'}</dd>
          <dt className="grp">Commission</dt><dd />
          <dt>Commission {num(f.commRate) ? `${num(f.commRate)}%` : ''}</dt><dd>{money(m.commission)}</dd>
          <dt>PSF {m.psfRate ? `${(m.psfRate * 100).toFixed(2).replace(/\.?0+$/, '')}%` : ''}</dt><dd>{money(m.psf)}</dd>
          <dt>Origination fee</dt><dd>{money(m.originationFee)}</dd>
          <dt className="sum">Gross (comm + PSF + orig)</dt><dd className="sum">{money(m.gross)}</dd>
          <dt className="grp">Referral{partner && partner.name !== 'None' ? ` · ${partner.name} ${Math.round(partner.pct * 100)}%` : ''}</dt><dd />
          {partner && partner.name !== 'None' && partner.monthlyCap ? (
            <>
              <dt>Fee before cap</dt><dd>{money(m.referralRaw)}</dd>
              <dt>Cap {money(partner.monthlyCap)}/mo · owed so far</dt><dd>{money(referralPaidThisMonth)}</dd>
              <dt>Excess not paid</dt><dd style={{ color: m.referralExcess ? 'var(--teal-bright)' : undefined }}>{money(m.referralExcess)}</dd>
            </>
          ) : null}
          <dt>Referral fee paid{m.referralCapped ? ' (capped)' : ''}</dt><dd style={{ color: 'var(--amber-bright)' }}>{money(-m.referralFee)}</dd>
          <dt className="sum">Net commission</dt><dd className="sum">{money(m.net)}</dd>
          <dt className="grp">Split</dt><dd />
          {(['opener', 'closer', 'override'] as const).map((role) => {
            const id = f[`${role}Id`];
            const who = assign.find((o) => o.id === id)?.label ?? '—';
            const amt = role === 'opener' ? m.openerPayout : role === 'closer' ? m.closerPayout : m.overridePayout;
            return <React.Fragment key={role}><dt>{role === 'override' ? 'Override' : role[0]!.toUpperCase() + role.slice(1)} · {who}{id ? ` ${num(f[`${role}Rate`])}%` : ''}</dt><dd>{money(amt)}</dd></React.Fragment>;
          })}
          <dt>Total rep payout</dt><dd style={{ color: 'var(--amber-bright)' }}>{money(m.totalRepPayout)}</dd>
          <dt className="sum">House net</dt><dd className="sum" style={{ color: 'var(--teal-bright)' }}>{money(m.houseNet)}</dd>
        </dl>
      </section>
      </div>
      {err && <div className="note" style={{ background: 'var(--red-light)', borderColor: 'var(--red-light-2)', color: 'var(--red)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 9 }}>
        <button className="btn primary big" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save deal & push to Sheets'}</button>
        <button className="btn big" onClick={onClose}>Cancel</button>
      </div>
      <div className="subtle" style={{ fontSize: 13 }}>Rates: {pct(0.2)} means 20 — type either.</div>
    </Drawer>
  );
}

function structureNote(gross: number, f: Record<string, string>): string {
  const n = num(f.commIncrements);
  const up = Math.min(100, Math.max(0, num(f.commUpfrontPct)));
  const upfront = gross * (up / 100);
  const rest = gross - upfront;
  const cadence = { '7': 'week', '14': 'two weeks', '30': 'month' }[f.commCadenceDays ?? '7'] ?? 'increment';
  if (!n) return 'Enter the number of increments to project the receipts.';
  const start = f.commStartDate || `one ${cadence} after funding`;
  if (f.commRemainder === 'at-end') return `Expect ${money(upfront)} at funding${up ? '' : ' (nothing upfront)'}, then ${n} merchant increments every ${cadence} starting ${start}, and the remaining ${money(rest)} once they are done.`;
  return `Expect ${up ? `${money(upfront)} at funding, then ` : ''}${n} receipts of ${money(rest / n)} every ${cadence} starting ${start} (${money(rest)} in total).`;
}
