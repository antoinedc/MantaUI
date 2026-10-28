# Server-first-2 — 07-artifacts-cards

## Previous findings verified

1. **Resolved — published-page resolution.** The server-first section now separates owned registration, foreign/null ownership, and absent registration. A collision never falls back to the deterministic URL; unusable owned URLs yield null. Unusable ordinary hosted links are omitted with explicit degraded feedback. Node cases 10–11 and both consumer contracts cover the outcomes. This matches the actual empty-URL behavior of `src/server/servePage.mjs:212–219` and truncated slug in `src/shared/planMode.mjs:49–69`.

2. **Resolved — omitted typed consumer.** The desktop migration table and Files now include `ArtifactPreview.test.tsx`; both its fixture and the retained day-grouping builders receive the new wire fields. The existing preview action tests remain. This addresses the typed literals in `src/renderer/ArtifactPreview.test.tsx:13–26` and `src/renderer/artifacts.test.ts:49–67` without weakening typecheck.

3. **Resolved — M-04-2 mount and retry.** The exact receipt now mounts `SessionModeRows` as sibling Sections and requires mode, selection, and retry callbacks. Legacy callers retain Open terminal; read-only callers get neither. The master ledger (`00-master.md:521`) now agrees with that gate, and WS02's wired caller supplies retry. This fits `SessionModeMenu.swift:39–68`, including its failed-catalog button. The new Xcode-only gate tests and interactive retry check cover the changed behavior.

4. **Resolved — incomplete derivation key.** The key now includes current base URL, relevant page fields, sidecar-derived expiry/message ownership, final-part content hash, and optional-read failures. Degraded status is request-local and expiry is recomputed; earlier-message edits have an explicit bounded staleness policy. Source-recovery and invalidation tests are specified. One new library-specific test-clock detail remains below.

5. **Resolved — obsolete normative statements.** The header declares the new channel and capability, verification requires node/desktop checks, and the obsolete capability-registration account is marked historical. Current registration remains `artifacts-list-1` in wave B.

## New findings

1. **SHOULD — Memoization / node case 8: finish specifying the fake-clock setup for lru-cache.** `perf: { now }` is a real 11.5.3 option, but alone does not make the proposed rapid fake-clock sequence deterministic. The default `ttlResolution: 1` caches the clock until a real timer clears it. Also, an entry created at injected time zero is treated as having no expiring start timestamp. **Evidence:** spec `07-artifacts-cards.md:234–245,280–291`; published [`lru-cache@11.5.3/dist/esm/index.js`](https://unpkg.com/lru-cache@11.5.3/dist/esm/index.js), lines 282, 466–475 and 497–500. A read-only probe against that exact published module returned `core/core/core` at ages 10/25/31 seconds with start=1000 and default resolution; `ttlResolution:0` returned `core/core/MISS`; start=0 still returned `core/core/core` even with resolution zero. **Fix:** pin `ttlResolution:0` for the injected-clock cache and start test clocks at a positive epoch (or explicitly coordinate the library timer and clock). Keep the required re-derivation assertion at 31 seconds. This is test-harness precision, not a reason to reject the library or block the production design.

## Additional checks

- MIME reuse matches `src/server/media.mjs:45–61`: the existing image/video rows include AVIF; the eight added document extensions preserve the unknown-extension fallback through the proposed nullable helper. The AVIF behavior change and media-tool MIME changes are explicitly acknowledged and tested; no full MIME database broadens preview classification.
- The direct dependency, lockfile, and media-module changes have explicit WS07 ownership in the master (`00-master.md:539,634–635`). Shared renderer/RPC changes remain IB mounts under D27.
- Capability detection still follows D25: exact unknown-channel detection is permitted, any capability-list read uses the shared accessor, and neither client restores local derivation.
- Plan path extraction, authenticated box-byte access, credential-free remote fetching, attachment rejection, and notice cleanup contracts remain intact.
- Review only. No repository implementation or application test suite was run; the small upstream-library probe above was executed in memory without installing dependencies.

Counts: BLOCKING 0 · SHOULD 1 · NIT 0.

VERDICT: APPROVE
