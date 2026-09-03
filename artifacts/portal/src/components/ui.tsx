import type { ReactNode } from 'react';
import type { CommissionStatus, PayoutStatus } from '../lib/api';

export function Card({ title, extra, children, className = '' }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <h3>
          {title}
          {extra && <small>{extra}</small>}
        </h3>
      )}
      {children}
    </section>
  );
}

export function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: ReactNode; tone?: 'pos' | 'neg' | 'warn' }) {
  return (
    <section className="card">
      <div className="label">{label}</div>
      <div className={`metric ${tone ?? ''}`}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </section>
  );
}

export function Pill({ tone, children }: { tone: 'teal' | 'amber' | 'red' | 'grey'; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function toneFor(status: CommissionStatus | PayoutStatus | string): 'teal' | 'amber' | 'red' | 'grey' {
  if (status === 'YES - Paid In Full' || status === 'Paid' || status === 'paid' || status === 'recovered' || status === 'Collected') return 'teal';
  if (status === 'Partially Paid' || status === 'Invoice Sent' || status === 'Partially paid' || status === 'approved' || status === 'Owed' || status === 'Part collected') return 'amber';
  if (status === 'open' || status === 'Slow Pay' || status === 'Default') return 'red';
  return 'grey';
}

/** Merchant contact stacked: name, email (mailto), phone (click-to-call). Clicks never bubble into a row's open handler. */
export function Contact({ name, email, phone, size = 'table' }: { name?: string | null; email?: string | null; phone?: string | null; size?: 'table' | 'inline' }) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  if (!name && !email && !phone) return <span className="subtle">—</span>;
  return (
    <div className={`contact ${size}`}>
      {name && <span className="name">{name}</span>}
      {email && <a href={`mailto:${email}`} onClick={stop} title="Email merchant">{email}</a>}
      {phone && <a className="tel" href={`tel:${phone.replace(/[^+\d]/g, '')}`} onClick={stop} title="Call merchant">{phone}</a>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Drawer({ title, sub, onClose, children }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <button className="btn close" onClick={onClose} aria-label="Close">✕</button>
        <div>
          <h2>{title}</h2>
          {sub && <div className="muted" style={{ marginTop: 4 }}>{sub}</div>}
        </div>
        {children}
      </aside>
    </>
  );
}

export function Loading({ error }: { error?: unknown }) {
  if (error) return <div className="note neg">{error instanceof Error ? error.message : 'Something went wrong'}</div>;
  return <div className="empty">Loading…</div>;
}
