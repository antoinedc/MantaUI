// @vitest-environment jsdom
//
// Component tests for the Pill chrome primitive (BET-534, stage 5 of M527).
//
// As with Card/Field/IconButton, the primitive's "tokens" are class names
// that map through tailwind.config.js to the design tokens (rounded-full →
// --r-full, bg-accent-bg → --accent-bg, text-text-muted → --tx2,
// text-accent → --accent, px-2/py-px → sp-2 / the pill's 1px breathing room,
// text-meta → 12px). jsdom loads no stylesheet, so the contract is asserted
// on the exact class strings — a retune of Pill's chrome fails here.
//
// The two-stage C4 guard is load-bearing: `tone` is a REQUIRED prop with no
// default (a bare `<Pill>` must be a TYPE error, not invisible text), and
// Pill must not accept `className` (standing decision 3).

import { describe, it, expect, afterEach } from "vitest";
import { Zap } from "lucide-react";
import { mount, type Harness } from "./testHarness";
import { Pill } from "./Pill";
import { SessionHeader } from "./SessionHeader";
import { QuestionCard } from "./Cards";
import type { QuestionRequest } from "../shared/types";

const PILL_BASE = "inline-flex items-center gap-2 rounded-full px-2 py-px font-semibold";

function pillEl(h: Harness): HTMLElement {
  const el = h.container.querySelector("span.rounded-full") as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe("Pill", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("renders the capsule --r-full radius, sp-2 padding and gap per the contract", () => {
    h = mount(<Pill tone="neutral">meta</Pill>);
    const el = h.container.firstElementChild as HTMLElement;
    expect(el.className).toBe(`${PILL_BASE} text-meta text-text-muted`);
    expect(el.className).toContain("rounded-full");
    expect(el.className).toContain("px-2");
    expect(el.className).toContain("py-px");
    expect(el.className).toContain("gap-2");
  });

  it("accent tone renders the --accent-bg surface with a matching --accent foreground (C1)", () => {
    h = mount(<Pill tone="accent">Recommended</Pill>);
    const el = pillEl(h);
    expect(el.className).toContain("bg-accent-bg");
    expect(el.className).toContain("text-accent");
  });

  it("warn tone renders the --warn-bg surface with a matching --warn foreground (C1)", () => {
    h = mount(<Pill tone="warn">stale</Pill>);
    const el = pillEl(h);
    expect(el.className).toContain("bg-warn-bg");
    expect(el.className).toContain("text-warn");
  });

  it("ok tone renders the --ok-bg surface with a matching --ok foreground (C1)", () => {
    h = mount(<Pill tone="ok">Recommended</Pill>);
    const el = pillEl(h);
    expect(el.className).toContain("bg-ok-bg");
    expect(el.className).toContain("text-ok");
  });

  it("neutral tone sets no background and reads as a muted label (inherits its surface)", () => {
    h = mount(<Pill tone="neutral">label</Pill>);
    const el = pillEl(h);
    expect(el.className).not.toContain("bg-");
    expect(el.className).toContain("text-text-muted");
  });

  it("border flag adds the optional --border edge", () => {
    h = mount(<Pill tone="neutral" border>edge</Pill>);
    const el = pillEl(h);
    expect(el.className).toContain("border");
    expect(el.className).toContain("border-border");
  });

  it("renders a leading icon at 14px, hidden from the a11y tree", () => {
    h = mount(
      <Pill tone="neutral" icon={<Zap />}>
        active
      </Pill>,
    );
    const svg = h.container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("14");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(pillEl(h).textContent).toContain("active");
  });

  it("size=label renders the 13px standing-tag size (vs meta default)", () => {
    h = mount(<Pill tone="accent" size="label">Recommended</Pill>);
    expect((h.container.firstElementChild as HTMLElement).className).toContain("text-label");
  });

  it("tone is REQUIRED with no default — a bare Pill is a type error (C4)", () => {
    // If Pill ever grew a default tone this directive becomes unused and
    // typecheck fails — the abstract-base-is-not-a-variant guard (C4) lives
    // in the types.
    // @ts-expect-error — Pill MUST NOT default tone (M527 C4)
    void <Pill>invisible text</Pill>;
    expect(true).toBe(true);
  });

  it("has no className escape hatch — the prop is not accepted (compile-time)", () => {
    // If Pill ever grew a className prop this directive becomes unused and
    // typecheck fails — the standing-decision-3 guard lives in the types.
    // @ts-expect-error — Pill must NOT accept className (M527 decision 3)
    void <Pill tone="neutral" className="bg-red-500">x</Pill>;
    expect(true).toBe(true);
  });
});

