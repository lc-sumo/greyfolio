import type { WalletAdjustment } from '@greystone/commission';
import type { Repo } from '../repo.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function validateAdjustmentInput(input: { amount: unknown; reason: unknown; effectiveDate: unknown }) {
  const amount = Number(input.amount);
  const reason = String(input.reason ?? '').trim();
  const effectiveDate = String(input.effectiveDate ?? '');
  const today = new Date().toISOString().slice(0, 10);
  if (!Number.isFinite(amount) || Math.abs(amount) > 1_000_000_000 || amount === 0 || Math.round(amount * 100) !== amount * 100) throw new Error('amount must be nonzero exact cents within bounds');
  if (!reason || reason.length > 500) throw new Error('reason is required and must be at most 500 characters');
  if (!ISO.test(effectiveDate)) throw new Error('effectiveDate must be an ISO date');
  const date = new Date(`${effectiveDate}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== effectiveDate || effectiveDate > today) throw new Error('effectiveDate must be a valid nonfuture date');
  return { amount, reason, effectiveDate };
}

export async function createAdjustment(repo: Repo, input: { idempotencyKey: string; dealId: string; repId: string; amount: unknown; reason: unknown; effectiveDate: unknown }, actorRepId: string) {
  const key = input.idempotencyKey.trim();
  if (!key) throw new Error('idempotencyKey is required');
  const { amount, reason, effectiveDate } = validateAdjustmentInput(input);
  const ctx = await repo.loadContext();
  if (!ctx.deals.some((d) => d.id === input.dealId)) throw new Error('deal not found');
  if (!(await repo.findRep(input.repId))) throw new Error('rep not found');
  const existing = (await repo.listWalletAdjustments()).find((a) => a.idempotencyKey === key);
  if (existing) {
    if (existing.dealId !== input.dealId || existing.repId !== input.repId || existing.amount !== amount || existing.reason !== reason || existing.effectiveDate !== effectiveDate) throw new Error('idempotency key conflicts with an existing adjustment');
    return existing;
  }
  const now = new Date().toISOString();
  return repo.createWalletAdjustment({ id: `wa-${crypto.randomUUID()}`, idempotencyKey: key, dealId: input.dealId, repId: input.repId, amount, reason, effectiveDate, actorRepId, reversalOf: null, createdAt: now });
}

export async function reverseAdjustment(repo: Repo, id: string, idempotencyKey: string, reason: unknown, actorRepId: string) {
  const key = idempotencyKey.trim();
  if (!key) throw new Error('idempotencyKey is required');
  const all = await repo.listWalletAdjustments();
  const original = all.find((a) => a.id === id);
  if (!original) throw new Error('adjustment not found');
  if (original.reversalOf) throw new Error('cannot reverse a reversal');
  const prior = all.find((a) => a.reversalOf === id);
  if (prior) {
    if (prior.idempotencyKey === key) return prior;
    throw new Error('adjustment has already been reversed');
  }
  const parsed = validateAdjustmentInput({ amount: -original.amount, reason: reason || `Reversal: ${original.reason}`, effectiveDate: new Date().toISOString().slice(0, 10) });
  const existing = all.find((a) => a.idempotencyKey === key);
  if (existing) {
    if (existing.reversalOf !== id) throw new Error('idempotency key conflicts with an existing adjustment');
    return existing;
  }
  return repo.reverseWalletAdjustment(id, { id: `wa-${crypto.randomUUID()}`, idempotencyKey: key, dealId: original.dealId, repId: original.repId, amount: parsed.amount, reason: parsed.reason, effectiveDate: parsed.effectiveDate, actorRepId, reversalOf: id, createdAt: new Date().toISOString() });
}