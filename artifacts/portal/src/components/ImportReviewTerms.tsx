import type { Settings } from '../lib/api';
import type { Source } from './import-review-types';

type Editable = Omit<Source, 'id' | 'line' | 'commissionStatus' | 'lenderPaid' | 'repPaid'>;
type Change = (key: keyof Editable, value: string | number | null) => void;

const numberValue = (value: number | null) => value === null ? '' : String(value);
function Numeric({ label, value, onChange, step = '0.01', hint }: {
  label: string; value: number | null; onChange: (value: number | null) => void; step?: string; hint?: string;
}) {
  return <label>{label}<input type="number" min="0" step={step} value={numberValue(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />{hint && <small>{hint}</small>}</label>;
}
function Text({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label>{label}<input type="text" value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
function Options({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  const choices = [...new Set([value, ...options].filter(Boolean))];
  return <label>{label}<select value={value} onChange={(e) => onChange(e.target.value)}><option value="">None / choose</option>{choices.map((x) => <option value={x} key={x}>{x}</option>)}</select></label>;
}

export function ImportReviewTerms({ terms, settings, roster, onChange }: {
  terms: Source; settings?: Settings;
  roster: string[]; onChange: Change;
}) {
  const lenderNames = settings?.lenders.map((l) => l.name) ?? [];
  const productNames = settings?.products.map((p) => p.name) ?? [];
  const partnerNames = settings?.partners.map((p) => p.name) ?? [];
  const frequencies = settings?.lists.frequencies ?? [];
  return <div className="review-terms">
    <div className="review-section-title"><b>Deal terms</b><span>Pre-filled from the tracker. Change anything that is wrong before confirming.</span></div>
    <div className="review-form-grid">
      <Text label="Business name" value={terms.business} onChange={(v) => onChange('business', v)} />
      <label>Funded date<input type="date" value={terms.date} onChange={(e) => onChange('date', e.target.value)} /></label>
      <Numeric label="Funded / draw amount" value={terms.amount} onChange={(v) => onChange('amount', v ?? 0)} />
      <Options label="Lender" value={terms.lender} options={lenderNames} onChange={(v) => onChange('lender', v)} />
      <Options label="Product" value={terms.product} options={productNames} onChange={(v) => onChange('product', v)} />
      <Numeric label="Commission rate (%)" value={terms.commRate} onChange={(v) => onChange('commRate', v)} hint={terms.commRate !== null && terms.commRate <= 1 ? 'Sheet uses a fractional rate; confirm before importing.' : undefined} />
      <Numeric label="Gross commission" value={terms.gross} onChange={(v) => onChange('gross', v)} />
      <Numeric label="Total rep payout" value={terms.totalRepPayout} onChange={(v) => onChange('totalRepPayout', v)} />
    </div>
    <details className="review-more"><summary>Additional terms and rep splits</summary>
      <div className="review-form-grid">
        <Text label="Parent deal ID (initial row may match its own ID)" value={terms.parent} onChange={(v) => onChange('parent', v.toUpperCase())} />
        <Numeric label="Factor / APR" value={terms.factor} onChange={(v) => onChange('factor', v)} step="0.0001" />
        <Numeric label="Term (business days)" value={terms.termDays} onChange={(v) => onChange('termDays', v)} step="1" />
        <Options label="Payment frequency" value={terms.frequency} options={frequencies} onChange={(v) => onChange('frequency', v)} />
        <Numeric label="PSF %" value={terms.psf} onChange={(v) => onChange('psf', v)} />
        <Numeric label="PSF $" value={terms.psfDollars} onChange={(v) => onChange('psfDollars', v)} />
        <Options label="Referral partner" value={terms.referralPartner} options={partnerNames} onChange={(v) => onChange('referralPartner', v)} />
        <Numeric label="Referral fee $" value={terms.referralFee} onChange={(v) => onChange('referralFee', v)} />
        <Options label="Opener" value={terms.opener} options={roster} onChange={(v) => onChange('opener', v)} />
        <Numeric label="Opener rate (%)" value={terms.openerRate} onChange={(v) => onChange('openerRate', v)} />
        <Numeric label="Opener payout $" value={terms.openerDollars} onChange={(v) => onChange('openerDollars', v)} />
        <Options label="Closer" value={terms.closer} options={roster} onChange={(v) => onChange('closer', v)} />
        <Numeric label="Closer rate (%)" value={terms.closerRate} onChange={(v) => onChange('closerRate', v)} />
        <Numeric label="Closer payout $" value={terms.closerDollars} onChange={(v) => onChange('closerDollars', v)} />
        <Options label="Override" value={terms.override} options={roster} onChange={(v) => onChange('override', v)} />
        <Numeric label="Override rate (%)" value={terms.overrideRate} onChange={(v) => onChange('overrideRate', v)} />
        <Numeric label="Override payout $" value={terms.overrideDollars} onChange={(v) => onChange('overrideDollars', v)} />
        <Numeric label="Clawback amount $" value={terms.clawbackAmount} onChange={(v) => onChange('clawbackAmount', v)} />
        <label>Clawback date<input type="date" value={terms.clawbackDate} onChange={(e) => onChange('clawbackDate', e.target.value)} /></label>
        <Options label="Deal status" value={terms.dealStatus} options={settings?.lists.dealStatuses ?? []} onChange={(v) => onChange('dealStatus', v)} />
        <Text label="Lead source" value={terms.leadSource} onChange={(v) => onChange('leadSource', v)} />
        <Text label="Deal notes from tracker" value={terms.notes} onChange={(v) => onChange('notes', v)} />
      </div>
    </details>
    <small className="review-source-note">Original sheet values stay on record; corrections are saved separately.</small>
  </div>;
}