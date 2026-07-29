// sshTarget.test.ts — resolveInstallTarget + the runner.ts argv helpers.
// Pure: no fs, no ssh, no DOM.

import { describe, it, expect } from "vitest";
import {
  CUSTOM_HOST_VALUE,
  resolveInstallTarget,
  isEmptySshTarget,
  sshTargetDestination,
  sshTargetExtraArgs,
  sshTargetLabel,
  type HostFieldSelection,
} from "./sshTarget.js";

function sel(overrides: Partial<HostFieldSelection> = {}): HostFieldSelection {
  return {
    alias: CUSTOM_HOST_VALUE,
    host: "",
    port: "",
    user: "",
    identityFile: "",
    ...overrides,
  };
}

describe("resolveInstallTarget", () => {
  it("alias passthrough — returns the alias unchanged, no CustomSshTarget", () => {
    const r = resolveInstallTarget(sel({ alias: "dev" }));
    expect(r).toEqual({ ok: true, target: "dev" });
  });

  it("alias passthrough trims surrounding whitespace", () => {
    const r = resolveInstallTarget(sel({ alias: "  dev  " }));
    expect(r).toEqual({ ok: true, target: "dev" });
  });

  it("alias passthrough rejects an empty/whitespace-only alias", () => {
    const r = resolveInstallTarget(sel({ alias: "   " }));
    expect(r.ok).toBe(false);
  });

  it("full custom target — every field populated", () => {
    const r = resolveInstallTarget(
      sel({
        host: "box.example.com",
        port: "2222",
        user: "root",
        identityFile: "~/.ssh/id_ed25519",
      }),
    );
    expect(r).toEqual({
      ok: true,
      target: {
        kind: "custom",
        host: "box.example.com",
        port: 2222,
        user: "root",
        identityFile: "~/.ssh/id_ed25519",
      },
    });
  });

  it("custom target trims every field", () => {
    const r = resolveInstallTarget(
      sel({
        host: "  box.example.com  ",
        port: " 2222 ",
        user: " root ",
        identityFile: "  ~/.ssh/id_ed25519  ",
      }),
    );
    expect(r).toEqual({
      ok: true,
      target: {
        kind: "custom",
        host: "box.example.com",
        port: 2222,
        user: "root",
        identityFile: "~/.ssh/id_ed25519",
      },
    });
  });

  it("omits port when empty — 'let OpenSSH decide', not a substituted default", () => {
    const r = resolveInstallTarget(sel({ host: "box.example.com" }));
    expect(r).toEqual({ ok: true, target: { kind: "custom", host: "box.example.com" } });
    const target = r.ok && typeof r.target === "object" ? r.target : null;
    expect(target && "port" in target).toBe(false);
  });

  it("omits user when empty", () => {
    const r = resolveInstallTarget(sel({ host: "box.example.com", port: "22" }));
    expect(r).toEqual({
      ok: true,
      target: { kind: "custom", host: "box.example.com", port: 22 },
    });
    const target = r.ok && typeof r.target === "object" ? r.target : null;
    expect(target && "user" in target).toBe(false);
  });

  it("omits identityFile when empty", () => {
    const r = resolveInstallTarget(
      sel({ host: "box.example.com", user: "root" }),
    );
    expect(r).toEqual({
      ok: true,
      target: { kind: "custom", host: "box.example.com", user: "root" },
    });
    const target = r.ok && typeof r.target === "object" ? r.target : null;
    expect(target && "identityFile" in target).toBe(false);
  });

  it("empty host → error, no target returned", () => {
    const r = resolveInstallTarget(sel({ port: "22" }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/host/i);
  });

  it("whitespace-only host → error", () => {
    const r = resolveInstallTarget(sel({ host: "   " }));
    expect(r.ok).toBe(false);
  });

  it("invalid port — non-numeric → error", () => {
    const r = resolveInstallTarget(sel({ host: "box.example.com", port: "abc" }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/port/i);
  });

  it("invalid port — zero → error", () => {
    const r = resolveInstallTarget(sel({ host: "box.example.com", port: "0" }));
    expect(r.ok).toBe(false);
  });

  it("invalid port — above 65535 → error", () => {
    const r = resolveInstallTarget(sel({ host: "box.example.com", port: "70000" }));
    expect(r.ok).toBe(false);
  });

  it("invalid port — non-integer → error", () => {
    const r = resolveInstallTarget(sel({ host: "box.example.com", port: "22.5" }));
    expect(r.ok).toBe(false);
  });

  it("boundary ports 1 and 65535 are valid", () => {
    expect(resolveInstallTarget(sel({ host: "h", port: "1" })).ok).toBe(true);
    expect(resolveInstallTarget(sel({ host: "h", port: "65535" })).ok).toBe(true);
  });
});

describe("isEmptySshTarget", () => {
  it("true for an empty/whitespace-only alias string", () => {
    expect(isEmptySshTarget("")).toBe(true);
    expect(isEmptySshTarget("   ")).toBe(true);
  });

  it("false for a non-empty alias string", () => {
    expect(isEmptySshTarget("dev")).toBe(false);
  });

  it("true for a custom target with an empty host", () => {
    expect(isEmptySshTarget({ kind: "custom", host: "" })).toBe(true);
    expect(isEmptySshTarget({ kind: "custom", host: "   " })).toBe(true);
  });

  it("false for a custom target with a host", () => {
    expect(isEmptySshTarget({ kind: "custom", host: "box.example.com" })).toBe(false);
  });
});

describe("sshTargetDestination", () => {
  it("returns the alias verbatim (trimmed) for a string target", () => {
    expect(sshTargetDestination("  dev  ")).toBe("dev");
  });

  it("returns host only for a custom target with no user", () => {
    expect(sshTargetDestination({ kind: "custom", host: "box.example.com" })).toBe(
      "box.example.com",
    );
  });

  it("returns user@host for a custom target with a user", () => {
    expect(
      sshTargetDestination({ kind: "custom", host: "box.example.com", user: "root" }),
    ).toBe("root@box.example.com");
  });

  it("never includes the port — it is a separate -p flag, not part of the destination", () => {
    const dest = sshTargetDestination({
      kind: "custom",
      host: "box.example.com",
      port: 2222,
    });
    expect(dest).toBe("box.example.com");
    expect(dest).not.toContain("2222");
  });
});

describe("sshTargetExtraArgs", () => {
  it("returns [] for a string (alias) target", () => {
    expect(sshTargetExtraArgs("dev")).toEqual([]);
  });

  it("returns [] for a custom target with no port/identityFile", () => {
    expect(sshTargetExtraArgs({ kind: "custom", host: "box.example.com" })).toEqual([]);
  });

  it("builds -p for a custom port", () => {
    expect(
      sshTargetExtraArgs({ kind: "custom", host: "h", port: 2222 }),
    ).toEqual(["-p", "2222"]);
  });

  it("builds -i for a custom identity file", () => {
    expect(
      sshTargetExtraArgs({ kind: "custom", host: "h", identityFile: "~/.ssh/id_x" }),
    ).toEqual(["-i", "~/.ssh/id_x"]);
  });

  it("builds both -p and -i, in that order, when both are set", () => {
    expect(
      sshTargetExtraArgs({
        kind: "custom",
        host: "h",
        port: 2222,
        identityFile: "~/.ssh/id_x",
      }),
    ).toEqual(["-p", "2222", "-i", "~/.ssh/id_x"]);
  });
});

describe("sshTargetLabel", () => {
  it("returns the alias verbatim for a string target", () => {
    expect(sshTargetLabel("dev")).toBe("dev");
  });

  it("formats host/user/port for a custom target", () => {
    expect(
      sshTargetLabel({ kind: "custom", host: "box.example.com", user: "root", port: 2222 }),
    ).toBe("root@box.example.com:2222");
  });

  it("omits user@ and :port when not set", () => {
    expect(sshTargetLabel({ kind: "custom", host: "box.example.com" })).toBe(
      "box.example.com",
    );
  });
});
