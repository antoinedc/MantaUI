# iOS PWA (compact scope) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing `mobile/www/` web bundle installable on iOS as a fullscreen standalone app via Safari "Add to Home Screen" — manifest + apple meta tags + icons only, no service worker, no native wrapper.

**Architecture:** Purely additive static metadata. A `manifest.webmanifest` and two PNG icons are placed in a new Vite `publicDir` (`src/renderer/public/`) so `npm run build:mobile` copies them verbatim into `mobile/www/` (which is wiped each build via `emptyOutDir`). PWA `<link>`/`<meta>` tags are added to the shared `src/renderer/index.html` template so they survive rebuilds. No backend or app-logic changes; the app still reaches the Linux box over the existing cloudflare quick-tunnel via the `window.api` HTTP+SSE shim.

**Tech Stack:** Vite (`electron.vite.config.mobile.ts`), `sips` (macOS built-in, icon resize — zero new dependency), existing `src/server/` static serve + `cloudflared` quick-tunnel.

---

## Key facts (verified, do not re-derive)

- Mobile build: `electron.vite.config.mobile.ts`, `root: src/renderer`, `build.outDir: mobile/www`, `emptyOutDir: true`, `rollupOptions.input: src/renderer/index.html`.
- Vite `root` is `src/renderer/` → default `publicDir` is **`src/renderer/public/`** (does not exist yet). Vite copies `publicDir` contents verbatim to `outDir` on build. This is the ONLY way static PWA assets survive `emptyOutDir: true`.
- `src/renderer/index.html` is **shared by BOTH** the mobile build and the desktop Electron build (`electron.vite.config.ts:27`). PWA tags are inert in Electron but the desktop build MUST be re-verified (hard non-regression invariant).
- CSP meta in `index.html` is `default-src 'self'; ...` — a same-origin `manifest.webmanifest` is allowed by `default-src 'self'`. No CSP change needed; verified in Task 4.
- Icon source: `mobile/assets/icon.png`, 1024×1024 PNG.
- Build command: `npm run build:mobile` (= `vite build --config electron.vite.config.mobile.ts`).
- Desktop build command: `npm run build`.

---

## File Structure

- **Create:** `src/renderer/public/manifest.webmanifest` — PWA manifest (name, display, colors, icon refs, relative `start_url`).
- **Create:** `src/renderer/public/icons/icon-180.png` — apple-touch-icon (iOS home screen), derived from `mobile/assets/icon.png`.
- **Create:** `src/renderer/public/icons/icon-512.png` — manifest icon, derived from `mobile/assets/icon.png`.
- **Modify:** `src/renderer/index.html` — add manifest link + apple-mobile-web-app meta tags + apple-touch-icon link inside `<head>`.

Each file has one responsibility. The manifest declares the installable app; the icons are its visual identity; the HTML tags wire Safari to them. No code files change.

---

### Task 1: Generate iOS PWA icons from the existing source icon

**Files:**
- Create: `src/renderer/public/icons/icon-180.png`
- Create: `src/renderer/public/icons/icon-512.png`
- Source (read-only): `mobile/assets/icon.png` (1024×1024)

- [ ] **Step 1: Create the public/icons directory**

Run:
```bash
mkdir -p src/renderer/public/icons
```
Expected: no output, directory created.

- [ ] **Step 2: Generate the 180×180 apple-touch-icon**

Run:
```bash
sips -z 180 180 mobile/assets/icon.png --out src/renderer/public/icons/icon-180.png
```
Expected: output ending with `.../src/renderer/public/icons/icon-180.png`.

- [ ] **Step 3: Generate the 512×512 manifest icon**

Run:
```bash
sips -z 512 512 mobile/assets/icon.png --out src/renderer/public/icons/icon-512.png
```
Expected: output ending with `.../src/renderer/public/icons/icon-512.png`.

- [ ] **Step 4: Verify both icons exist at the correct dimensions**

