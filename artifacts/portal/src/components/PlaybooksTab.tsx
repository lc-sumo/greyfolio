import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, Loading, Pill } from './ui';
import { MERGE_FIELD_HELP, TRIGGER_KINDS, api, post, type DryRun, type FiringView, type MerchantTemplate, type PlaybookAction, type PlaybookList, type PlaybookRule, type PlaybookTrigger, type PlaybookView, type RosterRep, type RunResult, type Settings, type TaskView, type Team } from '../lib/api';
import { compact, day, fullDay, money } from '../lib/format';
import { useSession } from '../lib/session';

type Run = (label: string, fn: () => Promise<unknown>) => Promise<boolean>;

const BUCKETS = [
  { value: 'due', label: 'Renewable now' },
  { value: 'prospecting', label: 'Prospecting' },
  { value: 'building', label: 'Upcoming' },
  { value: 'risk', label: 'At risk' },
  { value: 'refinanced', label: 'Refinanced / paid' },
];

function triggerSummary(t: PlaybookTrigger): string {
  switch (t.kind) {
    case 'paidInPct': return `paid-in reaches ${t.atLeast}%`;
    case 'daysSinceFunding': return `${t.atLeast} days since funding`;
    case 'daysToMaturity': return `${t.atMost} days to maturity`;
    case 'bucket': return `stage is ${t.in.map((b) => BUCKETS.find((x) => x.value === b)?.label ?? b).join(' / ')}`;
    case 'locUnused': return `unused line ≥ ${money(t.atLeast)}`;
    case 'status': return `status is ${t.in.join(' / ')}`;
    case 'lenderOverdue': return 'lender payment overdue';
    case 'clawbackWindowClosing': return `clawback window closes within ${t.withinDays} days`;
    case 'noNoteDays': return `no note for ${t.atLeast} days`;
  }
}
function actionSummary(a: PlaybookAction): string {
  switch (a.kind) {
    case 'emailRep': return 'email the rep';
    case 'emailAdmins': return 'email admins';
    case 'task': return `task, due in ${a.dueInDays}d`;
    case 'setStatus': return `set status ${a.status}`;
  }
}

const blankRule = (): PlaybookRule => ({ trigger: { kind: 'paidInPct', atLeast: 50 }, filters: {}, actions: [{ kind: 'task', title: 'Call {{merchant}} ({{paidIn}} paid in)', dueInDays: 3 }], repeatDays: 14 });

