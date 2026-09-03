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
artifacts/portal/       (Phase 3+) React/Vite portal.
docs/             Phase notes and review checklists.
```

## Build status

| Phase | Scope | Status |
|---|---|---|
| 1 | Data model and money math, no UI | Done ([notes](docs/PHASE-1-REVIEW.md)) |
| 2 | Auth (OIDC) and server-side rep scoping | **Done — awaiting review** ([notes](docs/PHASE-2-REVIEW.md)) |
| 3 | Rep portal | Not started |
| 4 | Admin master board and deal entry | Not started |
| 5 | Payroll | Not started |
| 6 | Renewals, merchants, analytics | Not started |
| 7 | Settings | Not started |
| 8 | Google Sheets | Not started |
| 9 | QuickBooks | Not started |

## Getting started

```bash
pnpm install
pnpm test          # domain + seed tests
pnpm typecheck

# Database
cp lib/db/.env.example lib/db/.env   # set DATABASE_URL
pnpm db:migrate                       # applies lib/db/migrations
pnpm db:seed                          # reps + settings from the workbook

# API
cp artifacts/api-server/.env.example artifacts/api-server/.env
pnpm --filter @greystone/api-server dev   # http://localhost:8080
# Without an IdP: AUTH_MODE=dev, then GET /auth/dev-login?email=leor@greystoneus.com
```

## The one rule

There is **one** definition of a rep's money: `repLedger(ctx, repId)` in `lib/commission/src/ledger.ts`. It returns `{ earned, paid, cash, held, recovered, owed }`. Every screen, roster, and payroll total reads it. `paid` comes only from the payment ledger (`commission_payout_lines`), never from a deal's status.
