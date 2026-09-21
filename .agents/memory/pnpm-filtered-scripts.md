---
name: pnpm filtered scripts
description: Prevents accidental dependency updates when invoking workspace package scripts.
---

Use `pnpm --filter <package> run <script>` for filtered workspace scripts. Do not omit `run` when the script name overlaps a pnpm command, such as `up`.

**Why:** `pnpm --filter @greystone/db up` was interpreted as a dependency update, while `pnpm --filter @greystone/db run up` correctly executed the database migration script.

**How to apply:** Always include `run` for filtered package scripts and check the lockfile immediately if pnpm prints dependency-resolution progress unexpectedly.