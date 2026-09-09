---
name: Dedicated Sheets sync
description: Security and reliability policy for spreadsheet-driven deal and remittance synchronization.
---

Bind the shared sync credential to the first dedicated spreadsheet that uses it. Treat the portal database as authoritative: existing sheet rows may update only explicitly safe operational fields, while committed payroll, accounting, and clawback history remain portal-controlled.

**Why:** Broad Google account access is intentionally avoided, and spreadsheet retries must never duplicate lender receipts or recreate deals after a lost response.

**How to apply:** Give new deal and remittance rows stable client-side IDs before sending them. Claim monetary operations durably before mutation; completed claims replay, while processing or failed claims stop for reconciliation rather than automatically rerunning.