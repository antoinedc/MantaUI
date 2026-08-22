// @vitest-environment jsdom
//
// routingControls.smoke.test.tsx — the routing control smoke (BET-1277 13a).
//
// AGENTS.md's "NEVER STUB A CONTROL TO DO NOTHING" section exists because this
// feature shipped that exact defect twice with a fully green suite: a Refresh
// button that discarded its result, and a checkbox hardcoded to `checked`.
// Ordinary unit tests can't catch that class — each handler is exercised with
// the happy-path expectation already baked into the same file. This smoke
// inverts the question: it DRIVES every interactive element the fixture's rows
// render (button / input / [role=option] / [role=menuitem]) and asserts the
// NEGATION of the defect — "pressing this changed nothing observable". Each
// control must do one of:
//   1. make an RPC call through the mocked transport (recorded in api.calls),
//   2. change the rendered DOM observably, or
//   3. for a presentational component (ModelMenu / ModelPicker, whose seam IS
//      the callbacks supplied by the caller, not window.api) fire one of those
//      callbacks — the callback is that control's transport.
//
// A control that is legitimately inert in a given fixture state (a disabled
// Save, a segment with nothing to select) is declared in an EXPLICIT allowlist
// with a one-line reason — the demoCoverage.test.ts inventory pattern. A
// disabled / read-only control is auto-allowed WITH a reason (outcome 3 of the
// NEVER-STUB rule: it isn't rendered dead, it reports its state); ANYTHING ELSE
// that no-ops must be allowlisted or this test fails, naming the control and
// that it has NO reason to be inert.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import {
  mount,
  installMockApi,
  resetStore,
  type MockApi,
  type Harness,
} from "./testHarness";
import { invalidateCachedResource } from "./useCachedResource";
import { _resetRoutingCatalogCache } from "./routingCatalog";
import { AccountsCard } from "./AccountsCard";
import { ModelsCard } from "./ModelsCard";
import { ModelsWeCouldntIdentify } from "./ModelsWeCouldntIdentify";
import { ModelMenu } from "./ModelMenu";
import { ModelPicker } from "./ModelPicker";
import type { OpencodeModel } from "../shared/types";

// ===== shared smoke driver =====

// Every interactive element the fixtures render. `[role=option]` / `[role=menuitem]`
// are also <button>s; querySelectorAll returns each node once regardless of how
// many selector groups it matches.
const INTERACTIVE =
  'button, input, textarea, select, [role="option"], [role="menuitem"], [role="radio"], [role="checkbox"], [role="switch"]';

// A stable, human-readable id for a control so an allowlist entry can name it.
function controlId(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role") ?? "";
  const type = (el as HTMLInputElement).type ?? "";
  const aria = el.getAttribute("aria-label") ?? "";
  const name = (el as HTMLInputElement).name ?? "";
  const placeholder = (el as HTMLInputElement).placeholder ?? "";
  const hook =
    (Array.from(el.classList).find((c) => c.startsWith("manta-")) as string) ??
    "";
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
  return [tag, role, type, aria, name, placeholder, hook, text].filter(Boolean).join("|");
}

// Drive a React onChange for a text/number/password field. React 18 owns its
// synthetic events, so a plain `value =` + dispatch is ignored; the native
// setter + bubble is the reliable path.
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? (window as unknown as { HTMLTextAreaElement: { prototype: HTMLTextAreaElement } })
          .HTMLTextAreaElement.prototype
      : (window as unknown as { HTMLInputElement: { prototype: HTMLInputElement } })
          .HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// The "user" interaction for a control. Buttons / role=option / menuitem /
// role=radio get a click; the M527 Checkbox renders a real input as sr-only
// inside a <label>, so a real user clicks the visible box — drive that path,
// not the hidden input (BET-1199; the same reason clickCheckbox exists).
function press(el: Element): void {
  act(() => {
    const role = el.getAttribute("role");
    if (
      el instanceof HTMLButtonElement ||
      role === "option" ||
      role === "menuitem" ||
      role === "radio" ||
      role === "checkbox" ||
      role === "switch"
    ) {
      (el as HTMLButtonElement).click();
    } else if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") {
        const box = el.closest("label")?.querySelector('span[aria-hidden="true"]');
        if (box) box.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        else el.click();
      } else {
        setNativeValue(el, el.type === "number" ? "123" : "a");
      }
    } else if (el instanceof HTMLTextAreaElement) {
      setNativeValue(el, "a");
    } else {
      (el as HTMLElement).click();
    }
  });
}

