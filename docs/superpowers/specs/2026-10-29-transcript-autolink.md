# Transcript autolinking — make every URL clickable, tagged or not

Status: agreed 2026-10-29. Branch `feat/transcript-autolink`.

## Problem

Assistant prose already turns `https://…` and `www.…` into links (remark-gfm's
autolink-literal). Everywhere else a URL is dead text:

- URLs inside inline code (`` `https://docs.x.com/a` ``) — ~20% of the URLs the
  AI writes (measured: 39 in inline code vs 164 bare over 7 days of real
  transcripts).
- Every surface that is not rendered as markdown: the user's own message
  bubble, Bash / Read / Grep / WebFetch tool output, the WebFetch card's URL
  (coloured like a link, not clickable), todo items, reasoning text, the
  over-50k-char plain fallback, the slash-command bar, CTO pane `<pre>` blocks.
- Schemeless web addresses (`mantaui.com/downloads`, `cto.useronda.com`).

Two incidental bugs in `src/renderer/MarkdownBody.tsx`, fixed in the same change:

- The `a` and `code` overrides spread react-markdown's `node` prop onto the DOM
  (`node="[object Object]"` on every link / inline code).
- The `code` override branches on an `inline` prop react-markdown v10 no longer
  passes, so the intended inline-code styling (accent colour, no box) never
  applies.

## Library decision

| Option | Weekly dl | Licence | Notes |
|---|---|---|---|
| **linkify-it** (chosen) | ~38M | MIT | markdown-it's detector; one tiny dep (`uc.micro`); cheap `pretest()` short-circuit; configurable fuzzy-TLD list; returns match index/text/url |
| linkifyjs (+ linkify-react) | ~25M (~1M react) | MIT | larger (270 kB), its own tokenizer; React wrapper renders its own anchors — we need ours |
| autolinker | ~2M | MIT | HTML-string oriented, not React |
| hand-rolled regex | — | — | rejected: boundary/punctuation/IDN edge cases are exactly what the library already solves |

Prose markdown keeps remark-gfm for schemeful URLs; schemeless detection there
is added by a small remark plugin that reuses the same linkify helper.

## Contract

### 1. Detection — `src/renderer/linkify.ts` (pure, tested)

`findLinks(text: string, opts?: { schemeless?: boolean }): LinkMatch[]`
where `LinkMatch = { start: number; end: number; text: string; href: string }`.
`opts.schemeless` defaults to `true`.

Built on ONE module-level configured `linkify-it` instance:

- Schemeful: `http://`, `https://`, plus `www.` — always detected.
- Emails, IPs-without-scheme, `ftp:`, `mailto:` and other schemes: NOT detected
  (`fuzzyEmail: false`, `fuzzyIP: false`; only http/https/www results kept).
- Schemeless (`fuzzyLink`) uses an EXPLICIT TLD allowlist that replaces
  linkify-it's default list (whose 2-letter ccTLDs collide with file
  extensions: `install.sh`, `main.py`, `lib.rs`, `README.md`):
  `com net org io dev app ai co me so gg xyz info biz edu gov tech cloud site page run eu uk de fr ca us`.
- Schemeless TLDs that collide with common file names — `app`, `ai` — only link
  when followed by a path (`/`). `MantaUI.app`, `logo.ai` stay text;
  `foo.app/x` links.
- A schemeless match is rejected when the character immediately before it is
  any of `/ \ . @ ~ - _ $ :` or a word character (it is part of a path,
  identifier or address), e.g. `/home/dev/foo.com`, `src/a.io`, `x@y.com`.
- A match (any kind) immediately followed by `<`, `{` or `$` is a template
  placeholder, not a link: `http://localhost:<port>`, `https://{host}/x` → none.
- Trailing sentence punctuation is excluded (`…/pull/1.` → href ends `/1`);
  balanced parentheses are kept (linkify-it default behaviour — verify).
- href: schemeful → as written; `www.x` and schemeless → `https://` + text.
- Fast path: if `pretest()` is false, return `[]` without a full scan.

### 2. Rendering — `src/renderer/Linkified.tsx`

