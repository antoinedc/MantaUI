---
name: verify-build
description: Run typecheck and full test suite for better-ui and report pass/fail. Mandatory before claiming any change is done. Read-only — does not deploy.
---

# verify-build

When you're about to claim a task is done, run this skill first.

## What it does

Runs the two mandatory checks from the project root
(`/home/dev/projects/better-ui`):

```bash
npm run typecheck   # tsc across all tsconfigs (main, web, node)
npm test            # vitest (renderer) + node:test (src/server/*.test.mjs)
```

These are the canonical "would this even ship?" checks.

## When to use

- Before commenting "done" on any issue that touches TypeScript source in
  `src/main/`, `src/renderer/`, `src/preload/`, or `src/server/`.
- Before `git push` on any branch that modified TypeScript or `.mjs` files.
- Whenever you've changed a type in `src/preload/` — both the Electron and
  mobile shim consumers must still compile.

## When NOT to use

- Documentation-only changes (`*.md`, `AGENTS.md`).
- Mobile asset/config-only changes (`mobile/` non-TS files).

## Steps

1. Confirm you're in `/home/dev/projects/better-ui`.
2. Run `npm run typecheck`. Capture stdout + stderr.
3. Run `npm test`. Capture stdout + stderr.
4. Report in the issue comment:
   - `typecheck`: ✅ pass or ❌ fail
   - `test` (renderer/Vitest): ✅ pass or ❌ fail
   - `test` (server/node:test): ✅ pass or ❌ fail
   - For failures: first 30 lines of error output and a one-line diagnosis.
5. If anything failed, **do not push**. Fix the failure, re-run, then push.

## Notes

- `npm run test:server` runs only the Node server tests if you want a faster
  targeted check after server-only changes.
- `npm run test:watch` runs Vitest in watch mode (renderer only) — useful
  during active development, not for final verification.
- This skill is local-only. It does NOT deploy to prod or touch any remote host.
