# Phase 3 review notes — rep portal (+ demo board)

Phase 3 of [BUILD-ORDER.md](../design_handoff_greystone_commission_portal/BUILD-ORDER.md) is complete: wallet → my deals → clawbacks → statements, plus the admin View-as entry point. Also added the demo seed requested for testing.

## Demo board — `pnpm db:seed:demo`

`lib/db/src/seed/demo.ts` builds a deterministic board (seeded RNG) from the workbook reps/lenders/products/partners: ~58 deals over the last 200 days, LOC/consolidation opportunities with draws, weekly-lender schedules, twice-monthly payroll runs, and clawbacks. **Every dollar in the ledger is produced by the domain layer** (`commissionFor`, `newDraw`, `planPayout`), so the demo satisfies the same invariants production data must. Eight tests assert it: no future dates, every clawback roll-up equals its recovery rows, every rep's `owed = earned − paid − held ≥ 0`, `repPaid` only on fully paid deals, unique ledger keys.

It also creates four placeholder teams, makes their leaders `manager`, and deactivates one rep (Levi Forgash) so invariant #9 is visible. **It wipes deal, draw, ledger, clawback, run and team data** before loading; reps and settings are re-seeded, never deleted.

## What was built — `artifacts/portal`

React 19 + Vite 8 + TanStack Query + React Router. Plain CSS with the README's design tokens as custom properties (`src/styles.css`); DM Sans / Space Mono from Google Fonts; brand PNGs from the handoff.

| Screen | File | Reads |
|---|---|---|
| Login | `pages/Login.tsx` | `/auth/methods` → SSO button (OIDC) and/or dev email sign-in |
| My dashboard | `pages/Dashboard.tsx` | `/api/me/dashboard?from&to` — wallet, five period cards, paired monthly bars (two axes, labelled), anonymized leaderboard, "Owed to me" |
| My deals | `pages/Deals.tsx` | `/api/me/deals` — search, payout-status filter, 1220px table in an `overflow-x:auto` scroller with the totals row as the last grid row |
| Deal drawer | `components/DealDrawer.tsx` | `/api/me/deals/:id` — share card, terms, one line per role per segment, payment history (recoveries in red), clawback notice |
| Clawbacks | `pages/Clawbacks.tsx` | `/api/me/clawbacks` — three cards, policy note, table showing *remaining* on open rows and *withheld* on recovered rows |
| Statements | `pages/Statements.tsx` | `/api/me/statements` — one card per run with lines; `Gross − clawbacks = net paid` |
| Rep roster (admin landing) | `pages/Roster.tsx` | `/api/admin/reps` — every rep's earned/paid/held/owed from `repLedger`, with a **View as** button |

**View-as** is a sidebar select (admins: all reps incl. inactive; team leads: their team). Selecting a rep sets the `X-View-As` header on every request, invalidates all queries, and shows an amber banner. The portal never filters money client-side — it renders what `/api/me/*` returns.

The API now also serves the built portal when `PORTAL_DIST` is set (SPA fallback for non-`/api`, non-`/auth` paths), and exposes `GET /auth/methods` and `GET /api/me/dashboard`.

**Verified** with Playwright against the demo board: login, dashboard (YTD and 30d), deals, drawer, clawbacks, statements as a rep; roster, View-as an active rep and an inactive rep as admin. No console errors. Screenshots are in the session, not the repo.

## Decisions that need a reviewer's eye

1. **No shadcn/ui.** The README asks for the codebase's existing component library, which is not in this repo. Rather than bolt on Tailwind + shadcn for six screens, the portal uses small local primitives (`components/ui.tsx`) and token-driven CSS that matches the spec's pixel values directly. If the original front-end shell turns up, its primitives can replace `ui.tsx` without touching pages.

2. **Admin screens are stubs.** Master deals, payroll, renewals and settings show a "built in Phase N" note. The admin landing is the roster, which is useful now (it reads the same ledger reps see) and is the natural home for View-as.

3. **Period cards**: "Earned this period" buckets by funded date, "Paid this period" by payout date, and "Balance owed" is lifetime (owed is a balance, not a flow). The rank is by commission earned *in the period*, among active reps plus the viewer.

4. **"Awaiting lender"** on the wallet is the rep's share sitting on segments the lender has not fully paid — the amount the rep can see is earned but not yet backed by collected commission.

5. **Statements show `Method: ACH`** as a static label; the payment method is not modelled yet.

6. **Login SSO button** posts to `/auth/login?returnTo=<path>`; the dev email form only renders when the API reports `devAuth: true`.

## Next: Phase 4

Admin master board (20-column grid, 2360px scroller, at-risk tinting) and the product-driven new-deal drawer, then deal detail with split editor, draw ledger and weekly schedule. Needs deal write endpoints on the API (create, patch splits, add draw, set collection) — all of which already exist as pure functions in `@greystone/commission`.