Run:
```bash
sips -g pixelWidth -g pixelHeight src/renderer/public/icons/icon-180.png src/renderer/public/icons/icon-512.png
```
Expected: `icon-180.png` reports `pixelWidth: 180` / `pixelHeight: 180`; `icon-512.png` reports `pixelWidth: 512` / `pixelHeight: 512`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/public/icons/icon-180.png src/renderer/public/icons/icon-512.png
git commit -m "feat(pwa): add iOS PWA icons (180, 512) from source icon

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

### Task 2: Create the web app manifest

**Files:**
- Create: `src/renderer/public/manifest.webmanifest`

- [ ] **Step 1: Write the manifest file**

Create `src/renderer/public/manifest.webmanifest` with exactly this content:

```json
{
  "name": "Better UI",
  "short_name": "bui",
  "description": "Remote claude / opencode over tmux",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0e0f12",
  "theme_color": "#0e0f12",
  "start_url": ".",
  "scope": ".",
  "icons": [
    {
      "src": "./icons/icon-180.png",
      "sizes": "180x180",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "./icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}
```

Rationale for choices (do not change without re-reading the spec):
- `start_url` / `scope` are `"."` (relative) so the installed app works under ANY cloudflare tunnel hostname — the URL is ephemeral by design (scope A).
- `#0e0f12` matches the app's dark `bg` (consistent with the mobile shell).
- `512` icon is `any maskable` so Android-style maskable contexts crop cleanly; iOS uses the apple-touch-icon link (Task 3) regardless.

- [ ] **Step 2: Verify the manifest is valid JSON**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('src/renderer/public/manifest.webmanifest','utf8')); console.log('valid json')"
```
Expected: `valid json` (no parse error).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/public/manifest.webmanifest
git commit -m "feat(pwa): add web app manifest (standalone, relative start_url)

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

### Task 3: Inject PWA tags into the shared HTML template

**Files:**
- Modify: `src/renderer/index.html` (inside `<head>`, after the CSP meta line)

The current `<head>` is:
```html
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Better UI</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: http: https:;" />
  </head>
```

- [ ] **Step 1: Add the PWA + apple meta tags**

In `src/renderer/index.html`, replace this exact block:

```html
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: http: https:;" />
  </head>
```

with:

```html
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: http: https:;" />
    <!-- iOS PWA: installable via Safari "Add to Home Screen". Inert on
         desktop Electron (apple-* ignored; manifest link harmlessly 404s
         since Electron loads its own out-dir index.html). -->
    <link rel="manifest" href="./manifest.webmanifest" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="bui" />
    <link rel="apple-touch-icon" href="./icons/icon-180.png" />
  </head>
```

- [ ] **Step 2: Verify the tags are present and well-formed**

Run:
```bash
grep -c 'rel="manifest"\|apple-mobile-web-app-capable\|apple-mobile-web-app-status-bar-style\|apple-mobile-web-app-title\|rel="apple-touch-icon"' src/renderer/index.html
```
Expected: `5`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat(pwa): wire manifest + apple meta tags in shared index.html

Inert on desktop Electron; enables iOS standalone install on mobile.

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

### Task 4: Verify the mobile build emits the PWA assets and tags

**Files:**
- No file changes — verification only. Builds into `mobile/www/` (generated, gitignored output).

- [ ] **Step 1: Run the mobile build**

Run:
```bash
npm run build:mobile
```
Expected: `✓ built in ...` with no errors; output lists `mobile/www/index.html` and the assets chunks.

- [ ] **Step 2: Verify the manifest landed in the build output**

Run:
```bash
test -f mobile/www/manifest.webmanifest && echo "manifest OK" && node -e "JSON.parse(require('fs').readFileSync('mobile/www/manifest.webmanifest','utf8')); console.log('manifest valid json')"
```
Expected: `manifest OK` then `manifest valid json`.

- [ ] **Step 3: Verify the icons landed in the build output at correct sizes**

Run:
```bash
sips -g pixelWidth -g pixelHeight mobile/www/icons/icon-180.png mobile/www/icons/icon-512.png
```
Expected: `icon-180.png` 180×180; `icon-512.png` 512×512.

- [ ] **Step 4: Verify the emitted index.html still contains all 5 PWA tags (build did not strip them)**

Run:
```bash
grep -c 'rel="manifest"\|apple-mobile-web-app-capable\|apple-mobile-web-app-status-bar-style\|apple-mobile-web-app-title\|rel="apple-touch-icon"' mobile/www/index.html
```
Expected: `5`

- [ ] **Step 5: Verify CSP does not block the manifest (same-origin under default-src 'self')**

Run:
```bash
grep -o 'Content-Security-Policy[^>]*' mobile/www/index.html
```
Expected: contains `default-src 'self'`. (Confirms no `manifest-src` restriction exists; same-origin `./manifest.webmanifest` is permitted by `default-src 'self'`. No code change needed — this step is the explicit confirmation called for in the spec.)

- [ ] **Step 6: Commit the rebuilt bundle**

```bash
git add mobile/www
git commit -m "build(pwa): rebuild mobile bundle with PWA manifest + icons + tags

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

