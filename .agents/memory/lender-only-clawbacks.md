---
name: Lender-only clawbacks
description: Business policy for clawback basis, post-payout defaults, and forgiveness.
---

Clawbacks apply only to commission paid by the lender. Merchant-paid PSF remains part of ordinary commission and payout economics but is never part of clawback liability.

**Why:** Greystone charges PSF directly to the merchant, so a lender default cannot reverse money the lender never paid. A default discovered after rep payout must reduce the rep's balance without rewriting the original payout.

**How to apply:** Use the canonical lender-paid basis for caps, rep attribution, payroll recovery, and accounting. Record post-payout defaults as separate liabilities; keep original payout rows immutable. Forgiveness is an audited tombstone excluded from active balances and projection while retaining recovery/void history.