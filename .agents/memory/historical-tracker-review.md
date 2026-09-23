---
name: Historical tracker review
description: Why importing old tracker rows must be separated from posting lender receipts and rep payments.
---

Historical funding tracker review is a resumable fact-finding step, not a financial posting action. A “reviewed” answer must never itself create live deals, lender receipts, or paid payroll. A subsequent reconciliation/import must compare confirmed per-rep historical payments and live ledger state before posting anything.

**Why:** In the uploaded legacy tracker, “Paid In Full” frequently appears without a lender-paid date, while rep-paid dates and lender-paid dates describe different events. Deriving partial receipts as a fixed percentage or generating paid payroll from a date alone risks shifting commissions and overpaying reps. The user explicitly needs to verify terms and both payments over multiple sittings.

**How to apply:** Keep historical staging/review isolated from operational and accounting writes. Treat duplicate deal IDs, unsupported lender/product pairs, and payout discrepancies as blockers that require human correction. Never interpret a review checkbox as permission to post money.

Pre-fill review answers from explicit sheet evidence (such as a rep-paid date) and keep any corrected deal fields alongside the immutable original row, but require a fresh human confirmation before marking a row reviewed. Re-uploads of unchanged rows preserve corrections; changed source rows require re-review. The later live importer must consume the corrected terms and independently reconcile historical payments rather than treating suggestions or reviews as ledger events.

**Why:** Reviewing hundreds of rows from empty forms is impractical, but a sheet date or status alone still does not prove how much each person was paid. Prefill reduces repetitive typing without turning uncertain history into financial postings.

**How to apply:** Show which values came from the sheet, make them editable, keep review notes optional, and reset confirmation when monetary or identity fields change.