- `ExternalLink` — the ONE anchor used for every auto/markdown link. Behaviour
  moved verbatim from MarkdownBody's `a` override: `target="_blank"`,
  `rel="noreferrer"`, accent colour + underline, click →
  `getMantaPreload().openExternal(href)` with `preventDefault` when the preload
  exists. Additionally `e.stopPropagation()` on click so a link inside a
  clickable tool card / command bar header does not also toggle it. MarkdownBody's `a`
  override renders `ExternalLink` (minus `node`).
- `Linkified({ text, schemeless? })` — renders `text` as a fragment of strings
  and `ExternalLink`s, memoised on `text` (`useMemo`). Inherits the
  surrounding typography; adds no wrapper element (so `whitespace-pre-wrap`
  on the parent still applies).

### 3. Surfaces

| Surface | File (main) | Change |
|---|---|---|
| Assistant prose, schemeless | `MarkdownBody.tsx` | remark plugin: split mdast `text` nodes (NOT inside `link`, `linkReference`, `inlineCode`, `code`) into text + `link` nodes via `findLinks` |
| Inline code | `MarkdownBody.tsx` `code` override | content rendered via `Linkified`; schemeful links anywhere in the span; schemeless only when the whole trimmed span is one link. Keep code styling on the `<code>`. |
| Inline-code style bug | `MarkdownBody.tsx` | drop the dead `inline` branch: the `pre` override renders block code via `CodeBlock` from the child's props, so the `code` component's own output is only ever displayed inline — always render the inline styling. Check `index.css` for any existing `code` styling so it is not doubled. |
| `node` leak | `MarkdownBody.tsx` | destructure `node` out in `a` and `code` |
| >50k plain fallback | `MarkdownBody.tsx` | `<Linkified>` inside the `<pre>` |
| User message bubble | `MessageRow.tsx` (`<MessageBubble>{text}`) | `<Linkified text={text}/>` |
| Slash-command bar args + expanded text | `MessageRow.tsx` `UserCommandBar` | `Linkified` (the args sit inside a `<button>`: links there must not toggle — stopPropagation covers it; nested `<a>` in `<button>` is invalid HTML, so render args links only in the expanded text, keep args plain) |
| Todo items | `MessageRow.tsx` ActiveTodos | `Linkified` |
| Reasoning text | `ToolCall.tsx` | `Linkified` |
| Tool output lines (Bash, Read, Grep, Glob, WebFetch body) | `ToolBodies.tsx` `ConnectorOutput`, `CollapsibleLines` | each rendered line via `Linkified` (only visible lines are scanned) |
| WebFetch header URL | `ToolBodies.tsx` `WebFetchBody` | `ExternalLink` with the full URL |
| CTO pane `<pre>` blocks | `ctoSections.tsx` (4 sites) | `Linkified` |

Out of scope (later): fenced code blocks / Prism tokens, unified diffs,
absolute file paths (peek), the native iOS client.

## Performance

`findLinks` costs one `pretest` regex for link-free text. Transcript rows are
already memoised and `Linkified` memoises on `text`, so detection runs once per
text change, not per keystroke. Tool output scans only visible lines.

## Tests (must exist and pass)

- `src/renderer/linkify.test.ts`: schemeful, `www.`, schemeless allowlist hits
  (`mantaui.com`, `cto.useronda.com`, `mantaui.com/downloads`,
  `app.tryethernal.com/docs/api`); non-links (`install.sh`, `main.py`,
  `lib.rs`, `README.md`, `package.json`, `x.ts`, `MantaUI.app`, `logo.ai`,
  `/home/dev/foo.com`, `src/a.io`, `user@x.com`, `http://localhost:<port>`,
  `https://{host}/x`); `foo.app/x` links; trailing `.`/`,`/`)` handling;
  href normalisation; empty / link-free input returns `[]`.
- `MarkdownBody` component tests: bare schemeless in prose links; inline-code
  URL links and keeps `<code>`; `[text](url)` and gfm autolinks unchanged (no
  double wrapping); no `node` attribute in output; fenced code not linkified.
- Component tests for user bubble, a tool-output surface, WebFetch header, and
  that clicking an auto link calls `openExternal` and does not propagate.
