## Forward the four-char `verify` through the device-side claim screens (BET-514)

The two-sided-confirm code (`verify`, BET-493 §5.3) is surfaced on the box
(`manta pair` CLI, web pair page, and pair links carrying `&verify=`), but the
DEVICE-side claim paths still sent only `{serverUrl, code}` and silently
dropped `verify` — so a device joining by pasting a `manta://pair?…&verify=…`
link (or typing a CLI-minted code by hand) claimed WITHOUT the confirm and
resumed the shared primary `box_token` instead of a distinct Stage-2 device.
That is the "joiner reuses the desktop's own token" outcome BET-493/BET-513
are meant to prevent, at the last remaining device-side surfaces.

### What changed (device claim path now forwards `verify`)

- **`src/shared/types.ts`** — `AuthClaimInput.verify?: string`.
- **`src/renderer/mobile/pairPayload.ts`** — `PairPayload.verify?` +
  `normalizeVerifyCode` / `isValidVerifyCode` / `VERIFY_RE`; `parsePairPayload`
  parses `&verify=` (present-but-malformed → refuse whole payload, never
  silently drop); `buildPairPayload` appends `&verify=` when present.
  *Note:* this wire-format half is what BET-513 (PR #426, currently closed-unmerged)
  was meant to ship — it is a hard prerequisite for the device path and is not
  in `main`, so it is carried here so BET-514 is complete + mergeable. If #426
  re-opens, the `pairPayload` change is shared/identical.
- **`src/renderer/mobile/setupLogic.ts`** — `SetupFields.verify?`;
  `buildSetupClaimInput` accepts + emits `verify`; `prefillFromPairLink`
  returns it.
- **`src/renderer/pairClaim.ts`** — `claimBox` forwards `verify` to
  `window.api.authClaim` (desktop manual Connect).
- **`src/main/auth.ts`** — desktop IPC claim POST body includes `verify`.
- **`src/renderer/api/httpApi.ts`** — `submitPairingCode` / `claimAgainst`
  include `verify` (mobile/web reach) and `authClaim` forwards `input.verify`.
- **`src/renderer/mobile/pairingLogic.ts` + `PairingScreen.tsx`** — the mobile
  pairing screen collects the 4-char code and forwards it.
- **`src/renderer/PairStep.tsx`** (manual Connect) + **`SetupScreen.tsx`**
  (mobile manual sheet) — collect + forward the optional verify field.
- **`src/renderer/mobile/deepLink.ts`** — `DeepLinkDeps.authClaim` input type +
  claim input carry `payload.verify` (QR / deep-link auto-claim).

The server's claim-with-`verify` already provisions a DISTINCT Stage-2 device
(BET-493); this PR completes the request half. Absent `verify` keeps the legacy
claim body unchanged (back-compat), confirmed by tests on every surface.

**Base: origin/main @ `40d8773`**

**Files changed:** 15 files, +465 / −39.
`src/renderer/mobile/pairPayload.ts`, `pairPayload.test.ts`, `setupLogic.ts`,
`setupLogic.test.ts`, `pairingLogic.ts`, `pairingLogic.test.ts`,
`PairingScreen.tsx`, `SetupScreen.tsx`, `PairStep.tsx`, `pairClaim.ts`,
`deepLink.ts`, `src/renderer/api/httpApi.ts`, `src/main/auth.ts`,
`src/main/auth.test.ts`, `src/shared/types.ts`

**Self-check:** every acceptance criterion scored ≥8 (see below).

**Verification results:**
- PR branch (`multica/BET-514-forward-verify-device-claim` @ `cdf88b9`):
  - typecheck: exit 0. Errors: none. log sha256: `00a5b65767585a439874e95183a8a3e16731ab621895b1c6bb2ebbe3c05b5624`
  - test: exit 0. 85 files / 1774 vitest pass; node 1346 pass / 0 fail. Failures: none. log sha256: `dac69a35956d19bc184af429cbd91db52bd28757f25fc43417696137594cc062`
- Base (`main` @ `40d8773`):
  - typecheck: exit 0. Errors: none. log sha256: `00a5b65767585a439874e95183a8a3e16731ab621895b1c6bb2ebbe3c05b5624`
  - test: exit 0. 85 files / 1754 vitest pass; node 1346 pass / 0 fail. Failures: none. log sha256: `3fc525a57212a25eef17971fe956e20715f0780730415c129d4b4cf1c2875901`
- **Conclusion:** 0 new failures. This PR adds 20 vitest tests (all passing);
  node suite identical to base. No regressions.

Logs cached at `/tmp/tc-pr.log`, `/tmp/tc-main.log`, `/tmp/test-pr.log`, `/tmp/test-main.log`.

**E2E smoke (renderer):** built `npm run build` and launched via Playwright's
Electron launcher under `xvfb-run`. App launched (title "Manta UI"), **F: 0
console/renderer errors** (the load-bearing invariant). The app booted to the
pre-pairing onboarding "Connect your box" screen — which is precisely the
`PairStep` component this PR modifies — and rendered it with no errors. The
sidebar/terminal/chat invariants (B/C/D/E) are not applicable on a fresh
unpaired launch (no box configured → no sidebar-level chrome yet); this is the
expected onboarding state, not a regression from this change.
