import { useState, type ReactNode } from 'react';

const tabs = ['Portal', 'Lenders', 'Referral partners', 'Product rules', 'Teams', 'Reps', 'CRM & thresholds', 'Playbooks', 'Import from sheet', 'Lender remittance'];
const nav = ['Funding overview', 'Master deals', 'Merchants', 'Run payroll', 'Renewals', 'Books', 'Rep roster', 'Settings', 'Audit log'];

const css = `
.tech-settings{--ink:#17252d;--muted:#6f7e86;--faint:#9aa7ad;--line:#d8e0e3;--line2:#e8edef;--paper:#f4f7f8;--surface:#fff;--nav:#11242d;--nav2:#19343e;--cyan:#0b7790;--cyan-dark:#075a70;--cyan-soft:#e4f3f6;--lime:#b9dc72;min-height:100vh;background:var(--paper);color:var(--ink);font:14px/1.42 'DM Sans',ui-sans-serif,system-ui,sans-serif;letter-spacing:-.01em;-webkit-font-smoothing:antialiased}
.tech-settings *{box-sizing:border-box}.tech-settings button,.tech-settings input,.tech-settings select,.tech-settings textarea{font:inherit}
.ts-shell{display:grid;grid-template-columns:244px minmax(0,1fr);min-height:100vh}
.ts-side{background:var(--nav);color:#d9e4e7;padding:20px 13px 15px;display:flex;flex-direction:column;min-height:100vh}
.ts-brand{display:flex;align-items:center;gap:11px;padding:2px 10px 21px;border-bottom:1px solid #29414a;margin-bottom:17px}
.ts-mark{width:28px;height:28px;border:1px solid #77b5c1;border-radius:7px;display:grid;place-items:center;color:#c6eef2;font:700 16px Georgia,serif;position:relative}
.ts-mark:after{content:'';width:5px;height:5px;background:var(--lime);border-radius:50%;position:absolute;right:-3px;top:-3px}
.ts-brand strong{display:block;color:#f4fbfc;font-size:15px;letter-spacing:.01em}.ts-brand span{display:block;color:#8ca6ad;font-size:11px;margin-top:1px}
.ts-eyebrow,.ts-label{font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8ea5ac}
.ts-nav{display:grid;gap:3px}.ts-nav .ts-eyebrow{padding:0 10px 8px}
.ts-nav a{height:35px;padding:0 10px;display:flex;align-items:center;gap:10px;color:#a9bdc2;text-decoration:none;border-radius:6px;transition:background .16s,color .16s,transform .16s}
.ts-nav a:hover{background:#19343e;color:#fff;transform:translateX(2px)}.ts-nav a.active{background:#214550;color:#fff;box-shadow:inset 3px 0 var(--lime)}
.ts-nav a i{width:5px;height:5px;border-radius:50%;border:1px solid #66828a}.ts-nav a.active i{background:var(--lime);border-color:var(--lime)}
.ts-sidefoot{margin-top:auto;border-top:1px solid #29414a;padding:15px 8px 0;display:grid;gap:10px}.ts-sidefoot select{height:33px;width:100%;background:#19343e;color:#e6f1f3;border:1px solid #34535c;border-radius:5px;padding:0 8px;font-size:12px}
.ts-user{display:flex;gap:9px;align-items:center;padding:4px 2px}.ts-avatar{width:27px;height:27px;border-radius:50%;background:#355763;color:#e5fafb;display:grid;place-items:center;font-size:12px;font-weight:700}.ts-user b{display:block;font-size:13px;color:#f2f8f9}.ts-user span{display:block;color:#8fa7ad;font-size:11px}
.ts-link{border:0;background:transparent;text-align:left;padding:0 2px;color:#8fa7ad;font-size:11px;cursor:pointer}.ts-link:hover{color:#d9f1f3}
.ts-main{min-width:0}.ts-header{height:84px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 31px}
.ts-header h1{font-size:25px;line-height:1.05;margin:4px 0 0;font-weight:750;letter-spacing:-.045em}.ts-header .ts-eyebrow{color:var(--cyan);font-size:9px}
.ts-status{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.ts-status i{width:7px;height:7px;background:#71bd7c;border-radius:50%;box-shadow:0 0 0 3px #e3f3e6}
.ts-body{padding:22px 31px 38px;max-width:1510px}.ts-tabs{display:flex;align-items:center;gap:3px;overflow:auto;background:#fff;border:1px solid var(--line);border-radius:7px;padding:4px;box-shadow:0 1px 1px #18384408}.ts-tabs button{border:0;background:transparent;color:#6b7b82;white-space:nowrap;padding:8px 11px;border-radius:4px;font-size:12px;font-weight:650;cursor:pointer;transition:background .16s,color .16s}.ts-tabs button:hover{color:var(--ink);background:#f0f5f6}.ts-tabs button.on{background:var(--nav);color:#fff}
.ts-intro{display:flex;align-items:baseline;justify-content:space-between;gap:18px;margin:16px 1px 19px}.ts-intro p{margin:0;color:var(--muted);font-size:13px}.ts-intro .ts-meta{font:10px ui-monospace,SFMono-Regular,monospace;letter-spacing:.08em;text-transform:uppercase;color:#94a1a6}
.ts-grid{display:grid;grid-template-columns:minmax(300px,.9fr) minmax(380px,1.35fr) minmax(300px,.9fr);gap:13px;align-items:start}
.ts-card{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:18px 18px 16px;box-shadow:0 2px 7px #16343d08;min-width:0}.ts-card.wide{grid-column:span 2}.ts-card-head{display:flex;justify-content:space-between;gap:15px;align-items:flex-start;border-bottom:1px solid var(--line2);padding-bottom:12px;margin-bottom:14px}.ts-card h2{font-size:14px;margin:0;font-weight:750;letter-spacing:-.015em}.ts-card-head span{display:block;margin-top:3px;color:#8a989d;font-size:11px;line-height:1.35}.ts-code{color:#9aa8ad;font:10px ui-monospace,SFMono-Regular,monospace;white-space:nowrap}
.ts-form{display:grid;gap:12px}.ts-field{display:grid;gap:5px}.ts-field label,.ts-field>span:first-child{font-size:10px;font-weight:750;letter-spacing:.1em;text-transform:uppercase;color:#718087}.ts-field input,.ts-field select,.ts-field textarea{width:100%;border:1px solid #ccd7da;background:#fbfcfc;border-radius:5px;padding:0 10px;color:var(--ink);outline:none;transition:border .16s,box-shadow .16s,background .16s}.ts-field input,.ts-field select{height:35px}.ts-field textarea{padding:8px 10px;resize:vertical;line-height:1.65}.ts-field input:focus,.ts-field select:focus,.ts-field textarea:focus{border-color:#57a9ba;background:#fff;box-shadow:0 0 0 3px #d9f0f3}.ts-help{font-size:11px;color:#98a5a9;line-height:1.35}
.ts-actions{display:flex;align-items:center;gap:10px;margin-top:14px}.ts-btn{height:34px;border-radius:5px;padding:0 12px;border:1px solid #c7d3d6;background:#fff;color:#63747a;font-weight:700;font-size:12px;cursor:pointer;transition:background .16s,transform .16s,border .16s}.ts-btn:hover{transform:translateY(-1px);border-color:#9ebbc2;background:#f6fafb}.ts-btn.primary{background:var(--cyan);border-color:var(--cyan);color:#fff}.ts-btn.primary:hover{background:var(--cyan-dark);border-color:var(--cyan-dark)}.ts-saved{color:#40865e;font-size:11px;animation:ts-in .2s ease-out}@keyframes ts-in{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}
.ts-toggle{display:grid;grid-template-columns:31px 1fr;gap:10px;align-items:start;padding:0 0 12px}.ts-toggle:last-of-type{padding-bottom:0}.ts-toggle button{width:30px;height:18px;border:0;border-radius:10px;background:#c5d0d3;padding:0;position:relative;cursor:pointer;transition:background .18s}.ts-toggle button:after{content:'';position:absolute;top:3px;left:3px;width:12px;height:12px;background:#fff;border-radius:50%;transition:transform .18s}.ts-toggle button.on{background:var(--cyan)}.ts-toggle button.on:after{transform:translateX(12px)}.ts-toggle strong{font-size:12px;display:block;line-height:1.25}.ts-toggle p{margin:3px 0 0;color:#89979c;font-size:11px;line-height:1.35}
.ts-rule{border-top:1px solid var(--line2);margin:3px 0 13px}.ts-footnote{margin:12px 0 0;color:#9aa6aa;font-size:10px;line-height:1.45}
@media(max-width:1120px){.ts-grid{grid-template-columns:repeat(2,minmax(280px,1fr))}.ts-card.wide{grid-column:span 2}}
@media(max-width:760px){.ts-shell{display:block}.ts-side{min-height:auto;padding:13px}.ts-brand{margin-bottom:10px;padding-bottom:13px}.ts-nav{display:flex;overflow:auto}.ts-nav .ts-eyebrow,.ts-sidefoot{display:none}.ts-nav a{white-space:nowrap}.ts-header{height:70px;padding:0 17px}.ts-status{display:none}.ts-body{padding:14px 13px 28px}.ts-intro{display:block;margin:13px 1px}.ts-intro .ts-meta{display:block;margin-top:8px}.ts-grid{display:block}.ts-card{margin-bottom:12px}.ts-card.wide{grid-column:auto}.ts-tabs{border-radius:6px}}
`;

