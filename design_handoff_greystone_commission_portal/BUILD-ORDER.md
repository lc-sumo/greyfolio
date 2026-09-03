# Build Order — Greystone Commission Portal

Read `README.md` first, especially **Accounting Invariants**. This file is the sequence.

Prompt to open with in Claude Code:

> Read `design_handoff_greystone_commission_portal/README.md` in full, then open `Greystone Commission Portal.dc.html` in a browser to see the intended UI. We are implementing this in the existing Greystone codebase (Postgres + Drizzle, Express + OIDC, React/Vite + shadcn/ui). Extend the existing `commission_*` schema rather than replacing it. Start with Phase 1 below and stop for review before Phase 2.

---

## Phase 1 — Data model and money math (no UI)

1. Migrate the schema additions in README → "Schema Changes Required".
2. Implement the domain layer with **one function per concept**, and unit-test each:
   - `segments(deal)` — initial + draws
   - `commissionFor(segment)` — the calculation chain
   - `collectedOf(segment)` / `outstandingOf(segment)` / `statusFor(collected, gross)`
   - `repClawback(clawback, repId)` → `{share, recovered, remaining}`
   - `repLedger(repId)` → `{earned, paid, cash, held, recovered, owed}`
3. Write tests for the invariants directly. Each of these failed at least once in the prototype:
   - paid never derived from deal status
   - a recovered clawback writes a negative ledger row and is collected exactly once
   - `owed = earned − paid(gross) − held`
   - a partially collected upfront deal reports partial, not full, collection
   - status is a pure function of collection
   - a paid figure never renders negative
   - no funded date in the future is accepted
4. Seed from the workbook: `REPS`, `SETTINGS`, `PARTNERS`, and the `FUNDED DEALS` header for column mapping.

**Do not start UI until `repLedger` is tested.** Every duplicated money calculation in the prototype produced two screens disagreeing about a rep's balance.

## Phase 2 — Auth and rep scoping

1. Wire OIDC (already present in `artifacts/api-server/src/routes/auth.ts`).
2. Roles: `rep`, `manager`, `admin`.
3. **Scope rep queries server-side.** House net, referral fees, override amounts and other reps' names must never reach a rep's client. Do not filter in React.
4. Implement admin **View as** as a server-side impersonation scope, audit-logged.

## Phase 3 — Rep portal

Wallet → My deals → Clawbacks → Statements. Smallest surface, exercises the whole ledger, and it's what reps will judge the product by.

## Phase 4 — Admin master board and deal entry

Master grid, then the product-driven new-deal drawer, then the deal detail drawer (splits, draw ledger, weekly schedule). Note the deal form is driven by product rules from settings — build the rules table before the form.

## Phase 5 — Payroll

Per-rep line selection, clawback netting, ledger writes, the paid-in-run ledger with recovery rows, CSV export. Pin the selected rep on commit.

## Phase 6 — Renewals, merchants, analytics

Read-only over the same domain layer; fast once Phase 1 is solid.

## Phase 7 — Settings

Six tabs. Enforce the in-use guards (lenders/partners/products refuse deletion with a count; teams refuse while staffed).

## Phase 8 — Google Sheets

Portal → Sheet push first (one-way is genuinely useful on its own). Then inbound change *staging* with accept/discard. Never auto-apply inbound edits.

## Phase 9 — QuickBooks

Confirm scope with the user first (README → Open Questions #1). Post only on run approval; carry the deal ID in every memo.

---

## Things that will bite you

- A controlled `<select>` whose value is absent from its options silently renders as "— none —". Three different rep option lists are required — see invariant #9.
- Bare `1fr` grid columns containing wide tables overflow the document instead of scrolling. Use `minmax(0,1fr)`.
- Earned and paid are on different time axes (funded month vs. payout date). Don't chart them as one.
- `Override` is the workbook's term for the team-leader cut. Use it consistently — the prototype briefly called it "team lead rip" and the two names coexisted on different screens.
- Deal IDs are the `F1`, `F2`… series the sheet generates. An LOC's ten pulls share one ID.
