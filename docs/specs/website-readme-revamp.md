# Spec — Website + README revamp (SEO/GEO, screenshots, features, open source)

Status: **SPEC ONLY — nothing implemented.** Research date 2026-07-26.

Covers: positioning, homepage IA, SEO/GEO plan, competitor comparison pages,
screenshot shot list, README rewrite. Sources: DataForSEO (Google Ads,
US/en), full-site crawls of onorca.dev and conductor.build.

---

## 0. Blockers — fix before any of this ships

These invalidate claims we already make. Ordered by severity.

| # | Issue | Evidence | Fix |
|---|---|---|---|
| **B1** | **No LICENSE file.** Repo is public but GitHub reports `licenseInfo: null` → legally "all rights reserved". The homepage says "Free & **open source**" and the CTA band says "Open source." Both are currently unbacked. | `gh repo view` | Add `LICENSE` (recommend **MIT** — matches Orca, removes any adoption friction). Until this lands, every "open source" claim is a liability, and the whole §5 open-source strategy is unbuildable. |
| **B2** | **0 stars, 0 forks.** Orca has 29.6k in ~4 months. | `gh repo view` | Not fixable by decree, but it means: do **not** put a star-count badge on the site (Orca does; for us it's negative proof). Revisit once >500. |
| **B3** | **Stale repo description**: "Desktop client for remote Claude Code sessions". Undersells — it's a server + desktop + mobile + agent-tools platform. The GitHub description is a real ranking/answer surface. | `gh repo view` | Rewrite (see §7.1). |
| **B4** | Homepage says "macOS build is **signed**"; README says "The macOS build is **unsigned** — first launch will be blocked by Gatekeeper". One is wrong. | `website/index.html:282` vs `README.md:181` | Establish truth, then align. (`AGENTS.md` says Developer ID-signed but **not notarized**, so "signed, not notarized, right-click → Open" is likely correct and the README is stale.) |
| **B5** | Homepage step 01 says "It reaches the internet over a **named tunnel**." That's the maintainer box's legacy setup. Current architecture is Caddy + Let's Encrypt on `<box_id>.boxes.mantaui.com` — **no tunnel**. This is our single biggest differentiator and the copy describes the thing we replaced. | `website/index.html:382` vs `README.md:60-65` | Rewrite (see §3, Section 4). |

---

## 1. Competitive landscape

### 1.1 The competitors

**Three, not two.** Alongside Orca and Conductor, the most common thing our
buyer already does is **run Claude Code on a VPS and reach it with Termius
over SSH**. That is the incumbent to beat, and it is the strongest one:
it already keeps the agent alive when you walk away, which is the hard part.
It must appear in the comparison table and get its own `/vs/` page.

What Termius + SSH does not give you, and what the whole pitch against it
rests on:

- A readable transcript. You get the agent's terminal UI on a phone keyboard.
- A way to approve a command that is not typing into a TUI.
- Any notification when the agent stops and waits for you. You go and look.
- File upload, dictation, or anything the agent can initiate on its own.

Do not dismiss it. Say plainly that it solves the important part, and that
Manta runs on the same box beside it.

### 1.2 Orca and Conductor

| | **Orca** (onorca.dev) | **Conductor** (conductor.build) | **MantaUI** |
|---|---|---|---|
| Company | Stably Inc, YC | Melty Labs, YC S24, $24M raised | solo |
| H1 | "Ship 100x With The Agent IDE" | "Run parallel coding agents on your Mac." | — |
| Category word | "ADE" (Agent Development Environment) | "AI orchestrator" | — |
| License | **MIT, 29.6k ★** | **Proprietary, closed** | *(none yet — B1)* |
| Platforms | macOS, Win, Linux desktop | **macOS only** | Linux/macOS box + macOS desktop + iPhone app + browser |
| Architecture | **Desktop is source of truth** | **Desktop is source of truth** | **Server (the box) is source of truth** |
| Remote access | SSH targets, or "Remote Orca Server" — **requires Tailscale**, **"no cloud relay"**, **closing desktop drops the phone** | Conductor Cloud — **beta, Pro-gated, GitHub-only, 10-workspace cap** | **Auto-detected ingress (BET-267)**: tailnet if Tailscale is up, otherwise Caddy + LE on a per-box hostname. Box runs with zero clients connected |
| Mobile | "**read-mostly view**", "**intentionally not a full editor**", "a remote control for the desktop you already have running" | None shipped | **Same React client as desktop**, full parity. iPhone app; browser elsewhere |
| Permissions | **`--dangerously-skip-permissions` / `--yolo` pre-filled by default** for every agent | "Agents run directly on your system **without sandboxing**" | Explicit permission + question cards; `chatAutoAllow` is opt-in |
| Pricing page | **none** | **none** (`/pricing` → 404) | none |
| Comparison pages | **none** (targets "Cursor alternative"/"Conductor alternative" in `<meta keywords>` + JSON-LD FAQ only) | **none** | none |
| GEO/AEO | FAQPage JSON-LD ×10. **Blocks Ahrefs/Semrush.** No llms.txt | **Heavy**: llms.txt, llms-full.txt (318KB), `.md` twin per URL, `/.well-known/agent-skills/`, `Content-Signal: ai-train=yes` | `llms-install.md` only |

### 1.3 The three open flanks

1. **Nobody has comparison pages. Nobody has a pricing page.** Both YC-funded competitors left "Conductor alternative", "Orca alternative", "conductor pricing", "is conductor free" completely uncontested. Orca additionally blocks Ahrefs/Semrush, so they are partly blind to anything we build against them.
2. **Both are desktop-first; both admit their remote story is the weak part** — in their own docs, quotably. Orca: *"Closing the desktop app drops the connection — there is no cloud relay."* Conductor: cloud is beta + Pro + capped.
3. **Neither ships agent-facing tooling.** Schedules, webhooks, notify-with-routing, secrets-by-reference, peer messaging — the agent extending its own capabilities is a category nobody else is marketing.

### 1.4 What we must NOT claim

Orca genuinely beats us on: agent count (34 vs ~2), embedded browser/Design Mode, Monaco editor, diff annotation, cross-platform desktop, 29.6k stars. Conductor beats us on: diff review + PR/merge tail, Linear/GitHub integration, polish, funding.

**Do not fight on IDE surface** (editor, embedded browser, diff annotation, agent count). We lose those. Fight on *where the agent runs and who can reach it*. Worktrees are now **parity**, not a loss — see §2.6.

---

## 2. Positioning

### 2.1 The wedge

Both competitors sell **a better window onto agents running on your laptop**.
We sell **agents that don't live on your laptop at all**.

> Conductor's own pitch for Cloud — *"close your laptop during a task and the
> agent keeps going"* — is the default, free, day-one behaviour of MantaUI.
> They charge for it and it's in beta. That is the entire argument.

### 2.2 Recommended H1 options

Current H1 — "Drive Claude Code from anywhere" — is fine but generic, and
"from anywhere" is the weakest half (Orca and Conductor both claim remote).
The stronger claim is the *persistence*, not the *reach*.

| Option | Copy | Note |
|---|---|---|
| **A (recommended)** | **"Your coding agents keep running. With or without you."** <br> sub: "Manta runs Claude Code and opencode on your own Linux box or Mac — in real tmux. Close the laptop, the work continues. Steer it from your desk or your phone, same session, same state." | Leads with persistence (the true differentiator), covers remote + mobile + own-hardware in the sub. |
| B | "Claude Code, on your box, in your pocket." | Punchier, keyword-dense ("claude code" + mobile), less differentiated. |
| C | "The server is the box." | Too insider. Good as a section header, not an H1. |

Keep the H1 to ONE claim. Put "open source", "self-hosted", "free" in the
badge row under the CTA, not in the H1.

### 2.3 Four pillars (these become the homepage sections and the README feature list)

1. **It runs without you.** Real tmux on your box. Close every client — desktop, phone, browser — the agent keeps going. Reopen, re-attach, full scrollback. *(vs Orca: closing desktop drops the phone. vs Conductor: that's the paid beta.)*
2. **The phone app is the same app.** Same code as the desktop: full transcript, live tool output, approvals, voice, file upload. A native iPhone app, and any browser everywhere else. *(Orca calls its mobile app "read-mostly" and "intentionally not a full editor". Conductor has no phone app.)*
3. **It works out how to reach you.** The installer probes `tailscale status`; if Tailscale is already running it uses the tailnet and skips Caddy, public DNS and Let's Encrypt entirely. If not, it provisions a per-box hostname and certificate. The decision is persisted to `~/.manta/ingress.json` and can be forced with `MANTA_INGRESS=public|tailscale`. *(Orca **requires** Tailscale and warns "Do not forward the Orca port directly to the public internet." For us a tailnet is one of two supported paths, not a prerequisite.)*
4. **The agent can act between turns.** Schedule itself, be woken by a webhook, notify you on the right device, use secrets by reference, message sibling sessions. *(Nobody else markets this.)*

Supporting, not a pillar: approvals-by-default (contrast Orca's yolo default),
open source, free, your hardware.

---

## 2.4 Copy rules (applies to the site, the README, and every page below)

House style follows [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).
Copy that reads as machine-generated undermines a developer-tool pitch faster
than a weak claim does. Banned outright:

| Pattern | Example to avoid | Write instead |
|---|---|---|
| **Negative parallelism** — "not X, but Y" / "not just X, but also Y" | "Not a status dashboard. The actual client." | "Reading a terminal UI on a phone keyboard is miserable. This is the actual client." |
| **Em-dash overuse** as a general-purpose connector | "Same code as desktop — full transcript, live output — and approvals" | Full stops, commas or colons. Em dashes only inside a direct quotation. |
| **Trailing "-ing" clauses** tacked onto a sentence to add significance | "…runs on your box, enabling you to work from anywhere" | Cut the clause, or make it its own sentence. |
| **Rule of three** — triads of adjectives or phrases | "Fast, secure, and reliable" | Two items, or four. Or just the one that is true. |
| **Puffery** | boasts, vibrant, rich, seamless, robust, powerful, groundbreaking, cutting-edge, effortless | A specific fact instead. |
| **Significance language** | "stands as", "serves as", "plays a crucial role", "underscores the importance of" | Delete. Say the thing itself. |
| **Emoji as formatting** | Emoji as list bullets or card icons | Monochrome line SVG icons, matching the existing icon set. |
| **Heavy boldface** mid-paragraph | Bold scattered through body copy | At most one bold phrase per block. |
| **Title Case headings** | "Run Your Agents From Anywhere" | Sentence case. |
| **Vague attribution** | "developers widely agree", "many teams find" | Name the source, quote it, link it, date it. |

Two things to check on every draft: read it aloud, and count the em dashes. If
a sentence only exists to tell the reader that the previous sentence mattered,
delete it.

## 2.5 Terminology and claim limits

**Android does not exist yet.** There is a Capacitor scaffold, but nothing
shipped. Never imply an Android app on the site, in the README, or in schema
markup. The honest line is **"a native iPhone app, and any browser everywhere
else"** — which is true, covers Android users, and does not promise a store
listing we cannot deliver. Consequences:

- Drop `claude code android` (170/mo) from the target keyword set until it ships.
- `SoftwareApplication` JSON-LD `operatingSystem` lists Linux, macOS, iOS and
  Web. Not Android.
- Do not point out that Orca's Android build is a sideloaded APK. It invites
  the obvious reply.

**Do not say PWA.**

It is deprecated as a user-facing term and it makes the
mobile client sound like a fallback. Say **"the phone app"**, or
**"a native iPhone app, and any browser everywhere else"**. The installable-from-browser route
still exists and can be documented, but it is never the headline description
of the mobile client.

Also fix on sight: "app for iOS" → "iPhone app"; any phrasing that implies
the phone client is a companion, viewer, or remote. It is a client.

---

## 2.6 Verified capabilities (checked against git, 2026-07-26)

Two claims in the first draft of this spec were wrong because they predated
shipped work. Both are now confirmed from the repo, not from memory.

**Worktree per session — SHIPPED (BET-246, `11054b0`).** `worktreePerSession`
creates a sibling git worktree on its own branch for each new chat session in
a git repo. `worktreeCleanOnClose` removes it (and best-effort the branch) on
session close, prompting before discarding uncommitted work; tracked per window
via the `@manta-worktree-path` tmux option so it never touches a pre-existing
worktree or the main checkout. Global setting plus a per-session override in
the new-session dialog. Separate and older: the project-create dialog detects
an existing multi-worktree repo and offers one session per worktree.

→ The comparison table says **Yes**. Frame it as **parity** with Orca and
Conductor, never as a differentiator, since both market it harder than we do.

**Auto-detected ingress — SHIPPED (BET-267, `8a0f123`).** `MANTA_INGRESS`
defaults to `auto`. The installer runs `tailscale status --json`; if
`BackendState` is `Running` with an IPv4 it selects tailnet mode and skips
Caddy, public DNS and Let's Encrypt entirely, with devices connecting to
`http://<tailnet-ip>:8787`. Otherwise it selects public mode: Caddy plus a
Let's Encrypt certificate on `<box_id>.boxes.mantaui.com`. The decision is
persisted to `~/.manta/ingress.json` and drives the pairing output. Forceable
with `MANTA_INGRESS=public|tailscale`. macOS boxes always skip public TLS.

→ **Retire the "no VPN needed" line.** It is now both inaccurate and a weaker
claim than the truth. The claim is *"it works out how to reach you"*: a tailnet
if you already run one, a public hostname if you do not, decided for you. This
also sharpens the Orca contrast — they **require** Tailscale, we **support** it.

**Standing rule:** before writing a capability claim, check `git log --grep`
for the feature and read the setting's own description. This spec was drafted
partly from `AGENTS.md`, which lagged both features.

---

## 3. Homepage IA

Target: `website/index.html`. Current page is 465 lines, one section per pillar
already — the bones are OK. The rework is **copy + real screenshots + new
sections + schema**, not a rebuild.

| # | Section | Change | Notes |
|---|---|---|---|
| 1 | Nav | **Add** Docs, Pricing, Compare (dropdown → /vs/conductor, /vs/orca), Changelog. Keep GitHub. | Both competitors have Docs+Changelog in nav; we have neither. Nav links are the main internal-linking surface. |
| 2 | Hero | New H1/sub (§2.2). Keep the dual install tab (agent-prompt / curl) — **this is genuinely better than both competitors' download-only CTA** and should stay above the fold. **No badge/chip row** — it fragments the eye between the headline and the install box, which is the one thing on the page that has to be seen. The same claims are carried by the meta line, the open-source band and the comparison table. |
| 3 | Hero visual | **Replace the hand-built HTML mockup with a real screenshot** (shot A, §6). Orca uses a fake mockup, Conductor uses one real screenshot — the real one reads as more credible for a solo/OSS project where "does this actually exist" is the objection. | Keep the HTML mockup as the mobile-breakpoint fallback if the screenshot doesn't scale down. |
| 4 | **NEW — "Close the laptop" band** | The single most differentiating claim, given its own band right under the hero. Desktop + phone showing the *same session* side by side (shot M). Copy: box keeps running, clients are disposable. | This is the section that beats both competitors. It doesn't exist today. |
| 5 | Features grid | Keep 6-card grid, **rewrite to the 4 pillars + 2**. Add real screenshots/GIFs per card or link each to an anchor. Current cards are decent but flat — "Approvals, not surprises" should explicitly contrast with yolo-by-default. | See §4 for per-card copy direction. |
| 6 | **NEW — Agent-native tools** | Schedule / webhook / notify / secrets / peers / serve-page. Nobody else has this. Six small cards or a two-column list. | Feeds the "AI tools" long-tail and the GEO answer set. |
| 7 | How it works | **Fix B5** (no tunnel). Three steps: install on box → pair with 6-digit code → open desktop or phone. Add the architecture diagram (the README's ASCII one, redrawn as SVG). | Architecture diagram is a trust asset for a self-hosted product. |
| 8 | Mobile section | Keep. Add **real** phone screenshots (shots C, D) replacing the CSS phone. Add the push-notification shot — it's the proof that "your phone is a real client". | |
| 9 | **NEW — Comparison table** | Four columns: Manta / Orca / Conductor / **Termius + SSH**. Named honestly; both competitors refuse to name anyone, so naming them differentiates *and* wins the comparison SERP. Include the rows we lose. | See §5.3 and the design constraint below. Links to the three /vs/ pages. |
| 10 | **NEW — Open source band** | See §7. | |
| 11 | **NEW — FAQ** | 8–10 Q&As, marked up as `FAQPage` JSON-LD. This is the primary GEO asset. | See §5.4. |
| 12 | CTA band | Keep. Add "Free forever, no account, no signup" — neither competitor can say "no account" (Orca requires an Orca account for mobile pairing). | |
| 13 | Footer | Expand to 4 columns (Product / Compare / Resources / Legal) to carry internal links. | |

---

## 4. Feature story — what to show and say

Derived from what actually ships (per `AGENTS.md`), ordered by differentiating power.

| Feature | Why it earns homepage space | Competitor contrast |
|---|---|---|
| Persistent tmux sessions on your box | Pillar 1 | Orca/Conductor both die with the desktop app |
| Phone app with full desktop parity (iPhone; browser elsewhere) | Pillar 2 | Orca "read-mostly"; Conductor none |
| Native push with **smart routing** — active on desktop ⇒ no phone buzz; idle ⇒ desktop first, escalate to phone after 90s; blocking asks (permission/question/error) hit every device immediately | Genuinely novel. Slack/Discord-grade presence logic in a dev tool. | **Neither has any notification routing** |
| Auto-detected ingress: tailnet or per-box HTTPS + LE cert, decided by the installer | Pillar 3 | Orca *requires* Tailscale and warns you off public exposure. We support both and choose for you |
| Permission + question cards | Trust | Orca ships `--yolo` pre-filled; Conductor "no sandboxing" |
| Git worktree per session (BET-246) — new sessions in a repo branch their own sibling worktree; optional clean-on-close, prompts if dirty | Parity with the thing Orca and Conductor market hardest | Orca and Conductor both have it. Claim parity, not advantage |
| Live tool output (bash stdout tailing at ~4Hz), diffs, per-turn token/context bar with cache breakdown | Depth proof | Comparable, but our cache-cost surfacing (stale-cache "/clear to save Nk tokens" pill) is unique |
| Terminal **and** chat per window, switchable, real tmux underneath | We're not a wrapper that hides the terminal | Orca has a great terminal but no chat panel; Conductor chat-only + terminal |
| Inline subagent rendering | Parity | Orca has deeper orchestration — don't over-claim |
| Agent-native tools (schedule/webhook/notify/secrets/peers/serve-page) | Pillar 4, wholly uncontested | Orca has a CLI; nobody has scheduling/webhooks/secrets-by-reference |
| Secrets by reference — value never enters the transcript | Security story with a concrete mechanism | Nobody |
| Voice push-to-talk (dictate + command mode) | Mobile-credibility | Orca has mobile dictation; Conductor none |
| Drag-drop upload, screenshot auto-detect, agent→you outbox | Polish | Orca has file drag; nobody has the reverse channel |
| Model picker + per-session persistence + global default | Parity | |
| `llms-install.md` — install by pasting a prompt into any agent | **Unique.** The install flow is itself agent-native. | Both are DMG downloads |

**Deliberately omitted from marketing** (we lose or it's immature): embedded
browser, Monaco editor, diff annotation, 34-agent support, Linear/Jira,
Windows/Linux desktop.

---

## 5. SEO / GEO plan

### 5.1 Keyword data (DataForSEO, Google Ads, US, en, 2026-07-26)

**Core cluster — all winnable, all on-positioning:**

| Keyword | Vol/mo | CPC | Comp |
|---|---|---|---|
| claude code web | 4,400 | $5.40 | LOW |
| claude code app | 2,400 | $6.09 | LOW |
| coding on phone | 2,400 | $4.95 | LOW |
| claude code ui | 1,600 | $5.74 | LOW |
| **claude code remote** | **1,300** | **$49.44** | **LOW** |
| claude code alternative | 1,300 | $22.17 | MEDIUM |
| claude code mobile | 1,000 | $8.01 | LOW |
| claude code open source | 1,000 | $4.42 | LOW |
| claude code gui | 720 | $7.03 | LOW |
| claude code worktree | 480 | — | LOW |
| claude code browser | 480 | $6.78 | LOW |
| claude code dashboard | 480 | $5.99 | LOW |
| claude code web ui | 390 | $6.70 | LOW |
| claude code tmux | 390 | — | LOW |
| claude code notifications | 390 | — | LOW |
| claude code monitor | 390 | $12.64 | LOW |
| claude code cloud | 390 | $14.54 | LOW |
| claude code ios | 320 | $7.29 | LOW |
| claude code from phone | 260 | $5.18 | LOW |
| opencode ui | 210 | $7.13 | LOW |
| claude code android | 170 | $8.78 | LOW |
| claude code client | 70 | $6.79 | LOW |
| self hosted claude code | 50 | — | LOW |
| claude code vps | 50 | $9.96 | MEDIUM |
| conductor alternative | 40 | $8.95 | LOW |
| orca alternative | 10 | — | LOW |

**Head terms (context, not targets):** `claude code` 550k, `vibe coding` 110k,
`opencode` 90.5k, `ai coding assistant` 22.2k, `tmux` 22.2k, `ai coding agent`
5.4k, `ai pair programming` 2.9k ($67 CPC), `agentic coding` 2.4k.

**Read:** the addressable "claude code + surface" cluster is ~**16k/mo,
almost all LOW competition**, and `claude code remote` at **$49.44 CPC** tells
you exactly how commercially valuable that intent is. `opencode` at 90.5k is a
large adjacent term we're legitimately relevant to (we ship opencode as the
chat backend) and neither competitor emphasises.

**Competitor-alternative terms are tiny (40 + 10/mo) — build those pages for
intent quality and because they're uncontested, not for volume.**

### 5.2 Page plan

Priority order. Each page = one keyword cluster, one intent.

| Priority | URL | Primary KW (vol) | Also targets |
|---|---|---|---|
| P0 | `/` | claude code remote (1,300) | claude code app, claude code client |
| P0 | `/claude-code-web-ui` | claude code web (4,400) | claude code ui 1,600 · gui 720 · web ui 390 · browser 480 · dashboard 480 → **~8k/mo combined** |
| P0 | `/claude-code-mobile` | claude code mobile (1,000) | coding on phone 2,400 · from phone 260 · ios 320 → **~4k/mo**. NOTE: `claude code android` (170) is NOT targetable until an Android app exists. |
| P1 | `/claude-code-remote` | claude code remote (1,300, $49 CPC) | self hosted claude code, claude code vps, claude code cloud |
| P1 | `/open-source` | claude code open source (1,000) | + carries §7 |
| P1 | `/pricing` | (intent gap) | "is manta free", "conductor pricing", "orca pricing" — **both competitors 404 here** |
| P1 | `/vs/conductor` | conductor alternative (40) | "conductor vs", "conductor alternative mac" |
| P1 | `/vs/orca` | orca alternative (10) | "orca alternative", "onorca alternative" |
| P1 | `/vs/ssh-tmux` | claude code vps (50) | "claude code ssh", "claude code termius", "run claude code on a server", self hosted claude code |
| P2 | `/docs/*` | long tail | Required for credibility. Both competitors' docs carry their entire long-tail. |
| P2 | `/claude-code-notifications` | claude code notifications (390) | claude code monitor 390 |
| P2 | `/claude-code-tmux` | claude code tmux (390) | |
| P2 | `/changelog` | brand | Orca + Conductor both nav-link it; signals liveness |

**Comparison table design constraint.** A 4-column × 17-row table is at the
limit of what is scannable, so the styling has to do no work of its own:

- **Two greys and one tint. No red, amber or green.** Colour-coding every cell
  turns the table into noise and reads as a sales device. Supported reads in
  the primary text colour, unsupported reads in a dim grey, everything else in
  the mid grey. The reader's eye finds the pattern from contrast alone.
- **Every cell fits on one line.** No wrapped sub-captions. Detail belongs on
  the `/vs/` page, not in the cell.
- **The Manta column gets a background tint only**, never coloured text.
- Row-hover highlight, since horizontal tracking across four columns is the
  main failure mode.
- **"Agents run on" says "Your VPS" for Manta**, matching the Termius column
  verbatim. Same words, same box. The reader who already runs Claude Code on a
  VPS should see immediately that Manta goes on the machine they already have,
  not somewhere new.
- **A "Full comparison →" link sits in a table footer cell under each
  competitor column**, going to that competitor's page. The Manta footer cell
  is empty. This is the only navigation into the `/vs/` pages from the table,
  which is why the table can afford to be short.
- **No "where we lose" divider on the homepage.** The homepage table carries
  the axes we chose to compete on, at 12 rows. The concessions (diff review,
  built-in editor, agent-runtime count, desktop OS coverage, maturity) move to
  the `/vs/` pages, where there is room to make them properly rather than as a
  one-word cell.
- **Accept the trade-off knowingly:** a homepage table with no losing rows is a
  marketing table, and a reader who knows Orca will notice what is absent. The
  mitigation is the line printed directly beneath it naming what Orca and
  Conductor do better and linking to the full pages. Keep that line. Without it
  the table is rebuttable and the honesty argument in §5.3 collapses.

### 5.3 Comparison-page template (`/vs/<competitor>`)

Three pages, not two: `/vs/orca`, `/vs/conductor`, `/vs/ssh-tmux`
(the Termius-over-SSH incumbent, see 1.1). The SSH page is the highest-intent
of the three because that reader has already bought the premise.


Same structure for both. **Be scrupulously fair — include rows we lose.** An
honest table is more persuasive and far more likely to be cited by an LLM
than a rigged one. Both competitors refuse to name anyone; we name them.

```
H1: MantaUI vs <X>
Lede: one paragraph, neutral. "Both run coding agents. <X> runs them on your
      Mac and gives you a window onto them. Manta runs them on a box you own
      and gives every device an equal window. Here's the honest difference."

[Verdict box — 3 bullets: pick X if… / pick Manta if… / they overlap on…]

[Full table: ~18 rows. Architecture, platforms, license, mobile, remote
 access, notifications, permissions, agent tooling, price, maturity.
 Green/red honestly distributed.]

H2: Where <X> is better        ← genuinely, 4-6 items, no hedging.
                                 This is where the rows cut from the homepage
                                 table land: diff review, editor, agent count,
                                 desktop OS coverage, maturity.
H2: Where Manta is better      ← 3-4 items
H2: The architectural difference  ← the desktop-vs-server diagram, both sides
H2: Can I use both?            ← yes; they're not exclusive
H2: FAQ (FAQPage JSON-LD)
```

Facts to cite (all sourced, all quotable, all from their own docs — quote
verbatim and link, so the page is defensible):

**vs Orca:** "Closing the desktop app drops the connection — there is no cloud
relay." · "The mobile app is intentionally not a full editor — it's a remote
control for the desktop you already have running." · "Do not forward the Orca
port directly to the public internet. Prefer Tailscale…" (note: we *support* a
tailnet, they *require* one) · yolo/permission-bypass
flags pre-filled by default ·
2,310 open issues. **Concede:** MIT + 29.6k stars, 34 agents, cross-platform
desktop, Design Mode, orchestration protocol, terminal quality.

**vs Termius + SSH:** concede first and fully. It keeps the agent alive, it
is mature, it runs anywhere, and it costs nothing to keep. Then be specific
about what is missing: the agent's terminal UI rendered on a phone keyboard,
no approve button, no notification when it blocks, no upload, no dictation,
nothing the agent can start on its own. Close on coexistence, since Manta
installs on the same box and does not take SSH away.

**vs Conductor:** macOS only, "not available for Windows or Linux yet" ·
closed source, `license: Proprietary` · "Agents run directly on your system
without sandboxing" · "Workspace isolation is development isolation, not a
security boundary" · Cloud is beta, Pro-gated, GitHub-only, 10-workspace cap ·
no published prices. **Concede:** diff review + inline comments → agent, PR/
merge/checks tail, Linear/GitHub depth, `CONDUCTOR_PORT`, polish, funding.

### 5.4 GEO / AEO (answer-engine optimisation)

Conductor is executing this hard and it's the highest-leverage gap. Ship all of:

1. **`/llms.txt` + `/llms-full.txt`** — full site as markdown. Conductor's is 318KB and clearly deliberate.
2. **`.md` twin for every page** (`/vs/orca.md`) — Conductor serves these.
3. **`FAQPage` JSON-LD** on `/`, both `/vs/` pages, `/pricing`. This is what LLMs quote.
4. **`SoftwareApplication` JSON-LD** — `price: 0`, `license: MIT`, `operatingSystem: Linux, macOS, iOS, Web`. No Android until it ships (§2.5). Still more platforms than either competitor.
5. **`robots.txt`: `Content-Signal: ai-train=yes, search=yes, ai-input=yes`** — Conductor opts in; Orca blocks SEO crawlers but not AI. Opt in.
6. **`/.well-known/agent-skills/manta/SKILL.md`** — Conductor publishes an Agent Skill so any agent can configure their product. **We're better positioned: `llms-install.md` already exists and is exactly this.** Promote it to a well-known Agent Skill + link it from the homepage.
7. Do **not** block Ahrefs/Semrush (Orca does). We want the backlink data.
8. `sitemap.xml` with per-page priority + `lastmod`. None exists today.

**Target answer set** — the questions to be the answer to:

- "How do I use Claude Code from my phone?"
- "Can I run Claude Code on a server / VPS?"
- "What's a web UI for Claude Code?"
- "Does Claude Code keep running if I close my laptop?"
- "Open source alternative to Conductor / Orca"
- "How do I get notified when Claude Code needs approval?"
- "Can I self-host a Claude Code interface?"
- "Claude Code on iPhone"

Every one of these is a page in §5.2 and an FAQ entry.

### 5.5 Technical SEO baseline (all missing today)

`sitemap.xml` · `robots.txt` · canonical tags · OG image (`/opengraph-image`,
1200×630) · Twitter `summary_large_image` · per-page `<title>`/description ·
`BreadcrumbList` on sub-pages · self-hosted fonts (currently two render-blocking
Google Fonts preconnects) · real `<h2>/<h3>` hierarchy on new pages.

---

## 6. Screenshots — shot list

Today: **zero real product screenshots on the site.** The hero is a hand-built
HTML mockup; the phone is CSS divs. For a self-hosted OSS tool the #1 visitor
objection is "is this real and does it work" — mockups actively hurt.

Capture at **2× retina**, dark theme, `1440×900` desktop / `393×852` phone
(iPhone 15 Pro). Consistent fake-but-plausible project names across every shot
(`ethernal`, `marketing`, `infra`) so the set reads as one product. Scrub real
paths/tokens.

### 6.1 Priority shots

| ID | Shot | Where used | Why |
|---|---|---|---|
| **A** | **Hero.** Full desktop window: sidebar with 3 projects / 6 sessions showing mixed status dots (running / idle / amber attention / red `!` permission), chat panel mid-turn with a tool call + live bash output + context bar. | Hero, README top | The "many agents, one view" shot. Must show *live status variety* — that's the product. |
| **M** | **Same session, two devices.** Desktop window + phone side by side showing the identical session/transcript. | "Close the laptop" band | **The money shot.** Proves parity, which is exactly Orca's admitted weakness. |
| **D** | **Push notification** on a phone lock screen: title `ethernal / feat-auth`, body `Permission needed — Bash(rm -rf …)`. | Mobile section, /claude-code-notifications | Nobody else has notification routing. Highest-differentiation single image. |
| **B** | **Permission card + question card** in the transcript, buttons visible. | Features (approvals) | Direct visual rebuttal of yolo-by-default. |
| **C1** | Mobile session list — projects grouped, live statuses. | Mobile section, README | |
| **C2** | Phone session detail — full transcript + composer + mic button. iPhone frame only. | Mobile section, /claude-code-mobile | Rebuts "read-mostly". |
| **E** | **Terminal window** — xterm.js, real claude TUI running under tmux, status line visible. | Features (chat + terminal) | Proves "real tmux, not a wrapper". |
| **F** | Live bash output tailing — **animated GIF/webm**, ~6s, output streaming line by line. | Features (live output) | Motion proves "live" in a way a still cannot. |

### 6.2 Secondary shots

| ID | Shot | Where |
|---|---|---|
| G | Context bar close-up — segmented input/cache-write/cache-read + stale-cache "/clear to save 47k tokens" pill | Features / docs |
| H | Scheduled tasks card (⏰) with 2–3 cron'd prompts | Agent-tools section |
| I | Secrets card (🔑) — metadata-only list, value never shown | Agent-tools section |
| J | Subagents — collapsed task cards, one expanded | Features |
| K | Pairing screen — 6-digit code, desktop + box terminal | How it works |
| L | Settings → Providers / Subagents / Plugins toggle | /docs |
| N | Agent-tools montage — notify + webhook + peers | Agent-tools section |
| O | Architecture diagram (SVG, redrawn from README ASCII) | How it works, README |

### 6.3 Video (optional, high value)

A single **45–75s silent looping demo**, no narration, captioned:
start a task on desktop → close the laptop → phone buzzes with a permission
request → approve on phone → reopen desktop, work continued and finished.

That's the entire positioning in one clip, and it's a claim neither competitor
can film. Conductor has YouTube embeds in their sitemap with `<video:video>`
schema — worth matching for video rich results.

---

## 7. Open source prominence

**Gated on B1 (add a LICENSE).** Without it none of this is honest.

### 7.1 Actions

1. **`LICENSE` — MIT.** Matches Orca; zero friction; makes "open source" true.
2. **Repo description** → e.g. *"Open-source, self-hosted Claude Code & opencode client. Agents run in real tmux on your own Linux box or Mac; drive them from desktop, phone, or browser over HTTPS."* (keyword-dense, accurate, GitHub search + LLM surface).
3. **Repo topics** — Orca uses these deliberately. Add: `claude-code`, `opencode`, `ai-agents`, `self-hosted`, `tmux`, `coding-agent`, `mobile`, `pwa`, `electron`, `remote-development`, `open-source`, `devtools`.
4. **README rewrite** (§8) — the README *is* the open-source landing page and ranks independently.
5. **Homepage open-source band**, placed after the comparison table:
   - "MIT licensed. Self-hosted. No account, no telemetry, no vendor."
   - Three links: Read the source · Architecture docs · Report an issue
   - **Concrete trust claims neither competitor can make in full:** runs entirely on hardware you own · no data leaves your box except APNs push fanout (and Web Push doesn't even do that) · no account required · auditable install script (`curl … | bash` — link to the actual file)
   - `CONTRIBUTING.md` + good-first-issue link
6. **Do not show star count** until >500 (B2).
7. **No repo-topic chips on the website.** They were tried in the mockup and
   removed: they read as GitHub chrome pasted onto a marketing page and add no
   claim a visitor cares about. Repo topics still matter **on GitHub itself**
   (item 3 above) — that is a different surface.
7. Add `SECURITY.md` — for a self-hosted tool holding secrets and box tokens, this is a credibility requirement, and Orca doesn't have one.

### 7.2 The honest-differentiation angle

Orca is also MIT, so "open source" alone doesn't differentiate against them —
only against Conductor. The differentiated claim is the **combination**:
open source **and** self-hosted **and** no account **and** the server outlives
every client. Orca is open source but desktop-bound and account-gated for
mobile pairing; Conductor is neither. Say it as the combination, not as
"we're open source".

---

## 8. README rewrite

Current README (336 lines) opens with a tagline, then AI-assisted setup, then
an architecture diagram — and **never lists features at all**. It reads as a
maintainer runbook. ~40% of it (releases, prod infra, rollback) belongs in
`docs/`, not the README.

Requested order: **install → features → technical**. Proposed:

| § | Content | Notes |
|---|---|---|
| 1 | Logo, one-line description, badge row (License · Platforms · Build · Docs) | No star badge (B2) |
| 2 | **Hero screenshot** (shot A) | Immediately after the badges — GitHub's above-the-fold |
| 3 | **Install** — three tabs of prose: (a) paste-to-your-agent prompt, (b) `curl \| bash`, (c) manual/git. Then "get the desktop app" and "get the phone app". Nothing before this but the screenshot. | Currently split across "AI-assisted setup" and "Quick start" with architecture wedged between. Merge and hoist. |
| 4 | **Features** — the §2.3 pillars, then a scannable list grouped as: Sessions and terminal · Chat and review · Phone app and notifications · Agent-native tools · Files and voice · Security. Inline small screenshots for the top 3–4. | **The single biggest gap. Does not exist today.** |
| 5 | **How it works** — architecture diagram (keep ASCII, add SVG), "the server is the box" explanation, the two window types, auth model | Mostly exists; tighten |
| 6 | **Technical details** — transport (`/rpc` + `/events` SSE), state layout on the box, ports, component table, installer internals, config schema | Exists, keep, condense |
| 7 | **AI tools on the box** — schedule/serve-page/peers/notify/secrets/webhook, one line each + install note | Exists, keep |
| 8 | **Development** — build/test/run from source, repo layout pointer to `AGENTS.md` | Exists |
| 9 | **Comparison** — short honest table + links to the two `/vs/` pages | New; README comparison tables rank |
| 10 | Contributing · Security · License · Known gaps · Reporting issues | Add CONTRIBUTING/SECURITY/LICENSE links |
| — | **Move out to `docs/`**: release runbook, rollback procedure, prod infra, prod box ops | ~90 lines of maintainer-only content currently in the README |

Apply the copy rules in 2.4 and the terminology rule in 2.5 (no "PWA").
Also fix B4 (signed vs unsigned) and add the keyword-bearing phrases naturally
in the first 200 words: *Claude Code*, *opencode*, *self-hosted*, *mobile*,
*remote*, *open source*, *tmux*.

---

## 8.5 URL scheme and deploy constraints (decided, do not re-litigate)

Verified against the live site on 2026-07-26.

- **Caddy on the prod box already strips `.html`.** `/privacy` and
  `/privacy.html` both return 200. So a file at `website/pricing.html` is
  served at `https://mantaui.com/pricing` with no infra change.
- **Nested URLs are not available.** `website/*.html` in the deploy workflow is
  a top-level glob, so `website/vs/orca.html` would never be copied, and the
  Caddyfile is not in the repo (it lives only on the box, unversioned) so no
  agent can add a route for it. **Use flat, hyphenated filenames**:
  `vs-orca.html` → `/vs-orca`, `claude-code-mobile.html` → `/claude-code-mobile`.
  Every `/vs/x` reference elsewhere in this spec means `/vs-x`.
- **The deploy workflow's verify step is a hardcoded list of seven `check`
  calls.** New pages are copied by the glob but never verified, so a silently
  failed deploy would pass green. Make the verify data-driven before adding
  pages (see the issue list).
- **No agent may SSH to the prod box.** Anything needing a Caddyfile change is
  out of scope by construction.

---

## 9. Sequencing

| Phase | Work | Gate |
|---|---|---|
| **0** | B1 LICENSE, B3 repo description + topics, B4/B5 copy corrections | Blocks everything claiming "open source" |
| **1** | Capture screenshots A, M, D, B, C1, C2, E (§6.1) | Blocks homepage + README |
| **2** | README rewrite (§8) | Independent of website; ships first, ranks on its own |
| **3** | Homepage rework (§3) + technical SEO baseline (§5.5) | Needs phase 1 |
| **4** | `/vs/conductor`, `/vs/orca`, `/vs/ssh-tmux`, `/pricing` | Uncontested SERPs, cheapest wins |
| **5** | `/claude-code-web-ui`, `/claude-code-mobile`, `/claude-code-remote`, `/open-source` | The ~16k/mo cluster |
| **6** | GEO layer (§5.4) — llms.txt, .md twins, JSON-LD, Agent Skill | Compounding |
| **7** | `/docs`, `/changelog`, long-tail pages, demo video | |

**Deploy note:** every page here ships through the existing `web-v*` tag →
`.github/workflows/website-deploy.yml` path, which scp's `website/*.{html,png}`
into the prod webroot and verifies each URL 200 + sha256. **Adding new pages or
new asset types (screenshots as `.webp`/`.jpg`, `sitemap.xml`, `llms.txt`,
`.well-known/`) requires updating that workflow's copy list and verify list** —
it currently only handles `index/privacy/terms` + `install.sh` +
`llms-install.md`. Easy to miss; it will silently not deploy.

---

## 10. Open questions

1. **License — MIT or Apache-2.0?** MIT matches Orca and is friction-free; Apache-2.0 adds a patent grant. Recommend MIT.
2. **Is the macOS build signed?** (B4) Determines the install copy.
3. **Do we want `/docs` at all**, or keep docs in the repo? Both competitors carry their entire long-tail on docs pages; repo-only docs forfeit that. Recommend a minimal `/docs` generated from the repo markdown.
4. **Pricing page for a free product** — recommend yes: it's a real intent gap ("is X free"), both competitors 404 there, and it's the cheapest trust page to write.
5. **Name.** "MantaUI" vs "Manta UI" vs "Manta" is inconsistent across the site, README, and repo. Pick one before building pages that will be linked to.
6. **How hard do we go at the SSH incumbent?** A `/vs/ssh-tmux` page that
   concedes generously converts better than one that attacks, but it also
   tells a chunk of readers that their current setup is fine. Recommend
   conceding: that reader is technical and will spot a rigged argument.
7. **Do we claim opencode support prominently?** `opencode` is 90.5k/mo and we ship it as the chat backend. Recommend yes — it's a large, uncontested adjacent term.
