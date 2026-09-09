# Google Sheets sync

## Install

1. In the portal deployment, set `SHEETS_SYNC_SECRET` to a long random value.
   Do not put it in a spreadsheet cell, URL, or log.
2. Open the spreadsheet that should be the mirror, choose **Extensions >
   Apps Script**, replace the editor contents with `Code.gs`, and save.
3. Reload the spreadsheet and choose **Greystone Sync > Set up / update
   connection**. Enter the portal URL (the default is
   `https://folio.greystoneus.com`) and the same shared key. Apps Script
   stores both in Script Properties and prompts again only if they are
   removed.
4. Use **Sync both tabs** once to authorize UrlFetch and installable triggers.
   **Install hourly sync** creates a trigger for that spreadsheet only.

The first successful request binds the shared key to that spreadsheet's ID;
the same key from another spreadsheet is rejected. Mutation requests use
durable at-most-once claims. If a request times out after portal work begins,
reconcile its idempotency key in the portal instead of retrying with a new
key: processing and failed claims are deliberately not replayed.
Completed identical retries replay their stored response before checking the
deal's now-changed outstanding balance.

The portal is authoritative. Pull creates both tabs and writes the complete
48-column importer-compatible Master Deals header. Existing rows retain and
safely push only `Deal Status` and `Lender Paid Date`; money, reps, terms,
notes, clawbacks and all other columns are portal-owned. Blank-ID rows are
retained as `NEW ROW INPUT` and may contain all importer inputs needed to
create a deal. Before push, the script persists an uppercase `GS-<UUID>` Deal ID on every
nonblank new row. That stable ID makes a lost-response retry resolve to the
same portal deal. IDs are trimmed and normalized uppercase; duplicate
normalized IDs abort with both row numbers. Fully blank rows are untouched. Master Deals push uses the existing safe
`updateExisting` importer semantics and never directly writes tables.

Lender Remittance gets portal-owned `Receipt ID` and `Applied` columns if
needed. Each nonblank row receives a persistent Receipt ID and is sent alone
with `remittance-<Receipt ID>` as its operation key. Equal receipts remain
distinct when their Receipt IDs differ; editing a sent receipt conflicts
rather than applying twice. A receipt must apply completely—problem rows and
positive residual amounts are rejected. The script rereads and fingerprints
the live row before stamping Applied, so concurrent edits are not marked.
Single-segment scheduled/incremental receipts are supported and apply as an
exact locked delta. A lender payment spanning multiple deal segments must be
split into separate remittance rows so each row remains atomic.

The custom **Greystone Sync** menu can install a time-based trigger. Triggers
run only in the spreadsheet where this script is installed. Never share the
script project or its Script Properties.