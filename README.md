# Greystone Commission Portal

Commission tracking portal for Greystone Merchant Partners: reps see their own deals, splits, payouts, and clawbacks as a running wallet; finance ops run the master deal board, payroll, renewals, merchants, settings, and the Google Sheets / QuickBooks integrations.

The design handoff (spec, prototype, workbook, brand assets) lives in [`design_handoff_greystone_commission_portal/`](design_handoff_greystone_commission_portal/README.md). Read its **Domain Model & Business Rules** and **Accounting Invariants** sections before touching money code.

## Layout

```
lib/commission/   @greystone/commission — pure domain layer (no I/O). Segments, the
                  commission chain, collection, clawbacks, the rep ledger, payroll planning.
lib/db/           @greystone/db — Postgres schema (Drizzle), migrations, row→domain mappers,
                  and the workbook seed (REPS / SETTINGS / PARTNERS / FUNDED DEALS column map).
artifacts/api-server/   @greystone/api-server — Express API: OIDC sign-in, roles, server-side rep
                        scoping, audit-logged admin View-as.
artifacts/portal/       @greystone/portal — React/Vite portal (every screen through Phase 7; Sheets and QuickBooks arrive in Phases 8–9).
docs/             Phase notes and review checklists.
```

## Build status

| Phase | Scope | Status |
|---|---|---|
| 1 | Data model and money math, no UI | Done ([notes](docs/PHASE-1-REVIEW.md)) |
| 2 | Auth (OIDC) and server-side rep scoping | Done ([notes](docs/PHASE-2-REVIEW.md)) |
| 3 | Rep portal | Done ([notes](docs/PHASE-3-REVIEW.md)) |
| 4 | Admin master board and deal entry | Done ([notes](docs/PHASE-4-REVIEW.md)) |
| 5 | Payroll | Done ([notes](docs/PHASE-5-REVIEW.md)) |
| 6 | Renewals, merchants, analytics | Done ([notes](docs/PHASE-6-REVIEW.md)) |
| 7 | Settings | **Done — awaiting review** ([notes](docs/PHASE-7-REVIEW.md)) |
| 8 | Google Sheets | Not started |
| 9 | QuickBooks | Not started |

Review asks and where they land: [docs/BACKLOG.md](docs/BACKLOG.md).

## Getting started

### Zero-setup preview

`pnpm --filter @greystone/portal build:demo` produces `artifacts/portal/dist-demo/portal-demo.html`: the whole rep portal plus admin roster as one file, running the same domain layer and rep projections in the browser over the demo board. Open it in any browser, or host it anywhere static. Nothing in it is real data.

### Preview in GitHub Codespaces (nothing to install)

On the repo page, switch the branch to `claude/new-session-kdfrhy`, then **Code → Codespaces → Create codespace on claude/new-session-kdfrhy**. The dev container installs dependencies, migrates and seeds the demo board, builds the portal, starts the API, and opens port 8080 in your browser. Sign in with `leor@greystoneus.com`. If the tab opens before the API is up, wait a few seconds and reload; `tail -f /tmp/api.log` in the Codespace terminal shows progress.

### One command with Docker (nothing else to install)

```bash
git clone https://github.com/lc-sumo/greyfolio -b claude/new-session-kdfrhy && cd greyfolio
docker compose up --build
```

Open http://localhost:8080 and sign in with `leor@greystoneus.com` (admin), `noah.levine@greystoneus.com` (rep) or `raymond.amato@greystoneus.com` (team lead). The container applies migrations and loads the demo board on every start (`SEED=demo`); set `SEED=none` in `docker-compose.yml` to keep your data between restarts. `docker compose down -v` wipes the database.

### Manual setup

```bash
pnpm install
pnpm test          # domain + seed tests
pnpm typecheck

# Database
cp lib/db/.env.example lib/db/.env   # set DATABASE_URL
pnpm db:migrate                       # applies lib/db/migrations
pnpm db:seed                          # reps + settings from the workbook
pnpm db:seed:demo                     # + a realistic demo board (wipes deal data)

# Run it (two terminals, or see "One process" below)
AUTH_MODE=dev SESSION_SECRET=local DATABASE_URL=… pnpm api:dev      # http://localhost:8080
pnpm portal:dev                                                   # http://localhost:5173 (proxies /api and /auth)

# One process: build the portal and let the API serve it
pnpm portal:build
AUTH_MODE=dev SESSION_SECRET=local DATABASE_URL=… PORTAL_DIST=artifacts/portal/dist pnpm api:dev
```

Sign in with any rep's email from the roster (e.g. `leor@greystoneus.com` for admin, `noah.levine@greystoneus.com` for a rep, `raymond.amato@greystoneus.com` for a team lead). In production set `OIDC_ISSUER` and leave `AUTH_MODE` unset.

**Email + password accounts** work everywhere (set `AUTH_PASSWORD=off` to disable). An admin sets or resets a rep's password in Settings › Reps (a readable temporary one is suggested); the rep signs in with email + password and can change it from the sidebar. Passwords are scrypt-hashed in `commission_reps.password_hash` (migration `0003_rep_passwords`) and never leave the API; five failed attempts lock an email for 15 minutes.

## Launch checklist

Everything after step 1 is done from inside the portal by an admin. The host only holds secrets.