function Toggle({ title, hint, initial = true }: { title: string; hint: string; initial?: boolean }) {
  const [on, setOn] = useState(initial);
  return <div className="ts-toggle"><button type="button" aria-label={title} className={on ? 'on' : ''} onClick={() => setOn(!on)} /><div><strong>{title}</strong><p>{hint}</p></div></div>;
}

function SaveButton({ children = 'Save changes' }: { children?: ReactNode }) {
  const [saved, setSaved] = useState(false);
  return <div className="ts-actions"><button className="ts-btn primary" type="button" onClick={() => { setSaved(true); window.setTimeout(() => setSaved(false), 2200); }}>{children}</button>{saved && <span className="ts-saved">Saved just now</span>}</div>;
}

function Card({ title, note, code, className = '', children }: { title: string; note: string; code?: string; className?: string; children: ReactNode }) {
  return <section className={`ts-card ${className}`}><div className="ts-card-head"><div><h2>{title}</h2><span>{note}</span></div>{code && <div className="ts-code">{code}</div>}</div>{children}</section>;
}

export function TechnicalClean() {
  const [tab, setTab] = useState('Portal');
  const [names, setNames] = useState({ company: 'Greystone Merchant Partners', portal: 'Commission portal', email: 'ops@greystone.com' });
  return <div className="tech-settings"><style>{css}</style><div className="ts-shell">
    <aside className="ts-side">
      <div className="ts-brand"><div className="ts-mark">G</div><div><strong>Greystone</strong><span>Commission portal</span></div></div>
      <nav className="ts-nav"><div className="ts-eyebrow">Admin / workspace</div>{nav.map(item => <a href="#settings" className={item === 'Settings' ? 'active' : ''} key={item}><i />{item}</a>)}</nav>
      <div className="ts-sidefoot"><div className="ts-label">View as</div><select defaultValue="admin"><option value="admin">Admin — master view</option></select><div className="ts-user"><div className="ts-avatar">L</div><div><b>Leor</b><span>Super admin</span></div></div><button className="ts-link" type="button">Change password</button><button className="ts-link" type="button">Two-factor sign-in</button><button className="ts-link" type="button">Sign out</button></div>
    </aside>
    <main className="ts-main"><header className="ts-header"><div><div className="ts-eyebrow">Admin / controls</div><h1>Settings</h1></div><div className="ts-status"><i />All systems operational</div></header>
      <div className="ts-body"><div className="ts-tabs">{tabs.map(item => <button type="button" className={tab === item ? 'on' : ''} onClick={() => setTab(item)} key={item}>{item}</button>)}</div>
        <div className="ts-intro"><p>Names, automatic emails, security and the dropdown lists — everything about how the portal itself behaves.</p><span className="ts-meta">Portal configuration · v2.4</span></div>
        <div className="ts-grid">
          <Card title="Names" note="Sidebar, sign-in screen, emails and authenticator apps" code="PORTAL.01"><div className="ts-form">
            <div className="ts-field"><label>Company</label><input value={names.company} onChange={e => setNames({ ...names, company: e.target.value })} /></div>
            <div className="ts-field"><label>Portal name</label><input value={names.portal} onChange={e => setNames({ ...names, portal: e.target.value })} /></div>
            <div className="ts-field"><label>Support email</label><input value={names.email} onChange={e => setNames({ ...names, email: e.target.value })} /><span className="ts-help">Shown to reps when something needs a human</span></div>
          </div><SaveButton>Save names</SaveButton></Card>
          <Card title="Automatic emails" note="Each one is logged in the Audit log as mail.sent" code="PORTAL.02">
            <Toggle title="Statements when a run is approved" hint="Every rep with lines in the run gets their summary and a link to Pay history." /><Toggle title="Clawback notices" hint="Each rep with a slice hears the amount and that it nets against their next payout." /><Toggle title="Rep questions to admins" hint="When a rep asks about a deal from their drawer, admins get the note by email too." /><Toggle title="Daily renewal digest" hint="Refi-ready and Prospecting deals, to every admin, once a day." />
            <div className="ts-rule" /><div className="ts-form"><div className="ts-field"><label>Digest goes out at</label><select defaultValue="8"><option value="8">08 your time · 13:00 UTC</option></select></div><div className="ts-field"><label>Playbooks run daily at</label><select defaultValue="7"><option value="7">07 your time · 12:00 UTC</option></select><span className="ts-help">Rules under Settings › Playbooks fire once a day after this hour; rep emails roll up into one message.</span></div></div><SaveButton>Save email controls</SaveButton><p className="ts-footnote">The sending address and provider key live in the host's Secrets (MAIL_PROVIDER, MAIL_API_KEY, MAIL_FROM) — those never change from here.</p>
          </Card>
          <Card title="Permissions" note="What reps may do from their portal" code="PORTAL.03"><Toggle title="Reps can email merchants from a deal" hint="Off hides the button for everyone. On, you can still block individual reps under Reps › Merchant email. Emails go out under the rep's name from the templates under Playbooks." /><Toggle title="Reps can fill in merchant details on their deals" hint="Contact name, email and phone — never the business name or the money. Saved to the merchant record and audited, so Merchants, renewals and playbooks see it too." /><SaveButton>Save permissions</SaveButton></Card>
          <Card title="Security" note="Passwords and two-factor controls" code="PORTAL.04"><Toggle title="Require two-factor for admins" hint="Admins who have not set up an authenticator are held at a setup screen until they do. Turn on your own first." /><div className="ts-form"><div className="ts-field"><label>Sign out after inactivity</label><select defaultValue="4"><option value="4">4 hours</option></select><span className="ts-help">Everyone, admins included. A tab left open returns to the sign-in screen; the server refuses the old session too.</span></div><div className="ts-field"><label>Remember a device after a two-factor code</label><select defaultValue="14"><option value="14">14 days</option></select><span className="ts-help">The rep still types their password; the code is skipped on a remembered browser.</span></div></div><SaveButton>Save security</SaveButton></Card>
          <Card title="Dropdown lists" note="One per line · commission statuses are fixed because they drive collection" code="PORTAL.05" className="wide"><div className="ts-form" style={{ gridTemplateColumns: 'repeat(2,minmax(0,1fr))' }}><div className="ts-field"><label>Payment frequencies</label><textarea rows={5} defaultValue={'Weekly\nBi-weekly\nMonthly'} /></div><div className="ts-field"><label>Deal statuses</label><textarea rows={5} defaultValue={'Performing\nProspecting\nRefi Ready'} /><span className="ts-help">Keep Performing, Prospecting and Refi Ready — the portal sets those itself.</span></div></div><SaveButton>Save lists</SaveButton></Card>
        </div>
      </div>
    </main>
  </div></div>;
}