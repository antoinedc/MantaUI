// Wire shape of the box's `artifacts:list` channel (src/server/artifacts.mjs).
// The box derives everything (links, files, images, hosted pages, outbox files,
// plans, expiry state, counts); clients only render it.

export type ArtifactKind = "link" | "image" | "file" | "plan";
export type ArtifactOrigin = "user" | "agent";

// Derived plan lifecycle. The box sends "draft" until a plan→job link exists.
export type PlanStatus = "draft" | "approved" | "building" | "done";

export type ArtifactExpiryState = "live" | "soon" | "expired" | "never";

// `null` on the item = no expiry concept (plain files, links, plans). A hosted
// page with no TTL is `{ state: "never", expiresAt: null }`.
export type ArtifactExpiry = {
  state: ArtifactExpiryState;
  expiresAt: number | null;
};

export type ArtifactPlanInfo = {
  status: PlanStatus;
  steps: number;
  pageUrl: string | null;
  // Non-null iff `pageUrl` is null.
  pageUrlReason: "other-session" | "no-public-address" | null;
  fileAvailable: boolean;
};

export type ArtifactItem = {
  id: string; // part id (".0/.1" suffixed), "page:<sub>", "outbox:<path>", "plan:<rel>"
  kind: ArtifactKind;
  origin: ArtifactOrigin;
  label: string;
  href: string; // box path, data: URI, or URL
  mime: string | null; // null for links
  size: number | null;
  at: number; // epoch ms
  messageId: string | null; // owning message; null when none
  context: string | null; // links / hosted pages only
  isHosted: boolean; // true only for serve_page rows
  expiry: ArtifactExpiry | null;
  plan: ArtifactPlanInfo | null; // kind "plan" only
};

export type ArtifactCounts = { link: number; image: number; file: number; plan: number };

// Which sources could not be read ("pages" | "outbox" | "directory") or were
// hidden ("public-address": hosted pages omitted — the box has no public URL).
export type ArtifactDegraded = "pages" | "outbox" | "directory" | "public-address";

export type ArtifactsListResult = {
  sessionId: string;
  generatedAt: number; // box clock, ms
  items: ArtifactItem[];
  counts: ArtifactCounts;
  degraded: ArtifactDegraded[];
};
