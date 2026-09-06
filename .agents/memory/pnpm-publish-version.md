---
name: pnpm Publish version
description: Why the repository pnpm pin must match Replit's provided Publish installer.
---

Keep the repository's exact pnpm version aligned with the pnpm version provided by the Replit Publish environment, invoke pnpm directly in Publish build commands, and avoid pnpm lifecycle commands during production startup.

**Why:** A mismatched exact pin made the provided pnpm recursively bootstrap an older pnpm during the managed package-install phase. Calling `corepack enable` later also failed because it tried to create a symlink in the read-only Nix store. With production mode enabled, a startup lifecycle command also attempted dependency resolution against the package firewall and timed out before the HTTP port opened.

**How to apply:** Align the package-manager declaration with the provided pnpm, omit Corepack setup, perform installs only in the build phase, and invoke already-installed workspace binaries directly during startup. Verify a frozen install and the exact production run command.