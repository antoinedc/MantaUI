Supplied the real production GitHub device-grant `client_id` and verified it against real GitHub.

**What changed**
- `src/server/forge/auth.mjs`: set `DEVICE_CLIENT_ID` to the registered product id `Ov23liJP5kpodIqrcc3F`. The placeholder guard and the injectable `clientId` seam are untouched — an explicit placeholder/empty id still surfaces the `notConfigured` renderer state, but the production default now runs the flow for real.
- Added a test pinning that the default id is real (never falls back to the placeholder) and is unguarded.

**Verification (non-interactive, against real GitHub)**
- `POST github.com/login/device/code` with the new `client_id` → HTTP 200 with a valid `device_code`/`user_code`/`verification_uri`, confirming the app is registered and accepted.
- `npm run typecheck`: exit 0, no errors.
- `npm test`: 1961 pass / 0 fail / 0 skip.

**PR:** https://github.com/antoinedc/MantaUI/pull/859

**Hand-off note:** the last step of the acceptance criterion — a human entering the `user_code` at `github.com/login/device` on a box with no `gh`/no token, then confirming a working token is stored under `GITHUB_TOKEN` — is inherently interactive and cannot be exercised by an agent. The client-id prerequisite this issue was blocked on is now proven; that end-to-end confirmation remains an explicit manual step for a human with access to a fresh box.
