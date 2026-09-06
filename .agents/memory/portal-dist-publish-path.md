---
name: Portal distribution path in Publish
description: How to pass the built portal path when starting the filtered API workspace.
---

Anchor the portal distribution path to the monorepo root before invoking the filtered API package.

**Why:** pnpm runs the filtered API script with the API package as its working directory. A relative monorepo path was therefore resolved under that package, causing the Autoscale root health check to return 500.

**How to apply:** In the Publish run command, derive the absolute portal path from the shell's root working directory before `pnpm --filter` changes package context. Verify both `/` and `/health` return 200 in a production-style local start.