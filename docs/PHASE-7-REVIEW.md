# Phase 7 review notes — settings

Phase 7 of [BUILD-ORDER.md](../design_handoff_greystone_commission_portal/BUILD-ORDER.md) is complete: six settings tabs with the in-use guards, all admin-only.

## What was built

**API — `services/settings.ts`, routes under `/api/admin`**
- `GET settings/usage` — how many deals reference each lender / partner / product, and reps per team. Drives the usage column and the disabled Remove buttons.
- `PUT settings/lenders | partners | products` — whole-list saves. Names must be unique (exact match — the workbook carries both `NONE` and `None`). **Removing anything deals still reference is refused with the count** ("Lenders in use cannot be removed: MBC (3 deals)"). Weekly lenders need a week count; a `draw` basis forces `parent`; draw %s are kept only for multi-draw products. Rates accept `12` or `0.12`.
- `PUT settings/thresholds` (clawback window, payment overdue, renewal mark, additional-capital days — all validated), `PUT settings/crm` (must be http(s) or blank), `PUT settings/payroll` (cycle).
- Teams: `POST teams`, `PATCH teams/:id`, `DELETE teams/:id`. **Setting a leader moves them onto the team and grants Team lead access** (unless already Master). **Deletion is refused while reps are assigned.**
- Reps: `POST reps` (email required and unique — it is how they sign in), `PATCH reps/:id` (name, email, team, opener/closer/override %, access, active). Guards: the last active admin cannot be demoted or deactivated; you cannot demote or deactivate yourself.
- Every write is audit-logged (`settings.update`, `team.update`, `rep.update`).

**Portal — `pages/Settings.tsx`**, pill tabs with a one-line hint each:
1. **Lenders** — name, terms (Upfront / Weekly), weeks, usage; add / remove; Save.
2. **Referral partners** — name, fee %, monthly cap (blank = uncapped), usage.
3. **Product rules** — product, commission basis, default %, initial / subsequent draw % (disabled unless multi-draw), toggles for Factor / Term / Parent / Clawback / Renewable, usage; per-product multi-draw switch.
4. **Teams** — summary cards (reps, lead, override %, earned, owed) and an editable table: name, **team leader select**, override %, rep count, Save / Delete (disabled while staffed). Add team with a leader.
5. **Reps** — 1340px table: name, email, team, opener / closer / override %, earned, owed, access (Rep / Team lead / Master), active toggle, Save, **View as**. Add rep.
6. **CRM & thresholds** — URL template with live preview, clawback window, payment overdue, renewal mark, additional capital after, payout cycle.

**Tests: 67 in the API (12 new), 202 across the repo.** Browser run on the demo: added a lender, in-use Remove disabled, changed a team leader (saved and re-rendered), staffed-team Delete disabled, edited the CRM template with live preview, saved a 50% renewal mark and watched the renewals header update.

## Decisions to glance at

1. **Leader ⇒ team member + Team lead access.** Picking a leader who is on another team moves them. The select labels such reps with their current team so this is visible before saving.
2. **Deactivating a rep** keeps them on every existing deal, drops them from new-deal assignment, and keeps them reachable through View as (invariant #9). The Reps tab toggle saves immediately; other edits save per row.
3. **Whole-list saves** for lenders / partners / products (one PUT with the full list) rather than per-row endpoints; guards run on what was removed.
4. **Renewal mark and Prospecting days are editable here**, so the 40% vs 50% question is a setting, not a code change.
5. Unchanged: settings are stored as JSON rows in `commission_settings`, as the README allowed.

## Next: Phase 8 — Google Sheets

Portal → Sheet push (one-way) first, then inbound change staging with accept / discard. Needs the spreadsheet ID and a service account.
