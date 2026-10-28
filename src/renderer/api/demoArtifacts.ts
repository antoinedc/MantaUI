// Static `artifacts:list` fixtures for the demo transport. The artifacts the
// demo's Artifacts panel shows used to be derived in the renderer from the demo
// transcript; derivation now lives on the box (src/server/artifacts.mjs), so the
// demo serves the same rows as literal data. Literal on purpose — nothing here
// derives anything.
//
// The rows reproduce what the visual baselines show: four links (three hosted
// pages with live / soon / expired pills + one pasted RFC link), six images and
// five files across a "today", a "yesterday" and a Nov-2023 group.

import type { ArtifactItem, ArtifactsListResult } from "../../shared/artifactsTypes.js";
import { DEMO_T0 } from "./demoFixture.js";

const BOX_URL = "https://9f3b1d4c8e7a2b5d0c6e4f7a3b9d2c1e.boxes.mantaui.com";
const UPLOADS = "/home/dev/projects/infra/services/billing/uploads";

// Page expiry anchors to the capture's real "now" (module load): the panel
// renders the state the box sent, and the box computes it against the live clock.
const NOW = Date.now();
const HOUR = 3_600_000;

const bothUp =
  "Both are up — the split view keeps the transcript readable at narrow widths: " +
  `${BOX_URL}/pages/artifacts-panel and ${BOX_URL}/pages/composer-v2.`;
const densities =
  "Three densities side by side — compact is the one that survives at 1280px: " +
  `${BOX_URL}/pages/sidebar-density.`;

const item = (over: Partial<ArtifactItem> & Pick<ArtifactItem, "id" | "kind" | "label" | "href" | "at">): ArtifactItem => ({
  origin: "agent",
  mime: null,
  size: null,
  messageId: null,
  context: null,
  isHosted: false,
  expiry: null,
  plan: null,
  ...over,
});

const image = (id: string, name: string, size: number, at: number, origin: "user" | "agent", messageId: string) =>
  item({ id, kind: "image", label: name, href: `${UPLOADS}/${name}`, mime: "image/png", size, at, origin, messageId });

const FIXTURE_ITEMS: ArtifactItem[] = [
  item({
    id: "page:artifacts-panel", kind: "link", label: "artifacts-panel", href: `${BOX_URL}/pages/artifacts-panel`,
    at: NOW - HOUR, messageId: "msg_a_art", context: bothUp.slice(0, 160), isHosted: true,
    expiry: { state: "live", expiresAt: NOW + 23 * HOUR },
  }),
  item({
    id: "page:composer-v2", kind: "link", label: "composer-v2", href: `${BOX_URL}/pages/composer-v2`,
    at: NOW - 2 * HOUR, messageId: "msg_a_art", context: bothUp.slice(0, 160), isHosted: true,
    expiry: { state: "soon", expiresAt: NOW + 2 * HOUR },
  }),
  item({
    id: "page:sidebar-density", kind: "link", label: "sidebar-density", href: `${BOX_URL}/pages/sidebar-density`,
    at: NOW - 86_400_000 - 30 * 60_000, messageId: "msg_a_art2", context: densities.slice(0, 160), isHosted: true,
    expiry: { state: "expired", expiresAt: NOW - 1_000 },
  }),
  item({
    id: "prt_u_art", kind: "link", origin: "user", label: "datatracker.ietf.org/doc/html/rfc4180",
    href: "https://datatracker.ietf.org/doc/html/rfc4180", at: DEMO_T0 - 20 * 60_000, messageId: "msg_u_art",
    context: "here's the RFC — the quoting rules are what always breaks naive parsers",
  }),

  item({ id: "prt_a_csv", kind: "file", label: "cohort-analysis.csv", href: `${UPLOADS}/cohort-analysis.csv`, mime: "text/csv", size: 862_208, at: DEMO_T0 - 10 * 60_000, messageId: "msg_a_art" }),
  item({ id: "prt_u_csv", kind: "file", origin: "user", label: "q3-revenue.csv", href: `${UPLOADS}/q3-revenue.csv`, mime: "text/csv", size: 1_258_291, at: DEMO_T0 - 20 * 60_000, messageId: "msg_u_art" }),
  item({ id: "prt_u_pdf", kind: "file", origin: "user", label: "brand-guidelines.pdf", href: `${UPLOADS}/brand-guidelines.pdf`, mime: "application/pdf", size: 5_033_164, at: DEMO_T0 - 20 * 60_000, messageId: "msg_u_art" }),
  item({ id: "prt_a_retention", kind: "file", label: "retention-report.pdf", href: `${UPLOADS}/retention-report.pdf`, mime: "application/pdf", size: 1_153_433, at: DEMO_T0 - 86_400_000 - 40 * 60_000, messageId: "msg_a_art2" }),
  item({ id: "prt_a_notes", kind: "file", label: "migration-notes.md", href: `${UPLOADS}/migration-notes.md`, mime: "text/markdown", size: 12_288, at: DEMO_T0 - 86_400_000 - 40 * 60_000, messageId: "msg_a_art2" }),

  image("prt_a_img1", "export-preview.png", 988_160, DEMO_T0 - 10 * 60_000, "agent", "msg_a_art"),
  image("prt_a_img2", "api-docs-diff.png", 1_056_768, DEMO_T0 - 10 * 60_000, "agent", "msg_a_art"),
  image("prt_u_img1", "Screenshot 2026-08-05 at 09.12.41.png", 1_431_656, DEMO_T0 - 20 * 60_000, "user", "msg_u_art"),
  image("prt_u_img2", "Screenshot 2026-08-05 at 09.15.02.png", 1_208_314, DEMO_T0 - 20 * 60_000, "user", "msg_u_art"),
  image("prt_a_oldimg", "cohort-grid.png", 1_675_568, DEMO_T0 - 86_400_000 - 40 * 60_000, "agent", "msg_a_art2"),
  image("prt_a_oldimg2", "Screenshot 2026-08-03 at 16.40.12.png", 1_310_720, DEMO_T0 - 86_400_000 - 40 * 60_000, "agent", "msg_a_art2"),
];

// The `artifacts` demo state adds one self-contained image (a data: URI, so the
// preview overlay renders with no box) for the preview-overlay capture.
const PREVIEW_IMAGE = item({
  id: "prt_preview_img",
  kind: "image",
  origin: "user",
  label: "Screenshot 2026-08-05 at 10.45.17.png",
  href:
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NDAiIGhlaWdodD0iMzYwIj48cmVjdCB3aWR0aD0iNjQwIiBoZWlnaHQ9IjM2MCIgZmlsbD0iIzMzNDA2YiIvPjxjaXJjbGUgY3g9IjMyMCIgY3k9IjE4MCIgcj0iMTIwIiBmaWxsPSIjNWU2YzliIi8+PC9zdmc+",
  mime: "image/svg+xml",
  at: DEMO_T0 - 45_000,
  messageId: "msg_preview_img",
});

export function demoArtifactsList(
  demoStateName: string,
  sessionId: string,
  demoState: { activeSessionId: string | null },
): ArtifactsListResult {
  const active = !sessionId || sessionId === demoState.activeSessionId;
  const items = active
    ? [...FIXTURE_ITEMS, ...(demoStateName === "artifacts" ? [PREVIEW_IMAGE] : [])].sort((a, b) => b.at - a.at)
    : [];
  const counts = { link: 0, image: 0, file: 0, plan: 0 };
  for (const i of items) counts[i.kind]++;
  return { sessionId, generatedAt: Date.now(), items, counts, degraded: [] };
}
