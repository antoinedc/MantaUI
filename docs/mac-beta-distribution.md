# macOS beta distribution (outside the App Store)

Ship the desktop app as a **signed + notarized DMG** hosted on `mantaui.com`,
with electron-updater auto-updates. No App Store review. Testers double-click,
no Gatekeeper warnings.

**The build MUST run on a Mac** — `codesign`, `notarytool`, and the `.dmg`
target need macOS + Xcode command-line tools. This Linux box cannot produce a
signed Mac build. Everything below runs on your Mac.

## One-time setup (on your Mac)

### 1. Xcode command-line tools

```
xcode-select --install     # if not already installed
```

### 2. Create a "Developer ID Application" certificate

This is a DIFFERENT cert type than the iOS/App-Store ones. It's the only cert
Apple accepts for apps distributed OUTSIDE the App Store. Easiest via Xcode:

- Xcode → Settings → Accounts → (your Apple ID) → Manage Certificates…
- Click **+** → **Developer ID Application** → Done.

That installs the cert + its private key into your login keychain. Verify:

```
security find-identity -v -p codesigning | grep "Developer ID Application"
```

You should see one line with the team id `FSQ3HS4Z24`.

### 3. App-specific password for notarization

- Go to https://appleid.apple.com → Sign-In & Security → App-Specific Passwords
- Generate one (label it "manta notarize"). Copy the value.

### 4. Export the notarization env (per shell, or add to a local, GITIGNORED file)

```
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="FSQ3HS4Z24"
```

electron-builder reads these automatically and staples the notarization ticket
into the `.dmg`. (`electron-builder.yml` already sets `mac.identity: "Developer
ID Application"` + `mac.notarize.teamId`.) The signing cert comes from the
keychain — no `CSC_LINK` needed if step 2's cert is present.

## Build + publish (each release)

```
git pull
npm ci
bash scripts/release/desktop.sh --mac-only
```

This runs `npm run build` then `electron-builder --mac --publish never`,
producing signed + notarized DMGs (x64 + arm64) plus `latest-mac.yml` in
`dist/desktop/`. Notarization adds ~2-5 min (Apple's server round-trip).

Then publish to the prod box:

```
bash scripts/release/publish.sh
```

It scp's the DMGs + `latest-mac.yml` to `mantaui.com/updates/` (auto-update
feed) and `mantaui.com/downloads/` (human download), refreshing
`Manta-latest.dmg`. Testers download from the website; existing installs
auto-update via electron-updater polling `https://mantaui.com/updates/latest-mac.yml`.

## Verify a build is really notarized

```
spctl -a -vvv -t install "dist/desktop/Manta UI-<version>-arm64.dmg"
# → "accepted, source=Notarized Developer ID"
xcrun stapler validate "dist/desktop/Manta UI-<version>-arm64.dmg"
# → "The validate action worked!"
```

## Tester experience

- Download `Manta-latest.dmg` from `mantaui.com`, open it, drag Manta UI to
  Applications, launch. No "damaged/unidentified developer" warning.
- Pairing: same 6-digit code / QR flow as mobile (Settings → Connection →
  Generate Pairing Code on another paired device, or `bui pair` on the box).

## If you skip notarization (NOT recommended for beta)

An unsigned or signed-but-not-notarized DMG triggers Gatekeeper: testers must
right-click → Open the first time, or run `xattr -cr /Applications/Manta\ UI.app`.
Auto-update also gets unreliable. Only acceptable for a couple of technical
testers.
