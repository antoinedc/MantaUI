// demoLayout.ts — demo-mode fixture-state selector.
//
// BET-559: the renderer is the desktop app only; the mobile web-client shell
// it used to branch to is retired. The `?demo` URL override that once chose
// between <App/> and <MobileApp/> is gone with it — demo mode always renders
// the desktop <App/>. What remains here is the fixture-state selector, which
// is still the one named way to choose which demo transport state the visual
// harness / marketing shots capture.

// Which fixture state the demo transport serves.
//
// Every fixture state the demo transport can serve is a single named member
// here plus its branch in demoApi — never a new URL boolean. Each state is
// reachable by pasting a URL into a browser, so a human reviewer sees
// exactly what the machine captured.
//
// "full"         — the populated fixture (projects, sessions, a transcript).
//                  The default, and what the marketing shots capture.
// "empty"        — a box with no projects yet. This is a REAL product state
//                  (a freshly-paired box), and it is the only way to reach
//                  the zero-project screens, which otherwise require
//                  deleting fixture data from a live box.
// "version-skew" — minClient raised above the client so the non-dismissible
//                  version-skew banner renders (the first non-happy-path
//                  capture).
// "reconnecting"  — the events-WebSocket reports a degraded connection state
//                  so the reconnecting banner renders (the top-severity bar).
// "incompatible"  — the box is on a different major than the desktop so the
//                  wire-contract incompatibility card renders.
// "update-failed" — the desktop auto-update reports an integrity/permission
//                  failure so the update-failed banner renders.
// "server-update" — the box is older than the desktop on the same major so
//                  the "Box needs an upgrade" (server-update) card renders.
// "stream"       — the transcript is served incrementally (not whole). The
//                  demo transport replays demoState.messages a few parts at a
//                  time and exposes window.__mantaDemoStream so the visual
//                  harness can advance it phase by phase (early/mid/late).
//                  This is the state the mid-stream capture harness (BET-560)
//                  drives to prove the transcript assembler produces the same
//                  result over time, not just in its settled end state.
// "artifacts"    — the default transcript PLUS one image file artifact (a
//                  data: URL), isolated here so the preview-overlay capture
//                  (BET-661) has an image to render without touching the
//                  shared fixture or any other baseline.
export const DEMO_STATES = [
  "full",
  "empty",
  "version-skew",
  "reconnecting",
  "incompatible",
  "update-failed",
  "server-update",
  "stream",
  "artifacts",
] as const;
export type DemoState = (typeof DEMO_STATES)[number];

/** `?demo&state=<name>`. An unknown or absent value falls back to "full", so
 *  a typo degrades to the default capture rather than a blank screen. */
export function pickDemoState(params: URLSearchParams): DemoState {
  const raw = params.get("state");
  return (DEMO_STATES as readonly string[]).includes(raw ?? "")
    ? (raw as DemoState)
    : "full";
}