type Finding = {
  id: string;
  changed: boolean;
  disabled: boolean;
  reason?: string;
};

/**
 * Drive every interactive element currently (or newly, after a press) rendered
 * by a mounted surface, asserting each one produces a signal or is allowlisted.
 *
 * The signal for a surface is a serialized string built from its RPC call
 * record (api.calls), the rendered DOM (document.body — portals included) and,
 * for the presentational menues, a callback counter. A control whose signal is
 * byte-identical before and after the press "did nothing" — the exact defect.
 */
async function smokeDrive(opts: {
  h: Harness;
  surface: string;
  signal: () => string;
  allowlist?: Record<string, string>;
  /** Which DOM to drive. "container" (default derived per call) = only the
   *  mounted component's own subtree — used by the data cards, whose nested
   *  dialogs / popups are portaled to <body> and would otherwise be driven
   *  in states they never reach under a single-pass jsdom drive. The SIGNAL
   *  always includes <body>, so a card control that opens a portal still
   *  counts as "did something". "document" = the whole body (used by the
   *  presentational menus, whose entire surface is portaled). */
  scope?: "container" | "document";
}): Promise<void> {
  const { h, surface, allowlist = {} } = opts;
  const scope = opts.scope ?? "document";
  const seen = new Set<string>();
  const queue: Element[] = [];
  const findings: Finding[] = [];

  const enqueue = () => {
    const root = scope === "container" ? h.container : document.body;
    for (const el of Array.from(root.querySelectorAll<Element>(INTERACTIVE))) {
    const id = controlId(el);
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(el);
    }
  };
  enqueue();

  // Bound the total interactions so a control that keeps re-appearing with a
  // new id (e.g. a busy spinner cycling its label) can never loop the drive
  // forever. The seen-set already prevents re-driving the same id.
  const budget = 250;
  let steps = 0;

  while (queue.length > 0 && steps < budget) {
    const el = queue.shift()!;
    steps++;
    const id = controlId(el);

    // A control removed by an earlier step (a row deleted, a menu closed) is
    // no longer rendered — outcome 3 ("it isn't there"), nothing to assert.
    if (!el.isConnected) continue;

    const disabled =
      (el instanceof HTMLButtonElement && el.disabled) ||
      (el instanceof HTMLInputElement && (el.disabled || el.readOnly)) ||
      el.getAttribute("aria-disabled") === "true";

    if (disabled) {
      findings.push({
        id,
        changed: false,
        disabled: true,
        reason:
          allowlist[id] ??
          `${surface}: control disabled / read-only in this fixture — inert by design (outcome 3)`,
      });
      continue;
    }

    const before = opts.signal();
    press(el);
    await h.flush();
    const after = opts.signal();
    const changed = before !== after;
    findings.push({
      id,
      changed,
      disabled: false,
      reason: changed ? undefined : allowlist[id],
    });
    enqueue();
  }

  for (const f of findings) {
    const msg =
      `${surface}: control "${f.id}" was ${f.disabled ? "disabled" : "pressed"} and produced NO observable ` +
      `change — no RPC call, no DOM change${f.disabled ? "" : ", no callback"} — the 'stubbed control' ` +
      `defect. Reason: ${f.reason ?? "NONE (not allowlisted)"}`;
    expect(f.changed || f.reason !== undefined, msg).toBe(true);
  }
}

/**
 * A snapshot of the rendered DOM that CAN see a React-controlled input change.
 * `outerHTML` alone is blind to a controlled input's new value (React writes
 * `.value` / `.checked` as properties, which serialization does not reflect),
 * so we fold in every field's current value + checked state.
 */
function domSignal(): string {
  const fields = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input, textarea, select",
    ),
  ).map((e) => `${e.tagName}::${e.value}::${(e as HTMLInputElement).checked}`);
  return JSON.stringify({ html: document.body.outerHTML, fields });
}

/** Serialize a surface's RPC record + rendered DOM into one signal string. */
function rpcDomSignal(api: MockApi): () => string {
  return () => JSON.stringify({ rpc: api.calls, dom: domSignal() });
}

