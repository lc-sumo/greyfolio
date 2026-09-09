---
name: Consolidation commission schedule
description: Defines how consolidation funding increments control commission timing and stop-early recovery.
---

Consolidation is one funded deal with a commission-disbursement schedule, not a line of credit. Its funding increments are separate from the merchant’s longer loan repayment term.

For a split structure, the configured upfront share is paid at funding and the remainder is payable only after the merchant receives every planned funding increment. For example, a 23-increment consolidation with 50% upfront pays half initially and half when increment 23 is received.

If funding stops early, commission earned scales to the amount actually disbursed. Any initial payment above that earned amount is recoverable; if funding continues, additional commission is not due until the full increment schedule completes when the remainder is configured for payment at completion.

**Why:** Consolidation lenders disburse approved funding over increments, while the merchant may repay over a much longer term. Commission follows money delivered to the merchant, not repayment duration.

**How to apply:** Keep increment count, cadence, upfront share, and completion-payment controls on consolidation entry. Do not expose LOC credit-line, initial-draw-rate, or subsequent-draw-rate fields.