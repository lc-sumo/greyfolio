import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Shell } from '../components/Shell';
import { Card, Loading, Pill } from '../components/ui';
import { api, post, type Lender, type ProductRule, type ReferralPartner, type RosterRep, type Settings as SettingsData, type Team, type Usage } from '../lib/api';
import { compact, money, pct } from '../lib/format';
import { useSession } from '../lib/session';

type TabKey = 'lenders' | 'partners' | 'products' | 'teams' | 'reps' | 'crm';
const TABS: Array<{ key: TabKey; label: string; hint: string }> = [
  { key: 'lenders', label: 'Lenders', hint: 'Commission terms are a property of the lender: upfront, or paid in N weekly increments.' },
  { key: 'partners', label: 'Referral partners', hint: 'Fee % of gross commission and an optional monthly cap. Blank cap = uncapped.' },
  { key: 'products', label: 'Product rules', hint: 'The product decides which fields the new-deal form shows and how commission is based.' },
  { key: 'teams', label: 'Teams', hint: 'A team has a leader who earns the override on the team’s deals. Set the leader here.' },
  { key: 'reps', label: 'Reps', hint: 'Rates default onto new deals and can be overridden per deal. Deactivating never changes history.' },
  { key: 'crm', label: 'CRM & thresholds', hint: 'CRM deep link template and the day counts that drive at-risk, Prospecting and renewals.' },
];

export function Settings() {
  const { notify, setViewAs } = useSession();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsData>('/api/admin/settings') });
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api<Usage>('/api/admin/settings/usage') });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<{ teams: Team[] }>('/api/admin/teams') });
  const roster = useQuery({ queryKey: ['roster'], queryFn: () => api<{ reps: RosterRep[] }>('/api/admin/reps') });
  const [tab, setTab] = useState<TabKey>('lenders');
  const [err, setErr] = useState('');

  async function run(label: string, fn: () => Promise<unknown>) {
    setErr('');
    try {
      await fn();
      await qc.invalidateQueries();
      notify(label);
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
      return false;
    }
  }
  const current = TABS.find((t) => t.key === tab)!;
  const ready = settings.data && usage.data && teams.data && roster.data;

  return (
    <Shell eyebrow="Admin" title="Settings">
      <div className="seg" style={{ alignSelf: 'flex-start' }}>{TABS.map((t) => <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => { setTab(t.key); setErr(''); }}>{t.label}</button>)}</div>
      <div className="muted" style={{ marginTop: -6 }}>{current.hint}</div>
      {err && <div className="note" style={{ background: 'var(--red-light)', borderColor: 'var(--red-light-2)', color: 'var(--red)' }}>{err}</div>}
      {!ready ? <Loading error={settings.error ?? usage.error ?? teams.error ?? roster.error} /> : (
        <>
          {tab === 'lenders' && <LendersTab lenders={settings.data!.lenders} usage={usage.data!.lenders} run={run} />}
          {tab === 'partners' && <PartnersTab partners={settings.data!.partners} usage={usage.data!.partners} run={run} />}
          {tab === 'products' && <ProductsTab products={settings.data!.products} usage={usage.data!.products} run={run} />}
          {tab === 'teams' && <TeamsTab teams={teams.data!.teams} reps={roster.data!.reps} usage={usage.data!.teams} run={run} />}
          {tab === 'reps' && <RepsTab reps={roster.data!.reps} teams={teams.data!.teams} run={run} onViewAs={(id) => setViewAs(id)} />}
          {tab === 'crm' && <CrmTab settings={settings.data!} run={run} />}
        </>
      )}
    </Shell>
  );
}

type Run = (label: string, fn: () => Promise<unknown>) => Promise<boolean>;
const pctIn = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(Math.round(v * 10000) / 100));

