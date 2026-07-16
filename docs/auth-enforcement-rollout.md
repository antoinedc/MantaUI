# Auth-enforcement rollout runbook (M1)

**Audience:** whoever operates a live bui-server box when the M1 auth gate ships.

**Why this exists:** the live bui-server predates the auth gate. It has been
serving `0.0.0.0:8787` with **no authentication**. Once the M1 code is deployed
and the process restarts, `createAuthEngine({ enforce: true })` is the default —
**every data route immediately requires a valid `Authorization: Bearer <box_token>`.**
Any device that was talking to the box before the restart (the desktop app, an
installed PWA, a browser tab) will start getting `401` the instant the new
process comes up, until it pairs. This runbook is the ordered procedure that
keeps that transition from locking you out.

The client side is already handled: on a `401`, `httpApi` throws
`AuthRequiredError`, and the mobile/web client renders the **pairing screen**
(BET-52) instead of the session list. The desktop app has its own onboarding
pair screen (BET-49). So the failure mode is "app shows a code-entry screen,"
not "app is dead" — but you still have to mint a code and enter it on each
device.

---

## Pre-flight (before you restart anything)

1. **Client plumbing must already be live on the boxes/apps.** The Bearer
   plumbing (BET-51) and the pairing UI (BET-52 mobile / BET-49 desktop) must be
   in the build the devices are running *before* you flip enforcement on the
   server. If a device is on an old client that doesn't know about
   `AuthRequiredError` / the pairing screen, it will just show broken calls after
   the restart. **Order: ship the client update, confirm devices are on it, then
   deploy + restart the server with the gate on.**

2. **Know your escape hatch.** `MANTA_AUTH_DISABLED=1` in the server's environment
   makes `createAuthEngine` construct with `enforce: false` — the gate allows
   every request and the server prints a loud one-time warning on boot. This is
   the "don't lock me out" lever. Keep it ready but do **not** leave it on in a
   deployment you intend to commercialize — it disables the whole point of M1.

3. **You need loopback access to the box** (SSH in, or a local shell). Minting a
   pairing code is **local-only** by design: `GET /auth/pair` is rejected unless
   the request originates from the box itself (loopback AND no proxy-injected
   `X-Forwarded-For`). This is what stops a remote attacker from minting a code
   and claiming the `box_token` in two requests. You cannot pair a device
   without shell access to the box.

---

## Rollout order

### 1. Deploy the server with the gate ON (default)

Deploy the M1 build. Do **not** set `MANTA_AUTH_DISABLED`. On restart the server
logs that enforcement is active. At this point every existing device sees `401`
and drops to its pairing screen.

> If you want a zero-downtime cutover for a device you can't immediately reach,
> deploy first with `MANTA_AUTH_DISABLED=1`, pair every device (steps 2–3), then
> remove the env var and restart once more to enforce. This trades a brief
> unauthenticated window for not stranding a device.

### 2. Mint a pairing code on the box (per device)

Run the loopback pairing request **on the box** (the `bui pair` CLI does this;
the equivalent raw call is a loopback curl):

```bash
curl -s http://127.0.0.1:8787/auth/pair
# → {"pairing_code":"847291","box_id":"<32-hex>","expiresAt":<epoch-ms>}
```

Notes:
- The code is **6 digits**, **one-time**, and **~5-min TTL** (`PAIRING_TTL_MS`).
- Only **one** code is active at a time — minting a new one supersedes any prior
  unclaimed code. Mint immediately before you type it in; don't batch.
- If you run this from off-box (through the tunnel), you get `403` — that's the
  local-only guard working. Get onto the box.

### 3. Claim the code on the device

On the device that needs access, open the app; it shows the pairing screen
(fresh install, or a `401` because it has no/stale token). Enter the 6-digit
code and tap **Connect**. The client POSTs it:

```
POST /auth/claim  {"pairing_code":"847291"}
→ 200 {"box_token":"<32-hex>","box_id":"<32-hex>"}   # success
→ 403 {"error":"pairing failed"}                     # wrong / expired / reused
→ 429 {"error":"rate limited"}                        # too many attempts
```

On `200` the client persists `box_token` in `localStorage["manta_token"]` and
reloads into the session list. The token is long-lived — the device does **not**
re-pair on every launch, only reloads persist it across restarts.

Repeat steps 2–3 for **each** device (desktop, phone, each browser profile).

### 4. Verify

After pairing each device, confirm the real transports still work end-to-end —
these are the paths that carry the `box_token` differently and are the most
likely to regress:

- **RPC / uploads / downloads** — open a session, send a prompt; upload a file;
  pull an agent file. These send `Authorization: Bearer`. A `401` here means the
  token didn't persist or the header isn't attached.
- **Live event stream (`/events` WS)** and **terminal (`/pty` WS)** — the
  session's status dots update and a terminal window streams. Browsers can't set
  a WS header, so these carry the token as `?token=`; the server accepts
  `?token=` on `/events` + `/pty` **only**. If the transcript is live and the
  terminal echoes, the WS auth is good.
- **PWA presence / push forwarding** — confirm the installed PWA still receives
  pushes and that focus-forwarding (`reportFocus`) still suppresses the
  "Claude is done" push for the on-screen session.

If all four hold on every paired device, enforcement is live and healthy.

---

## Re-pair path (token revoked / rotated later)

If a `box_token` is rotated or invalidated on the box, paired devices start
getting `401` again on their next call. The client handles this automatically:
the same `AuthRequiredError` → pairing screen flow fires, so a rotated token
does **not** brick the app — it just asks the user to pair again. Operationally
that's the same steps 2–3: mint a fresh code on the box, enter it on the device.

---

## Rollback

If a rollout goes wrong and devices are stranded:

1. Set `MANTA_AUTH_DISABLED=1` in the server environment and restart. The gate
   goes fully permissive; every device works again with no token (the client
   simply never hits a `401`).
2. Diagnose (was the client build too old? did a device fail to persist its
   token? is the tunnel injecting headers that break loopback detection?).
3. Re-enable by removing the env var and restarting once the devices are on a
   client that can pair. **Do not ship the permissive mode as the steady state.**
