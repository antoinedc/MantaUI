## Summary

Supplies the real public GitHub OAuth `client_id` for the Manta product's device-grant flow (BET-849). The device flow itself was implemented, guarded and tested in BET-796; the only missing piece was a production `client_id`, which Antoine registered and posted on the issue (`Ov23liJP5kpodIqrcc3F`).

**Change:** `src/server/forge/auth.mjs` — set `DEVICE_CLIENT_ID` to the real id. The guard (`DEVICE_CLIENT_ID_PLACEHOLDER`) and the injectable `clientId` seam in `startDeviceGrant`/`pollDeviceGrant` are untouched: an explicit placeholder/empty id still raises `DeviceFlowNotConfiguredError` → `notConfigured` renderer state, but the production default now runs the flow for real.

**Added test** pinned the invariant so the default never silently falls back to a placeholder.

## Verification

Verified against real GitHub (non-interactively): `POST github.com/login/device/code` with the new `client_id` returns HTTP 200 with a valid `device_code`/`user_code`/`verification_uri`, confirming the app is registered and accepted. Typecheck and the full suite are green.

**Files changed:** 2 files.

**Verification results:**
- PR branch (`multica/BET-849-device-client-id`): typecheck exit 0, no errors. `npm test`: 1961 pass / 0 fail / 0 skip.
- Base: `origin/main @ 74b9da9`.
- Conclusion: 0 new failures; no pre-existing failures.

The final interactive step of the acceptance criterion — a human entering the `user_code` at `github.com/login/device` on a box with no `gh`/no token — cannot be exercised by an agent and remains an explicit manual hand-off (as flagged during dispatch); the client-id prerequisite this issue was blocked on is now proven.

**Base: origin/main @ 74b9da9**
