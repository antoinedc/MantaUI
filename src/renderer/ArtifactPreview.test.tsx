// @vitest-environment jsdom
//
// BET-1156: the inline-media preview removes the dead Attach affordance. The
// ArtifactPreview header renders the Attach (Paperclip) button ONLY when the
// caller passes a real `onAttach`; the inline-media preview passes null, so no
// Attach button — while the Artifacts panel keeps passing one and keeps it.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, type Harness } from "./testHarness";
import { ArtifactPreview } from "./ArtifactPreview";
import type { Artifact } from "./artifacts";

const artifact: Artifact = {
  id: "id",
  kind: "file",
  origin: "agent",
  key: "report.pdf",
  label: "report.pdf",
  href: "/home/dev/outbox/report.pdf",
  mime: "application/pdf",
  size: null,
  at: 0,
  messageId: null,
  context: null,
  expiresAt: null,
};

function preview(props: Partial<Parameters<typeof ArtifactPreview>[0]> = {}) {
  return mount(
    <ArtifactPreview
      artifacts={[artifact]}
      index={0}
      onClose={() => {}}
      onDownload={() => {}}
      onAttach={() => {}}
      {...props}
    />,
  );
}

describe("ArtifactPreview Attach affordance (BET-1156)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.unstubAllGlobals();
  });

  it("hides the Attach button when onAttach is null", () => {
    h = preview({ onAttach: null });
    expect(h.container.querySelector('button[aria-label="Attach"]')).toBeNull();
  });

  it("shows the Attach button when a real onAttach is provided", () => {
    h = preview({ onAttach: () => {} });
    expect(h.container.querySelector('button[aria-label="Attach"]')).toBeTruthy();
  });

  it("keeps the Download button in both cases", () => {
    h = preview({ onAttach: null });
    expect(h.container.querySelector('button[aria-label="Download"]')).toBeTruthy();
  });
});
