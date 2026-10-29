import { describe, it, expect } from "vitest";
import { launcherSpawnPayload } from "./launcherSpawn";

const flag = (key: string, def: boolean, value?: boolean) => ({ key, label: key, type: "boolean" as const, default: def, ...(value === undefined ? {} : { value }) });

describe("launcherSpawnPayload (WS11 D3 review #2)", () => {
  it("a current box (rows carry `value`) gets just the id — the box resolves the saved options", () => {
    expect(launcherSpawnPayload({ id: "claude", label: "Claude", flags: [flag("skipPermissions", true, false)] })).toEqual({ id: "claude" });
  });
  it("an older box (no `value`) gets the row's own defaults, so skip-permissions is not silently dropped", () => {
    expect(launcherSpawnPayload({ id: "claude", label: "Claude", flags: [flag("skipPermissions", true), flag("other", false)] })).toEqual({
      id: "claude",
      flags: { skipPermissions: true, other: false },
    });
  });
  it("a launcher with no flags is just the id", () => {
    expect(launcherSpawnPayload({ id: "codex", label: "Codex", flags: [] })).toEqual({ id: "codex" });
  });
});