describe("Pill migration — ContextPill call site (BET-534 two-adopter rule)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  function renderHeader(stale: boolean, staleTokens = 0) {
    return mount(
      <SessionHeader
        branch={null}
        ctxBreakdown={{ freshInput: 1, cacheRead: 1, cacheWrite: 1, totalInput: 100, pct: 12, segments: [] }}
        ctxLimit={200000}
        staleCache={{ isStale: stale, idleMs: stale ? 3_600_000 : 0, staleTokens, ttlMs: 3_600_000 }}
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

  function pillSpan(): HTMLElement {
    const btn = h!.container.querySelector("button.manta-ctx-pill") as HTMLElement;
    expect(btn).toBeTruthy();
    // The Pill is the button's root child (the popover span only mounts when
    // open). Its chrome is the pill's, distinct from the button's interaction
    // wrapper.
    const pill = btn.querySelector("span") as HTMLElement;
    expect(pill).toBeTruthy();
    return pill;
  }

  it("non-stale ContextPill renders through Pill's neutral chrome with no tint", () => {
    h = renderHeader(false);
    const pill = pillSpan();
    expect(pill.className).toContain("rounded-full");
    expect(pill.className).toContain("px-2");
    expect(pill.className).toContain("text-text-muted");
    expect(pill.className).not.toContain("bg-");
    // The % metric still renders.
    expect(pill.textContent).toContain("12%");
  });

  it("stale ContextPill renders through Pill's warn chrome (the canonical warn pill)", () => {
    h = renderHeader(true);
    const pill = pillSpan();
    expect(pill.className).toContain("bg-warn-bg");
    expect(pill.className).toContain("text-warn");
  });

  it("stale ContextPill carries the cold token count inside the pill (BET-968)", () => {
    h = renderHeader(true, 344_000);
    const pill = pillSpan();
    expect(pill.textContent).toContain("344k cold");
    // The cold chip inherits the Pill's warn foreground — no inline colour.
    const cold = [...pill.querySelectorAll("span")].find((s) =>
      s.textContent?.includes("cold"),
    ) as HTMLElement;
    expect(cold).toBeTruthy();
    expect(cold.textContent).toContain("344k");
    expect(cold.textContent).toContain("cold");
  });

  it("non-stale ContextPill does not render a cold chip (BET-968)", () => {
    h = renderHeader(false, 344_000);
    const pill = pillSpan();
    expect(pill.textContent).not.toContain("cold");
  });

  it("does not inject arbitrary classes into the migrated context-pill call site", () => {
    h = renderHeader(false);
    const btn = h!.container.querySelector("button.manta-ctx-pill") as HTMLElement;
    // Button keeps only identity + the interactive wrapper (no old hand-rolled
    // pill chrome), and the Pill span carries only Pill-owned classes.
    expect(btn.className).not.toContain("inline-flex");
    expect(btn.className).not.toContain("py-px");
    expect(pillSpan().className).not.toContain("bg-red-500");
  });
});

describe("Pill migration — Recommended option tag (BET-534 two-adopter rule)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const question: QuestionRequest = {
    id: "q1",
    sessionID: "s1",
    requestId: "que_1",
    questions: [
      {
        question: "Pick one",
        header: "CSV export",
        options: [
          { label: "A", description: "option a" },
          // The "(Recommended)" suffix convention drives `recommended: true`
          // (Cards.tsx parses it off and badges the option).
          { label: "B (Recommended)", description: "option b" },
        ],
      },
    ],
  };

  it("Recommended tag renders through Pill's GREEN ok chrome at the label size (BET redesign)", () => {
    h = mount(<QuestionCard request={question} onReply={() => {}} onReject={() => {}} />);
    const pill = Array.from(h.container.querySelectorAll("span.rounded-full")).find(
      (el) => el.textContent === "Recommended",
    ) as HTMLElement;
    expect(pill).toBeTruthy();
    // The redesign moves the Recommended tag from accent (blue) to ok (green)
    // and places it inline; the capsule radius + label size are preserved.
    expect(pill.className).toContain("rounded-full");
    expect(pill.className).not.toContain("rounded-xs");
    expect(pill.className).toContain("bg-ok-bg");
    expect(pill.className).toContain("text-ok");
    expect(pill.className).not.toContain("bg-accent-bg");
    expect(pill.className).toContain("text-label");
    expect(pill.className).toContain("px-2");
  });
});
