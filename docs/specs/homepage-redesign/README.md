# Homepage redesign — implementation spec

**Status: ready to build. Every design decision is already made.**

`reference.html` in this directory is a complete, working rendering of the new
homepage. Open it in a browser. It links `website/site.css` and adds only the
CSS that does not already exist there. **It is the source of truth for markup,
class names, copy and CSS.** Do not redesign, do not improvise, do not
"improve" spacing or colour. If something looks wrong, it is a bug in the port,
not an invitation to redesign.

Full rationale, research and the rejected alternatives:
<https://3655737043030f5927b6c531f05ea650.boxes.mantaui.com/pages/homepage-redesign>

---

## The one-paragraph summary

The homepage's job is desktop app downloads. Today the first screen spends its
attention on a paste-this-into-your-agent install command, the hero video is 50
seconds of grey placeholder blocks, Windows is never mentioned even though the
installer ships, and the two capabilities no competitor has are a 34-word card
and a total omission. The new page keeps the headline, puts a picture of the
actual product in the first screen, makes the download button the only
prominent call to action, and organises everything else as five numbered stages
plus one grouped feature list.

---

## Rules for this work

1. **Deletion beats addition.** Issue 1 must produce a net-negative diff. If a
   rule, an asset or a section is not referenced by the new page, delete it.
2. **Reuse `site.css` before writing anything.** It already provides `.wrap`,
   `.btn` / `.btn-primary` / `.btn-ghost`, `.eyebrow`, `section`, `.sec-head`,
   `.sunk`, `.band`, `.card`, `.faq`, `.checks`, `.quotebox`, and the full token
   set. Every new rule you add is a code path someone maintains forever.
3. **Two new tokens only.** `--tile-fill` and `--tile-line`, added to the
   `:root` block in `website/site.css`. Everything else already exists. Do not
   introduce a third without saying why in the PR description.
4. **No hex literals in new CSS.** Use tokens. The reference already does; if
   you find a raw hex you introduced, replace it with the nearest token.
5. **One CSS home per rule.** Page-specific rules go in `website/index.html`'s
   inline `<style>` (this is the existing convention, stated at the top of
   `site.css`). Anything a second page would use goes in `site.css`. Do not
   duplicate a rule into both.
6. **Do not touch the other marketing pages.** `vs-*.html`,
   `claude-code-*.html`, `open-source.html`, `pricing.html` share `site.css`.
   Several rules that look dead on the homepage are alive there. See the
   deletion table in issue 1 for exactly what is safe.
7. **No new dependencies, no build step, no JavaScript framework.** This is a
   static HTML page with one stylesheet.

---

## Token map

Every colour in `reference.html` already resolves to an existing token. For
reference, this is what the mockup's working names became:

| Purpose | Token used |
|---|---|
| Page background | `--surface-app` |
| Sidebar / terminal / code background | `--surface-inset` |
| Card and panel background | `--surface-sunken`, `--surface-panel` |
| Raised surface (permission card, notification) | `--surface-panel` |
| Hairline between cells | `--border-subtle` |
| Visible border | `--border-default`, `--border-strong` |
| Primary text | `--text-primary` |
| Body text | `--text-secondary`, `--slate-300` |
| Muted text | `--text-tertiary`, `--slate-400`, `--slate-500` |
| Faintest text, gutter numbers | `--navy-500`, `--navy-600` |
| Accent / running state | `--cyan-400`, `--cyan-300` |
| Success, added lines | `--green-500` |
| Attention, warning | `--amber-500` |
| Error, removed lines | `--red-500` |
| Primary action | `--blue-500`, `--blue-300` |
| **Tile fill (new)** | `--tile-fill: rgba(255,255,255,.035)` |
| **Tile hairline (new)** | `--tile-line: rgba(255,255,255,.055)` |

---

## Page structure

| # | Section | Markup source in `reference.html` |
|---|---|---|
| 1 | Hero: headline, subhead, download, app window, five-stage rail, trust strip | `Section 1` |
| 2 | The problem, with the 3am chain | `Section 2` |
| 3 | Stage 1.0 Install | `Section 3` |
| 4 | Stage 2.0 Run | `Section 4` |
| 5 | Stage 3.0 Leave | `Section 5` |
| 6 | Stage 4.0 Automate | `Section 6` |
| 7 | Stage 5.0 Delegate | `Section 7` |
| 8 | Features, twelve tiles in three clusters | `Section 8` |
| 9 | Download block and closing band | `Section 9` |

Nav and footer are unchanged. Keep the ones already in `index.html`.

---

## Known follow-ups, deliberately out of scope

These are tracked separately and must **not** be attempted as part of the port:

- **The phone in stage 3.0** is a placeholder rounded rectangle. The real asset
  is Apple's official iPhone 17 Product Bezel plus two real screenshots, and it
  carries licence constraints (no tilting, no cropping, no added shadow, and a
  drawn CSS frame is prohibited outright). Leave the placeholder in place.
- **Two screen recordings** (a webhook opening a pull request, a plugin building
  the iOS app) belong in stage 4.0 later. Do not add a `<video>` to the hero.
- **The iOS TestFlight line** states "this month". If that is not true when you
  build, delete the line rather than softening it to "coming soon".
- **Real download URLs.** The reference uses `/downloads/Manta-latest.dmg` for
  macOS, which is correct. The Windows and iPhone buttons point at `#` and need
  the real targets; if there is no public Windows URL yet, the Windows button
  should link to the GitHub releases page.

---

## How to verify

1. `reference.html` and the rebuilt `website/index.html` should be visually
   identical from the hero down, ignoring nav and footer.
2. No horizontal scrollbar at 1280px, 1024px and 390px wide.
3. No console errors, no 404s for assets.
4. `grep -c "hero.mp4\|hero.webm\|hero-poster"` in `website/` returns 0 after
   issue 1.
5. Every `class=` in the new markup resolves to a rule in either `site.css` or
   the page's own `<style>`. No orphan classes.
