---
name: Production schema ownership
description: Why production startup must not execute schema migrations or other database DDL.
---

Let Replit's Publish flow apply development-to-production schema changes. The production application startup command should only start the application and must not run migration, push, or schema-sync commands.

**Why:** Replit applies the schema diff during Publish. Running the migration ledger again during container startup can replay changes against an already-current production schema, crash every instance, and prevent Autoscale health checks from succeeding.

**How to apply:** Apply schema changes to development through the normal development flow, review any schema prompt during Publish, and keep production startup free of DDL. If production schema looks stale, inspect the Publish schema diff rather than adding a migration hook.