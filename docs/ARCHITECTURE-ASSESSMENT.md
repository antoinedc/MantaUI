# MANTA Architecture Assessment & Productization Plan

## Executive Summary

MANTA is **~7700 LoC in ChatPanel.tsx alone**, with a monolithic but functional architecture. The codebase has **accumulated significant technical debt** in network/connectivity handling (evident from git history), but a full rewrite is **not the right move** for productization. Instead: **refactor the network layer, stabilize the existing architecture, then build the mobile app on top.**

## Current Architecture: Honest Assessment

### What's Working

1. **ChatPanel.tsx (7673 LoC)** — monolithic but coherent. All the hard UX problems (pin-to-bottom v4, streaming flush, queued-drain, subagent rendering) are solved. This is your moat.
2. **Server modules (`src/server/`)** — pure, testable, well-structured. Each module has a clear responsibility.
3. **Desktop main (`src/main/`)** — functional, though `index.ts` (1533 LoC) and `opencode.ts` (1705 LoC) are getting large.
4. **Mobile (Capacitor)** — works, but is a PWA wrapped in native shells. Not App Store-ready.

### What's Broken / Needs Fixing

1. **Network layer is fragile** — git history shows repeated fixes for:
   - SSE stall detection (`fix(sse): stop false-positive stall on <global> stream`)
   - SSH forward self-heal (`fix(opencode): self-heal SSH forward against orphaned ControlMaster`)
   - WebSocket reconnect (`fix(mobile): never permanently abandon WS reconnect`)
   - Backend flood (`fix(opencode): only stream open sessions, not every workspace dir`)
   - Backpressure (`perf(opencode): land forwardFetch backpressure + raise cap 6→16`)

2. **ChatPanel.tsx is too large** — 7673 LoC, monolithic. Hard to test, hard to extend, hard to port to mobile.

3. **No auth** — `0.0.0.0:8787` open to internet. Cannot ship commercially.

4. **Mobile is PWA, not native** — requires manual `localStorage['manta_server']` config. Not App Store-ready.

5. **No auto-update** — README says "pull from git for new versions."

### Architecture Verdict: **Refactor, Don't Rewrite**

A full rewrite would:
- Take 3-6 months of dev time
- Break all the hard-won UX (pin-to-bottom, streaming flush, queued-drain)
- Introduce new bugs in a new codebase
- Delay productization by 6+ months

**Instead**: stabilize the network layer, extract ChatPanel into smaller components, add auth, then build mobile on top.

## Network/Connectivity Issues: Root Cause Analysis

### Problem

The codebase has **repeated connectivity fixes** because:
1. **SSH ControlMaster is fragile** — orphaned sockets, port forwarding failures
2. **SSE/WebSocket reconnect is ad-hoc** — no unified reconnect strategy
3. **No backpressure** — opencode can flood the renderer with events
4. **No connection pooling** — each SSH call opens a new connection

### Fixes Needed (Before Mobile)

1. **Unified connection manager** — one place that handles:
   - SSH ControlMaster lifecycle (create, heal, close)
   - SSE/WebSocket reconnect (with exponential backoff)
   - Connection pooling (reuse connections)
   - Health checks (detect dead connections)

2. **Backpressure** — opencode events should be rate-limited, not streamed raw to renderer

3. **Connection state machine** — explicit states: connecting → connected → stalled → reconnecting → closed

4. **Tests** — mock SSH/SSE/WebSocket, test reconnect logic, test backpressure

### Estimated Effort

- **2-3 weeks** for network layer refactor (M0)
- **1 week** for ChatPanel extraction (M0.5)
- **1 week** for auth gate (M1)

## Mobile Architecture: Capacitor vs React Native

### Current: Capacitor (Hybrid)

**What it is**: WebView wrapper around existing React renderer. Native shells (iOS/Android) load `mobile/www/` (Vite-built React app).

**Pros**:
- Reuses existing React code (ChatPanel, Terminal, etc.)
- Fast to build (no new framework to learn)
- Single codebase for desktop + mobile

**Cons**:
- Not "native" — WebView performance limits
- App Store review risk (Guideline 4.2: "minimum functionality")
- No access to native APIs beyond Capacitor plugins
- Push notifications are Web Push (VAPID), not native APNs/FCM
- Cannot do true background execution

**Verdict**: **Capacitor is fine for v1 mobile**, but you'll hit limits:
- App Store review (need to justify "why not native?")
- Push notification reliability (Web Push vs APNs)
- Performance for long sessions (WebView memory leaks)

