---
name: Accounting sync serialization
description: Safe ordering for PostgreSQL advisory locks, connection pools, and repeatable-read accounting snapshots.
---

Serialize accounting syncs inside each application process before reserving a database connection. Hold a session advisory lock for cross-process coordination, then begin the repeatable-read accounting transaction only after that lock is acquired.

**Why:** A reserved postgres.js handle is not a full Drizzle transaction client, and letting many advisory-lock waiters reserve from the application pool can starve the lock holder of the separate connection needed for its transaction.

**How to apply:** Any sync or period-close path that refreshes immutable journals must enter the local queue first, reserve at most one lock connection per process, start its consistent snapshot after lock acquisition, and release the lock, connection, and queue slot in nested failure-safe cleanup.