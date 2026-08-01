// @vitest-environment jsdom
//
// Component tests for the IconButton chrome primitive (BET-532, stage 3 of
// M527).
//
// As with Card, the primitive's "tokens" are class names that map through
// tailwind.config.js to the design tokens (rounded → --r-xs 4px, p-1 → 4px
// hit-area padding, text-text-faint → --tx3, hover:text-text → --tx1, the
// arbitrary hover:bg-[var(--fill-hover)] → --fill-hover, outline-accent →
// --accent). jsdom loads no stylesheet, so the contract is asserted on the
// exact class strings — a retune of IconButton's chrome fails here
// immediately. The two SessionHeader adopters are migrated below through the
// real exported component.

import { describe, it, expect, afterEach } from "vitest";
import { Terminal, MoreHorizontal } from "lucide-react";
import { mount, type Harness } from "./testHarness";
import { IconButton } from "./IconButton";
import { SessionHeader } from "./SessionHeader";

// The exact chrome string IconButton owns (no className escape hatch means
// every call site renders exactly this).
const CHROME =
  "manta-icon-button inline-flex items-center justify-center rounded p-1 text-text-faint hover:text-text hover:bg-[var(--fill-hover)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

function buttonEl(h: Harness): HTMLButtonElement {
  const el = h.container.querySelector("button") as HTMLButtonElement;
  expect(el).toBeTruthy();
  return el;
}

function iconSize(h: Harness): string | null {
  return h.container.querySelector("svg")?.getAttribute("width") ?? null;
}

describe("IconButton", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the square hit area, --r-xs radius, resting tx3→tx1 hover and --fill-hover bg per the contract", () => {
    h = mount(<IconButton label="Switch" icon={<Terminal />} />);
    const el = buttonEl(h);
    // Square hit area (p-1) + --r-xs radius (rounded) + resting --tx3
    // (text-text-faint) → --tx1 (hover:text-text) on hover with --fill-hover
    // bg, plus the --accent focus ring. All pinned as the exact class string.
    expect(el.className).toBe(CHROME);
    expect(el.className).toContain("rounded");
    expect(el.className).toContain("p-1");
    expect(el.className).toContain("text-text-faint");
    expect(el.className).toContain("hover:text-text");
    expect(el.className).toContain("hover:bg-[var(--fill-hover)]");
    expect(el.className).toContain("outline-accent");
  });

  it("uses the label as the accessible name and hides the decorative icon", () => {
    h = mount(<IconButton label="Terminal" icon={<Terminal />} />);
    const el = buttonEl(h);
    expect(el.getAttribute("aria-label")).toBe("Terminal");
    expect(el.getAttribute("title")).toBe("Terminal");
    expect(iconSize(h)).toBe("16");
    expect(h.container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("supports an explicit title tooltip distinct from the label", () => {
    h = mount(<IconButton label="Terminal" title="Switch to Terminal" icon={<Terminal />} />);
    const el = buttonEl(h);
    expect(el.getAttribute("aria-label")).toBe("Terminal");
    expect(el.getAttribute("title")).toBe("Switch to Terminal");
  });

  it("renders a 16px icon by default (md) and a 20px standalone (lg)", () => {
    h = mount(<IconButton label="A" icon={<Terminal />} />);
    expect(iconSize(h)).toBe("16");
    h.rerender(<IconButton label="A" icon={<Terminal />} size="lg" />);
    expect(iconSize(h)).toBe("20");
  });

  it("passes menu semantics through for a trigger-style icon button", () => {
    h = mount(
      <IconButton label="Session actions" icon={<MoreHorizontal />} ariaHaspopup="menu" ariaExpanded />,
    );
    const el = buttonEl(h);
    expect(el.getAttribute("aria-haspopup")).toBe("menu");
    expect(el.getAttribute("aria-expanded")).toBe("true");
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // If IconButton ever grew a className prop this directive becomes unused
    // and typecheck fails — the standing-decision-3 guard lives in the types.
    // @ts-expect-error — IconButton must NOT accept className (M527 decision 3)
    void <IconButton label="x" icon={<Terminal />} className="bg-red-500" />;
    expect(true).toBe(true);
  });
});

describe("IconButton migration — SessionHeader call sites (BET-532 two-adopter rule)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  // Minimal SessionHeader props rendering BOTH adopted controls: the mode
  // toggle (onModeChange set) and the session-menu trigger (hasSession, not
  // readOnly). totalInput 0 hides the context pill so it doesn't add buttons.
  function renderHeader() {
    return mount(
      <SessionHeader
        branch={null}
        ctxBreakdown={{ freshInput: 0, cacheRead: 0, cacheWrite: 0, totalInput: 0, pct: 0, segments: [] }}
        ctxLimit={0}
        staleCache={{ isStale: false, idleMs: 0, staleTokens: 0, ttlMs: 0 }}
        modelName={null}
        hasSession
        onFork={() => {}}
        onCompact={() => {}}
        onClear={() => {}}
        onDelete={() => {}}
        breadcrumb={null}
        mode="chat"
        onModeChange={() => {}}
      />,
    );
  }

  it("mode toggle renders through IconButton's chrome with no unintended change", () => {
    h = renderHeader();
    const els = Array.from(h!.container.querySelectorAll("button"));
    expect(els.length).toBe(2);
    const modeToggle = els[0];
    // Same chrome class + same accessible name/title as the pre-migration
    // button (aria-label names the mode you switch TO from chat: Terminal).
    expect(modeToggle.className).toBe(CHROME);
    expect(modeToggle.getAttribute("aria-label")).toBe("Terminal");
    expect(modeToggle.getAttribute("title")).toBe("Switch to Terminal");
    expect(modeToggle.querySelector("svg")?.getAttribute("width")).toBe("16");
  });

  it("session-menu trigger renders through IconButton with its menu semantics", () => {
    h = renderHeader();
    const els = Array.from(h!.container.querySelectorAll("button"));
    const trigger = els[1];
    expect(trigger.className).toBe(CHROME);
    expect(trigger.getAttribute("aria-label")).toBe("Session actions");
    expect(trigger.getAttribute("title")).toBe("Session actions");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.querySelector("svg")?.getAttribute("width")).toBe("16");
  });

  it("does not inject arbitrary classes into the migrated call sites", () => {
    h = renderHeader();
    for (const el of h!.container.querySelectorAll("button")) {
      expect(el.className).toBe(CHROME);
    }
  });
});
