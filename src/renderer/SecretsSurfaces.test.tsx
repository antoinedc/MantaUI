// @vitest-environment jsdom
//
// Component tests for the two secrets surfaces: the chat popover's SecretsCard
// (inline editing, BET-1437 deep-link) and Settings → Secrets. The mock api
// records every call, so each test asserts both the visible outcome and the
// exact patch/ids sent to the server.

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import type { Project, SecretMeta } from "../shared/types";
import { installMockApi, mount, type Harness, type MockApi } from "./testHarness";
import { useStore } from "./store";
import { SecretsCard } from "./PanelCards";
import { SecretsSettings } from "./SecretsSettings";

function typeInto(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function click(el: Element | null | undefined) {
  expect(el, "element to click").toBeTruthy();
  act(() => (el as HTMLElement).click());
}

function buttonIn(root: ParentNode, label: string): HTMLButtonElement | null {
  return (
    (Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement) ??
    null
  );
}

const meta = (p: Partial<SecretMeta> & { id: string; key: string }): SecretMeta => ({
  scope: "shared",
  sessionID: null,
  project: null,
  hint: "",
  hasValue: true,
  createdAt: Date.now() - 41 * 86_400_000,
  updatedAt: Date.now() - 41 * 86_400_000,
  ...p,
});

describe("SecretsCard (chat popover)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const secrets = [
    meta({ id: "a", key: "GITHUB_PAT", hint: "git push token" }),
    meta({ id: "b", key: "AWS_KEY", scope: "session", sessionID: "ses_1", overrides: "shared" }),
  ];

  function mountCard(over: Partial<React.ComponentProps<typeof SecretsCard>> = {}) {
    const onUpdate = vi.fn().mockResolvedValue({ ok: true });
    const onDelete = vi.fn();
    const onSave = vi.fn().mockResolvedValue(true);
    h = mount(
      <SecretsCard
        secrets={secrets}
        error={null}
        sessionId="ses_1"
        onSave={onSave}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onClose={() => {}}
        {...over}
      />,
    );
    return { onUpdate, onDelete, onSave };
  }

  it("lists metadata only, flags overrides, and keeps the add form collapsed", () => {
    mountCard();
    const text = h!.text();
    expect(text).toContain("GITHUB_PAT");
    expect(text).toContain("git push token");
    expect(text).toContain("overrides shared");
    expect(h!.container.querySelector('input[type="password"]')).toBeNull();
    click(buttonIn(h!.container, "+ Add secret"));
    expect(h!.container.querySelector('input[type="password"]')).not.toBeNull();
  });

  it("BET-1437 deep link: opens the form pre-filled, focuses the value, highlights the row", () => {
    mountCard({ prefillKey: "GITHUB_PAT" });
    const pw = h!.container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(pw).not.toBeNull();
    expect(document.activeElement).toBe(pw);
    const key = h!.container.querySelector('input[placeholder^="KEY"]') as HTMLInputElement;
    expect(key.value).toBe("GITHUB_PAT");
    const row = Array.from(h!.container.querySelectorAll("div.group")).find((d) => d.textContent?.includes("GITHUB_PAT"));
    expect((row as HTMLElement).style.boxShadow).toContain("inset");
  });

  it("renames in place: the patch carries only the new name", async () => {
    const { onUpdate } = mountCard();
    click(h!.container.querySelector('button[aria-label="Edit GITHUB_PAT"]'));
    const name = h!.container.querySelector('input[aria-label="Secret name"]') as HTMLInputElement;
    expect(name.value).toBe("GITHUB_PAT");
    expect(buttonIn(h!.container, "Save")!.disabled).toBe(true);
    typeInto(name, "GH_TOKEN");
    expect(h!.text()).toContain("Renaming GITHUB_PAT → GH_TOKEN");
    await act(async () => buttonIn(h!.container, "Rename & save")!.click());
    expect(onUpdate).toHaveBeenCalledWith("a", { key: "GH_TOKEN" });
    expect(h!.container.querySelector('input[aria-label="Secret name"]')).toBeNull(); // closed on success
  });

  it("replaces the value only after 'Replace value…', never showing the stored one", async () => {
    const { onUpdate } = mountCard();
    click(h!.container.querySelector('button[aria-label="Edit GITHUB_PAT"]'));
    expect(h!.container.querySelector('input[type="password"]')).toBeNull();
    expect(h!.text()).toContain("stored · set 41 days ago");
    click(buttonIn(h!.container, "Replace value…"));
    const pw = h!.container.querySelector('input[aria-label="New value"]') as HTMLInputElement;
    expect(pw.value).toBe("");
    expect(document.activeElement).toBe(pw);
    click(buttonIn(h!.container, "Keep current"));
    expect(h!.container.querySelector('input[aria-label="New value"]')).toBeNull();
    click(buttonIn(h!.container, "Replace value…"));
    typeInto(h!.container.querySelector('input[aria-label="New value"]') as HTMLInputElement, "ghp_NEW");
    await act(async () => buttonIn(h!.container, "Save")!.click());
    expect(onUpdate).toHaveBeenCalledWith("a", { value: "ghp_NEW" });
  });

  it("a failed save shows the server's error and stays open; Enter saves", async () => {
    const onUpdate = vi.fn().mockResolvedValue({ ok: false, error: 'A shared secret named "X" already exists here.' });
    mountCard({ onUpdate });
    click(h!.container.querySelector('button[aria-label="Edit GITHUB_PAT"]'));
    const hint = h!.container.querySelector('input[aria-label="Hint for the agent"]') as HTMLInputElement;
    typeInto(hint, "new hint");
    await act(async () => {
      press(hint, "Enter");
    });
    expect(onUpdate).toHaveBeenCalledWith("a", { hint: "new hint" });
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toContain("already exists here");
    expect(h!.container.querySelector('input[aria-label="Secret name"]')).not.toBeNull();
  });

  it("rejects an invalid new name inline and blocks save", () => {
    const { onUpdate } = mountCard();
    click(h!.container.querySelector('button[aria-label="Edit GITHUB_PAT"]'));
    typeInto(h!.container.querySelector('input[aria-label="Secret name"]') as HTMLInputElement, "2FA-CODE");
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toMatch(/Letters, digits/);
    expect(buttonIn(h!.container, "Rename & save")!.disabled).toBe(true);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("Esc cancels the editor (and does not bubble), double-click opens it, one row at a time", () => {
    mountCard();
    const row = Array.from(h!.container.querySelectorAll("div.group")).find((d) => d.textContent?.includes("GITHUB_PAT"))!;
    act(() => {
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(h!.container.querySelectorAll('input[aria-label="Secret name"]')).toHaveLength(1);
    click(h!.container.querySelector('button[aria-label="Edit AWS_KEY"]'));
    expect(h!.container.querySelectorAll('input[aria-label="Secret name"]')).toHaveLength(1);
    expect((h!.container.querySelector('input[aria-label="Secret name"]') as HTMLInputElement).value).toBe("AWS_KEY");
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    press(h!.container.querySelector('input[aria-label="Secret name"]')!, "Escape");
    document.removeEventListener("keydown", outer);
    expect(h!.container.querySelector('input[aria-label="Secret name"]')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it("deleting asks first, then calls onDelete with the id", () => {
    const { onDelete } = mountCard();
    click(h!.container.querySelector('button[aria-label="Delete GITHUB_PAT"]'));
    expect(onDelete).not.toHaveBeenCalled();
    click(buttonIn(h!.container, "Cancel"));
    click(h!.container.querySelector('button[aria-label="Delete GITHUB_PAT"]'));
    click(buttonIn(h!.container, "Delete"));
    expect(onDelete).toHaveBeenCalledWith("a");
  });

  it("'Manage all in Settings' opens Settings on the Secrets section", () => {
    mountCard();
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("manta-open-settings", on);
    click(buttonIn(h!.container, "Manage all in Settings ↗"));
    window.removeEventListener("manta-open-settings", on);
    expect(seen).toEqual([{ section: "secrets" }]);
  });
});

describe("SecretsSettings (Settings → Secrets)", () => {
  let h: Harness | null = null;
  let api: MockApi;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  const win = (index: number, name: string, opencodeSessionId: string | null) => ({
    index, name, active: false, paneCurrentPath: "/x", opencodeSessionId,
  });
  const projects: Project[] = [
    { tmuxSession: "manta", defaultCwd: "~", attached: false, windows: [win(0, "secrets-ui", "ses_a")] },
  ];
  const list = [
    meta({ id: "1", key: "GITHUB_PAT", hint: "git push token" }),
    meta({ id: "2", key: "AWS_KEY", hint: "shared aws" }),
    meta({ id: "3", key: "STRIPE_TEST_KEY", scope: "project", project: "manta" }),
    meta({ id: "4", key: "AWS_KEY", scope: "session", sessionID: "ses_a", hint: "staging" }),
    meta({ id: "5", key: "TMP_DB_URL", scope: "session", sessionID: "ses_gone_1234567890" }),
    meta({ id: "6", key: "CTO_TOKEN", scope: "session", sessionID: "ses_cto" }),
  ];
  const sessionInfo = (ids: string[]) =>
    Promise.resolve(
      Object.fromEntries(
        ids.map((id) => [
          id,
          id === "ses_cto"
            ? { state: "found", title: "On-call CTO" }
            : { state: "missing", title: null },
        ]),
      ),
    );

  async function mountSettings(over: Record<string, unknown> = {}, onNavigated = () => {}, projectsOverride?: Project[]) {
    ({ api } = installMockApi({
      secretsList: () => Promise.resolve(list),
      secretsSessionInfo: sessionInfo,
      secretsUpdate: () => Promise.resolve({ ok: true }),
      secretsDelete: () => Promise.resolve({ deleted: true }),
      tmuxSelectWindow: () => Promise.resolve(),
      ...over,
    }));
    act(() => useStore.setState({ projects: projectsOverride ?? projects }));
    h = mount(<SecretsSettings onNavigated={onNavigated} />);
    await h.flush();
  }

  it("lists every secret grouped Shared / Projects / Sessions, with session labels and override badges", async () => {
    await mountSettings();
    expect(api.calls.secretsList[0]).toEqual([undefined, true]);
    const text = h!.text();
    expect(text).toContain("Shared");
    expect(text).toContain("STRIPE_TEST_KEY");
    expect(text).toContain("manta / secrets-ui");
    expect(text).toContain("ses_gone…7890");
    expect(text).toContain("chat closed");
    expect(text).toContain("On-call CTO");
    expect(text).toContain("no open window");
    expect(text).toContain("overrides shared");
    expect(text).toContain("no hint");
    expect(text).toContain("All 6");
    expect(text).toContain("Shared 2");
  });

  it("asks the server only about sessions with no window", async () => {
    await mountSettings();
    expect(api.calls.secretsSessionInfo[0]).toEqual([["ses_cto", "ses_gone_1234567890"]]);
  });

  it("a live session with no window (the CTO chat) is labelled by its title and cannot be 'Delete all'-ed; a closed chat can", async () => {
    await mountSettings();
    const deleteAll = Array.from(h!.container.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Delete all");
    expect(deleteAll).toHaveLength(1);
    const ctoHeader = Array.from(h!.container.querySelectorAll("div")).find(
      (d) => d.textContent?.startsWith("On-call CTO") && d.textContent.includes("no open window"),
    )!;
    expect(ctoHeader.textContent).not.toContain("Delete all");
    expect(ctoHeader.textContent).not.toContain("chat closed");
    // its own row is still individually deletable
    expect(h!.container.querySelector('button[aria-label="Delete CTO_TOKEN"]')).not.toBeNull();
  });

  it("when the existence check fails, windowless sessions show no badge and no 'Delete all', and the failure is said", async () => {
    await mountSettings({ secretsSessionInfo: () => Promise.reject(new Error("opencode down")) });
    expect(h!.text()).not.toContain("chat closed");
    expect(h!.text()).not.toContain("no open window");
    expect(buttonIn(h!.container, "Delete all")).toBeNull();
    expect(h!.text()).toContain("ses_gone…7890");
    expect(h!.container.querySelector('[role="status"]')?.textContent).toContain("opencode down");
  });

  it("while the tmux listing is still empty, a 'found' answer is not trusted to mean 'no window'", async () => {
    await mountSettings({}, () => {}, []);
    expect(h!.text()).not.toContain("no open window");
    expect(h!.text()).toContain("chat closed"); // a 404 still holds
  });

  it("search matches key or hint; the filter narrows to one scope", async () => {
    await mountSettings();
    typeInto(h!.container.querySelector('input[aria-label="Search secrets"]') as HTMLInputElement, "staging");
    expect(h!.text()).toContain("AWS_KEY");
    expect(h!.text()).not.toContain("GITHUB_PAT");
    typeInto(h!.container.querySelector('input[aria-label="Search secrets"]') as HTMLInputElement, "zzz-nothing");
    expect(h!.text()).toContain("No secrets match.");
    typeInto(h!.container.querySelector('input[aria-label="Search secrets"]') as HTMLInputElement, "");
    click(buttonIn(h!.container, "Projects 1"));
    expect(h!.text()).toContain("STRIPE_TEST_KEY");
    expect(h!.text()).not.toContain("GITHUB_PAT");
  });

  it("edits a row inline and refetches; shows 'Overridden in N sessions' for a shared secret", async () => {
    await mountSettings();
    const edit = h!.container.querySelector('button[aria-label="Edit AWS_KEY"]') as HTMLButtonElement;
    click(edit);
    expect(h!.text()).toContain("Overridden in 1 session");
    const hint = h!.container.querySelector('input[aria-label="Hint for the agent"]') as HTMLInputElement;
    typeInto(hint, "prod aws");
    const before = api.calls.secretsList.length;
    await act(async () => buttonIn(h!.container, "Save")!.click());
    await h!.flush();
    expect(api.calls.secretsUpdate[0]).toEqual(["2", { hint: "prod aws" }]);
    expect(api.calls.secretsList.length).toBeGreaterThan(before);
    expect(h!.container.querySelector('input[aria-label="Hint for the agent"]')).toBeNull();
  });

  it("delete confirms first; a delete failure is reported, not swallowed", async () => {
    await mountSettings({ secretsDelete: () => Promise.reject(new Error("disk full")) });
    click(h!.container.querySelector('button[aria-label="Delete GITHUB_PAT"]'));
    expect(h!.docText()).toContain("Delete GITHUB_PAT?");
    expect(api.calls.secretsDelete).toBeUndefined();
    const dialog = h!.docQuery('div[role="dialog"]')!;
    await act(async () => buttonIn(dialog, "Delete")!.click());
    await h!.flush();
    expect(api.calls.secretsDelete[0]).toEqual(["1"]);
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toContain("disk full");
  });

  it("'Delete all' on a closed chat group deletes each of its secrets after confirmation", async () => {
    await mountSettings();
    click(buttonIn(h!.container, "Delete all"));
    const dialog = h!.docQuery('div[role="dialog"]')!;
    expect(dialog.textContent).toContain("TMP_DB_URL");
    await act(async () => buttonIn(dialog, "Delete all")!.click());
    await h!.flush();
    expect(api.calls.secretsDelete.map((c) => c[0])).toEqual(["5"]);
  });

  it("'Open chat' activates the window and tells Settings to close; a failure is shown", async () => {
    const navigated = vi.fn();
    await mountSettings({}, navigated);
    await act(async () => buttonIn(h!.container, "Open chat ↗")!.click());
    await h!.flush();
    expect(api.calls.tmuxSelectWindow[0]).toEqual([{ sessionName: "manta", windowIndex: 0 }]);
    expect(navigated).toHaveBeenCalledTimes(1);
  });

  it("Add dialog: project scope sends the chosen workspace, and warns when it would replace one", async () => {
    await mountSettings({ secretsSet: () => Promise.resolve({ ok: true }) });
    click(buttonIn(h!.container, "+ Add secret"));
    click(buttonIn(h!.docQuery('div[role="dialog"]')!, "A project"));
    typeInto(h!.docQuery('#add-secret-key') as HTMLInputElement, "STRIPE_TEST_KEY");
    typeInto(h!.docQuery('#add-secret-value') as HTMLInputElement, "sk_test");
    expect(h!.docText()).toContain("already exists here — saving replaces its value.");
    typeInto(h!.docQuery('#add-secret-key') as HTMLInputElement, "NEW_KEY");
    await act(async () => buttonIn(h!.docQuery('div[role="dialog"]')!, "Save")!.click());
    await h!.flush();
    expect(api.calls.secretsSet[0]).toEqual([
      { key: "NEW_KEY", value: "sk_test", scope: "project", sessionID: null, project: "manta", hint: undefined },
    ]);
    expect(h!.docQuery('div[role="dialog"]')).toBeNull();
  });

  it("Add dialog shows the server error and stays open", async () => {
    await mountSettings({ secretsSet: () => Promise.resolve({ ok: false, error: "nope" }) });
    click(buttonIn(h!.container, "+ Add secret"));
    typeInto(h!.docQuery('#add-secret-key') as HTMLInputElement, "K1");
    typeInto(h!.docQuery('#add-secret-value') as HTMLInputElement, "v");
    await act(async () => buttonIn(h!.docQuery('div[role="dialog"]')!, "Save")!.click());
    await h!.flush();
    expect(h!.docQuery('div[role="dialog"]')!.textContent).toContain("nope");
  });

  it("a failed load shows the error with Retry", async () => {
    await mountSettings({ secretsList: () => Promise.reject(new Error("offline")) });
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toContain("offline");
    expect(buttonIn(h!.container, "Retry")).not.toBeNull();
  });
});
