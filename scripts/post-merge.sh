#!/usr/bin/env bash
set -euo pipefail

pnpm install --frozen-lockfile

# Replit Publish owns production schema changes. Only reconcile the
# development database after a task merge.
if [[ "${NODE_ENV:-}" != "production" ]]; then
  pnpm db:up
fi

pnpm portal:build