# Phase 4 review notes — admin master board and deal entry

Phase 4 of [BUILD-ORDER.md](../design_handoff_greystone_commission_portal/BUILD-ORDER.md) is complete: the master grid, the product-driven new-deal drawer, and the admin deal detail drawer with splits, draw ledger and weekly schedule.

## The rule you added: only admins add deals

- Every deal write lives under `/api/admin/*` behind `requireRole('admin')` — create, splits, status, draws, collection. Team leads (`manager`) get 403 like reps do.
- There is no rep-facing write route. `POST /api/me/deals` is a 404, and the rep portal renders no "New deal" control. Tests: `admin-deals.test.ts › only admins add deals`.
- Reading the master board is admin-only as well, because those rows carry house net, referral fees and every rep's name.

## What was built

**Domain (`lib/commission/src/deal.ts`)**
- `priceDeal(draft, ctx)` — validates the guards (business + amount + lender, parent when the product demands one, no future date, known lender/partner), applies the product rule (factor vs APR, term, multi-draw initial/subsequent %), runs `commissionFor`, attaches the lender's weekly schedule. Accepts rates as fractions or percents.
- `nextDealId` — the sheet's F-series, one past the highest.
- `atRisk` — inside the clawback window or Slow Pay / Default.
- `crmUrl` — `{id}` `{opportunity}` `{business}` tokens, URL-encoded; blank template hides links.

**API (`artifacts/api-server`)**
- `services/deals.ts`: `createDeal`, `updateSplits`, `setDealStatus`, `addDraw`, `setCollection`. Collection has ONE writer: the status select, the lender-paid pill, "Record week received"/"Reverse last" and explicit dollars all route through `setCollection`, so status stays a function of collection.
- `admin-views.ts`: `adminDealRow` (20-column board row) and `adminDealDetail` (segments with collection + schedule, every rep's ledger rows, clawback slices).
- Routes: `GET /api/admin/settings`, `GET /api/admin/deals[?search&rep&status]`, `GET/POST /api/admin/deals[/:id]`, `PATCH …/splits`, `PATCH …/status`, `POST …/draws`, `POST …/collection`, `GET /api/admin/teams`.
- `repo.memory.ts` is now shared by tests and the browser demo; `repo.db.ts` gained the write methods.
- Every write is audit-logged (`deal.create`, `deal.update`, `deal.draw`, `deal.collection`).

**Portal (`artifacts/portal`)**
- `pages/MasterDeals.tsx` — search across merchant contact/email/phone, rep filter (all reps, inactive suffixed), status filter, **+ New deal**, Push to Sheets (Phase 8 stub). 20 columns in a 2360px grid inside an `overflow-x:auto` scroller, totals as the last grid row, at-risk rows tinted `#fdf9f8`. Lender-paid pill and both status selects write through the API.
- `components/NewDealDrawer.tsx` — product-driven: the rule decides factor vs APR, term, credit line + draw %s, parent selector. Lenders labelled `· weekly ×N`, partner prefills its %, existing-merchant notice on email match, computed Total / Payback / Est. renewal, opener/closer/override from **active reps only** with live payout, and the dark Live math card. `lib/math.ts` runs the same `commissionFor` the server runs, so the preview cannot disagree with the saved deal.
- `components/AdminDealDrawer.tsx` — Open in CRM, dark share card (total payout, gross, net, house net, outstanding), terms with commission/deal status selects, weekly schedule (pip strip, received / still-to-come / next due, Record week / Reverse last), draw ledger with per-segment collection toggle and Add draw at the subsequent rate, split editor over **all reps** (inactive suffixed), payment history with recoveries in red, clawback notice with each rep's remaining slice.
- The demo build (`build:demo`) now runs the real services over the in-memory repo, so the hosted preview supports creating deals, adding draws and recording weeks (state resets on reload).

**Tests: 12 new in the API (41 total there), 11 in the domain (95); 162 across the repo.** Playwright on the demo build: rep sees no New deal control; admin opens the board, a deal drawer, creates a ROWAN deal from the form (live math matched the saved deal), sees the 20-week schedule, records a week.

## Decisions to glance at

1. **Team leads cannot add deals.** You said "only admin"; managers are treated as reps for writes. Easy to widen to `requireRole('admin', 'manager')` if that changes.
2. **Master deals also lists `Slow Pay`** as a deal status even though the workbook's dropdown lacks it — the design uses it for at-risk tinting and the renewal "blocked" bucket. Remove from `setDealStatus` if you'd rather stay on the sheet's six.
3. **Partial receipts on upfront deals**: choosing "Partially Paid" in the select keeps an existing partial figure or defaults to half; the drawer's draw ledger and the API accept exact dollars (`{dollars}`) — the UI for typing an exact figure is a Phase 5/6 nicety pending open question #7.
4. **Draws on weekly lenders get their own schedule** (open question #2 answered provisionally with "yes"). One line in `addDraw` flips it.
5. **Rep option lists**: new deal → `assign` (active only); split editor and rep filter → `edit` (all, inactive suffixed); View-as → `view-as`. Invariant #9, three lists.
6. The **Push to Sheets** button only toasts until Phase 8.

## Next: Phase 5 — payroll

Runs, per-rep line selection with search, clawback netting, ledger writes with recovery rows, paid-in-run ledger, CSV export, pin the rep on commit. `planPayout` / `applyPayout` already exist and are tested; the work is the run model, endpoints and the screen.
