# bui mobile (Expo React Native)

The bui mobile app — a native iOS/Android client built with **Expo** (managed
workflow, TypeScript). This is the M3 milestone (BET-37) stage 2 scaffold:
**QR pairing + a read-only session list**, provable on **Expo Go / iOS
simulator** with **zero Apple credentials**.

- Bundle identifier: `com.antoinedc.bui` (iOS + Android)
- Framework: Expo SDK 52 + React Navigation (native-stack)
- QR scan: `expo-camera`
- Secure token storage: `expo-secure-store` (iOS Keychain / Android Keystore)

## What it does

1. **Pairing screen** — scan the `bui://pair?server=…&code=…` QR shown by the
   desktop app, OR enter the server URL + 6-digit pairing code manually (the
   fallback for Expo Go on a simulator, which has no camera). On success the
   box_token is stored in the device keychain.
2. **Session list screen** — calls the box's `tmux:list` RPC (Bearer
   box_token) and renders a **read-only** list of sessions: title +
   running/idle dot, grouped by project. Tapping a row shows a placeholder —
   live transcript streaming is a later milestone (M5).

## Run it (Expo Go / simulator)

```bash
cd mobile-rn
npm install
npx expo start
```

Then:
- Press **i** to open the iOS simulator, **a** for an Android emulator, or scan
  the dev QR with **Expo Go** on a physical device.
- On a simulator (no camera), use the **manual entry** fields: paste your box
  URL (e.g. `http://192.168.1.10:8787`) and the 6-digit code from
  `npm run pair` on the box.

## Device / TestFlight builds (EAS)

This box is Linux and can't compile iOS, so device builds run on **Expo
Application Services (EAS Build)** — cloud macOS builders. The build/submit
config lives in [`eas.json`](./eas.json) with three profiles:

| Profile | Purpose | iOS output | Apple account needed? |
|---|---|---|---|
| `development` | Dev client, hot reload | **simulator** `.app` | No |
| `preview` | Internal QA / demo | **simulator** `.app` | No |
| `production` | Store / TestFlight | signed device `.ipa` | **Yes** |

The `development` and `preview` profiles set `ios.simulator: true`, so they build
a simulator `.app` that needs **no Apple credentials** — that's the CI-friendly
sanity build. Only `production` (a signed device binary) requires an Apple
Developer account.

### One-time setup

```bash
cd mobile-rn
npm install
npm install -g eas-cli          # or: npx eas-cli@latest ...
eas login                       # interactive; or export EXPO_TOKEN=<token> for CI
eas init                        # links this app to an Expo project (writes extra.eas.projectId into app.json)
```

`EXPO_TOKEN` (an Expo access token, created at https://expo.dev under Account →
Access Tokens) lets `eas` run **non-interactively** from this box — set it
instead of `eas login` for scripted/CI runs.

### Build

```bash
# No Apple account — simulator build (runs on the iOS simulator):
eas build --platform ios --profile preview

# Signed device / TestFlight build (requires Apple Developer membership):
eas build --platform ios --profile production
```

The first `production` build prompts EAS to create the iOS Distribution
certificate + provisioning profile for you (EAS-managed credentials); it needs
you to be logged into an Apple account with an active **Apple Developer Program**
membership.

### Submit to TestFlight

```bash
eas submit -p ios --profile production --latest
```

`eas submit` uploads the built `.ipa` to App Store Connect / TestFlight. The
`submit.production.ios` block in `eas.json` reads the **App Store Connect API
key** from env (never committed) — set these before submitting:

| Env var | What | Where it comes from |
|---|---|---|
| `ASC_API_KEY_PATH` | Path to the `.p8` API key file | App Store Connect → Users and Access → Integrations → App Store Connect API |
| `ASC_API_KEY_ID` | Key ID for that `.p8` | same page |
| `ASC_API_KEY_ISSUER_ID` | Issuer ID for your ASC account | same page |

Store the `.p8` and IDs as **EAS secrets** (`eas secret:create`) or export them
in the shell for a one-off submit — do **not** commit them to the repo.

### EAS free tier

EAS Build's free tier uses a **shared build queue** (builds wait behind paid
users) and caps **builds per month**. That's fine for the occasional TestFlight
build here — `eas.json` intentionally does **not** request paid priority builds.
Expect a queue wait on free-tier builds.

A signed `production` build/submit is **human-blocked** on the Apple artifacts
above (Developer membership, `EXPO_TOKEN`, ASC API key). This slice ships the
config + docs; the actual signed run is an operator step.

## Verify without a simulator (this repo's CI path)

This box is Linux (no Xcode), so we don't compile native binaries here. The pure
logic (pairing-outcome classification, QR-payload wiring, session-list mapping)
is unit-tested and typechecked:

```bash
cd mobile-rn
npm install
npm run typecheck   # tsc against the Expo/RN types
npm test            # vitest — pure modules only
```

The pure-module tests are **also** collected by the repo-root `npm test`
(vitest) so `npm run typecheck && npm test` at the repo root covers this app's
logic without needing the RN app's own `node_modules` for the pure layer.

## Structure

```
mobile-rn/
  app.json            Expo config (name "bui", bundle id com.antoinedc.bui, camera perms)
  App.tsx             Navigation root (Pairing ↔ Sessions), launch-time credential check
  index.ts            Expo entry (registerRootComponent)
  src/
    pure/             Framework-free, unit-tested logic (no fetch/camera/keychain):
      pairPayload.ts    ported BET-73 QR/deeplink parser + builder
      claim.ts          /auth/claim outcome classification (ported shared classifier)
      scanWiring.ts     decoded-QR → pair-or-error decision; camera availability
      sessionList.ts    raw tmux:list JSON → FlatList view model
      __tests__/        vitest specs for each pure module
    api/              Impure side effects:
      pairingApi.ts     fetch: POST /auth/claim, POST /rpc/<channel> (Bearer)
      credentials.ts    expo-secure-store read/write of { serverUrl, boxId, boxToken }
    screens/          RN screens:
      PairingScreen.tsx    QR scan (expo-camera) + manual fallback
      SessionListScreen.tsx  read-only FlatList of sessions
    theme.ts          shared dark palette
```

The **pure ↔ impure split** mirrors the desktop/web client's convention
(`src/renderer/mobile/pairingLogic.ts` + `src/shared/claim.mjs`): all
URL/payload/outcome logic is pure and tested; `fetch` and the keychain live in
thin `api/` wrappers.
