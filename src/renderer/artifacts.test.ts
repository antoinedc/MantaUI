import { describe, it, expect } from "vitest";
import type { OpencodeMessage, ServedPageMeta } from "../shared/types";
import {
  deriveArtifacts,
  groupByDay,
  pageState,
  countByKind,
  type Artifact,
} from "./artifacts";

// ── builders ────────────────────────────────────────────────────────────────

function msg(
  id: string,
  role: "user" | "assistant",
  parts: Array<Record<string, unknown>>,
  created = id === "u" ? 1000 : 2000,
): OpencodeMessage {
  return {
    info: {
      id,
      sessionID: "ses_a",
      role,
      ...(created > 0 ? { time: { created } } : {}),
    },
    parts: parts.map((p, i) => ({ id: `${id}-p${i}`, messageID: id, ...(p as object) })),
  } as unknown as OpencodeMessage;
}

function filePart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "file", mime: "text/plain", url: "file:///home/u/report.txt", filename: "report.txt", ...overrides };
}

function textPart(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "text", text, ...overrides };
}

function toolPart(tool: string): Record<string, unknown> {
  return { type: "tool", tool, state: { status: "completed" } };
}

function page(p: Partial<ServedPageMeta>): ServedPageMeta {
  return { subdomain: "preview", url: "", createdAt: 0, expiresAt: null, sessionID: "ses_a", ...p };
}

function fileArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "id",
    kind: "file",
    origin: "agent",
    key: "/home/u/report.txt",
    label: "report.txt",
    href: "/home/u/report.txt",
    mime: "text/plain",
    at: 2000,
    messageId: null,
    context: null,
    expiresAt: null,
    ...overrides,
  };
}

const img = (href: string, at: number) => fileArtifact({ kind: "image", key: href.toLowerCase(), href, label: href, at });

// ── extraction rules ────────────────────────────────────────────────────────

describe("deriveArtifacts", () => {
  it("splits file parts into image vs file by mime and strips file://", () => {
    const messages = [
      msg("u", "user", [filePart({ mime: "image/png", url: "file:///a/pic.png", filename: "pic.png" })]),
      msg("a", "assistant", [filePart({ mime: "application/pdf", url: "file:///b/doc.pdf", filename: "doc.pdf" })]),
    ];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out).toHaveLength(2);
    const image = out.find((a) => a.kind === "image")!;
    const file = out.find((a) => a.kind === "file")!;
    expect(image.href).toBe("/a/pic.png");
    expect(image.origin).toBe("user");
    expect(file.href).toBe("/b/doc.pdf");
    expect(file.mime).toBe("application/pdf");
  });

  it("assistant file part → origin agent", () => {
    const messages = [msg("a", "assistant", [filePart({ url: "file:///x/agent.bin", filename: "agent.bin" })])];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out[0].origin).toBe("agent");
    expect(out[0].kind).toBe("file");
  });

  it("uses filename, falling back to last path segment of url", () => {
    const a = deriveArtifacts([msg("a", "assistant", [filePart({ url: "file:///dir/no-name", filename: undefined })])], [], "ses_a");
    expect(a[0].label).toBe("no-name");
  });

  it("user text part with one URL → link with context (URL removed)", () => {
    const messages = [msg("u", "user", [textPart("see https://example.com/path and more")])];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("link");
    expect(out[0].origin).toBe("user");
    expect(out[0].href).toBe("https://example.com/path");
    expect(out[0].label).toBe("example.com/path");
    expect(out[0].context).toBe("see and more");
    expect(out[0].mime).toBeNull();
    // single link keeps the part id (spec: "the part id")
    expect(out[0].id).toBe("u-p0");
  });

  it("user text part with two URLs → two artifacts", () => {
    const messages = [msg("u", "user", [textPart("https://a.com/x https://b.com/y")])];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.href).sort()).toEqual(["https://a.com/x", "https://b.com/y"]);
    // two links from one part must NOT share an id (React-key collision guard)
    expect(new Set(out.map((a) => a.id)).size).toBe(2);
  });

  it("assistant text part with a URL → NO artifact", () => {
    const messages = [msg("a", "assistant", [textPart("docs at https://example.com/docs")])];
    expect(deriveArtifacts(messages, [], "ses_a")).toEqual([]);
  });

  it("tool parts of every kind → NO artifacts", () => {
    for (const tool of ["read", "write", "edit", "bash", "webfetch"]) {
      const messages = [msg("a", "assistant", [toolPart(tool)])];
      expect(deriveArtifacts(messages, [], "ses_a"), `tool:${tool}`).toEqual([]);
    }
  });

  it("patch part → NO artifact", () => {
    const messages = [msg("a", "assistant", [{ type: "patch", state: {} }])];
    expect(deriveArtifacts(messages, [], "ses_a")).toEqual([]);
  });

  it("synthetic and ignored text parts are skipped", () => {
    const messages = [
      msg("u", "user", [textPart("https://example.com/1", { synthetic: true })]),
      msg("u2", "user", [textPart("https://example.com/2", { ignored: true })], 3000),
    ];
    expect(deriveArtifacts(messages, [], "ses_a")).toEqual([]);
  });

  it("pages are filtered by sessionID and matched to their announcing message", () => {
    const link = "https://box.example/pages/preview";
    const messages = [
      msg("a", "assistant", [textPart(`Here's your page: ${link}`)], 100),
      msg("a2", "assistant", [textPart("later")], 200),
    ];
    const pages = [
      page({ subdomain: "mine", url: link, sessionID: "ses_a", createdAt: 150, expiresAt: 999 }),
      page({ subdomain: "other", url: "https://x/p", sessionID: "ses_b", createdAt: 300, expiresAt: 999 }),
    ];
    const out = deriveArtifacts(messages, pages, "ses_a");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("page:mine");
    expect(out[0].origin).toBe("agent");
    expect(out[0].label).toBe("mine");
    expect(out[0].expiresAt).toBe(999);
    expect(out[0].messageId).toBe("a");
    expect(out[0].context).toContain("Here's your page");
  });

  it("a page with no announcing message → messageId null", () => {
    const pages = [page({ subdomain: "preview", url: "https://box.example/pages/preview", sessionID: "ses_a", createdAt: 500 })];
    const messages = [msg("a", "assistant", [textPart("no url at all")])];
    const out = deriveArtifacts(messages, pages, "ses_a");
    expect(out[0].messageId).toBeNull();
    expect(out[0].context).toBeNull();
  });

  it("dedupe keeps the newest of two same-href items", () => {
    const out = deriveArtifacts(
      [
        msg("u", "user", [filePart({ url: "file:///a/report.txt", filename: "report.txt" })], 100),
        msg("u2", "user", [filePart({ url: "file:///a/report.txt", filename: "report.txt" })], 500),
      ],
      [],
      "ses_a",
    );
    expect(out).toHaveLength(1);
    expect(out[0].at).toBe(500);
    expect(out[0].id).toBe("u2-p0");
  });

  it("ordering is newest-first overall", () => {
    const out = deriveArtifacts(
      [
        msg("u", "user", [filePart({ url: "file:///a/one.txt", filename: "one.txt" })], 100),
        msg("u2", "user", [textPart("https://example.com/x")], 300),
        msg("a", "assistant", [filePart({ url: "file:///a/two.pdf", filename: "two.pdf" })], 200),
      ],
      [],
      "ses_a",
    );
    expect(out.map((a) => a.at)).toEqual([300, 200, 100]);
  });
});

