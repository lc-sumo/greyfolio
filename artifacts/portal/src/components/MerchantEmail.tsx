import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { DEMO, api, post, type MerchantPreview, type MerchantTemplate } from '../lib/api';
import { useSession } from '../lib/session';

/** The rep picks a template, reads it rendered for this deal, edits if they like, sends under their own name. */
export function MerchantEmail({ dealId, merchantEmail }: { dealId: string; merchantEmail: string }) {
  const { notify, viewAs } = useSession();
  const tpl = useQuery({ queryKey: ['merchant-templates'], queryFn: () => api<{ merchant: MerchantTemplate[]; live: boolean; allowed: boolean }>('/api/me/templates') });
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || !templateId) return;
    void api<MerchantPreview>(`/api/me/deals/${encodeURIComponent(dealId)}/merchant-email/preview?template=${encodeURIComponent(templateId)}`).then((p) => { setSubject(p.subject); setBody(p.body); }).catch((e) => notify(e instanceof Error ? e.message : 'Could not load the template'));
  }, [open, templateId, dealId, notify]);
  if (viewAs || (tpl.data && !tpl.data.allowed)) return null;
  if (!open) return <button className="btn" onClick={() => { setOpen(true); setTemplateId(tpl.data?.merchant[0]?.id ?? ''); }} title={merchantEmail ? `Email ${merchantEmail} from a template, under your name` : 'This deal has no merchant email on file'} disabled={!merchantEmail}>Email the merchant</button>;
  return (
    <section className="card">
      <h3>Email the merchant <small>to {merchantEmail} · sent under your name, replies come to you</small></h3>
      <div style={{ display: 'grid', gap: 8 }}>
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>{(tpl.data?.merchant ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
        <textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} style={{ border: '1px solid var(--border-strong)', borderRadius: 8, padding: '8px 10px', background: 'var(--input-bg)', color: 'inherit', font: 'inherit' }} />
        <span style={{ display: 'flex', gap: 6 }}>
          <button className="btn primary" disabled={busy || !subject.trim() || !body.trim() || (tpl.data ? !tpl.data.live && !DEMO : false)} onClick={async () => { setBusy(true); try { await post(`/api/me/deals/${dealId}/merchant-email`, { templateId, subject, body }); notify(`Sent to ${merchantEmail}`); setOpen(false); } catch (e) { notify(e instanceof Error ? e.message : 'Could not send'); } finally { setBusy(false); } }}>{busy ? 'Sending…' : 'Send'}</button>
          <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          {tpl.data && !tpl.data.live && !DEMO && <span className="subtle" style={{ fontSize: 13, alignSelf: 'center' }}>Email is not set up on this portal yet.</span>}
        </span>
      </div>
    </section>
  );
}
