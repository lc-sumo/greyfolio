# Deploying the commission portal

Two supported paths. Both run the same Docker image: the Express API serving the built portal, migrations applied on boot.

## Option A — Render (managed, ~15 minutes)

1. Push this repo to GitHub. In Render: **New → Blueprint**, pick the repo. `render.yaml` creates the web service and a Postgres database, generates `SESSION_SECRET`, and wires `DATABASE_URL`.
2. First deploy boots with `SEED=workbook`, which loads reps, lenders, products and referral partners from the tracker tabs. After it is up, change `SEED` to `none` so later boots leave the data alone.
3. Set `BASE_URL` and `APP_ORIGIN` to the service URL (`https://greystone-portal.onrender.com`) or your domain once it is attached under **Settings → Custom domains**.
4. Email: create a [Resend](https://resend.com) account, verify the sending domain, paste the key into `MAIL_API_KEY`. `MAIL_FROM` must be on that domain. Postmark works the same way with `MAIL_PROVIDER=postmark`.
5. Sign in with `leor@greystoneus.com` after setting its password from a one-off shell (`Shell` tab → `pnpm --filter @greystone/api-server exec tsx -e "…"`) — or simpler: temporarily set `AUTH_MODE=dev`, sign in, set passwords in Settings › Reps, then remove `AUTH_MODE`. Production refuses `AUTH_MODE=dev`, so do this on a preview deploy or use the SQL below.
6. Import the FUNDED DEALS tab: Settings › Import from sheet.

**Backups on Render**: paid Postgres plans take daily snapshots (Dashboard → database → Backups). Also run `scripts/backup.sh` from your laptop weekly against the external connection string for an off-platform copy.

### Setting the first admin password by SQL

```sql
-- generate the hash locally: pnpm --filter @greystone/api-server exec tsx -e "import('./src/auth/password.ts').then(async m => console.log(await m.hashPassword('Your-Password-1234')))"
update commission_reps set password_hash = 'scrypt$16384$…' where email = 'leor@greystoneus.com';
```

## Option B — Your own server with Docker Compose

Any Linux box with Docker (a $6–12/month VPS is plenty).

```sh
git clone … greyfolio && cd greyfolio
cp .env.production.example .env.production   # fill in secrets, BASE_URL, mail key
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

This starts Postgres, the app on port 8080, and a backup sidecar that writes a `pg_dump` to `./backups` every day at 07:00 UTC and keeps 30 days. Put a reverse proxy with TLS in front (Caddy: `portal.greystoneus.com { reverse_proxy localhost:8080 }`), and copy `./backups` somewhere else nightly (`rclone sync ./backups s3:greystone-backups`, or a cron on another machine).

Restore: `docker compose -f docker-compose.prod.yml exec backup sh /backup.sh restore /backups/greystone-2026-09-03T0700.sql.gz`.

Set `SEED=workbook` for the very first boot only, then `none`.

## Environment reference

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `SESSION_SECRET` | yes | 32+ random characters; rotating it signs everyone out |
| `BASE_URL`, `APP_ORIGIN` | yes | Public URL; used in emails and reset links |
| `NODE_ENV=production` | yes | Secure cookies, refuses dev sign-in, requires the above |
| `AUTH_PASSWORD` | no | `off` to disable email + password sign-in (then SSO is required) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | no | SSO (Google Workspace, Okta, Entra) |
| `MAIL_PROVIDER` | no | `resend`, `postmark`, `log` (print only), `off` (default in production) |
| `MAIL_API_KEY`, `MAIL_FROM` | with mail | Provider key and verified sender |
| `RENEWAL_DIGEST_HOUR_UTC` | no | Hour the renewal digest goes to admins (default 13); `off` disables |
| `SEED` | no | `workbook` on first boot, `none` afterwards, `demo` only for previews |
| `APP_NAME` | no | Shown in emails and authenticator apps |

## What email is used for

- **Forgot password** links (one hour, single use). With `MAIL_PROVIDER=off` the sign-in screen tells reps to ask an admin instead.
- **Statements** to each rep when a payroll run is approved.
- **Clawback notices** to each rep with a slice when one is recorded.
- **Renewal digest** to admins once a day when anything is renewal-ready or in Prospecting.

Every send is in the Audit log as `mail.sent`, with the provider's message id or the error.

## Health and logs

`GET /health` returns `{ok:true}` and is what Render and Compose poll. Logs are one JSON line per request (`REQUEST_LOG=off` to silence) plus errors; ship them to your log provider by tailing the container.

## Upgrading

Push to `main` (Render auto-deploys) or `git pull && docker compose … up -d --build`. Migrations in `lib/db/migrations` run on every boot and are idempotent.
