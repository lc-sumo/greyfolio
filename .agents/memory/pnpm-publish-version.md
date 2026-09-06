---
name: pnpm Publish version
description: Why the repository pnpm pin must match Replit's provided Publish installer.
---

Keep the repository's exact pnpm version aligned with the pnpm version provided by the Replit Publish environment.

**Why:** A mismatched exact pin made the provided pnpm recursively bootstrap an older pnpm during the managed package-install phase. Under the Publish container's thread limits, the child Node process aborted before the application build began.

**How to apply:** When changing the pnpm pin, update both the package-manager declaration and Publish build/run commands together, then verify that `pnpm --version` does not trigger a bootstrap and that a frozen install succeeds.