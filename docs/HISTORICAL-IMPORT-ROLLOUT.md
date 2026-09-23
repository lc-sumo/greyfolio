# Reviewed tracker import rollout

This import is separate from the old `/api/admin/import` endpoint. Staging and marking a row reviewed do **not** create a deal or record cash. A commit is an explicit admin action following a dry-run preview. Do not bulk-run the old importer over the reviewed sheet.

## Before enabling operators to commit

1. Publish the schema migration through the normal Replit Publish schema process. Do not run migrations at server startup or copy development rows into production. Verify the migration is applied before using the commit action.
2. Export and retain a production backup of the tracker and portal data under your normal retention policy. Check lender/product settings and the rep roster against the source records, including former reps.
3. Stage the tracker CSV, review each source row, and record *actual* lender receipts and *actual* per-rep payment amounts and dates from external evidence. Sheet statuses and rep-paid dates are hints only. A total paid to “reps” without payees is insufficient evidence.
4. For a small pilot, dry-run one unpaid deal, one partially received deal, one previously paid deal, and one existing deal. Inspect the proposed ID, terms, collection, each payroll ledger row, clawback, and any blockers. Never resolve a discrepancy by fabricating an amount or accepting an inferred percentage.
   Include a partially paid rep role: confirm the historical cash is recorded once and only the remaining role amount appears in the next payroll queue. Weekly receipts require verified week counts and amounts; clawbacks require their actual date.
5. Commit only rows whose preview has no blockers. A changed review, source row, deal, or ledger requires a new preview; do not retry an old token. Confirm the imported rows against the original lender remittances and payroll records, and inspect the accounting sync before proceeding in batches.

## Recovery and monitoring

- A rejected commit has no partial posting; investigate the blocker, correct the review/source or live record, and preview again.
- A committed row must not be committed again. If a historical fact was wrong, use the portal's audited correction/void and collection workflows rather than re-uploading the same row as a new deal.
- Check the admin audit log for import commits and compare portal deal IDs, lender receipts, per-rep payout keys and accounting journals against external statements. Pause further commits on any unexplained difference.
- A closed accounting period may require an accounting correction in an open period. Coordinate that through the existing books workflow; do not bypass period close or directly edit journal rows.