### Alternative: React Native

**What it is**: Native UI components, JavaScript bridge to native code.

**Pros**:
- True native UI (better App Store review odds)
- Native push (APNs/FCM)
- Better performance
- Access to all native APIs

**Cons**:
- **Complete rewrite of ChatPanel.tsx** (7673 LoC → new React Native components)
- 3-6 months of dev time
- Two codebases to maintain (desktop + mobile)
- No code reuse from existing React renderer

**Verdict**: **React Native is NOT worth it for v1**. The rewrite effort is too high, and you'd lose all the hard-won UX. Capacitor is the right choice for v1.

### Recommendation: **Capacitor for v1, React Native for v2**

- **v1 (6 months)**: Capacitor hybrid app. Ship fast, validate demand.
- **v2 (12+ months)**: If mobile is a significant revenue driver, rewrite in React Native. By then, you'll have:
  - Proven business model
  - Revenue to fund rewrite
  - Clear understanding of what native features matter

## Productization Plan: 6-Month Roadmap

### Phase 0: Stabilize (Month 1-2)

**Goal**: Fix network layer, extract ChatPanel, add auth. No new features.

**M0: Network Layer Refactor**
- Unified connection manager (SSH, SSE, WebSocket)
- Connection state machine (connecting → connected → stalled → reconnecting → closed)
- Backpressure (rate-limit opencode events)
- Connection pooling (reuse SSH ControlMaster)
- Health checks (detect dead connections)
- Tests (mock SSH/SSE/WebSocket, test reconnect logic)

**M0.5: ChatPanel Extraction**
- Split ChatPanel.tsx (7673 LoC) into smaller components:
  - `Transcript.tsx` (message list, pin-to-bottom)
  - `Composer.tsx` (input, attachments, voice)
  - `PermissionCard.tsx`, `QuestionCard.tsx` (cards)
  - `RunningIndicator.tsx` (status)
  - `ContextBar.tsx` (context usage)
- Extract `chatUtils.ts` (pure logic) — already partially done
- Tests for each component

**M1: Auth Gate**
- Single-box token auth on `src/server/`
- `/auth/pair`, `/auth/claim` endpoints
- Desktop "Pair device" UI
- Mobile QR pairing (M3)

**Deliverable**: Stable network layer, extracted ChatPanel, auth gate. No user-facing features yet.

### Phase 1: Mobile MVP (Month 3-4)

**Goal**: Ship mobile app that pairs with box, shows preview, gates streaming behind IAP.

**M2: Relay MVP**
- Outbound tunnel coordinator (box dials out)
- Account↔box routing (box_id → tunnel endpoint)
- Operated native push (APNs/FCM)
- IAP receipt validation (Apple Server Notifications v2)
- Metering/rate-limiting per box_id

**M3: Mobile Pairing**
- QR scanner integration (Capacitor barcode scanner)
- Pairing flow (QR + deferred deeplink)
- Auto-connect to box (box_id + pairing token)
- Remove `localStorage['manta_server']` manual config
- Secure storage (Keychain/Keystore) for box_token

**M4: Paywall**
- Free preview (metadata only: project list, session stats)
- Blurred placeholder (NOT CSS-over-real-content)
- Apple IAP integration (receipt validation)
- Server-side endpoint gating (402 pre-sub)

**Deliverable**: Mobile app that pairs with box, shows preview, gates streaming behind IAP.

### Phase 2: Mobile Full Access (Month 5)

**Goal**: Mobile app works fully (streaming, prompts, push, terminal) for paying users.

**M5: Mobile Full Access**
- Live transcript streaming (post-sub)
- Sending prompts (post-sub)
- Push notifications (post-sub, native APNs/FCM)
- Terminal access (post-sub, WebSocket)

**M6: Desktop Upsell**
- "Pair phone" Settings panel (shows QR)
- "Get on mobile" flow (generates deferred deeplink)
- AI choice onboarding wizard (Claude / OpenAI / BYO)
- Auto-update + packaging (.dmg/.AppImage)

**Deliverable**: Full mobile experience for paying users. Desktop has mobile upsell.

### Phase 3: Polish & Ship (Month 6)

**Goal**: App Store submission, launch.

**M7: App Store Submission**
- iOS: sign + notarize .ipa, submit to App Store Connect
- Android: sign .aab, submit to Play Console
- App Store review (frame as "mobile capability", not "unlock your data")
- Free trial (7-day, Apple requires this)

