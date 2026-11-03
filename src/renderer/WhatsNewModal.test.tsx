// @vitest-environment jsdom
//
// The "What's new" window: B (highlight cards) when the newest entry carries a
// highlights block, A (release notes) otherwise. Every control is asserted to
// DO something visible — a card link performs its action and closes, an action
// this build cannot perform shows no link, "Full changelog" opens the browser
// and reports a failure.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { installMockApi, mount, resetStore, type Harness } from "./testHarness";
import { useStore } from "./store";
import {
  CHANGELOG_URL,
  WhatsNewModal,
  countSmallerChanges,
  resolveWhatsNewAction,
  stripShips,
} from "./WhatsNewModal";
import type { ChangelogEntry } from "../shared/api";
import { NOTES_ENTRY, OLDER_ENTRY, ROUTINES_ENTRY } from "./whatsNewFixtures";

describe("WhatsNewModal", () => {
  let h: Harness | null = null;
  let api: ReturnType<typeof installMockApi>["api"];

  beforeEach(() => {
    resetStore();
    ({ api } = installMockApi());
  });
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const open = (
    entries: ChangelogEntry[],
    extra: Partial<React.ComponentProps<typeof WhatsNewModal>> = {},
  ) => {
    const onClose = vi.fn();
    h = mount(<WhatsNewModal entries={entries} previous={null} onClose={onClose} {...extra} />);
    return onClose;
  };
  const text = () => h!.docText();
  const button = (label: string | RegExp): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      typeof label === "string" ? (b.textContent ?? "").trim() === label : label.test(b.textContent ?? ""),
    );
  const click = (el: HTMLElement | undefined) => {
    expect(el, "control to click").toBeTruthy();
    act(() => el!.click());
  };

  describe("B — the newest entry has highlights", () => {
    it("shows the hero, every card with its icon, and a collapsed notes row", () => {
      open([ROUTINES_ENTRY], { onOpenRoutines: () => {}, onOpenSettings: () => {} });
      expect(text()).toContain("MANTA 1.4.0");
      expect(text()).toContain("Routines are here");
      expect(text()).toContain("New on your server.");
      for (const t of ["Routines", "Cheaper handoffs", "Catching up"]) expect(text()).toContain(t);
      expect(document.body.querySelectorAll("h3").length).toBe(3);
      expect(document.body.querySelectorAll("svg").length).toBeGreaterThanOrEqual(3);
      // 6 bullets in the notes, 3 of them are cards.
      expect(text()).toContain("+ 3 smaller changes");
      expect(text()).not.toContain("Scheduled work in its own fresh session");
    });

    it("See all expands the notes in place (and Hide collapses them); Ships: is dropped", () => {
      open([ROUTINES_ENTRY]);
      click(button("See all"));
      expect(text()).toContain("Scheduled work in its own fresh session");
      expect(text()).not.toContain("Ships:");
      expect(text()).not.toContain("server-v12");
      click(button("Hide"));
      expect(text()).not.toContain("Scheduled work in its own fresh session");
    });

    it("older unseen entries are a quiet footer line whose link expands their notes", () => {
      open([ROUTINES_ENTRY, NOTES_ENTRY, OLDER_ENTRY]);
      expect(text()).toContain("Also new since you last looked: 1.3.0, 1.2.0");
      expect(text()).not.toContain("Conversations are placed by weekly-quota deadline");
      click(button("See notes"));
      expect(text()).toContain("Conversations are placed by weekly-quota deadline");
      expect(text()).toContain("Enter sends now");
    });

    it("a card with no action has no link", () => {
      open([ROUTINES_ENTRY], { onOpenRoutines: () => {}, onOpenSettings: () => {} });
      expect(button(/Open Routines/)).toBeTruthy();
      expect(button(/Open Models settings/)).toBeTruthy();
      // three cards, two with an action
      expect(document.body.querySelectorAll("h3 ~ button").length).toBe(2);
    });

    it("a routines card performs its action, then closes", () => {
      const order: string[] = [];
      const onClose = vi.fn(() => order.push("close"));
      h = mount(
        <WhatsNewModal
          entries={[ROUTINES_ENTRY]}
          previous={null}
          onClose={onClose}
          onOpenRoutines={() => order.push("routines")}
          onOpenSettings={() => order.push("settings")}
        />,
      );
      click(button(/Open Routines/));
      expect(order).toEqual(["routines", "close"]);
    });

    it("a settings card opens Settings at its section, then closes", () => {
      const onOpenSettings = vi.fn();
      const onClose = open([ROUTINES_ENTRY], { onOpenSettings, onOpenRoutines: () => {} });
      click(button(/Open Models settings/));
      expect(onOpenSettings).toHaveBeenCalledWith("models");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("an action this build cannot perform shows no link", () => {
      const entry: ChangelogEntry = {
        ...ROUTINES_ENTRY,
        highlights: [
          { title: "A", icon: "zap", text: "routines but no handler", action: "routines" },
          { title: "B", icon: "zap", text: "gated section", action: "settings:cto" },
          { title: "C", icon: "zap", text: "unknown section", action: "settings:nope" },
          { title: "D", icon: "zap", text: "not an action", action: "https://example.com" },
        ],
      };
      open([entry], { onOpenSettings: () => {} });
      expect(document.body.querySelectorAll("h3 ~ button").length).toBe(0);
      expect(text()).not.toContain("Open ");
    });

    it("an unknown icon falls back to the default instead of breaking the card", () => {
      const entry: ChangelogEntry = { ...ROUTINES_ENTRY, highlights: [{ title: "Odd", icon: "no-such-icon", text: "x", action: null }] };
      open([entry]);
      expect(text()).toContain("Odd");
      expect(document.body.querySelector("h3")!.parentElement!.querySelector("svg")).not.toBeNull();
    });

    it("up to three cards are laid out in that many columns", () => {
      open([{ ...ROUTINES_ENTRY, highlights: ROUTINES_ENTRY.highlights.slice(0, 2) }]);
      const grid = [...document.body.querySelectorAll<HTMLElement>("div")].find((d) => d.style.gridTemplateColumns);
      expect(grid?.style.gridTemplateColumns).toContain("repeat(2");
    });
  });

  describe("A — no highlights", () => {
    it("shows the eyebrow with the version it moves from, title, chips (Server/Desktop only) and the notes", () => {
      open([NOTES_ENTRY], { previous: "1.2.0" });
      expect(text()).toContain("UPDATED · 1.2.0 → 1.3.0");
      expect(text()).toContain("What's new in Manta 1.3.0");
      expect(text()).toContain("Server");
      expect(text()).toContain("Desktop");
      expect(text()).not.toMatch(/\bios\b/i);
      expect(text()).toContain("Oct 30, 2026");
      expect(text()).toContain("Conversations are placed by weekly-quota deadline");
      expect(text()).not.toContain("Ships:");
    });

    it("omits the from-part when no earlier version is known", () => {
      open([NOTES_ENTRY]);
      expect(text()).toContain("UPDATED · 1.3.0");
      expect(text()).not.toContain("→ 1.3.0");
    });

    it("stacks every entry's notes, newest first, each under its version", () => {
      open([NOTES_ENTRY, OLDER_ENTRY]);
      const t = text();
      expect(t.indexOf("Conversations are placed")).toBeGreaterThan(-1);
      expect(t.indexOf("Enter sends now")).toBeGreaterThan(t.indexOf("Conversations are placed"));
      expect(t).toContain("1.3.0");
      expect(t).toContain("1.2.0");
    });

    it("a Box-only entry gets the Server chip", () => {
      open([OLDER_ENTRY]);
      expect(text()).toContain("Server");
      expect(text()).not.toMatch(/\bBox\b/);
    });
  });

  describe("footer and closing", () => {
    it("Got it closes", () => {
      const onClose = open([NOTES_ENTRY]);
      click(button("Got it"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Escape closes", () => {
      const onClose = open([NOTES_ENTRY]);
      const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
      act(() => {
        dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Full changelog opens the GitHub page externally", async () => {
      open([NOTES_ENTRY]);
      click(button(/Full changelog/));
      await h!.flush();
      expect(api.calls.openExternal.at(-1)).toEqual([CHANGELOG_URL]);
      expect(CHANGELOG_URL).toBe("https://github.com/antoinedc/MantaUI/blob/main/CHANGELOG.md");
    });

    it("Full changelog reports a failure instead of doing nothing", async () => {
      installMockApi({ openExternal: () => Promise.reject(new Error("no browser")) });
      open([NOTES_ENTRY]);
      click(button(/Full changelog/));
      await h!.flush();
      expect(useStore.getState().appToasts.some((t) => t.tone === "error" && String(t.message).includes("changelog"))).toBe(true);
    });
  });
});

describe("pure helpers", () => {
  it("stripShips drops only the Ships paragraph", () => {
    expect(stripShips("### A\n\n- one\n\nShips: `x`")).toBe("### A\n\n- one");
    expect(stripShips("Ships: `x`")).toBe("");
    expect(stripShips("Shipping soon")).toBe("Shipping soon");
  });

  it("countSmallerChanges counts top-level bullets less the cards", () => {
    expect(countSmallerChanges("- a\n- b\n  - nested\n- c", 1)).toBe(2);
    expect(countSmallerChanges("- a", 3)).toBe(0);
    expect(countSmallerChanges("no bullets", 0)).toBe(0);
  });

  it("resolveWhatsNewAction needs the allowlist AND a handler", () => {
    const run = () => {};
    expect(resolveWhatsNewAction("routines", { onOpenRoutines: run })?.label).toBe("Open Routines");
    expect(resolveWhatsNewAction("routines", {})).toBeNull();
    expect(resolveWhatsNewAction("settings:voice", { onOpenSettings: run })?.label).toBe("Open Voice settings");
    expect(resolveWhatsNewAction("settings:voice", {})).toBeNull();
    expect(resolveWhatsNewAction("settings:cto", { onOpenSettings: run })).toBeNull();
    expect(resolveWhatsNewAction(null, { onOpenRoutines: run })).toBeNull();
  });
});