// ===== shared fixtures =====

const ENTRIES = [
  { id: "custom/qwen3.5-72b", name: "Qwen3.5 72B", family: "qwen", description: "A 72B model." },
  { id: "acme/claude-haiku-4", name: "Claude Haiku 4", family: "haiku", limit: { context: 200000 } },
  { id: "x/ornith-nano", name: "Ornith Nano", family: "ornith" },
  { id: "x/ornith-small", name: "Ornith Small", family: "ornith" },
  { id: "x/ornith-medium", name: "Ornith Medium", family: "ornith" },
  { id: "x/ornith-large", name: "Ornith Large", family: "ornith" },
];

// One model per identity case (models.dev catalogue fixtures).
const EXACT_MODEL = {
  providerID: "acme",
  id: "my-endpoint",
  family: "claude-haiku-4",
  name: "My Endpoint",
  cost: { cacheRead: 0.3, cacheWrite: 0.3 },
};
const AMBIG_MODEL = { providerID: "custom", id: "ornith", family: "ornith", name: "Ornith" };
const NONE_MODEL = { providerID: "custom", id: "default-model", family: "", name: "Default" };

const SONNET: OpencodeModel = {
  providerID: "anthropic",
  id: "claude-sonnet-4",
  name: "Sonnet",
  capabilities: { input: ["text"] },
};
const OPUS: OpencodeModel = {
  providerID: "anthropic",
  id: "claude-opus-4",
  name: "Opus",
  capabilities: { input: ["text"] },
  variants: [{ id: "high" }, { id: "low" }],
};

// ===== 1. AccountsCard =====

describe("control smoke — AccountsCard", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    document.body.replaceChildren();
    h = null;
  });

  const ACCOUNTS_INERT: Record<string, string> = {
    "button|button|Probe endpoint": "Add-endpoint Probe is disabled until name + baseURL are entered (draftErr gate)",
  };

  it("every control it renders does something observable", async () => {
    resetStore();
    invalidateCachedResource("accounts");
    const { api } = installMockApi({
      opencodeProviderAuth: () =>
        Promise.resolve({
          action: "status" as const,
          providers: [
            { id: "anthropic", label: "Claude", plan: "Max 20x", console: null, docs: "", connected: true },
          ],
        }),
      opencodeGetProviders: () =>
        Promise.resolve([
          { id: "voska", name: "VoskaAI", baseURL: "https://api.voska.org/v1", hasApiKey: true, enabledModels: ["alpha"] },
        ]),
      accountHealth: () => Promise.resolve({}),
      configGet: () => Promise.resolve({}),
      opencodeSetProviders: () => Promise.resolve({ ok: true }),
      opencodeDiscoverModels: () =>
        Promise.resolve({ ok: true, models: [{ id: "alpha" }, { id: "beta" }] }),
      accountsRetry: () => Promise.resolve({ ok: true, state: "ok", message: "x" }),
      opencodeModelCatalog: () =>
        Promise.resolve({ supported: true, size: ENTRIES.length, entries: ENTRIES }),
    });
    _resetRoutingCatalogCache();
    h = mount(<AccountsCard />);
    await h.flush();
    await h.flush();
    await smokeDrive({ h, surface: "AccountsCard", scope: "container", signal: rpcDomSignal(api), allowlist: ACCOUNTS_INERT });
  });
});

// ===== 2. ModelsCard =====

describe("control smoke — ModelsCard", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    document.body.replaceChildren();
    h = null;
  });

  it("every control it renders does something observable", async () => {
    resetStore();
    invalidateCachedResource("models");
    const { api } = installMockApi({
      opencodeModels: () => Promise.resolve([{ ...SONNET }, { ...OPUS }]),
      configGet: () => Promise.resolve({}),
      opencodeSyncSubagents: () => Promise.resolve([]),
      opencodeModelCatalog: () =>
        Promise.resolve({ supported: true, size: ENTRIES.length, entries: ENTRIES }),
    });
    h = mount(<ModelsCard />);
    await h.flush();
    await h.flush();
    await smokeDrive({
      h,
      surface: "ModelsCard",
      scope: "container",
      signal: rpcDomSignal(api),
      // No allowlist: with scope "container" only the table surface is driven,
      // and every live table control (search / default radio / Main / Sub /
      // Edit) must produce a signal. The edit modal is a nested dialog portaled
      // to <body>, so its save/validate — already unit-tested — is intentionally
      // out of this smoke's reach.
    });
  });
});

