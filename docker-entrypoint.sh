#!/bin/sh
set -e
cd /app
echo "Waiting for Postgres…"
for i in $(seq 1 30); do
  (cd lib/db && node -e "const p=require('postgres')(process.env.DATABASE_URL);p\`select 1\`.then(()=>{p.end();process.exit(0)}).catch(()=>process.exit(1))") 2>/dev/null && break
  sleep 1
done
echo "Applying migrations"
pnpm --filter @greystone/db migrate
# Default seed: the demo board in development, nothing in production (set SEED=workbook for the first real boot).
if [ "$NODE_ENV" = "production" ]; then SEED="${SEED:-none}"; else SEED="${SEED:-demo}"; fi
if [ "$SEED" = "demo" ]; then
  echo "Loading demo board (SEED=demo)"
  pnpm --filter @greystone/db seed:demo
elif [ "${SEED}" = "workbook" ]; then
  pnpm --filter @greystone/db seed
fi
exec pnpm --filter @greystone/api-server start
