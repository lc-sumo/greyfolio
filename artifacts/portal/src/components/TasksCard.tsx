import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DEMO, api, post, type MyTasks, type TaskView } from '../lib/api';
import { day } from '../lib/format';
import { useSession } from '../lib/session';
import { Card, Pill } from './ui';

/** "My calls": the rep's open tasks, each closed with an outcome that feeds the renewal numbers. */
export function TasksCard({ onOpenDeal }: { onOpenDeal: (dealId: string) => void }) {
  const { viewAs, notify } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['my-tasks', viewAs], queryFn: () => api<MyTasks>('/api/me/tasks?status=open') });
  const [busy, setBusy] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<{ task: TaskView; outcome: string } | null>(null);
  const [note, setNote] = useState('');
  const t = q.data;
  if (!t) return null;
  async function submit() {
    if (!noteFor) return;
    setBusy(noteFor.task.id);
    try {
      await post(`/api/me/tasks/${noteFor.task.id}`, { outcome: noteFor.outcome, note });
      notify(`${noteFor.task.business}: ${t!.outcomes.find((o) => o.value === noteFor.outcome)?.label}`);
      setNoteFor(null);
      setNote('');
      await qc.invalidateQueries({ queryKey: ['my-tasks'] });
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not update');
    } finally {
      setBusy(null);
    }
  }
  const overdue = t.tasks.filter((x) => x.overdue).length;
  return (
    <Card title="My calls" extra={<span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{t.tasks.length ? `${t.tasks.length} open${overdue ? ` · ${overdue} overdue` : ''} · log what happened and the reminder stops` : 'nothing waiting on you'}{!viewAs && <CalendarFeed />}</span>}>
      {t.tasks.length === 0 ? <div className="muted">Renewal and draw reminders land here as soon as a deal qualifies. Add your own from any deal.</div> : (
        <div className="pl">
          {t.tasks.map((x) => (
            <div className="row" key={x.id} style={{ gridTemplateColumns: 'minmax(0,1fr) auto', alignItems: 'start' }}>
              <span>
                <b className="click" style={{ cursor: 'pointer' }} onClick={() => onOpenDeal(x.dealId)}>{x.title}</b>
                <div className="subtle" style={{ fontSize: 13 }}>{x.business} · {x.lender}{x.merchantContact ? ` · ${x.merchantContact}` : ''}{x.merchantPhone ? ` · ${x.merchantPhone}` : ''}{x.playbookName ? ` · ${x.playbookName}` : ''}</div>
                {noteFor?.task.id === x.id && (
                  <div className="noteadd" style={{ marginTop: 8 }}>
                    <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened? (goes on the deal as a note)" autoFocus />
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button className="btn primary" disabled={busy === x.id} onClick={() => void submit()}>Save {t.outcomes.find((o) => o.value === noteFor.outcome)?.label.toLowerCase()}</button>
                      <button className="btn" onClick={() => { setNoteFor(null); setNote(''); }}>Cancel</button>
                    </span>
                  </div>
                )}
              </span>
              <span style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
                <Pill tone={x.overdue ? 'red' : 'grey'}>{x.overdue ? `due ${day(x.dueDate)}` : `by ${day(x.dueDate)}`}</Pill>
                <select value="" style={{ height: 30 }} onChange={(e) => { if (e.target.value) { setNoteFor({ task: x, outcome: e.target.value }); setNote(''); } }}>
                  <option value="">Log outcome…</option>
                  {t.outcomes.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Small form: a rep adds a follow-up on one of their own deals. */
export function AddTask({ dealId, base = '/api/me' }: { dealId: string; base?: string }) {
  const { notify } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10));
  if (!open) return <button className="btn" onClick={() => setOpen(true)}>+ Add a follow-up</button>;
  return (
    <div className="noteadd">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Call about the renewal" autoFocus />
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} style={{ width: 150 }} />
        <button className="btn primary" disabled={!title.trim()} onClick={async () => { try { await post(`${base}/deals/${dealId}/tasks`, { title, dueDate: due }); notify('Follow-up added'); setOpen(false); setTitle(''); await qc.invalidateQueries({ queryKey: ['my-tasks'] }); await qc.invalidateQueries({ queryKey: ['deal-tasks', dealId] }); await qc.invalidateQueries({ queryKey: ['admin-tasks'] }); } catch (e) { notify(e instanceof Error ? e.message : 'Could not add'); } }}>Add</button>
        <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </span>
    </div>
  );
}

/** Tasks on one deal, for the admin drawer. */
export function DealTasks({ dealId }: { dealId: string }) {
  const { notify } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['deal-tasks', dealId], queryFn: () => api<{ tasks: TaskView[] }>(`/api/admin/tasks?deal=${encodeURIComponent(dealId)}`) });
  const outcomes = useQuery({ queryKey: ['my-tasks-outcomes'], queryFn: () => api<{ outcomes: MyTasks['outcomes'] }>('/api/admin/playbooks') });
  const tasks = q.data?.tasks ?? [];
  return (
    <section className="card">
      <h3>Tasks <small>from playbooks, from you, or from the rep</small></h3>
      {tasks.length === 0 ? <div className="muted" style={{ marginBottom: 8 }}>No tasks on this deal.</div> : (
        <div className="pl" style={{ marginBottom: 8 }}>
          {tasks.map((t) => (
            <div className="row" key={t.id} style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto' }}>
              <span><b>{t.title}</b><div className="subtle" style={{ fontSize: 13 }}>{t.repName}{t.playbookName ? ` · ${t.playbookName}` : ''}{t.outcome ? ` · ${outcomes.data?.outcomes.find((o) => o.value === t.outcome)?.label ?? t.outcome}` : ''}{t.note ? ` — ${t.note}` : ''}</div></span>
              <Pill tone={t.status === 'done' ? 'teal' : t.overdue ? 'red' : 'grey'}>{t.status === 'done' ? `done ${day(t.doneAt?.slice(0, 10) ?? '')}` : `due ${day(t.dueDate)}`}</Pill>
              {t.status === 'open' ? (
                <select value="" style={{ height: 28 }} onChange={async (e) => { const v = e.target.value; if (!v) return; const note = window.prompt('Note for the deal (optional)') ?? ''; try { await post(`/api/admin/tasks/${t.id}`, { outcome: v, note }); notify('Logged'); await qc.invalidateQueries({ queryKey: ['deal-tasks', dealId] }); await qc.invalidateQueries({ queryKey: ['admin-tasks'] }); await qc.invalidateQueries({ queryKey: ['deal-notes', dealId] }); } catch (x) { notify(x instanceof Error ? x.message : 'Could not update'); } }}>
                  <option value="">outcome…</option>
                  {(outcomes.data?.outcomes ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : <span />}
            </div>
          ))}
        </div>
      )}
      <AddTask dealId={dealId} base="/api/admin" />
    </section>
  );
}

/** Subscribe-once calendar of my tasks, eligibility and maturity dates. */
function CalendarFeed() {
  const { notify } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['calendar-feed'], queryFn: () => api<{ url: string | null; enabled: boolean }>('/api/me/calendar') });
  const [show, setShow] = useState(false);
  if (!q.data) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      {q.data.url && show ? (
        <>
          <input readOnly value={q.data.url} onFocus={(e) => e.target.select()} style={{ height: 28, width: 280, fontFamily: 'var(--mono)', fontSize: 12 }} />
          <button className="btn" style={{ height: 28, padding: '0 8px' }} onClick={() => { void navigator.clipboard?.writeText(q.data!.url!); notify('Feed link copied — add it as a calendar subscription (URL) in Google, Apple or Outlook'); }}>Copy</button>
          <button className="btn" style={{ height: 28, padding: '0 8px' }} title="Revoke this link; a new one can be made any time" onClick={async () => { await post('/api/me/calendar', {}, 'DELETE'); await qc.invalidateQueries({ queryKey: ['calendar-feed'] }); setShow(false); }}>Revoke</button>
        </>
      ) : (
        <button className="btn" style={{ height: 28, padding: '0 8px' }} disabled={DEMO} title={DEMO ? 'Available on the live portal' : 'A private calendar link with your tasks, eligibility and maturity dates'} onClick={async () => { if (!q.data!.url) { await post('/api/me/calendar', {}); await qc.invalidateQueries({ queryKey: ['calendar-feed'] }); } setShow(true); }}>{q.data.enabled ? 'Calendar link' : 'Add to my calendar'}</button>
      )}
    </span>
  );
}