1. **Host it.** `docs/DEPLOY.md` covers Replit, Render via `render.yaml`, or any Docker host via `docker-compose.prod.yml` (Postgres + app + a nightly `pg_dump` sidecar, `scripts/backup.sh`). Environment: `DATABASE_URL`, `SESSION_SECRET` (32+ random chars), `BASE_URL`/`APP_ORIGIN` (the public https address), and `SEED=workbook` on the first boot (safe to leave on: the seed never overwrites a row that exists). Email: `MAIL_PROVIDER=sendgrid` (or `resend` / `postmark`) + `MAIL_API_KEY` (SendGrid's own `SENDGRID_API_KEY` works too) + a verified `MAIL_FROM`. Optional `OIDC_*` for SSO. Point a free uptime monitor at `/health`; it answers 503 when the database is unreachable. Schema changes apply on boot through `db:up`, which records a push-built database into the migration ledger and then only ever runs reviewed migration files.
2. **First sign-in.** Every boot guarantees `lc@greystoneus.com` (or `SUPER_ADMIN_EMAIL`) exists as an active **super admin**. While nobody has a password and there is no SSO, the sign-in screen shows *Set up the first admin*: enter that email and choose a password. The screen closes itself once any password exists. Only a super admin can create admins, change an admin's access, password or two-factor, hand the super-admin flag to someone else, or change security settings; ordinary Masters run everything else.
3. **Settings › Portal.** Permissions (whether reps may email merchants from a deal; individual reps can also be blocked under Reps), company and portal names (the header, emails and the authenticator label), support email, which emails go out (statements, clawback notices, rep questions, the renewal digest and its hour, the playbook hour), security (idle sign-out, default 2 hours; remembered devices after a two-factor code, default 7 days; *require two-factor for every admin*, turn on your own first), and the dropdown lists (payment frequencies, deal statuses). The audit log shows every action with the IP address and its city.
4. **Bring the tracker in.** Google Sheets → File → Download → Microsoft Excel (or a CSV of the FUNDED DEALS tab), then Settings › Import from sheet. The preview lists every lender, partner or rep the sheet names that the portal does not know yet, with one-click adds; fix the red rows, import. Re-exporting the whole sheet later is fine: tick *skip rows already in the portal* and only new rows come in; tick *refresh status & lender-paid* as well to take the sheet's Deal Status and Lender Paid Date onto rows the portal already has (money and the ledger are never touched). Rows with a Rep Paid Date become paid ledger lines in a run called "Imported from sheet".
5. **Reps.** Settings › Reps: add or deactivate people, set rates, access level and team, send an invite (a 72-hour set-password link) or set a password by hand, reset two-factor if a phone is lost, and keep W-9s on file. Reps change their own password and turn on two-factor from the sidebar; a password change signs every other device out. Reps download their pay history and year-end totals from Pay history.
6. **Lenders, partners, products.** Settings › Lenders (which products each lender funds, increments, clawback policy, the LOC line fee for Revenued), › Partners and › Products: add, rename (deals follow the rename), deactivate. Thresholds and the CRM link template live beside them.
7. **Week to week.** Paste the lender's payment report into Settings › Lender remittance to mark increments and dollars received in one go. From the deal drawer: record, edit or forgive clawbacks; add, edit or remove LOC draws; record or reverse consolidation increments, upfronts and finals; fix merchant contact details on any deal; notes and files. Empty draft payroll runs can be closed out, an approved run reopened, and a run opened for any dates. Year-end totals per rep are on Run payroll (CSV for the accountant).
8. **Playbooks.** Settings › Playbooks: if/then rules on the renewal engine (paid-in %, days since funding, days to maturity, stage, unused LOC line, status, lender overdue, clawback window closing, no note) with filters and actions (email the rep, email admins, open a task, set a status). Dry-run a rule to see the deals it would touch today; three starter rules ship on; a daily run rolls each rep's emails into one message. Tasks land on the rep's dashboard with outcomes that feed renewal rates; reps email merchants from templates under their own name, and can subscribe their calendar to their tasks and renewal dates.
9. **Books.** Receivables aged from each lender's payment terms, referral partner payables with mark-paid, the monthly cash view with a QuickBooks journal CSV, and an exceptions list (funded with nothing received, reps paid ahead of the lender, past maturity, clawback closing, overdue receipts, partner fees due). Renewal chains link a new deal to the one it replaced; Merchants shows every position, lifetime house net, notes and open tasks per client; the roster carries scorecards.
10. **Audit log and backup.** Every login, edit, payout, void, password change, settings change, email sent and file uploaded, with the actor's IP, filterable by rep and action, CSV export. Settings › Portal downloads everything as one JSON backup. CI runs typecheck, tests, both portal builds and the Docker image on every push (`.github/workflows/ci.yml`).

## The one rule

There is **one** definition of a rep's money: `repLedger(ctx, repId)` in `lib/commission/src/ledger.ts`. It returns `{ earned, accrued, awaitingLender, paid, cash, held, recovered, owed }`. Every screen, roster, and payroll total reads it. `paid` comes only from the payment ledger (`commission_payout_lines`), never from a deal's status. `accrued` is the rep's share on commission the lender has actually paid (each increment received, each upfront collected), and **owed = max(0, accrued − paid − held)** — recording a lender increment is what moves money from "awaiting lender" into "owed". Increment schedules exist only on consolidation products; LOCs and LOC draws are paid upfront. **Reps are paid on gross commission** (rate × gross); the house absorbs the referral fee, so house net = gross − referral fee − rep payouts.
