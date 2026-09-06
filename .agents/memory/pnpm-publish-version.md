---
name: pnpm Publish version
description: Why the repository pnpm pin must match Replit's provided Publish installer.
---

Keep the repository's exact pnpm version aligned with the pnpm version provided by the Replit Publish environment, and invoke pnpm directly in Publish commands.

**Why:** A mismatched exact pin made the provided pnpm recursively bootstrap an older pnpm during the managed package-install phase. Calling `corepack enable` later also failed because it tried to create a symlink in the read-only Nix store.

**How to apply:** Align the package-manager declaration with the provided pnpm, omit Corepack setup from Publish commands, and verify that `pnpm --version` plus a frozen install succeed.