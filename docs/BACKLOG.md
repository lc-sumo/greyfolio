# Backlog — asks from review, mapped to the build order

| Ask | Where it lands | Status |
|---|---|---|
| Reps cannot add their own deals; only admin | Phase 4 — every deal write is `requireRole('admin')`; no rep write route exists | Done |
| Adding a draw takes optional term + factor rate and computes payback and the merchant's payment | Phase 4 follow-up — `newDraw` terms, `paymentFor`, draw ledger sublines, add-draw form | Done |
| Say "override" everywhere, never "rip" | Codebase already uses Override / `overrideRate` throughout (teams included); only the handoff prototype file uses "rip" and it is the untouched reference | Done |
| Set the team leader from the Settings tab alongside reps | Phase 7 — Settings › Teams (name, leader, override %) and Settings › Reps (team assignment) | Planned |
| Renewals available to every rep for THEIR renewals, to know when to follow up | Phase 6 — `My renewals` in the rep portal (`/api/me/renewals`, server-scoped to deals they open/close/override, with merchant contact for follow-up and their own est. share; other reps appear only as "Closer"/"Opener", never by name) plus the admin Renewals board | Done |
| Statements should just be pay history: every payout, when, how much, which deal | Phase 6 — `Pay history` replaces Statements (`/api/me/payments`): every ledger row grouped by payout date with the run, deal, line and amount; recoveries as red lines; day and lifetime totals | Done |
| Renewal mark stays at 40% (workbook), and a **Prospecting** trigger fires 30 days post funding (workbook `ADDITIONAL CAPITAL AFTER`): the merchant is eligible for more capital | Phase 6 — `renewalOf` computes `prospectingDate`; Deal Status is derived like the sheet (Performing → Prospecting at 30d → Refi Ready at the mark) unless set by hand to Refinanced / Default / Slow Pay / Paid In Full; renewals get a Prospecting tab and a "More capital" column; both thresholds editable in Phase 7 Settings | Done |
| CRM integration that fires triggers (e.g. renewal-ready → CRM task) | After Phase 9 — needs the real CRM (open question #6: URL pattern, API) before anything beyond the deep link | Later |

Payment math for a draw: `payback = amount × factor`; payments in the term at the deal's frequency are Daily = term, Weekly = term/5, Bi-Weekly = term/10, Monthly = term/21 (business days); `payment = payback / payments`.