function Row({ children, cols }: { children: ReactNode; cols: string }) {
  return <div className="srow" style={{ gridTemplateColumns: cols }}>{children}</div>;
}
function Head({ children, cols }: { children: ReactNode; cols: string }) {
  return <div className="srow head" style={{ gridTemplateColumns: cols }}>{children}</div>;
}

/* ---------- Lenders ---------- */
function LendersTab({ lenders, usage, run }: { lenders: Lender[]; usage: Record<string, number>; run: Run }) {
  const [rows, setRows] = useState(lenders);
  const [name, setName] = useState('');
  useEffect(() => setRows(lenders), [lenders]);
  const cols = 'minmax(180px,1.2fr) 150px 100px 110px 90px';
  const save = (next: Lender[]) => run('Lenders saved', () => post('/api/admin/settings/lenders', { lenders: next }, 'PUT'));
  return (
    <Card title="Lenders" extra={`${rows.length} · in-use lenders refuse deletion`}>
      <Head cols={cols}><span>Lender</span><span>Commission terms</span><span>Weeks</span><span>Usage</span><span /></Head>
      {rows.map((l, i) => (
        <Row key={i} cols={cols}>
          <input value={l.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <select value={l.terms} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, terms: e.target.value as Lender['terms'], weeks: e.target.value === 'weekly' ? x.weeks || 12 : 0 } : x)))}><option value="upfront">Upfront</option><option value="weekly">Weekly</option></select>
          <input inputMode="numeric" disabled={l.terms !== 'weekly'} value={l.terms === 'weekly' ? l.weeks : ''} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, weeks: Number(e.target.value) || 0 } : x)))} />
          <span className="num subtle">{usage[l.name] ? `${usage[l.name]} deal${usage[l.name] === 1 ? '' : 's'}` : 'unused'}</span>
          <button className="btn" disabled={!!usage[l.name]} title={usage[l.name] ? 'In use — cannot remove' : 'Remove'} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
        </Row>
      ))}
      <div className="toolbar" style={{ marginTop: 12 }}>
        <input className="search" placeholder="New lender name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!name.trim()} onClick={() => { setRows([...rows, { name: name.trim(), terms: 'upfront', weeks: 0 }]); setName(''); }}>+ Add lender</button>
        <span className="count" />
        <button className="btn primary" onClick={() => void save(rows)}>Save lenders</button>
      </div>
    </Card>
  );
}

/* ---------- Partners ---------- */
function PartnersTab({ partners, usage, run }: { partners: ReferralPartner[]; usage: Record<string, number>; run: Run }) {
  type Draft = { name: string; pct: string; monthlyCap: string };
  const toDraft = (p: ReferralPartner): Draft => ({ name: p.name, pct: pctIn(p.pct), monthlyCap: p.monthlyCap === null ? '' : String(p.monthlyCap) });
  const [rows, setRows] = useState<Draft[]>(partners.map(toDraft));
  useEffect(() => setRows(partners.map(toDraft)), [partners]);
  const cols = 'minmax(180px,1.2fr) 110px 140px 110px 90px';
  return (
    <Card title="Referral partners" extra={`${rows.length} · fee is a % of gross commission`}>
      <Head cols={cols}><span>Partner</span><span>Fee %</span><span>Monthly cap $</span><span>Usage</span><span /></Head>
      {rows.map((p, i) => (
        <Row key={i} cols={cols}>
          <input value={p.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input inputMode="decimal" value={p.pct} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} />
          <input inputMode="decimal" placeholder="uncapped" value={p.monthlyCap} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, monthlyCap: e.target.value } : x)))} />
          <span className="num subtle">{usage[p.name] ? `${usage[p.name]} deal${usage[p.name] === 1 ? '' : 's'}` : 'unused'}</span>
          <button className="btn" disabled={!!usage[p.name]} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
        </Row>
      ))}
      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="btn" onClick={() => setRows([...rows, { name: '', pct: '10', monthlyCap: '' }])}>+ Add partner</button>
        <span className="count" />
        <button className="btn primary" onClick={() => void run('Referral partners saved', () => post('/api/admin/settings/partners', { partners: rows.map((r) => ({ name: r.name, pct: Number(r.pct) || 0, monthlyCap: r.monthlyCap.trim() === '' ? null : Number(r.monthlyCap) })) }, 'PUT'))}>Save partners</button>
      </div>
    </Card>
  );
}

