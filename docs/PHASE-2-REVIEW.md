# Phase 2 review notes — auth and rep scoping

Phase 2 of [BUILD-ORDER.md](../design_handoff_greystone_commission_portal/BUILD-ORDER.md) is complete and stops here for review. The API exists; the React portal does not yet.

## What was built — `artifacts/api-server`

| Piece | File | Notes |
|---|---|---|
| Config from env | `src/config.ts` | Refuses `AUTH_MODE=dev`, a short `SESSION_SECRET`, or a missing `OIDC_ISSUER` in production. |
| Storage boundary | `src/repo.ts`, `src/repo.db.ts` | Routes talk to a `Repo` interface; Drizzle implements it. Tests use an in-memory repo. |
| OIDC | `src/auth/oidc.ts` | Authorization code + PKCE via `openid-client` v6, discovery from `OIDC_ISSUER`, nonce + state checks. The IdP email must match an **active** `commission_reps` row or sign-in is refused (403). Session is a signed, httpOnly, SameSite=Lax cookie. |
| Dev sign-in | same file | `GET /auth/dev-login?email=` only when `AUTH_MODE=dev`; the route is not mounted otherwise and the config throws in production. Replaces the prototype's identity picker for local work. |
| Roles | `src/auth/middleware.ts` | `rep`, `manager`, `admin` on `commission_reps.role`. `requireRole` guards admin routes. |
| Server-side scope | `src/auth/middleware.ts` › `resolveScope` | Every `/api/me/*` handler reads `req.scope.effectiveRepId`. View-as arrives as `X-View-As: <repId>` (or `?viewAs=`), is authorized by `canViewAs`, and replaces the actor's id for every downstream query. Nothing is filtered in the client. |
| Audit | `commission_audit_log` (migration `0001_audit_log.sql`) | One row per request served under View-as, plus login/logout. `GET /api/admin/audit` reads it. |
| Rep projections | `src/scope.ts` | `repDealView`, `repWallet`, `repClawbackViews`, `leaderboard`, `repStatements`, `repMonthly`. Built only from the domain layer. |
| Leak guard | `src/scope.ts` › `assertRepSafe` | Deep-scans a payload for forbidden keys (`houseNet`, `gross`, `net`, `referral*`, `openerId/closerId/overrideId`, split rates, PSF, origination, credit line…). Tests run it over every rep endpoint and also assert no other rep's name appears. |

**Endpoints**

```
GET  /health
GET  /auth/login  /auth/callback   POST /auth/logout   GET /auth/me   [GET /auth/dev-login]
GET  /api/me                 who am I (+ actor when under View-as)
GET  /api/me/wallet          repLedger + awaiting-lender
GET  /api/me/deals[?search&status]   GET /api/me/deals/:id
GET  /api/me/clawbacks       GET /api/me/statements   GET /api/me/leaderboard   GET /api/me/monthly?months=
GET  /api/admin/reps         roster with earned/paid/held/owed from repLedger        (admin)
GET  /api/admin/reps/options?purpose=assign|edit|view-as                           (admin, manager)
GET  /api/admin/view-as/:repId/check                                               (admin, manager)
GET  /api/admin/audit                                                              (admin)
```

**Tests: 25 in this package, 127 across the repo.** Verified live against Postgres 16 with `AUTH_MODE=dev`: rep sign-in, own deals only, rep View-as refused, admin View-as returns the rep's byte-identical payload, audit rows land in `commission_audit_log`.

## Decisions that need a reviewer's eye

1. **Manager scope is an assumption.** The README defines the roles but not what a manager sees. Implemented: a manager can View-as themselves or any rep on their own team, and cannot open admin routes. Admins can View-as anyone, including inactive reps (invariant #9: a departed rep's balance must be settleable).

2. **View-as is a per-request header, not a session mode.** The client sends `X-View-As` on every call while the admin has a rep selected. That keeps the scope stateless, makes each viewed request auditable, and means an admin tab left on "View as Julian" cannot leak into a later admin request that forgot to clear it. It also means one audit row per request; if that is too noisy, collapse to one row per (actor, target, minute) in `resolveScope`.

3. **The IdP is generic.** Any OIDC provider with discovery works (`OIDC_ISSUER`, client id, optional secret; PKCE is always on). Identity is matched on the **email claim**, lower-cased. This is why the seeded placeholder emails matter: until real addresses are in `commission_reps`, no one can sign in through OIDC. The README's "existing `auth.ts`" was not available to reuse.

4. **What a rep sees of a clawback**: the deal-level clawback amount, their charged share, recovered, and remaining. The deal's net is not exposed, so the rep cannot back out house net from the ratio.

5. **Leaderboard** ranks by earned net commission (`repLedger.earned`), anonymized as `Rep #n`, with the viewer labelled `You` and appended if outside the top 6.

6. **Statements** attach ledger rows to a run by `run_id`, falling back to the run's date window for rows with no run. Only periods with rows are returned.

7. **No CSRF token.** Cookies are `SameSite=Lax` and the API is JSON-only; the portal will be same-site. If the portal ends up on a different site, add a CSRF token or switch to `SameSite=None` + token.

## Next: Phase 3

Rep portal in `artifacts/portal` (React/Vite + shadcn/ui): wallet → my deals → clawbacks → statements, reading the `/api/me/*` endpoints above. The admin "View as" select drives the `X-View-As` header.