---

### Task 5: Verify desktop Electron build non-regression (hard invariant)

**Files:**
- No file changes — verification only. `src/renderer/index.html` is shared with the desktop build; this proves the PWA tags did not break desktop.

- [ ] **Step 1: Run the desktop build**

Run:
```bash
npm run build
```
Expected: all three targets build (`out/main/index.js`, `out/preload/index.mjs`, `out/renderer/...`) with `✓ built` and no errors.

- [ ] **Step 2: Confirm desktop renderer output exists**

Run:
```bash
test -f out/renderer/index.html && echo "desktop renderer built OK"
```
Expected: `desktop renderer built OK`.

- [ ] **Step 3: Confirm no desktop source files changed in this plan**

Run:
```bash
git diff --name-only HEAD~5..HEAD -- src/main src/preload src/renderer/App.tsx src/renderer/ChatPanel.tsx src/renderer/Terminal.tsx
```
Expected: empty output (no desktop source touched — only `src/renderer/index.html` shared template + new `public/` assets). `out/` is gitignored; nothing to commit here.

---

### Task 6: Local browser verification (everything verifiable without an iPhone)

**Files:**
- No file changes — runtime verification only.

- [ ] **Step 1: Serve the built bundle locally**

Run (background):
```bash
(cd mobile/www && python3 -m http.server 8848 >/dev/null 2>&1 &) && sleep 1 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8848/
```
Expected: `200`.

- [ ] **Step 2: Verify the manifest is reachable and served as JSON**

Run:
```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://localhost:8848/manifest.webmanifest
curl -s http://localhost:8848/manifest.webmanifest | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d);console.log('display='+m.display,'start_url='+m.start_url,'icons='+m.icons.length)})"
```
Expected: HTTP `200`; second line prints `display=standalone start_url=. icons=2`.

- [ ] **Step 2b: Verify both icons are reachable**

Run:
```bash
curl -s -o /dev/null -w "icon-180 %{http_code}\n" http://localhost:8848/icons/icon-180.png
curl -s -o /dev/null -w "icon-512 %{http_code}\n" http://localhost:8848/icons/icon-512.png
```
Expected: `icon-180 200` and `icon-512 200`.

- [ ] **Step 3: Verify manifest + apple tags resolve in a real (headless) browser with no console/CSP error**

Use the Playwright MCP browser:
1. `browser_navigate` to `http://localhost:8848/`
2. `browser_evaluate` with this function:

```js
() => {
  const man = document.querySelector('link[rel="manifest"]');
  const apple = document.querySelector('meta[name="apple-mobile-web-app-capable"]');
  const touch = document.querySelector('link[rel="apple-touch-icon"]');
  return {
    manifestHref: man && man.href,
    appleCapable: apple && apple.content,
    touchIcon: touch && touch.href,
  };
}
```
Expected: `manifestHref` ends `/manifest.webmanifest`, `appleCapable` is `"yes"`, `touchIcon` ends `/icons/icon-180.png`.

