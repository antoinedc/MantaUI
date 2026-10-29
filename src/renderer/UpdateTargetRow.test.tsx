// @vitest-environment jsdom
//
// WS11 D3 review #1/#10: a box/CLI update row renders the BOX's words, a failed check is "Couldn't check"
// (never the old-box note), and only a verdict without `view` is an older box.
import { describe, it, expect, afterEach } from "vitest";
import { mount, type Harness } from "./testHarness";
import { UpdateTargetRow } from "./Settings";
import type { UpdateTarget } from "../shared/types";

let h: Harness | null = null;
afterEach(() => {
  h?.unmount();
  h = null;
});

const base = (over: Partial<UpdateTarget>): UpdateTarget =>
  ({ id: "server", label: "Manta Server", current: "1.0.0", latest: null, available: false, ok: true, manual: false, disruption: "reconnect", ...over }) as UpdateTarget;

const show = (target: UpdateTarget) => {
  h = mount(
    <UpdateTargetRow target={target} desktopBusy={null} installReady={false} onUpdate={() => {}} rowState={{ kind: "idle" }} error={null} />,
  );
  return h.text();
};

describe("UpdateTargetRow", () => {
  it("a failed check says Couldn't check and never tells the user to update their box", () => {
    const text = show(base({ ok: false }));
    expect(text).toContain("Couldn't check");
    expect(text).not.toContain("Update your box");
  });

  it("a verdict without `view` (an older box) shows the update note", () => {
    expect(show(base({ ok: true }))).toContain("Update your box to use this");
  });

  it("renders the box's text and version text as given", () => {
    const text = show(base({ current: null, latest: "2.0.0", view: { tone: "action", text: "Update available", hasUpdate: true, versionText: "→ box-says 2.0.0" } }));
    expect(text).toContain("→ box-says 2.0.0");
    expect(text).toContain("Update");
  });

  it("the box's 'up to date' wording is shown, not a local string", () => {
    const text = show(base({ view: { tone: "ok", text: "Up to date (box)", hasUpdate: false, versionText: "1.0.0" } }));
    expect(text).toContain("Up to date (box)");
  });
});
