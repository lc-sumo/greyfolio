/**
 * Outbound email. One tiny interface, three providers:
 *  - resend   — HTTPS API (MAIL_PROVIDER=resend, MAIL_API_KEY=re_…)
 *  - postmark — HTTPS API (MAIL_PROVIDER=postmark, MAIL_API_KEY=server token)
 *  - log      — prints the message as a JSON log line (development default)
 *  - off      — nothing is sent; callers that need email say so to the user
 *
 * No SDKs: both providers are one POST with `fetch`, which keeps the server
 * image small and the demo bundle free of Node-only modules.
 */

export interface Mail {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}

export interface MailResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface Mailer {
  readonly kind: 'resend' | 'postmark' | 'log' | 'off' | 'memory';
  /** True when a message will actually reach an inbox. */
  readonly live: boolean;
  send(mail: Mail): Promise<MailResult>;
}

export interface MailConfig {
  provider: 'resend' | 'postmark' | 'log' | 'off';
  apiKey: string | null;
  from: string;
}

export function mailConfigFromEnv(env: NodeJS.ProcessEnv, production: boolean): MailConfig {
  const raw = (env.MAIL_PROVIDER ?? (production ? 'off' : 'log')).toLowerCase();
  const provider = raw === 'resend' || raw === 'postmark' || raw === 'log' || raw === 'off' ? raw : 'off';
  const apiKey = env.MAIL_API_KEY || null;
  if ((provider === 'resend' || provider === 'postmark') && !apiKey) throw new Error(`MAIL_PROVIDER=${provider} needs MAIL_API_KEY`);
  return { provider, apiKey, from: env.MAIL_FROM || 'Greystone Commission Portal <portal@greystoneus.com>' };
}

const list = (to: string | string[]) => (Array.isArray(to) ? to : [to]);

/** Plain-text bodies become minimal HTML so links stay clickable everywhere. */
export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linked = esc.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>');
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2a24;white-space:pre-wrap">${linked}</div>`;
}

export function mailerFor(cfg: MailConfig): Mailer {
  if (cfg.provider === 'off') return { kind: 'off', live: false, send: async () => ({ ok: false, error: 'Email is not configured (MAIL_PROVIDER)' }) };
  if (cfg.provider === 'log') {
    return {
      kind: 'log',
      live: false,
      async send(m) {
        console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', mail: { to: list(m.to), subject: m.subject, text: m.text } }));
        return { ok: true, id: `log-${Date.now()}` };
      },
    };
  }
  if (cfg.provider === 'resend') {
    return {
      kind: 'resend',
      live: true,
      async send(m) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: cfg.from, to: list(m.to), subject: m.subject, text: m.text, html: m.html ?? textToHtml(m.text) }),
        });
        const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
        return res.ok ? { ok: true, id: body.id } : { ok: false, error: body.message ?? `Resend responded ${res.status}` };
      },
    };
  }
  return {
    kind: 'postmark',
    live: true,
    async send(m) {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'x-postmark-server-token': cfg.apiKey!, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ From: cfg.from, To: list(m.to).join(','), Subject: m.subject, TextBody: m.text, HtmlBody: m.html ?? textToHtml(m.text), MessageStream: 'outbound' }),
      });
      const body = (await res.json().catch(() => ({}))) as { MessageID?: string; Message?: string };
      return res.ok ? { ok: true, id: body.MessageID } : { ok: false, error: body.Message ?? `Postmark responded ${res.status}` };
    },
  };
}

/** Tests and the demo: remembers every message instead of sending it. */
export function memoryMailer(): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return {
    kind: 'memory',
    live: true,
    sent,
    async send(m) {
      sent.push(m);
      return { ok: true, id: `mem-${sent.length}` };
    },
  };
}