**M8: Launch**
- Marketing site (manta.app)
- Documentation (self-hosting guide, mobile setup)
- Support (email, Discord)
- Monitor (crash reports, usage analytics)

**Deliverable**: Live on App Store + Play Store. Revenue starts.

## Risk Mitigation

### Risk 1: Apple App Review Rejection

**Risk**: "blurring user's own data" optics. Guideline 3.1.1.

**Mitigation**:
- Frame as paywalling **mobile capability** (live access, streaming, push), not data
- CTA copy: "stream live · push · from anywhere" (capability, not data)
- Offer 7-day free trial (Apple requires this)
- App Review defense: "we're paywalling mobile capability, not user data"

### Risk 2: Network Instability on Mobile

**Risk**: Mobile networks are flaky (cellular, Wi-Fi switching). Current network layer is fragile.

**Mitigation**:
- M0 network layer refactor (unified connection manager, backpressure, health checks)
- Test on real devices (not just simulator)
- Graceful degradation (show "reconnecting" banner, cache last state)

### Risk 3: Relay Bandwidth Cost

**Risk**: Free-tier preview still costs bandwidth. COGS per subscriber may be high.

**Mitigation**:
- Metadata-only endpoints (cheap: `listProjects`, session stats)
- Never stream transcript pre-sub (server-side gate)
- Rate-limit free tier (100 MB/day)
- Monitor COGS per subscriber, adjust pricing if needed

### Risk 4: Upstream opencode Changes

**Risk**: opencode changes event wire format, product breaks.

**Mitigation**:
- Pin opencode version (don't auto-update)
- Monitor upstream PRs (GitHub notifications)
- Abstract opencode client (`src/main/opencode.ts`, `src/server/opencode.mjs`) — easy to swap

### Risk 5: IAP Receipt Validation

**Risk**: Apple Server Notifications can be flaky, delayed.

**Mitigation**:
- Retry logic (exponential backoff)
- Fallback to manual receipt verification (user pastes receipt)
- Monitor Apple Developer forums for issues

## Success Metrics

### Month 2 (Phase 0 Complete)
- [ ] Network layer refactor done (tests pass)
- [ ] ChatPanel extracted (components testable)
- [ ] Auth gate working (self-hosters can secure box)
- [ ] `npm run typecheck && npm test` passes

### Month 4 (Phase 1 Complete)
- [ ] Mobile app installs from App Store / Play Store
- [ ] User can pair phone to box via QR scan
- [ ] User sees free preview of their projects/sessions
- [ ] User can subscribe via Apple IAP / Play Billing
- [ ] Server-side enforcement: pre-sub endpoints 402, post-sub endpoints work

### Month 6 (Phase 3 Complete)
- [ ] Mobile app live on App Store + Play Store
- [ ] 100+ paying subscribers
- [ ] <5% crash rate
- [ ] <10% churn rate (monthly)
- [ ] COGS per subscriber < $2/mo

## Next Steps

1. **Start M0: Network Layer Refactor** — this is the foundation. Without it, mobile will be unstable.
2. **Start M0.5: ChatPanel Extraction** — parallel with M0. Extract components as you refactor network.
3. **Start M1: Auth Gate** — after M0/M0.5. Cannot ship mobile without auth.
4. **Start M2: Relay MVP** — after M1. Relay is the paid product.
5. **Start M3: Mobile Pairing** — after M2. QR pairing is the user-facing feature.
6. **Start M4: Paywall** — after M3. Paywall is the revenue model.
7. **Start M5: Mobile Full Access** — after M4. Full access is the value prop.
8. **Start M6: Desktop Upsell** — after M5. Upsell is the growth engine.
9. **Start M7: App Store Submission** — after M6. Submission is the launch.
10. **Start M8: Launch** — after M7. Launch is the goal.

## Conclusion

MANTA's architecture is **monolithic but functional**. A full rewrite is **not the right move** for productization. Instead:

1. **Stabilize** the network layer (M0)
2. **Extract** ChatPanel into components (M0.5)
3. **Add** auth (M1)
4. **Build** the relay (M2)
5. **Ship** mobile on Capacitor (M3-M6)
6. **Submit** to App Store (M7)
7. **Launch** (M8)

This is a **6-month plan** to revenue. After that, if mobile is a significant revenue driver, consider React Native rewrite (v2).

**Key insight**: The hard part is not the code — it's the **network stability**, **auth**, and **App Store review**. Fix those first, then build the features.
