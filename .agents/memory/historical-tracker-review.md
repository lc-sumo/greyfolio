---
name: Historical tracker review
description: Why importing old tracker rows must be separated from posting lender receipts and rep payments.
---

Historical funding tracker review is a resumable fact-finding step, not a financial posting action. A “reviewed” answer must never itself create live deals, lender receipts, or paid payroll. A subsequent reconciliation/import must compare confirmed per-rep historical payments and live ledger state before posting anything.

**Why:** In the uploaded legacy tracker, “Paid In Full” frequently appears without a lender-paid date, while rep-paid dates and lender-paid dates describe different events. Deriving partial receipts as a fixed percentage or generating paid payroll from a date alone risks shifting commissions and overpaying reps. The user explicitly needs to verify terms and both payments over multiple sittings.

**How to apply:** Keep historical staging/review isolated from operational and accounting writes. Treat duplicate deal IDs, unsupported lender/product pairs, and payout discrepancies as blockers that require human correction. Never interpret a review checkbox as permission to post money.