---
name: Reviewed historical import atomicity
description: Why historical import must validate its preview inside the same locked transaction that posts operational and payroll facts.
---

An admin preview is only an inspection aid; the commit must reload and validate the source review, live deal, receipts, settings and rep ledger inside a single transaction before posting. Use canonical payroll keys for historical payouts, not separate “historical” keys that payroll would ignore.

**Why:** Sequential deal, clawback, ledger and review-status writes can fail mid-import and leave an apparently unimported row with money already posted. A preview token checked before the transaction cannot stop a concurrent edit or payroll payment. A custom payout key can make the payroll queue offer the same rep share again.

**How to apply:** Keep reviewed import isolated from the legacy CSV import. Lock the staged review and the same deal/rep resources as payroll, validate the current snapshot inside the transaction, and mark the review imported atomically with the posted facts. A source change after import is a correction workflow, not permission to import the ID again.

Historical partial role payments must remain visible as paid cash while the unspent remainder stays payable on the normal payroll line. Never use a partial receipt to mark a whole role/unit paid, and never let a full role/unit be offered again without subtracting the historical cash.

**Why:** The alternative choices either double-pay a rep or hide money they are still owed. The ledger and the payroll queue must agree about the same balance.

**How to apply:** When changing payroll key handling, voids, or earned-line calculations, check all three cases together: historical partial payment, payment of its remainder, and voiding either portion.

The authoritative import preview must see payroll committed while it waited for shared rep locks. Use statement-refreshing isolation when acquiring those locks after reading the staged review, or acquire locks before opening a transaction-wide snapshot. Do not assume serializable isolation itself makes a stale preview safe.

**Why:** A transaction-wide snapshot taken before waiting for payroll can miss a canonical payment that finishes during the wait. Historical partial-payment keys are distinct from full payroll keys, so key uniqueness alone cannot prevent an overpayment.

**How to apply:** Any change to import lock order or isolation must be checked against a concurrent payroll payment on the same rep; re-read live ledger facts after acquiring the shared lock, before planning or posting.

Reviewed historical economics are an as-of-funding record; current referral settings are not evidence of the rate or cap used when the deal funded.

**Why:** Repricing an old referral using today's partner configuration can silently change the historical house net even when the reviewed gross and rep split match.

**How to apply:** Require explicit confirmation of historical referral dollars when a partner is involved, reconcile the priced fee and net against that confirmation, and block rather than substitute current settings when a field is missing.