export function PlaybooksTab({ settings, teams, reps, run }: { settings: Settings; teams: Team[]; reps: RosterRep[]; run: Run }) {
  const qc = useQueryClient();
  const { notify } = useSession();
  const list = useQuery({ queryKey: ['playbooks'], queryFn: () => api<PlaybookList>('/api/admin/playbooks') });
  const log = useQuery({ queryKey: ['playbook-log'], queryFn: () => api<{ firings: FiringView[] }>('/api/admin/playbooks/log?limit=60') });
  const tasks = useQuery({ queryKey: ['admin-tasks', 'open'], queryFn: () => api<{ tasks: TaskView[] }>('/api/admin/tasks?status=open') });
  const [editing, setEditing] = useState<{ id: string | null; name: string; enabled: boolean; rule: PlaybookRule } | null>(null);
  const [dry, setDry] = useState<{ id: string | null; result: DryRun } | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<RunResult | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['playbooks'] }), qc.invalidateQueries({ queryKey: ['playbook-log'] }), qc.invalidateQueries({ queryKey: ['admin-tasks'] })]);
  if (!list.data) return <Loading error={list.error} />;
  const pbs = list.data.playbooks;

  async function dryRun(rule: PlaybookRule, id: string | null) {
    try {
      const result = await post<DryRun>('/api/admin/playbooks/dry-run', { rule, playbookId: id ?? undefined });
      setDry({ id, result });
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Dry run failed');
    }
  }
  async function runNow() {
    setRunning(true);
    try {
      const r = await post<RunResult>('/api/admin/playbooks/run', {});
      setLastRun(r);
      notify(r.fired ? `${r.fired} deal${r.fired === 1 ? '' : 's'} fired · ${r.tasks} task${r.tasks === 1 ? '' : 's'} · ${r.emails} email${r.emails === 1 ? '' : 's'}` : 'Nothing fired — every rule is up to date');
      await refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card title="Rules" extra={<span>{pbs.filter((p) => p.enabled).length} on · runs daily at {settings.notifications.playbookHourUtc}:00 UTC{list.data.lastRun ? ` · last run ${day(list.data.lastRun)}` : ' · never run yet'}</span>}>
        <div style={{ display: 'grid', gap: 10 }}>
          {pbs.map((p) => (
            <div key={p.id} className="row" style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto', gap: 14, alignItems: 'start', padding: '10px 12px', border: '1px solid var(--border-light)', borderRadius: 10, background: p.enabled ? undefined : 'var(--sunken)' }}>
              <button type="button" className={`tog ${p.enabled ? 'on' : ''}`} aria-pressed={p.enabled} title={p.enabled ? 'On — switch off' : 'Off — switch on'} onClick={() => void run(`${p.name} ${p.enabled ? 'paused' : 'on'}`, () => post(`/api/admin/playbooks/${p.id}`, { enabled: !p.enabled }, 'PATCH'))} style={{ marginTop: 4 }}><i /></button>
              <div style={{ minWidth: 0 }}>
                <b>{p.name}</b>
                <div className="subtle" style={{ fontSize: 13.5 }}>When {triggerSummary(p.rule.trigger)}{Object.keys(p.rule.filters ?? {}).length ? ` · ${[p.rule.filters.lenders?.length ? `lenders: ${p.rule.filters.lenders.join(', ')}` : '', p.rule.filters.products?.length ? `products: ${p.rule.filters.products.join(', ')}` : '', p.rule.filters.teams?.length ? `${p.rule.filters.teams.length} team${p.rule.filters.teams.length === 1 ? '' : 's'}` : '', p.rule.filters.reps?.length ? `${p.rule.filters.reps.length} rep${p.rule.filters.reps.length === 1 ? '' : 's'}` : '', p.rule.filters.minFunded ? `≥ ${compact(p.rule.filters.minFunded)}` : ''].filter(Boolean).join(' · ')}` : ''} → {p.rule.actions.map(actionSummary).join(' + ')} · {p.rule.repeatDays === null ? 'once per deal' : `every ${p.rule.repeatDays} days until closed`}</div>
                <div className="subtle num" style={{ fontSize: 12.5, marginTop: 4 }}>{p.firings} firing{p.firings === 1 ? '' : 's'}{p.lastFired ? ` · last ${day(p.lastFired)}` : ''} · {p.openTasks} open task{p.openTasks === 1 ? '' : 's'} · {p.doneTasks} done</div>
              </div>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button className="btn" style={{ height: 30, padding: '0 10px' }} onClick={() => void dryRun(p.rule, p.id)}>Dry run</button>
                <button className="btn" style={{ height: 30, padding: '0 10px' }} onClick={() => { setEditing({ id: p.id, name: p.name, enabled: p.enabled, rule: JSON.parse(JSON.stringify(p.rule)) }); setDry(null); }}>Edit</button>
                <button className="btn" style={{ height: 30, padding: '0 10px' }} onClick={() => { if (window.confirm(`Delete "${p.name}"? Its tasks stay; its history goes.`)) void run(`${p.name} deleted`, () => post(`/api/admin/playbooks/${p.id}`, {}, 'DELETE')); }}>✕</button>
              </span>
            </div>
          ))}
          {pbs.length === 0 && <div className="muted">No rules yet.</div>}
        </div>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={() => { setEditing({ id: null, name: '', enabled: true, rule: blankRule() }); setDry(null); }}>+ New rule</button>
          <button className="btn" disabled={running} onClick={() => void runNow()} title="Evaluate every rule now instead of waiting for the daily run">{running ? 'Running…' : 'Run all now'}</button>
          {lastRun && <span className="subtle" style={{ fontSize: 13 }}>Last: {lastRun.fired} fired · {lastRun.tasks} tasks · {lastRun.emails} emails · {lastRun.statuses} status changes</span>}
          <span className="count">A rule fires once per deal, or again every N days while the condition holds. It never fires again on a deal whose task was closed with a final outcome.</span>
        </div>
      </Card>

      {editing && <RuleEditor value={editing} settings={settings} teams={teams} reps={reps} triggers={list.data.triggers} onDryRun={(rule) => void dryRun(rule, editing.id)} onCancel={() => setEditing(null)} onSave={async (v) => { const ok = await run(v.id ? `${v.name} saved` : `${v.name} created`, () => (v.id ? post(`/api/admin/playbooks/${v.id}`, { name: v.name, enabled: v.enabled, rule: v.rule }, 'PATCH') : post('/api/admin/playbooks', { name: v.name, enabled: v.enabled, rule: v.rule }))); if (ok) { setEditing(null); await refresh(); } }} />}

      {dry && (
        <Card title={`Dry run · would fire for ${dry.result.wouldFire} of ${dry.result.matched} matching deal${dry.result.matched === 1 ? '' : 's'} today`} extra={<button className="linkish" style={{ color: 'var(--ink-subtle)' }} onClick={() => setDry(null)}>close</button>}>
          {dry.result.preview && (
            <div className="note" style={{ marginBottom: 12, whiteSpace: 'pre-wrap' }}><b>{dry.result.preview.subject}</b>{'\n'}{dry.result.preview.body}</div>
          )}
          <div className="scroller">
            <div className="table" style={{ ['--cols' as string]: 'minmax(200px,1.3fr) 110px 100px 130px 130px 80px 120px', minWidth: 880 }}>
              <div className="tr th"><div className="td">Deal</div><div className="td">Lender</div><div className="td r">Funded</div><div className="td">Rep</div><div className="td">Stage</div><div className="td r">Paid in</div><div className="td">Today</div></div>
              {dry.result.rows.map((r) => (
                <div className="tr" key={r.dealId}>
                  <div className="td ellipsis"><b>{r.business}</b> <span className="subtle num">{r.dealId}</span></div>
                  <div className="td ellipsis">{r.lender}</div>
                  <div className="td r num">{compact(r.funded)}</div>
                  <div className="td ellipsis">{r.rep}</div>
                  <div className="td ellipsis">{r.stage}</div>
                  <div className="td r num">{r.paidIn}</div>
                  <div className="td">{r.held ? <Pill tone="grey">held · {r.held}</Pill> : <Pill tone="teal">fires</Pill>}</div>
                </div>
              ))}
              {dry.result.rows.length === 0 && <div className="empty">No deal matches this rule today.</div>}
            </div>
          </div>
        </Card>
      )}

      <OpenTasks tasks={tasks.data?.tasks ?? []} outcomes={list.data.outcomes} reps={reps} onChanged={refresh} />
      <TemplatesEditor templates={settings.templates.merchant} run={run} />

      <Card title="Firing log" extra="newest first">
        {!log.data ? <Loading error={log.error} /> : log.data.firings.length === 0 ? <div className="muted">Nothing has fired yet. Use Dry run to see what would, or Run all now.</div> : (
          <div className="scroller">
            <div className="table" style={{ ['--cols' as string]: '150px minmax(180px,1fr) minmax(200px,1.2fr) 140px minmax(160px,1fr)', minWidth: 860 }}>
              <div className="tr th"><div className="td">When</div><div className="td">Rule</div><div className="td">Deal</div><div className="td">Rep</div><div className="td">Did</div></div>
              {log.data.firings.map((f) => (
                <div className="tr" key={f.id}>
                  <div className="td num">{fullDay(f.firedAt.slice(0, 10))}</div>
                  <div className="td ellipsis">{f.playbookName}</div>
                  <div className="td ellipsis"><b>{String(f.detail?.business ?? '')}</b> <span className="subtle num">{f.dealId}</span></div>
                  <div className="td ellipsis">{f.repName ?? '—'}</div>
                  <div className="td subtle ellipsis">{Array.isArray(f.detail?.actions) ? (f.detail!.actions as string[]).join(', ') : ''}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function RuleEditor({ value, settings, teams, reps, triggers, onDryRun, onCancel, onSave }: { value: { id: string | null; name: string; enabled: boolean; rule: PlaybookRule }; settings: Settings; teams: Team[]; reps: RosterRep[]; triggers: PlaybookList['triggers']; onDryRun: (rule: PlaybookRule) => void; onCancel: () => void; onSave: (v: { id: string | null; name: string; enabled: boolean; rule: PlaybookRule }) => void }) {
  const [v, setV] = useState(value);
  const rule = v.rule;
  const setRule = (patch: Partial<PlaybookRule>) => setV({ ...v, rule: { ...rule, ...patch } });
  const t = rule.trigger as PlaybookTrigger & { atLeast?: number; atMost?: number; withinDays?: number; in?: string[] };
  const def = triggers.find((x) => x.kind === t.kind)!;
  const setTrigger = (kind: PlaybookTrigger['kind']) => {
    const d = triggers.find((x) => x.kind === kind)!;
    const next: Record<string, unknown> = { kind };
    if (d.param === 'atLeast') next.atLeast = kind === 'paidInPct' ? 50 : kind === 'locUnused' ? 10000 : 30;
    if (d.param === 'atMost') next.atMost = 21;
    if (d.param === 'withinDays') next.withinDays = 7;
    if (d.param === 'in') next.in = kind === 'bucket' ? ['due'] : [settings.lists.dealStatuses[0] ?? 'Performing'];
    setRule({ trigger: next as unknown as PlaybookTrigger });
  };
  const toggleIn = (list: string[] | undefined, x: string, set: (n: string[] | undefined) => void) => {
    const cur = list ?? [];
    const next = cur.includes(x) ? cur.filter((y) => y !== x) : [...cur, x];
    set(next.length ? next : undefined);
  };
  const setFilter = (patch: Partial<PlaybookRule['filters']>) => setRule({ filters: { ...rule.filters, ...patch } });
  const setAction = (i: number, a: PlaybookAction) => setRule({ actions: rule.actions.map((x, j) => (j === i ? a : x)) });
  const chipList = (all: string[], sel: string[] | undefined, onToggle: (x: string) => void, labelOf: (x: string) => string = (x) => x) => (
    <div className="chips">{all.map((x) => <button key={x} type="button" className={`chip ${sel?.includes(x) ? 'on' : ''}`} onClick={() => onToggle(x)}>{labelOf(x)}</button>)}</div>
  );
  return (
    <Card title={v.id ? 'Edit rule' : 'New rule'} extra={<span>merge fields: {MERGE_FIELD_HELP.map((f) => `{{${f}}}`).join(' ')}</span>}>
      <div className="form" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)' }}>
        <label className="field"><span className="label">Name</span><input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Halfway paid in — renewal call" autoFocus /></label>
        <label className="field"><span className="label">Repeat</span>
          <select value={rule.repeatDays === null ? 'once' : String(rule.repeatDays)} onChange={(e) => setRule({ repeatDays: e.target.value === 'once' ? null : Number(e.target.value) })}>
            <option value="once">Once per deal</option>
            {[3, 7, 14, 30, 60].map((n) => <option key={n} value={n}>Every {n} days until closed</option>)}
          </select>
        </label>
      </div>
      <div style={{ marginTop: 14 }}><b>When</b></div>
      <div className="form" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', marginTop: 6 }}>
        <label className="field"><span className="label">Trigger</span><select value={t.kind} onChange={(e) => setTrigger(e.target.value as PlaybookTrigger['kind'])}>{triggers.map((x) => <option key={x.kind} value={x.kind}>{x.label}</option>)}</select></label>
        {def.param && def.param !== 'in' && (
          <label className="field"><span className="label">{def.unit === '%' ? 'Percent' : def.unit === '$' ? 'Dollars' : 'Days'}</span><input inputMode="numeric" value={String(t[def.param] ?? '')} onChange={(e) => setRule({ trigger: { ...t, [def.param!]: Number(e.target.value) } as PlaybookTrigger })} /></label>
        )}
      </div>
      {def.param === 'in' && (
        <div style={{ marginTop: 8 }}>
          {t.kind === 'bucket' ? chipList(BUCKETS.map((b) => b.value), t.in, (x) => setRule({ trigger: { kind: 'bucket', in: (t.in ?? []).includes(x) ? (t.in ?? []).filter((y) => y !== x) : [...(t.in ?? []), x] } as PlaybookTrigger }), (x) => BUCKETS.find((b) => b.value === x)?.label ?? x)
            : chipList(settings.lists.dealStatuses, t.in, (x) => setRule({ trigger: { kind: 'status', in: (t.in ?? []).includes(x) ? (t.in ?? []).filter((y) => y !== x) : [...(t.in ?? []), x] } as PlaybookTrigger }))}
        </div>
      )}
      <div style={{ marginTop: 14 }}><b>Only for</b> <span className="subtle" style={{ fontSize: 13 }}>leave everything unselected for all deals</span></div>
      <div className="form" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginTop: 6 }}>
        <div className="field"><span className="label">Lenders</span>{chipList(settings.lenders.filter((l) => l.active !== false).map((l) => l.name), rule.filters.lenders, (x) => toggleIn(rule.filters.lenders, x, (n) => setFilter({ lenders: n })))}</div>
        <div className="field"><span className="label">Products</span>{chipList(settings.products.filter((p) => p.active !== false).map((p) => p.name), rule.filters.products, (x) => toggleIn(rule.filters.products, x, (n) => setFilter({ products: n })), (x) => x.replace(' - UPFRONT COMM', '').replace(' - TOTAL FUNDING', ''))}</div>
        <div className="field"><span className="label">Teams</span>{chipList(teams.map((x) => x.id), rule.filters.teams, (x) => toggleIn(rule.filters.teams, x, (n) => setFilter({ teams: n })), (x) => teams.find((tm) => tm.id === x)?.name ?? x)}</div>
        <div className="field"><span className="label">Reps (deal owner)</span>{chipList(reps.filter((r) => r.active).map((r) => r.id), rule.filters.reps, (x) => toggleIn(rule.filters.reps, x, (n) => setFilter({ reps: n })), (x) => reps.find((r) => r.id === x)?.name ?? x)}</div>
        <label className="field"><span className="label">Minimum funded</span><input inputMode="numeric" value={rule.filters.minFunded ?? ''} placeholder="any size" onChange={(e) => setFilter({ minFunded: e.target.value ? Number(e.target.value) : undefined })} /></label>
      </div>
      <div style={{ marginTop: 14 }}><b>Then</b></div>
      <div style={{ display: 'grid', gap: 10, marginTop: 6 }}>
        {rule.actions.map((a, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '180px minmax(0,1fr) auto', gap: 10, alignItems: 'start', padding: 10, border: '1px solid var(--border-light)', borderRadius: 10 }}>
            <select value={a.kind} onChange={(e) => { const k = e.target.value as PlaybookAction['kind']; setAction(i, k === 'task' ? { kind: 'task', title: 'Call {{merchant}}', dueInDays: 3 } : k === 'setStatus' ? { kind: 'setStatus', status: settings.lists.dealStatuses[0] ?? 'Performing' } : { kind: k, subject: '{{merchant}} — {{stage}}', body: 'Hi {{rep.first}},\n\n{{merchant}} ({{lender}}, {{funded}}) is {{paidIn}} paid in.\n\n{{link}}' }); }}>
              <option value="task">Open a task for the rep</option>
              <option value="emailRep">Email the rep</option>
              <option value="emailAdmins">Email the admins</option>
              <option value="setStatus">Set the deal status</option>
            </select>
            <div style={{ display: 'grid', gap: 6 }}>
              {a.kind === 'task' && <><input value={a.title} onChange={(e) => setAction(i, { ...a, title: e.target.value })} placeholder="Task title" /><label className="field" style={{ gridTemplateColumns: 'auto 90px', display: 'grid', alignItems: 'center', gap: 8 }}><span className="subtle" style={{ fontSize: 13 }}>Due in (days)</span><input inputMode="numeric" value={a.dueInDays} onChange={(e) => setAction(i, { ...a, dueInDays: Number(e.target.value) || 0 })} /></label></>}
              {(a.kind === 'emailRep' || a.kind === 'emailAdmins') && <><input value={a.subject} onChange={(e) => setAction(i, { ...a, subject: e.target.value })} placeholder="Subject" /><textarea rows={4} value={a.body} onChange={(e) => setAction(i, { ...a, body: e.target.value })} style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '8px 10px', background: 'var(--input-bg)', color: 'inherit', font: 'inherit' }} /></>}
              {a.kind === 'setStatus' && <select value={a.status} onChange={(e) => setAction(i, { ...a, status: e.target.value })}>{settings.lists.dealStatuses.map((s) => <option key={s} value={s}>{s}</option>)}</select>}
            </div>
            <button className="btn" style={{ height: 30, padding: '0 8px' }} disabled={rule.actions.length === 1} onClick={() => setRule({ actions: rule.actions.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <div><button className="btn" onClick={() => setRule({ actions: [...rule.actions, { kind: 'emailRep', subject: '{{merchant}} — {{stage}}', body: 'Hi {{rep.first}},\n\n{{merchant}} ({{lender}}, {{funded}}) is {{paidIn}} paid in. Estimated renewal commission: {{estCommission}}.\n\n{{link}}' }] })}>+ Add action</button></div>
      </div>
      <div className="toolbar" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={!v.name.trim()} onClick={() => onSave(v)}>{v.id ? 'Save rule' : 'Create rule'}</button>
        <button className="btn" onClick={() => onDryRun(rule)}>Dry run</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </Card>
  );
}

function OpenTasks({ tasks, outcomes, reps, onChanged }: { tasks: TaskView[]; outcomes: PlaybookList['outcomes']; reps: RosterRep[]; onChanged: () => Promise<unknown> }) {
  const { notify } = useSession();
  const [rep, setRep] = useState('');
  const rows = tasks.filter((t) => !rep || t.repId === rep);
  async function log(t: TaskView, outcome: string) {
    const note = window.prompt(`${outcomes.find((o) => o.value === outcome)?.label ?? outcome} — add a note for the deal (optional)`) ?? '';
    try {
      await post(`/api/admin/tasks/${t.id}`, { outcome, note });
      notify(`${t.business}: ${outcomes.find((o) => o.value === outcome)?.label}`);
      await onChanged();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not update');
    }
  }
  return (
    <Card title="Open tasks" extra={<span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{tasks.length} open · <select value={rep} onChange={(e) => setRep(e.target.value)} style={{ height: 28 }}><option value="">every rep</option>{reps.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></span>}>
      {rows.length === 0 ? <div className="muted">Nothing open{rep ? ' for this rep' : ''}. Tasks come from rules, from you on a deal, or from a rep on their own deals.</div> : (
        <div className="scroller">
          <div className="table" style={{ ['--cols' as string]: '100px minmax(220px,1.4fr) 140px minmax(200px,1.2fr) 200px', minWidth: 900 }}>
            <div className="tr th"><div className="td">Due</div><div className="td">Task</div><div className="td">Rep</div><div className="td">Deal</div><div className="td">Log outcome</div></div>
            {rows.map((t) => (
              <div className="tr" key={t.id}>
                <div className={`td num ${t.overdue ? 'neg' : ''}`}>{day(t.dueDate)}</div>
                <div className="td ellipsis">{t.title}{t.playbookName && <div className="subtle" style={{ fontSize: 12.5 }}>{t.playbookName}</div>}</div>
                <div className="td ellipsis">{t.repName}</div>
                <div className="td ellipsis"><b>{t.business}</b> <span className="subtle num">{t.dealId} · {t.lender}</span></div>
                <div className="td"><select value="" onChange={(e) => { if (e.target.value) void log(t, e.target.value); }}><option value="">outcome…</option>{outcomes.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function TemplatesEditor({ templates, run }: { templates: MerchantTemplate[]; run: Run }) {
  const [rows, setRows] = useState<MerchantTemplate[]>(templates.map((t) => ({ ...t })));
  const set = (i: number, patch: Partial<MerchantTemplate>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const ta = { border: '1px solid var(--border-strong)', borderRadius: 8, padding: '8px 10px', background: 'var(--input-bg)', color: 'inherit', font: 'inherit', width: '100%' } as const;
  return (
    <Card title="Merchant email templates" extra="what a rep can send to a merchant from a deal, under their own name · reply-to is the rep">
      <div style={{ display: 'grid', gap: 12 }}>
        {rows.map((t, i) => (
          <div key={i} style={{ display: 'grid', gap: 6, padding: 10, border: '1px solid var(--border-light)', borderRadius: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,2fr) auto', gap: 8 }}>
              <input value={t.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Template name" />
              <input value={t.subject} onChange={(e) => set(i, { subject: e.target.value })} placeholder="Subject" />
              <button className="btn" style={{ height: 36 }} onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
            </div>
            <textarea rows={5} value={t.body} onChange={(e) => set(i, { body: e.target.value })} style={ta} />
          </div>
        ))}
      </div>
      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={() => void run('Templates saved', () => post('/api/admin/settings/templates', { merchant: rows }, 'PUT'))}>Save templates</button>
        <button className="btn" onClick={() => setRows([...rows, { id: '', name: '', subject: '', body: 'Hi {{contact}},\n\n\n\nBest,\n{{rep.name}}\n{{company}}' }])}>+ Add template</button>
        <span className="count">Fields: {MERGE_FIELD_HELP.map((f) => `{{${f}}}`).join(' ')}</span>
      </div>
    </Card>
  );
}