3. Call `browser_console_messages` and confirm there is **no** CSP violation or manifest fetch error referencing `manifest.webmanifest`.

- [ ] **Step 4: Stop the local server and clean up**

Run:
```bash
pkill -f "http.server 8848" 2>/dev/null; rm -rf .playwright-mcp 2>/dev/null; echo cleaned
```
Expected: `cleaned`. Confirm `git status --short` shows no stray test artifacts (no `.png`, no `.playwright-mcp`).

---

### Task 7: Produce the on-device iOS install checklist (manual, cannot be automated here)

**Files:**
- No code change. This task delivers the final hand-off so the user can do the one step that genuinely requires an iPhone.

- [ ] **Step 1: Write the on-device checklist into the spec's verification section**

Append the following to `docs/superpowers/specs/2026-05-17-ios-pwa-compact-design.md` under a new `## On-device install checklist (manual)` heading:

```markdown
## On-device install checklist (manual)

Performed once by a human with an iPhone — cannot be automated from the dev box.

1. On the Linux box:
   `BUI_MOBILE_HOST=127.0.0.1 npm run mobile`
   then in another shell:
   `cloudflared tunnel --url http://127.0.0.1:8787 --protocol http2`
   Note the printed `https://<random>.trycloudflare.com` URL.
2. On the iPhone, open that HTTPS URL in **Safari** (not Chrome — only
   Safari can install PWAs on iOS).
3. Confirm the bui session list renders over the tunnel.
4. Share button → **Add to Home Screen**. Confirm the icon preview is the
   bui icon and the title shows **bui**.
5. Tap Add. Launch the new home-screen icon.
6. Verify: launches **fullscreen / standalone** (no Safari address bar or
   toolbar); the bui mobile shell renders; the top header is NOT clipped
   under the iOS status bar / notch (safe-area inset working).
7. Verify chat + terminal work over the tunnel from the installed app.

If step 6 shows the header clipped under the status bar: that is a
`.mobile`-scoped safe-area CSS fix in `src/renderer/mobile/mobile.css`
(same pattern as the prior mobile work) — NOT a manifest change. File as
a follow-up; it is explicitly a known edge case in this design.
```

- [ ] **Step 2: Commit the checklist**

```bash
git add docs/superpowers/specs/2026-05-17-ios-pwa-compact-design.md
git commit -m "docs(pwa): add manual on-device iOS install checklist

Co-Authored-By: WOZCODE <contact@withwoz.com>"
```

- [ ] **Step 3: Final summary to the user**

Report: what shipped (manifest + icons + tags + rebuilt bundle), local verification results (manifest/icons reachable, tags present, no CSP error, desktop build still green), and that the ONLY remaining step is the manual on-device checklist now in the spec (requires an iPhone + a cloudflare tunnel session — cannot be done from the dev box). Do not claim "iOS install verified" — claim "everything dev-box-verifiable is verified; on-device install is a documented manual step."

---

## Notes for the executor

- **Do not add `vite-plugin-pwa` or any dependency.** Scope A is static files only; the spec explicitly rejected the plugin.
- **Do not add a service worker.** Out of scope; no offline.
- **Do not touch** Android (`mobile/android/`), iOS Capacitor scaffold (`mobile/ios/`), `src/server/`, or any desktop renderer source. Only the shared `index.html` template + new `src/renderer/public/` assets + regenerated `mobile/www/` output.
- The `mobile/www/` rebuild is a committed artifact in this repo (consistent with prior mobile commits like `b6e5ec9`, `60f1110`).
- After all tasks: per project convention, mobile bundle changes go to `main` (trunk-based, per `.multica/workspace-context.md`). Pushing is the user's call — ask, don't auto-push.
