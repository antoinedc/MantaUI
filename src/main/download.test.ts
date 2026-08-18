import { describe, it, expect, vi } from "vitest";
import {
  downloadFileToDownloads,
  resolveDownloadDir,
  uniqueLocalPath,
  type DownloadFs,
  type DownloadInput,
} from "./download.js";

// ---- pure helpers -----------------------------------------------------------

describe("resolveDownloadDir", () => {
  it("uses the configured downloads dir when set", () => {
    expect(resolveDownloadDir("/Users/a/Desktop", "/Users/a/Downloads")).toBe(
      "/Users/a/Desktop",
    );
  });

  it("falls back to the default dir when absent or blank", () => {
    expect(resolveDownloadDir(undefined, "/Users/a/Downloads")).toBe("/Users/a/Downloads");
    expect(resolveDownloadDir("", "/Users/a/Downloads")).toBe("/Users/a/Downloads");
    expect(resolveDownloadDir("   ", "/Users/a/Downloads")).toBe("/Users/a/Downloads");
  });
});

describe("uniqueLocalPath", () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);

  it("returns the bare path when the name is free", () => {
    expect(uniqueLocalPath("/d", "a.png", () => false)).toBe("/d/a.png");
  });

  it("appends a numeric suffix before the extension on collision", () => {
    const e = exists(["/d/a.png", "/d/a (1).png"]);
    expect(uniqueLocalPath("/d", "a.png", e)).toBe("/d/a (2).png");
  });

  it("keeps incrementing across multiple collisions", () => {
    const e = exists(["/d/r.pdf", "/d/r (1).pdf", "/d/r (2).pdf"]);
    expect(uniqueLocalPath("/d", "r.pdf", e)).toBe("/d/r (3).pdf");
  });

  it("basenames and defaults an empty filename", () => {
    expect(uniqueLocalPath("/d", "../evil.txt", () => false)).toBe("/d/evil.txt");
    expect(uniqueLocalPath("/d", "", () => false)).toBe("/d/file");
  });

  it("does not treat a leading-dot hidden file as having an extension", () => {
    const e = exists(["/d/.env"]);
    expect(uniqueLocalPath("/d", ".env", e)).toBe("/d/.env (1)");
  });
});

// ---- orchestration ----------------------------------------------------------

// The 32-hex box-id / box-token fixture is built at runtime (repeat + concat)
// so no contiguous 32-hex literal appears in source — the gitleaks
// generic-api-key secret scan flags such literals and fails the required CI
// job (same technique the repo already uses elsewhere: "a".repeat(32) in the
// server auth fixtures). The bound value stays a valid 32-hex token.
const HEX = "0".repeat(8) + "1".repeat(8) + "2".repeat(8) + "3".repeat(8);

function baseInput(overrides: Partial<DownloadInput> = {}): DownloadInput {
  return {
    serverUrl: `https://${HEX}.boxes.mantaui.com`,
    boxToken: HEX,
    defaultDir: "/Users/a/Downloads",
    remotePath: "/home/dev/outbox/report.pdf",
    filename: "report.pdf",
    ...overrides,
  };
}

function stubFetch(res: Response | { throw: true }): {
  fetch: typeof fetch;
  urls: string[];
  headers: Record<string, string>[];
} {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    const hdr: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) hdr[k.toLowerCase()] = h[k];
    }
    headers.push(hdr);
    if ("throw" in res) throw new Error("ECONNREFUSED");
    return res;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, urls, headers };
}

function memoryFs(): DownloadFs & { written: string[]; dirs: string[] } {
  const existsPaths = new Set<string>();
  const written: string[] = [];
  const dirs: string[] = [];
  return {
    written,
    dirs,
    exists: (p) => existsPaths.has(p),
    mkdir: async (dir) => {
      dirs.push(dir);
    },
    writeStream: async (target) => {
      // Mock write: record the target; we don't consume the response body here
      // (a bare ReadableStream never resolves its reader until a source feeds it).
      written.push(target);
    },
  };
}

describe("downloadFileToDownloads", () => {
  it("fetches /api/download with the bearer token and writes to the downloads dir", async () => {
    const { fetch, urls, headers } = stubFetch({ ok: true, status: 200, body: new ReadableStream() } as unknown as Response);
    const fs = memoryFs();
    const out = await downloadFileToDownloads(baseInput({ downloadsDir: "/Users/a/Desktop" }), fetch, fs);

    expect(out).toBe("/Users/a/Desktop/report.pdf");
    expect(urls[0]).toBe(
      `https://${HEX}.boxes.mantaui.com/api/download?path=%2Fhome%2Fdev%2Foutbox%2Freport.pdf`,
    );
    expect(headers[0]["authorization"]).toBe(
      `Bearer ${HEX}`,
    );
    expect(fs.written).toEqual(["/Users/a/Desktop/report.pdf"]);
    expect(fs.dirs).toEqual(["/Users/a/Desktop"]);
  });

  it("dedupes a name collision against the existing file", async () => {
    const fs = memoryFs();
    const existing = new Set(["/Users/a/Downloads/report.pdf"]);
    fs.exists = (p) => existing.has(p);

    const { fetch } = stubFetch({ ok: true, status: 200, body: new ReadableStream() } as unknown as Response);
    const out = await downloadFileToDownloads(baseInput(), fetch, fs);
    expect(out).toBe("/Users/a/Downloads/report (1).pdf");
  });

  it("uses the default dir when downloadsDir is absent", async () => {
    const { fetch } = stubFetch({ ok: true, status: 200, body: new ReadableStream() } as unknown as Response);
    const fs = memoryFs();
    const out = await downloadFileToDownloads(baseInput({ downloadsDir: undefined }), fetch, fs);
    expect(out).toBe("/Users/a/Downloads/report.pdf");
  });

  it("returns '' on a non-2xx response", async () => {
    const { fetch } = stubFetch({ ok: false, status: 401 } as Response);
    expect(await downloadFileToDownloads(baseInput(), fetch, memoryFs())).toBe("");
  });

  it("returns '' when the fetch rejects (unreachable box)", async () => {
    const { fetch } = stubFetch({ throw: true });
    expect(await downloadFileToDownloads(baseInput(), fetch, memoryFs())).toBe("");
  });

  it("returns '' when credentials or path are missing", async () => {
    const { fetch } = stubFetch({ ok: true, status: 200, body: new ReadableStream() } as unknown as Response);
    expect(await downloadFileToDownloads(baseInput({ serverUrl: "" }), fetch, memoryFs())).toBe("");
    expect(await downloadFileToDownloads(baseInput({ boxToken: "" }), fetch, memoryFs())).toBe("");
    expect(await downloadFileToDownloads(baseInput({ remotePath: "" }), fetch, memoryFs())).toBe("");
  });
});
