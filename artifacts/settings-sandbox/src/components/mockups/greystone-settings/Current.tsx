import { useState, type ReactNode } from 'react';
import './_group.css';

const tabs = ['Portal', 'Lenders', 'Referral partners', 'Product rules', 'Teams', 'Reps', 'CRM & thresholds', 'Playbooks', 'Import from sheet', 'Lender remittance'];
const nav = ['Funding overview', 'Master deals', 'Merchants', 'Run payroll', 'Renewals', 'Books', 'Rep roster', 'Settings', 'Audit log'];

function Toggle({ title, hint }: { title: string; hint: string }) {
  const [on, setOn] = useState(true);
  return <label className="toggle-row"><button type="button" aria-label={title} className={`tog ${on ? 'on' : ''}`} onClick={() => setOn(!on)} /><span><b>{title}</b><div className="subtle">{hint}</div></span></label>;
}
function Card({ title, extra, children }: { title: string; extra: string; children: ReactNode }) {
  return <section className="card"><h3>{title}<small>{extra}</small></h3>{children}</section>;
}

export function Current() {
  const [tab, setTab] = useState('Portal');
  const [names, setNames] = useState({ company: 'Greystone Merchant Partners', portal: 'Commission portal', email: 'ops@greystone.com' });
  return <div className="gs-settings">
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><div className="mark">G</div><div><b>Greystone</b><span>Commission portal</span></div></div>
        <nav className="nav"><div className="nav-group label" style={{color:'var(--navy-text-3)'}}>Admin</div>{nav.map(item => <a href="#settings" key={item} className={item === 'Settings' ? 'active' : ''}><i className="dot" />{item}</a>)}</nav>
        <div className="sidebar-foot"><label className="viewas"><span className="label">View as</span><select defaultValue="admin"><option value="admin">Admin — master view</option></select></label>
          <div className="who"><div className="avatar">L</div><div><b>Leor</b><span>Super admin</span></div></div><button className="linkish">Change password</button><button className="linkish">Two-factor sign-in</button><button className="linkish">Sign out</button>
        </div>
      </aside>
      <main className="main">
        <header className="header"><div><div className="label">Admin</div><h1>Settings</h1></div></header>
        <div className="body">
          <div className="seg">{tabs.map(item => <button type="button" className={tab === item ? 'on' : ''} onClick={() => setTab(item)} key={item}>{item}</button>)}</div>
          <div className="muted" style={{marginTop:-6}}>Names, automatic emails, security and the dropdown lists — everything about how the portal itself behaves.</div>
          <div className="portal-grid">
            <Card title="Names" extra="sidebar, sign-in screen, emails and authenticator apps"><div className="form">
              <label className="field"><span className="label">Company</span><input value={names.company} onChange={e => setNames({...names,company:e.target.value})}/></label>
              <label className="field"><span className="label">Portal name</span><input value={names.portal} onChange={e => setNames({...names,portal:e.target.value})}/></label>
              <label className="field"><span className="label">Support email</span><input value={names.email} onChange={e => setNames({...names,email:e.target.value})}/><span className="subtle">Shown to reps when something needs a human</span></label>
              </div><button className="btn primary" style={{marginTop:12}}>Save names</button></Card>
            <Card title="Automatic emails" extra="each one is logged in the Audit log as mail.sent">
              <Toggle title="Statements when a run is approved" hint="Every rep with lines in the run gets their summary and a link to Pay history." />
              <Toggle title="Clawback notices" hint="Each rep with a slice hears the amount and that it nets against their next payout." />
              <Toggle title="Rep questions to admins" hint="When a rep asks about a deal from their drawer, admins get the note by email too." />
              <Toggle title="Daily renewal digest" hint="Refi-ready and Prospecting deals, to every admin, once a day." />
              <label className="field" style={{marginTop:6}}><span className="label">Digest goes out at</span><select defaultValue="8"><option value="8">08 your time · 13:00 UTC</option></select></label>
              <label className="field" style={{marginTop:6}}><span className="label">Playbooks run daily at</span><select defaultValue="7"><option value="7">07 your time · 12:00 UTC</option></select><span className="subtle">Rules under Settings › Playbooks fire once a day after this hour; rep emails roll up into one message.</span></label>
              <button className="btn primary" style={{marginTop:12}}>Save emails</button><div className="subtle" style={{fontSize:13,marginTop:10}}>The sending address and provider key live in the host's Secrets (MAIL_PROVIDER, MAIL_API_KEY, MAIL_FROM) — those never change from here.</div>
            </Card>
            <Card title="Permissions" extra="what reps may do from their portal"><Toggle title="Reps can email merchants from a deal" hint="Off hides the button for everyone. On, you can still block individual reps under Reps › Merchant email. Emails go out under the rep's name from the templates under Playbooks." /><Toggle title="Reps can fill in merchant details on their deals" hint="Contact name, email and phone — never the business name or the money. Saved to the merchant record and audited, so Merchants, renewals and playbooks see it too." /><button className="btn primary" style={{marginTop:12}}>Save permissions</button></Card>
            <Card title="Security" extra="passwords and two-factor"><Toggle title="Require two-factor for admins" hint="Admins who have not set up an authenticator are held at a setup screen until they do. Turn on your own first." /><label className="field" style={{marginTop:8}}><span className="label">Sign out after inactivity</span><select><option>4 hours</option></select><span className="subtle">Everyone, admins included. A tab left open returns to the sign-in screen; the server refuses the old session too.</span></label><label className="field" style={{marginTop:8}}><span className="label">Remember a device after a two-factor code</span><select><option>14 days</option></select><span className="subtle">The rep still types their password; the code is skipped on a remembered browser.</span></label><button className="btn primary" style={{marginTop:12}}>Save security</button></Card>
            <Card title="Dropdown lists" extra="one per line · commission statuses are fixed because they drive collection"><div className="form" style={{gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))'}}><label className="field"><span className="label">Payment frequencies</span><textarea rows={6} defaultValue={'Weekly\nBi-weekly\nMonthly'} /></label><label className="field"><span className="label">Deal statuses</span><textarea rows={6} defaultValue={'Performing\nProspecting\nRefi Ready'} /><span className="subtle">Keep Performing, Prospecting and Refi Ready — the portal sets those itself.</span></label></div><button className="btn primary" style={{marginTop:12}}>Save lists</button></Card>
          </div>
        </div>
      </main>
    </div>
  </div>;
}