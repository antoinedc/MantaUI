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

A signed device build (EAS profiles / TestFlight) is **stage 3 (BET-75)** and is
intentionally out of scope here — everything above runs without an Apple
Developer account.

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
