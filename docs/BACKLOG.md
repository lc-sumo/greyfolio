# Backlog — asks from review, mapped to the build order

| Ask | Where it lands | Status |
|---|---|---|
| Reps cannot add their own deals; only admin | Phase 4 — every deal write is `requireRole('admin')`; no rep write route exists | Done |
| Adding a draw takes optional term + factor rate and computes payback and the merchant's payment | Phase 4 follow-up — `newDraw` terms, `paymentFor`, draw ledger sublines, add-draw form | Done |
| Say "override" everywhere, never "rip" | Codebase already uses Override / `overrideRate` throughout (teams included); only the handoff prototype file uses "rip" and it is the untouched reference | Done |
| Set the team leader from the Settings tab alongside reps | Phase 7 — Settings › Teams (name, leader, override %) and Settings › Reps (team assignment) | Planned |
| Renewals available to every rep for THEIR renewals | Phase 6 — admin Renewals screen plus a rep-scoped `/api/me/renewals` and "My renewals" nav item; reps see only deals they open/close/override, with the same 40% mark buckets | Planned |
| CRM integration that fires triggers (e.g. renewal-ready → CRM task) | After Phase 9 — needs the real CRM (open question #6: URL pattern, API) before anything beyond the deep link | Later |

Payment math for a draw: `payback = amount × factor`; payments in the term at the deal's frequency are Daily = term, Weekly = term/5, Bi-Weekly = term/10, Monthly = term/21 (business days); `payment = payback / payments`.
