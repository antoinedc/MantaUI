# macOS beta distribution (outside the App Store)

Ship the desktop app as a **Developer ID-signed DMG** hosted on `mantaui.com`,
with electron-updater auto-updates. No App Store review.

Bundle id: **`com.antoinedc.mantaui`** (aligned with iOS; `electron-builder.yml`
`appId` + `app.setAppUserModelId`).

## Notarization: OFF for the beta

`electron-builder.yml` has `mac.notarize: false`. The DMG is still
**Developer ID-signed**, but not notarized — this skips Apple's notarization
round-trip, which was adding 20-40 min of unpredictable queue latency per build.

**Tester first-launch (one time per machine):** a signed-but-not-notarized app
triggers a milder Gatekeeper prompt. Give testers this note:

> 1. Open the DMG, drag **Manta UI** to Applications.
> 2. In Applications, **right-click Manta UI → Open**, then click **Open** in
>    the dialog. (Double-clicking the first time is blocked; right-click → Open
>    is the override.)
> 3. It launches normally from then on.
>
> If macOS still refuses, run once in Terminal:
> `xattr -dr com.apple.quarantine "/Applications/Manta UI.app"`

**To re-enable notarization for public distribution:** set `mac.notarize: true`
in `electron-builder.yml` and make sure `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
and `APPLE_TEAM_ID` are in the Codemagic `mantaui` env group. Then testers get a
frictionless double-click with no warning.

**Two ways to build.** Recommended: **Codemagic** (macOS runner, fully
automated on a `mac-v*` tag — see below). Alternative: **locally on your Mac**
(`codesign` + `notarytool` need macOS; the Linux box can't sign — see "Local
build" at the bottom).

## Codemagic build (recommended)

The `mac-desktop` workflow in `codemagic.yaml` builds + signs + notarizes the
DMG on a Codemagic M2 runner and publishes it to `mantaui.com`.

### One-time setup

1. **Create a "Developer ID Application" certificate** on any Mac (this cert
   type is required for distribution OUTSIDE the App Store, and Apple restricts
   creating it via API — so make it once in Xcode):
   - Xcode → Settings → Accounts → (Apple ID) → Manage Certificates… → **+** →
     **Developer ID Application**.
   - In **Keychain Access**, find "Developer ID Application: … (FSQ3HS4Z24)",
     right-click → **Export** → save a `.p12` with a password.

2. **App-specific password** for notarization: https://appleid.apple.com →
   Sign-In & Security → App-Specific Passwords → generate one.

3. **Codemagic UI → the app → Environment variables**, add ONE group named
   exactly **`mantaui`** (the group name must match `codemagic.yaml`), all vars
   marked *Secure*:

   | var | value |
   |---|---|
   | `CSC_LINK` | the `.p12`, base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
   | `CSC_KEY_PASSWORD` | the `.p12` password |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
   | `APPLE_TEAM_ID` | `FSQ3HS4Z24` |
   | `PROD_SSH_KEY` | *(optional)* base64 SSH private key for `root@91.107.196.2` — only if you want Codemagic to publish to the box; otherwise download the DMG from Codemagic artifacts |

### Trigger a build

```
git tag mac-v<version> && git push origin mac-v<version>
```

(or run the `mac-desktop` workflow from the Codemagic UI). It produces
`dist/desktop/*.dmg` + `latest-mac.yml`, verifies notarization, and — if
`PROD_SSH_KEY` is set — scp's them to `mantaui.com/updates` + `/downloads` and
refreshes `Manta-latest.dmg`. If not set, grab the DMG from Codemagic artifacts.

---

## Local build (alternative — needs a Mac)

Everything below runs on your Mac (`codesign`/`notarytool`/`.dmg` need macOS).

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
