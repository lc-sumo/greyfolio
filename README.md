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

Open http://localhost:8080 and sign in with `leor@greystoneus.com` (admin), `julian.ribak@greystoneus.com` (rep) or `raymond.amato@greystoneus.com` (team lead). The container applies migrations and loads the demo board on every start (`SEED=demo`); set `SEED=none` in `docker-compose.yml` to keep your data between restarts. `docker compose down -v` wipes the database.

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

Sign in with any rep's email from the roster (e.g. `leor@greystoneus.com` for admin, `julian.ribak@greystoneus.com` for a rep, `raymond.amato@greystoneus.com` for a team lead). In production set `OIDC_ISSUER` and leave `AUTH_MODE` unset.

## The one rule

There is **one** definition of a rep's money: `repLedger(ctx, repId)` in `lib/commission/src/ledger.ts`. It returns `{ earned, paid, cash, held, recovered, owed }`. Every screen, roster, and payroll total reads it. `paid` comes only from the payment ledger (`commission_payout_lines`), never from a deal's status.
