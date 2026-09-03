# Phase 5 review notes — payroll

Phase 5 of [BUILD-ORDER.md](../design_handoff_greystone_commission_portal/BUILD-ORDER.md) is complete: runs, per-rep line selection, clawback netting, ledger writes with recovery rows, the paid-in-run ledger, CSV export, and the rep pinned on commit. Admin only, like every other write.

## What was built

**API (`artifacts/api-server`)**
- `services/payroll.ts`
  - `nextPeriod` / `createRun` — twice-monthly periods (1–15, 16–end) following the latest run; overlapping periods are refused.
  - `advanceRun` — `draft → approved → paid`; a paid run is locked.
  - `paySelected` — plans through the domain's `planPayout` (ledger rows, oldest-first recovery rows, `repPaid` stamps), then commits in **one transaction** via `repo.commitPayout`. Refuses a locked run, an unknown rep, an empty selection, another rep's line, and any line already in the ledger. The response echoes `repId` so the client pins it.
- `payroll-views.ts` — run summaries from the ledger (gross paid, recovered, cash, reps, lines), the rep list **sorted by amount owed** with outstanding line counts (every figure is `repLedger`'s), per-rep payable lines with `Initial`/`Draw n` labels and lender collection state, the clawback queue, what was paid in the run, and the CSV.
- Routes under `/api/admin/payroll` (admin only): overview, `POST runs`, `POST runs/:id/advance`, `GET runs/:id/reps/:repId`, `POST preview`, `POST runs/:id/pay`, `GET runs/:id/export.csv[?rep=]`.
- `repo.commitPayout` on both the Drizzle and in-memory repos; `insertRun` / `updateRun`.
- Audit rows: `payroll.run` (create / advance) and `payroll.pay` (rep, lines, gross, withheld, net).

**Portal (`artifacts/portal/src/pages/Payroll.tsx`)** — grid `296px minmax(0,1fr)`. Left: run list (period, status pill, summary) and the rep list sorted by owed. Right: rep + run header with Export CSV / Approve run → Mark as paid, four run totals, **Select deals to pay** (search across deal ID, business, merchant contact, email, phone; Select all shown; 1180px table in a scroller with Pay / Deal / Line / Business / Merchant contact / Lender / Funded / Role / Rate / Payout / Lender paid comm), the dark selection footer (selected, gross, clawbacks netted, net to pay, Pay selected & record), the amber uncollected warning listing deal IDs, the red clawback note stating what recovers now, and **Paid in this run** with recoveries as red negative rows and the `Gross − clawback recovered = cash paid` footer.

**Pin on commit.** The screen defaults to the rep owed most only while no rep is chosen; after a payment it sets `repId` from the server's response, so paying a rep who then drops to zero never re-targets the panel.

**Tests: 10 new in the API (51 there), 172 across the repo.** Browser flow on the demo build: rep nav has no payroll item; admin opens payroll, the most-owed rep is pre-selected, selects all shown, the footer shows gross / clawbacks netted / net, pays and records, the toast confirms, the rep stays pinned, the paid-in-run ledger shows the rows with the reconciliation footer, and View-as that rep shows the wallet updated from the same ledger.

## Decisions to glance at

1. **Run totals are ledger figures** — paid gross, clawback recovered, cash, and "still owed to reps" across everyone — rather than the prototype's "run gross payout / house net", which mixed deals funded in the period with payouts. Earned and paid are on different axes (invariant #7); a run is a payout event, so its cards show payouts.
2. **Approval does not gate payment.** You can pay lines in a `draft` run; `approved` releases statements (Phase 9 will queue QuickBooks on approval); `paid` locks the run. If you'd rather require approval before paying, that's one condition in `paySelected`.
3. **CSV export is one run, optionally one rep**, as a plain download from the real API. The hosted preview can't download, so it toasts instead.
4. **Payable lines include every outstanding line regardless of collection**; the amber warning and the per-line pill show which sit on uncollected commission. Open question #3 (payable on collection) is still yours — a filter is trivial once decided.
5. **Runs are created on demand** ("+ Open next run"), not on a schedule. A cron that opens the next period on the 1st and 16th is a Phase 8/9 nicety.

## Next: Phase 6

Renewals, merchants, analytics — read-only over the same domain layer.