// ===== 3. ModelsWeCouldntIdentify =====

describe("control smoke — ModelsWeCouldntIdentify", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    document.body.replaceChildren();
    h = null;
  });

  it("every control it renders does something observable", async () => {
    resetStore();
    invalidateCachedResource("modelsWeCouldntIdentify");
    const { api } = installMockApi({
      opencodeModels: () => Promise.resolve([EXACT_MODEL, AMBIG_MODEL, NONE_MODEL]),
      configGet: () => Promise.resolve({}),
      opencodeModelCatalog: () =>
        Promise.resolve({ supported: true, size: ENTRIES.length, entries: ENTRIES }),
    });
    _resetRoutingCatalogCache();
    h = mount(<ModelsWeCouldntIdentify />);
    await h.flush();
    await h.flush();
    await smokeDrive({
      h,
      surface: "ModelsWeCouldntIdentify",
      scope: "container",
      signal: rpcDomSignal(api),
      allowlist: {
        // The Caching group defaults to "None" — the active chip is already
        // selected, so re-pressing it is inert by definition. "Custom" shifts
        // state; "None" when it is the current value cannot.
        "button|button|None":
          "caching 'None' is the default selection; pressing the already-active chip is a no-op",
      },
    });
  });
});

// ===== 4. ModelMenu =====

describe("control smoke — ModelMenu", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    document.body.replaceChildren();
    h = null;
  });

  const anchorRef = () => ({ current: null }) as React.RefObject<HTMLButtonElement>;

  it("every control it renders does something observable", async () => {
    let cb = 0;
    const bump = () => {
      cb++;
    };
    const GROUPS: Array<[string, OpencodeModel[]]> = [
      ["anthropic", [{ ...SONNET }]],
      [
        "retired",
        [{ ...SONNET, id: "legacy-model", name: "Legacy", status: "deprecated" }],
      ],
    ];
    h = mount(
      <ModelMenu
        open
        anchorRef={anchorRef()}
        groups={GROUPS}
        modelOverride={null}
        defaultModel={{ providerID: "anthropic", modelID: "claude-sonnet-4" }}
        disabledKeys={["retired/legacy-model"]}
        onEnableDeprecated={bump}
        onSelectAuto={bump}
        onSelect={bump}
        onClose={bump}
      />,
    );
    await h.flush();
    const signal = () => JSON.stringify({ cb, dom: domSignal() });
    await smokeDrive({ h, surface: "ModelMenu", signal });
  });
});

// ===== 5. ModelPicker =====

describe("control smoke — ModelPicker", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    document.body.replaceChildren();
    h = null;
  });

  const MODELPICKER_INERT: Record<string, string> = {
    "button||||manta-fast-toggle-btn|Fast mode": "fast toggle has no -fast twin in this fixture — disabled (unavailable)",
  };

  it("every control it renders does something observable", async () => {
    let cb = 0;
    const bump = () => {
      cb++;
    };
    h = mount(
      <ModelPicker
        modelLabel="opencode"
        models={[OPUS]}
        modelOverride={{ providerID: "anthropic", modelID: "claude-opus-4" }}
        defaultModel={{ providerID: "anthropic", modelID: "claude-sonnet-4" }}
        onOpen={bump}
        onSelect={bump}
        onSelectEffort={bump}
        onSelectAuto={bump}
        onRoutedUndone={bump}
        presetLabel="Balanced"
        routed={{
          reason: "moved: incumbent ran out of credit",
          incumbent: { providerID: "anthropic", modelID: "claude-sonnet-4" },
        }}
      />,
    );
    await h.flush();
    const signal = () => JSON.stringify({ cb, dom: domSignal() });
    await smokeDrive({ h, surface: "ModelPicker", signal, allowlist: MODELPICKER_INERT });
  });
});

// The allowlists above are the explicit inventory of inert controls — a reader
// greps them to see every decision that a surface is allowed to no-op, in the
// same spirit as demoCoverage.test.ts's DEMO_UNIMPLEMENTED.

