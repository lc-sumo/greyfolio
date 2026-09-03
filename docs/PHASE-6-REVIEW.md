# Phase 6 review notes — renewals, merchants, analytics

Phase 6 of [BUILD-ORDER.md](../design_handoff_greystone_commission_portal/BUILD-ORDER.md) is complete, plus the review asks that landed in it (see [BACKLOG.md](BACKLOG.md)).

## What was built

**Domain (`lib/commission/src/renewals.ts`)**
- Business-day calendar matching the sheet: `addBusinessDays` (WORKDAY), `businessDaysBetween`, `addMonths` (EDATE for Monthly deals).
- `renewalOf(deal, thresholds, today)` → paid-in %, mark date (renewal mark, default 40%), maturity, days to mark, the **Prospecting** trigger (`additionalCapitalAfterDays`, default 30 calendar days post funding), bucket (`due · prospecting · building · risk · refinanced`), `soon` flag (inside 21 days of the mark), and `effectiveStatus`.
- `effectiveDealStatus` — the sheet's Deal Status formula: manual statuses (Refinanced, Default, Slow Pay, Paid In Full) stick; otherwise Performing → Prospecting → Refi Ready from the dates.

**API**
- Rep: `GET /api/me/renewals` (server-scoped; merchant contact included because the rep follows up; other reps appear as Closer/Opener, never by name; est. commission is the rep's share), `GET /api/me/payments` (pay history: every ledger row grouped by payout date with run label and day/lifetime totals).
- Admin: `GET /api/admin/renewals`, `GET /api/admin/merchants` (grouped on merchant email; deals with no email group under the business name), `GET /api/admin/overview?from&to`.
- Deal status writes accept only manual statuses or `Performing` (= back to auto). `PATCH /api/admin/deals/:id/crm` sets the CRM deal ID.

**Portal**
- **Renewals** (rep and admin, one component) laid out like the CRM: Deal ID (CRM) · Sheet # · Funded date · Parent deal · Business + contact · Lender · Funded ×factor · Term · More capital · Renewal · Due pill · Paid off · Commission · Who calls it / My role · Status. Tabs: All, Renewable now, Prospecting, Upcoming, Blocked, Refinanced.
- **Pay history** replaces Statements.
- **Merchants**: one expandable row per merchant email with deal count, funded, gross, outstanding, since; expanding shows the full deal history; every deal opens the admin drawer.
- **Funding overview** is now the admin landing page: eight cards (amount funded, commissions, opportunities + draw lines, avg deal size, avg factor, paid vs owed, clawback exposure, renewal pipeline), funded-volume + commission bars by month, lender performance (deals / funded / avg factor / **collected %**), renewal pipeline list, clawback exposure bars (reps' share, recovered portion filled). Period selector applies. Rep roster moved to its own nav item.
- The Deal ID shown everywhere is the CRM's; the F-number is a muted "Sheet #".

**Tests: 199 across the repo.** Browser checks on the demo build for both scopes.

## Decisions to glance at

1. **Lender "close rate"** from the README needs pipeline data the portal doesn't have; the table shows **collected %** (commission collected ÷ gross) instead, which is the lender metric ops actually chase.
2. **Paid vs owed** pairs paid-in-period (payout date) with owed lifetime (a balance). Same time-axis rule as the rep dashboard.
3. **Clawback exposure** = reps' share of open clawbacks not yet recovered (what still nets against payouts), not the deal-level amount.
4. **Merchants with no email** group under their business name rather than merging into one blank bucket.
5. Renewal mark 40% and Prospecting at 30 days come from settings; Phase 7 makes both editable.

## Next: Phase 7 — Settings

Six tabs: Lenders, Referral partners, Product rules, Teams (name, leader, override %), Reps (team, rates, access, active, View as), CRM & thresholds. In-use guards on deletion.
