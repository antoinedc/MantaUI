---
name: verify-build-better-ui
description: Runs npm run typecheck && npm test. Mandatory before marking any task done.
---

# Verify Build — Better UI

## What

Runs the full verification suite for the Better UI project.

## Commands

```bash
# Typecheck (renderer + main + server)
npm run typecheck

# Tests (renderer: vitest, server: node:test)
npm test

# Server tests only (faster)
npm run test:server
```

## When to Run

- **Before marking any task done** — this skill is mandatory for completion.
- After any change to:
  - `src/renderer/` (ChatPanel, chatUtils, Terminal, etc.)
  - `src/main/` (opencode, pty, setup, providers, etc.)
  - `src/server/` (all .mjs modules)
  - `mobile/` (Capacitor config, native shells)
  - `src/shared/` (types, voiceClassifier)

## What Counts as Done

A task is **not done** until:
1. `npm run typecheck` passes with no errors.
2. `npm test` passes all tests (renderer + server).
3. For mobile changes: `cd mobile && npm run apk` builds successfully.
4. For mobile changes: `npm run build:mobile` succeeds and `mobile/www/` is updated.

## Known Issues

- **Renderer tests**: pure utility functions only (no DOM, no Electron). `chatUtils.test.ts` is the main suite.
- **Server tests**: pure logic only (no live tmux/opencode). All server tests are in `src/server/*.test.mjs`.
- **Mobile tests**: none yet — build verification only.

## Failure Modes

- **Typecheck fails**: fix the type error before anything else. Don't suppress with `@ts-ignore`.
- **Tests fail**: investigate the failure, fix the root cause, don't delete tests.
- **Mobile build fails**: check `mobile/` logs, verify Capacitor config, ensure native deps are installed.

## Notes

- Run `npm run test:watch` for iterative development (vitest only).
- Run `npm run test:server` for faster feedback on server changes.
- The full `npm test` is the gate — don't skip it.