/* ---------- Products ---------- */
function ProductsTab({ products, usage, run }: { products: ProductRule[]; usage: Record<string, number>; run: Run }) {
  type Draft = Omit<ProductRule, 'comm' | 'drawInitial' | 'drawSubsequent'> & { comm: string; drawInitial: string; drawSubsequent: string };
  const toDraft = (p: ProductRule): Draft => ({ ...p, comm: pctIn(p.comm), drawInitial: pctIn(p.drawInitial), drawSubsequent: pctIn(p.drawSubsequent) });
  const [rows, setRows] = useState<Draft[]>(products.map(toDraft));
  useEffect(() => setRows(products.map(toDraft)), [products]);
  const set = (i: number, patch: Partial<Draft>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const cols = 'minmax(200px,1.3fr) 120px 80px 80px 80px repeat(5, 74px) 90px 80px';
  const Toggle = ({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => <button type="button" className={`tog ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)} aria-pressed={on}><i /></button>;
  return (
    <Card title="Product rules" extra="draw %s apply only to multi-draw products">
      <div className="scroller">
        <div style={{ minWidth: 1280 }}>
          <Head cols={cols}><span>Product</span><span>Commission basis</span><span>Default %</span><span>Initial draw %</span><span>Subsequent %</span><span>Factor</span><span>Term</span><span>Parent</span><span>Clawback</span><span>Renewable</span><span>Usage</span><span /></Head>
          {rows.map((p, i) => (
            <Row key={i} cols={cols}>
              <input value={p.name} onChange={(e) => set(i, { name: e.target.value })} />
              <select value={p.basis} onChange={(e) => set(i, { basis: e.target.value as ProductRule['basis'], parent: e.target.value === 'draw' ? true : p.parent })}><option value="funded">Funded amount</option><option value="draw">Draw amount</option><option value="payback">Payback</option></select>
              <input inputMode="decimal" value={p.comm} onChange={(e) => set(i, { comm: e.target.value })} />
              <input inputMode="decimal" disabled={!p.multiDraw} value={p.multiDraw ? p.drawInitial : ''} onChange={(e) => set(i, { drawInitial: e.target.value })} />
              <input inputMode="decimal" disabled={!p.multiDraw} value={p.multiDraw ? p.drawSubsequent : ''} onChange={(e) => set(i, { drawSubsequent: e.target.value })} />
              <Toggle on={p.factor} onChange={(v) => set(i, { factor: v })} />
              <Toggle on={p.term} onChange={(v) => set(i, { term: v })} />
              <Toggle on={p.parent} onChange={(v) => set(i, { parent: v })} disabled={p.basis === 'draw'} />
              <Toggle on={p.clawback} onChange={(v) => set(i, { clawback: v })} />
              <Toggle on={p.renewal} onChange={(v) => set(i, { renewal: v })} />
              <span className="num subtle">{usage[p.name] ? `${usage[p.name]} deal${usage[p.name] === 1 ? '' : 's'}` : 'unused'}</span>
              <button className="btn" disabled={!!usage[p.name]} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
            </Row>
          ))}
          <div className="subtle" style={{ fontSize: 11, margin: '6px 0' }}>Multi-draw: <span className="num">{rows.filter((p) => p.multiDraw).map((p) => p.name).join(', ') || 'none'}</span> · toggle per product below.</div>
          <div className="toolbar" style={{ marginTop: 8, gap: 8 }}>
            {rows.map((p, i) => <button key={i} className={`btn ${p.multiDraw ? 'primary' : ''}`} style={{ height: 28, padding: '0 10px', fontSize: 11.5 }} onClick={() => set(i, { multiDraw: !p.multiDraw, drawInitial: p.drawInitial || p.comm, drawSubsequent: p.drawSubsequent || String(Number(p.comm) / 2) })}>{p.name || '(unnamed)'}: {p.multiDraw ? 'multi-draw' : 'single'}</button>)}
          </div>
        </div>
      </div>
      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="btn" onClick={() => setRows([...rows, { name: '', basis: 'funded', factor: true, term: true, parent: false, comm: '10', clawback: true, renewal: true, multiDraw: false, drawInitial: '', drawSubsequent: '' }])}>+ Add product</button>
        <span className="count" />
        <button className="btn primary" onClick={() => void run('Product rules saved', () => post('/api/admin/settings/products', { products: rows.map((r) => ({ ...r, comm: Number(r.comm) || 0, drawInitial: Number(r.drawInitial) || 0, drawSubsequent: Number(r.drawSubsequent) || 0 })) }, 'PUT'))}>Save product rules</button>
      </div>
    </Card>
  );
}

/* ---------- Teams ---------- */
function TeamsTab({ teams, reps, usage, run }: { teams: Team[]; reps: RosterRep[]; usage: Record<string, number>; run: Run }) {
  const [drafts, setDrafts] = useState<Record<string, { name: string; leaderRepId: string; overrideRate: string }>>({});
  const [newTeam, setNewTeam] = useState({ name: '', leaderRepId: '', overrideRate: '5' });
  const d = (t: Team) => drafts[t.id] ?? { name: t.name, leaderRepId: t.leaderRepId ?? '', overrideRate: pctIn(t.overrideRate) };
  const byTeam = (id: string) => reps.filter((r) => r.teamId === id);
  const cols = 'minmax(180px,1.2fr) minmax(180px,1fr) 100px 90px 170px';
  return (
    <>
      <div className="grid-auto">
        {teams.map((t) => {
          const members = byTeam(t.id);
          const leader = reps.find((r) => r.id === t.leaderRepId);
          return (
            <section className="card" key={t.id}>
              <div className="label">{t.name}</div>
              <div className="metric">{members.length}<span className="muted" style={{ fontSize: 13, fontFamily: 'var(--sans)', fontWeight: 500 }}> reps</span></div>
              <div className="sub">Lead: <b>{leader?.name ?? '— none —'}</b> · override {pct(t.overrideRate)}</div>
              <div className="sub">Earned {compact(members.reduce((s, r) => s + r.earned, 0))} · owed {compact(members.reduce((s, r) => s + r.owed, 0))}</div>
            </section>
          );
        })}
      </div>
      <Card title="Teams" extra="a team refuses deletion while reps are assigned">
        <Head cols={cols}><span>Team</span><span>Team leader</span><span>Override %</span><span>Reps</span><span /></Head>
        {teams.map((t) => {
          const v = d(t);
          const dirty = v.name !== t.name || v.leaderRepId !== (t.leaderRepId ?? '') || v.overrideRate !== pctIn(t.overrideRate);
          return (
            <Row key={t.id} cols={cols}>
              <input value={v.name} onChange={(e) => setDrafts({ ...drafts, [t.id]: { ...v, name: e.target.value } })} />
              <select value={v.leaderRepId} onChange={(e) => setDrafts({ ...drafts, [t.id]: { ...v, leaderRepId: e.target.value } })}>
                <option value="">— none —</option>
                {reps.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name}{r.teamId && r.teamId !== t.id ? ` (${teams.find((x) => x.id === r.teamId)?.name ?? 'other team'})` : ''}</option>)}
              </select>
              <input inputMode="decimal" value={v.overrideRate} onChange={(e) => setDrafts({ ...drafts, [t.id]: { ...v, overrideRate: e.target.value } })} />
              <span className="num subtle">{usage[t.id] ?? 0}</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="btn primary" disabled={!dirty} style={{ height: 30, padding: '0 10px' }} onClick={() => run(`${v.name} saved`, async () => { await post(`/api/admin/teams/${t.id}`, { name: v.name, leaderRepId: v.leaderRepId || null, overrideRate: Number(v.overrideRate) }, 'PATCH'); setDrafts((s) => { const n = { ...s }; delete n[t.id]; return n; }); })}>Save</button>
                <button className="btn" disabled={!!usage[t.id]} title={usage[t.id] ? 'Move the reps first' : 'Delete team'} style={{ height: 30, padding: '0 10px' }} onClick={() => run(`${t.name} deleted`, () => api(`/api/admin/teams/${t.id}`, { method: 'DELETE' }))}>Delete</button>
              </span>
            </Row>
          );
        })}
        <div className="toolbar" style={{ marginTop: 12 }}>
          <input className="search" placeholder="New team name" value={newTeam.name} onChange={(e) => setNewTeam({ ...newTeam, name: e.target.value })} />
          <select className="filter" value={newTeam.leaderRepId} onChange={(e) => setNewTeam({ ...newTeam, leaderRepId: e.target.value })}><option value="">Leader — none yet</option>{reps.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          <input className="search" style={{ minWidth: 110 }} inputMode="decimal" placeholder="Override %" value={newTeam.overrideRate} onChange={(e) => setNewTeam({ ...newTeam, overrideRate: e.target.value })} />
          <button className="btn primary" disabled={!newTeam.name.trim()} onClick={() => run(`${newTeam.name} created`, async () => { await post('/api/admin/teams', { name: newTeam.name, leaderRepId: newTeam.leaderRepId || null, overrideRate: Number(newTeam.overrideRate) }); setNewTeam({ name: '', leaderRepId: '', overrideRate: '5' }); })}>+ Add team</button>
        </div>
      </Card>
    </>
  );
}

/* ---------- Reps ---------- */
function RepsTab({ reps, teams, run, onViewAs }: { reps: RosterRep[]; teams: Team[]; run: Run; onViewAs: (id: string) => void }) {
  type Draft = { name: string; email: string; teamId: string; openerRate: string; closerRate: string; overrideRate: string; role: string };
  const toDraft = (r: RosterRep): Draft => ({ name: r.name, email: r.email, teamId: r.teamId ?? '', openerRate: pctIn(r.openerRate), closerRate: pctIn(r.closerRate), overrideRate: pctIn(r.overrideRate), role: r.role });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [adding, setAdding] = useState<Draft | null>(null);
  const cols = 'minmax(150px,1.1fr) minmax(190px,1.2fr) 150px 70px 70px 70px 100px 100px 120px 90px 150px';
  const label = (role: string) => (role === 'admin' ? 'Master' : role === 'manager' ? 'Team lead' : 'Rep');
  const Editor = ({ v, onChange }: { v: Draft; onChange: (v: Draft) => void }) => (
    <>
      <input value={v.name} onChange={(e) => onChange({ ...v, name: e.target.value })} />
      <input value={v.email} onChange={(e) => onChange({ ...v, email: e.target.value })} />
      <select value={v.teamId} onChange={(e) => onChange({ ...v, teamId: e.target.value })}><option value="">— no team —</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      <input inputMode="decimal" value={v.openerRate} onChange={(e) => onChange({ ...v, openerRate: e.target.value })} />
      <input inputMode="decimal" value={v.closerRate} onChange={(e) => onChange({ ...v, closerRate: e.target.value })} />
      <input inputMode="decimal" placeholder="team" value={v.overrideRate} onChange={(e) => onChange({ ...v, overrideRate: e.target.value })} />
    </>
  );
  const body = (v: Draft) => ({ name: v.name, email: v.email, teamId: v.teamId || null, openerRate: Number(v.openerRate), closerRate: Number(v.closerRate), overrideRate: v.overrideRate.trim() === '' ? null : Number(v.overrideRate), role: v.role });
  return (
    <Card title="Reps" extra={`${reps.length} · ${reps.filter((r) => r.active).length} active`}>
      <div className="scroller">
        <div style={{ minWidth: 1340 }}>
          <Head cols={cols}><span>Name</span><span>Email</span><span>Team</span><span>Opener %</span><span>Closer %</span><span>Override %</span><span>Earned</span><span>Owed</span><span>Access</span><span>Active</span><span /></Head>
          {reps.map((r) => {
            const v = drafts[r.id] ?? toDraft(r);
            const dirty = !!drafts[r.id];
            return (
              <Row key={r.id} cols={cols}>
                <Editor v={v} onChange={(nv) => setDrafts({ ...drafts, [r.id]: nv })} />
                <span className="num">{compact(r.earned)}</span>
                <span className={`num ${r.owed ? 'warn' : ''}`}>{compact(r.owed)}</span>
                <select value={v.role} onChange={(e) => setDrafts({ ...drafts, [r.id]: { ...v, role: e.target.value } })}><option value="rep">Rep</option><option value="manager">Team lead</option><option value="admin">Master</option></select>
                <button type="button" className={`tog ${r.active ? 'on' : ''}`} aria-pressed={r.active} title={r.active ? 'Deactivate — history stays' : 'Reactivate'} onClick={() => run(`${r.name} ${r.active ? 'deactivated' : 'reactivated'}`, () => post(`/api/admin/reps/${r.id}`, { active: !r.active }, 'PATCH'))}><i /></button>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button className="btn primary" disabled={!dirty} style={{ height: 30, padding: '0 10px' }} onClick={() => run(`${v.name} saved`, async () => { await post(`/api/admin/reps/${r.id}`, body(v), 'PATCH'); setDrafts((s) => { const n = { ...s }; delete n[r.id]; return n; }); })}>Save</button>
                  <button className="btn" style={{ height: 30, padding: '0 10px' }} onClick={() => onViewAs(r.id)}>View as</button>
                </span>
              </Row>
            );
          })}
          {adding && (
            <Row cols={cols}>
              <Editor v={adding} onChange={setAdding} />
              <span /><span />
              <select value={adding.role} onChange={(e) => setAdding({ ...adding, role: e.target.value })}><option value="rep">Rep</option><option value="manager">Team lead</option><option value="admin">Master</option></select>
              <Pill tone="teal">new</Pill>
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="btn primary" style={{ height: 30, padding: '0 10px' }} onClick={() => run(`${adding.name} added`, async () => { await post('/api/admin/reps', body(adding)); setAdding(null); })}>Add</button>
                <button className="btn" style={{ height: 30, padding: '0 10px' }} onClick={() => setAdding(null)}>Cancel</button>
              </span>
            </Row>
          )}
        </div>
      </div>
      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="btn" disabled={!!adding} onClick={() => setAdding({ name: '', email: '', teamId: '', openerRate: '20', closerRate: '20', overrideRate: '', role: 'rep' })}>+ Add rep</button>
        <span className="count">Access: Rep sees their own portal · Team lead can View as their team · Master runs everything. The label reads {label('manager')} for managers.</span>
      </div>
    </Card>
  );
}

/* ---------- CRM & thresholds ---------- */
function CrmTab({ settings, run }: { settings: SettingsData; run: Run }) {
  const [tpl, setTpl] = useState(settings.crm.urlTemplate);
  const [t, setT] = useState({ clawbackWindowDays: String(settings.thresholds.clawbackWindowDays), paymentOverdueDays: String(settings.thresholds.paymentOverdueDays), renewalMark: pctIn(settings.thresholds.renewalMark), additionalCapitalAfterDays: String(settings.thresholds.additionalCapitalAfterDays) });
  const [cycle, setCycle] = useState(settings.payroll.cycle);
  useEffect(() => { setTpl(settings.crm.urlTemplate); setT({ clawbackWindowDays: String(settings.thresholds.clawbackWindowDays), paymentOverdueDays: String(settings.thresholds.paymentOverdueDays), renewalMark: pctIn(settings.thresholds.renewalMark), additionalCapitalAfterDays: String(settings.thresholds.additionalCapitalAfterDays) }); setCycle(settings.payroll.cycle); }, [settings]);
  const preview = tpl.trim() ? tpl.replace(/\{id\}/g, encodeURIComponent('OPP-48213')).replace(/\{opportunity\}/g, 'F12').replace(/\{business\}/g, encodeURIComponent('Cedar & Stone HVAC')) : '';
  return (
    <div className="two">
      <Card title="CRM deep link" extra="tokens: {id} {opportunity} {business}">
        <label className="field"><span className="label">URL template</span><input value={tpl} onChange={(e) => setTpl(e.target.value)} placeholder="https://crm.example.com/opportunity/{id}" /></label>
        <div className="note" style={{ marginTop: 10 }}>{preview ? <>Preview: <a href={preview} target="_blank" rel="noopener" className="num">{preview}</a></> : 'Blank template — no CRM links are shown anywhere.'}</div>
        <div className="subtle" style={{ fontSize: 11.5, marginTop: 8 }}>{'{id}'} is the CRM deal ID when one is set, else the sheet row. Each token is URL-encoded.</div>
        <button className="btn primary" style={{ marginTop: 12 }} onClick={() => void run('CRM template saved', () => post('/api/admin/settings/crm', { urlTemplate: tpl }, 'PUT'))}>Save CRM template</button>
      </Card>
      <Card title="Thresholds" extra="days are calendar days; the mark is % of term paid in">
        <div className="form">
          <label className="field"><span className="label">Clawback window (days)</span><input inputMode="numeric" value={t.clawbackWindowDays} onChange={(e) => setT({ ...t, clawbackWindowDays: e.target.value })} /><span className="subtle" style={{ fontSize: 11 }}>Deals stay AT RISK this long after funding</span></label>
          <label className="field"><span className="label">Payment overdue after (days)</span><input inputMode="numeric" value={t.paymentOverdueDays} onChange={(e) => setT({ ...t, paymentOverdueDays: e.target.value })} /><span className="subtle" style={{ fontSize: 11 }}>Unpaid lender commission older than this turns red</span></label>
          <label className="field"><span className="label">Renewal mark (% paid in)</span><input inputMode="decimal" value={t.renewalMark} onChange={(e) => setT({ ...t, renewalMark: e.target.value })} /><span className="subtle" style={{ fontSize: 11 }}>Renewable now once this far through the term</span></label>
          <label className="field"><span className="label">Additional capital after (days)</span><input inputMode="numeric" value={t.additionalCapitalAfterDays} onChange={(e) => setT({ ...t, additionalCapitalAfterDays: e.target.value })} /><span className="subtle" style={{ fontSize: 11 }}>Flips to Prospecting — merchant eligible for more capital</span></label>
          <label className="field" style={{ gridColumn: '1 / -1' }}><span className="label">Payout cycle</span><select value={cycle} onChange={(e) => setCycle(e.target.value)}>{['Weekly', 'Twice monthly', 'Monthly', 'Per deal on lender payment'].map((c) => <option key={c}>{c}</option>)}</select></label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn primary" onClick={() => void run('Thresholds saved', () => post('/api/admin/settings/thresholds', { clawbackWindowDays: Number(t.clawbackWindowDays), paymentOverdueDays: Number(t.paymentOverdueDays), renewalMark: Number(t.renewalMark), additionalCapitalAfterDays: Number(t.additionalCapitalAfterDays) }, 'PUT'))}>Save thresholds</button>
          <button className="btn" onClick={() => void run('Payout cycle saved', () => post('/api/admin/settings/payroll', { cycle }, 'PUT'))}>Save payout cycle</button>
        </div>
      </Card>
    </div>
  );
}

export { money };
