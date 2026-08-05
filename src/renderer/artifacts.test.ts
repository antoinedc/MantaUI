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
    size: null,
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

  it("threads the file part's byte size through as `size`", () => {
    const messages = [msg("u", "user", [filePart({ size: 1_258_291 })])];
    const out = deriveArtifacts(messages, [], "ses_a");
    expect(out[0].size).toBe(1_258_291);
  });

  it("leaves size null when the file part carries none (links/pages too)", () => {
    const withOut = deriveArtifacts([msg("u", "user", [filePart()])], [], "ses_a");
    expect(withOut[0].size).toBeNull();
    const link = deriveArtifacts([msg("u", "user", [textPart("https://example.com")])], [], "ses_a");
    expect(link[0].size).toBeNull();
    const p = deriveArtifacts([], [page({ createdAt: 0 })], "ses_a");
    expect(p[0].size).toBeNull();
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

  it("outbox file → file artifact (origin agent, scoped to its session)", () => {
    const got = deriveArtifacts([], [], "ses_a", [
      { path: "/home/dev/.manta-outbox/q3-revenue.csv", name: "q3-revenue.csv", size: 1204, sessionID: "ses_a", mtime: 5000, expiresAt: 5000 + 604800000 },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      kind: "file",
      origin: "agent",
      label: "q3-revenue.csv",
      href: "/home/dev/.manta-outbox/q3-revenue.csv",
      mime: "text/csv",
      size: 1204,
      at: 5000,
      messageId: null,
      context: null,
      expiresAt: 5000 + 604800000,
    });
  });

  it("outbox files from another session are excluded (workspace-linked)", () => {
    const got = deriveArtifacts([], [], "ses_a", [
      { path: "/home/dev/.manta-outbox/x.csv", name: "x.csv", size: 1, sessionID: "ses_OTHER", mtime: 1000, expiresAt: null },
    ]);
    expect(got).toEqual([]);
  });

  it("outbox image file → image artifact with its mime", () => {
    const got = deriveArtifacts([], [], "ses_a", [
      { path: "/home/dev/.manta-outbox/shot.png", name: "shot.png", size: 2048, sessionID: "ses_a", mtime: 1000, expiresAt: null },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe("image");
    expect(got[0].mime).toBe("image/png");
  });

  it("outbox file with an unknown extension keeps a null mime (file kind)", () => {
    const got = deriveArtifacts([], [], "ses_a", [
      { path: "/home/dev/.manta-outbox/archive.bin", name: "archive.bin", size: 99, sessionID: "ses_a", mtime: 1000, expiresAt: null },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe("file");
    expect(got[0].mime).toBeNull();
  });

  it("user uploads and outbox files both land in the same list", () => {
    const messages = [
      msg("u", "user", [filePart({ filename: "mine.csv", url: "file:///home/dev/.manta-uploads/mine.csv" })]),
    ];
    const got = deriveArtifacts(messages, [], "ses_a", [
      { path: "/home/dev/.manta-outbox/pushed.pdf", name: "pushed.pdf", size: 100, sessionID: "ses_a", mtime: 2000, expiresAt: null },
    ]);
    expect(got.length).toBe(2);
    expect(got.map((a) => a.origin).sort()).toEqual(["agent", "user"]);
  });

  it("edit tool part → NO artifact (modifies existing source, not produced)", () => {
    const messages = [
      msg("a", "assistant", [
        {
          type: "tool",
          tool: "edit",
          state: { status: "completed", input: { filePath: "/home/dev/q3-revenue.csv" } },
        },
      ]),
    ];
    expect(deriveArtifacts(messages, [], "ses_a")).toEqual([]);
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
