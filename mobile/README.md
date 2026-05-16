# bui mobile (Capacitor)

Native shell around the bui mobile web client. The app is a remote viewer —
it connects over WebSocket to a bui server you run on your own Linux box.
No code runs on the device.

## Layout

- `www/` — the web client (forked, committed). `www/vendor/` is generated.
- `sync-web.sh` — copies xterm vendor files from repo-root `node_modules`.
- `android/`, `ios/` — Capacitor native projects.
- `assets/icon.png` — 1024×1024 placeholder. To regenerate icons: replace
  `assets/icon.png`, then run `npx capacitor-assets generate --assetPath
  assets --android` from `mobile/`.

## Prerequisites

- Run `npm install` at the **repo root** first (provides xterm vendor files).
- Android: Android Studio / Android SDK + JDK 17.
- iOS: macOS with **Xcode.app** (not just Command Line Tools) and CocoaPods
  (`sudo gem install cocoapods`). Not available on the build machine as of
  2026-05-16, so iOS is scaffolded but not built here.

## Scripts

```bash
npm run sync       # copy vendor + cap sync android
npm run apk        # sync + gradle assembleDebug -> debug APK
npm run android    # open the project in Android Studio
npm run sync:ios   # copy vendor + cap sync ios (needs CocoaPods)
npm run ios        # open the project in Xcode
```

## Android — debug APK

```bash
npm run apk
# -> android/app/build/outputs/apk/debug/app-debug.apk
```
Install on a device with
`adb install -r android/app/build/outputs/apk/debug/app-debug.apk`,
or open in Android Studio (`npm run android`) and Run.

For a signed release: Android Studio → Build → Generate Signed Bundle/APK.

## iOS — deferred steps (run on a Mac with Xcode.app)

Run the `npm` commands below from `mobile/`.

1. Install Xcode.app from the App Store and `sudo gem install cocoapods`.
2. `npm run sync:ios`
3. `npm run ios` (opens Xcode).
4. Select your team/signing, pick a simulator, Run to test.
5. Release: Xcode → Product → Archive → Distribute App → TestFlight.

`Info.plist` already has `NSAllowsArbitraryLoads` so the app can reach
HTTP (non-TLS) bui servers on a LAN.

App Store / TestFlight description:

> bui connects to your own remote Linux server to display tmux terminal
> sessions. All code execution is on your server; the app is a remote viewer.

## First launch

The app shows a server-URL screen. Enter your bui server (e.g.
`http://192.168.1.50:8787` or `https://bui.example.com`). It is saved to
localStorage; change it later via the gear icon in the session list header.
