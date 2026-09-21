---
name: Consolidation commission schedule
description: Defines how consolidation funding increments control commission timing and stop-early recovery.
---

Consolidation (also called Reverse) is one funded parent deal with a commission-disbursement schedule, not a line of credit. Its funding increments are separate from the merchant’s longer loan repayment term.

Every newly entered or edited Consolidation/Reverse parent must carry its own explicit positive increment amounts totaling planned funding. A lender name never determines the deal’s increment count or amounts. Legacy disbursement child rows remain individual increments and do not receive nested schedules.

For a split structure, the configured upfront share is paid at funding and acts as a credit against total commission earned on funding actually received. The second half may release either after every effective funding increment clears or once the first half of planned funding is complete; that trigger must be explicit and is not yet implemented. For example, a 23-increment consolidation with 50% upfront may pay half initially and the balance when the configured release condition is met.

If funding stops early, commission earned is the actual funding received multiplied by the contractual commission rate. The original planned funding remains visible separately. Any upfront payment above earned commission is recoverable; otherwise only the difference is due once the shortened schedule is finalized.

**Why:** Consolidation lenders disburse approved funding over increments, while the merchant may repay over a much longer term. Commission follows money delivered to the merchant, not repayment duration.

**How to apply:** Require the deal-specific breakdown on parent entry, derive increment count from it, and retain cadence, upfront share, and completion-payment controls. Do not expose LOC draw fields or infer amounts from lender defaults.