// ── day grouping ────────────────────────────────────────────────────────────

describe("groupByDay", () => {
  // now = Wed 5 Aug 2026, 12:00 local
  const now = new Date(2026, 7, 5, 12, 0, 0).getTime();
  const today = new Date(2026, 7, 5, 9, 0).getTime();
  const yesterday = new Date(2026, 7, 4, 9, 0).getTime();
  const older = new Date(2026, 7, 3, 9, 0).getTime();

  it("groups Today / Yesterday / older with item order preserved and newest first", () => {
    const out = groupByDay(
      [img("/a/today2", today + 1000), img("/a/older", older), img("/a/today1", today), img("/a/yest", yesterday)],
      now,
    );
    expect(out.map((g) => g.label)).toEqual(["Today", "Yesterday", "Mon 3 Aug"]);
    expect(out[0].items.map((a) => a.href)).toEqual(["/a/today2", "/a/today1"]);
    expect(out[1].items.map((a) => a.href)).toEqual(["/a/yest"]);
    expect(out[2].items.map((a) => a.href)).toEqual(["/a/older"]);
  });

  it("empty input → empty groups", () => {
    expect(groupByDay([], now)).toEqual([]);
  });
});

// ── expiry state ────────────────────────────────────────────────────────────

describe("pageState", () => {
  const now = 1_000_000;

  it("expired exactly at now", () => {
    expect(pageState(now, now)).toBe("expired");
  });

  it("5h59m → soon", () => {
    expect(pageState(now + 5 * 3600 * 1000 + 59 * 60 * 1000, now)).toBe("soon");
  });

  it("6h01m → live", () => {
    expect(pageState(now + 6 * 3600 * 1000 + 60 * 1000, now)).toBe("live");
  });

  it("null expiresAt → null", () => {
    expect(pageState(null, now)).toBeNull();
  });
});

// ── counts ──────────────────────────────────────────────────────────────────

describe("countByKind", () => {
  it("counts mixed input", () => {
    const out = countByKind([
      fileArtifact({ kind: "link" }),
      fileArtifact({ kind: "image" }),
      fileArtifact({ kind: "image" }),
      fileArtifact({ kind: "file" }),
    ]);
    expect(out).toEqual({ link: 1, image: 2, file: 1 });
  });

  it("empty input → zeroed counts", () => {
    expect(countByKind([])).toEqual({ link: 0, image: 0, file: 0 });
  });
});
