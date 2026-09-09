---
name: Consolidation commission schedule
description: Defines how consolidation funding increments control commission timing and stop-early recovery.
---

Consolidation is one funded deal with a commission-disbursement schedule, not a line of credit. Its funding increments are separate from the merchant’s longer loan repayment term.

For a split structure, the configured upfront share is paid at funding and acts as a credit against total commission earned on funding actually received. The remainder is payable only after every effective funding increment clears. For example, a 23-increment consolidation with 50% upfront pays half initially and the balance when the funding schedule completes.

If funding stops early, commission earned is the actual funding received multiplied by the contractual commission rate. The original planned funding remains visible separately. Any upfront payment above earned commission is recoverable; otherwise only the difference is due once the shortened schedule is finalized.

**Why:** Consolidation lenders disburse approved funding over increments, while the merchant may repay over a much longer term. Commission follows money delivered to the merchant, not repayment duration.

**How to apply:** Keep increment count, cadence, upfront share, and completion-payment controls on consolidation entry. Do not expose LOC credit-line, initial-draw-rate, or subsequent-draw-rate fields.