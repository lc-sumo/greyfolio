export type Answer = 'unknown' | 'unpaid' | 'paid';
export type Status = 'not_reviewed' | 'in_progress' | 'needs_attention' | 'reviewed' | 'imported';

export interface Source {
  line: number; id: string; parent: string; date: string; business: string; lender: string; product: string;
  amount: number; factor: number | null; termDays: number | null; frequency: string; commRate: number | null;
  psf: number | null; psfDollars: number | null; gross: number | null; referralFee: number | null;
  totalRepPayout: number | null; referralPartner: string; opener: string; openerRate: number | null;
  openerDollars: number | null; closer: string; closerRate: number | null; closerDollars: number | null;
  override: string; overrideRate: number | null; overrideDollars: number | null;
  clawbackAmount: number | null; clawbackDate: string; dealStatus: string; notes: string; leadSource: string;
  lenderPaid: string; repPaid: string; commissionStatus: string;
}

export interface Decision {
  termsConfirmed: boolean;
  terms?: Partial<Source>;
  lender: Answer; lenderAmount: number | null; lenderDate: string | null;
  reps: Answer; repAmount: number | null; repDate: string | null; notes: string;
  repPayments: Array<{ repId: string; role: string; amount: number; paidAt: string }>;
  lenderWeeks: number | null;
}

export interface ReviewRow {
  sourceId: string; sourceHash: string; source: Source; review: Decision; status: Status; revision: number;
  issues: string[]; alreadyInPortal: boolean; updatedAt: string;
}