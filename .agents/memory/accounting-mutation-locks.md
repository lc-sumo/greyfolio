---
name: Accounting mutation locks
description: Transaction rule for preventing payroll and deal edits from producing stale or inconsistent ledger entries.
---

Any payout plan must be revalidated against current deal economics after acquiring the same parent-deal locks used by LOC, draw, and terms mutations, and before inserting any ledger row.

**Why:** Locking only at ledger insertion still permits an edit to commit between payout planning and payout commit, causing a stale amount to be recorded. Edit-side “no payouts yet” checks alone protect only the opposite race ordering.

**How to apply:** For any new monetary deal mutation or payout path, use a consistent sorted lock order, perform authoritative ledger/economics checks inside the transaction, and reject or re-plan when the locked snapshot differs.