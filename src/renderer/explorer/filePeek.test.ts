// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PREVIEW_BYTES } from "../chatUtils";
import {
  BINARY_SNIFF_BYTES,
  MAX_MARKDOWN_IMAGE_BYTES,
  createImageResolver,
  decodeText,
  fetchPeekBlob,
  imagePathOf,
  loadPeekedFile,
  mediaKindOf,
  reasonFromStatus,
} from "./filePeek";

type Call = { url: string; method: string; headers: Record<string, string>; signal?: AbortSignal | null };

let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;

function installFetch() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        url,
        method: init.method ?? "GET",
        headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {})),
        signal: init.signal,
      };
      calls.push(call);
      if (call.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return handler(call);
    }),
  );
}

const head = (size: number | null, type = "text/plain") =>
  new Response(null, {
    status: 200,
    headers: { ...(size == null ? {} : { "content-length": String(size) }), "content-type": type },
  });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bytes = (arr: number[] | Uint8Array, type = "text/plain") =>
  new Response((arr instanceof Uint8Array ? arr : new Uint8Array(arr)) as BodyInit, { status: 200, headers: { "content-type": type } });
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  localStorage.setItem("manta_server", "http://box.test");
  localStorage.setItem("manta_token", "tok123");
  installFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("loadPeekedFile", () => {
  it("HEADs first, then GETs the body and decodes text", async () => {
    handler = (c) => (c.method === "HEAD" ? head(5) : bytes(enc("hello")));
    const out = await loadPeekedFile("/home/dev/a.txt");
    expect(out).toEqual({ status: "text", text: "hello", size: 5 });
    expect(calls.map((c) => c.method)).toEqual(["HEAD", "GET"]);
  });

  it("sends the Bearer header on every request and never puts the token in a URL", async () => {
    handler = (c) => (c.method === "HEAD" ? head(2) : bytes(enc("hi")));
    await loadPeekedFile("/home/dev/a b.txt");
    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(c.headers.authorization).toBe("Bearer tok123");
      expect(c.url).not.toContain("tok123");
      expect(c.url).not.toContain("token=");
      expect(c.url).toBe("http://box.test/api/peek?path=%2Fhome%2Fdev%2Fa%20b.txt");
    }
  });

  it("never GETs a body larger than the preview limit", async () => {
    handler = () => head(MAX_PREVIEW_BYTES + 1);
    const out = await loadPeekedFile("/home/dev/big.log");
    expect(out).toEqual({ status: "too-large", size: MAX_PREVIEW_BYTES + 1 });
    expect(calls.map((c) => c.method)).toEqual(["HEAD"]);
  });

  it("accepts exactly the limit (HEAD size only; body is read bounded)", async () => {
    handler = (c) => (c.method === "HEAD" ? head(MAX_PREVIEW_BYTES) : bytes(enc("x")));
    const out = await loadPeekedFile("/home/dev/edge.txt");
    expect(out.status).toBe("text");
  });

  it("stops reading at limit + 1 when the file grew after the HEAD", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });
    handler = (c) => (c.method === "HEAD" ? head(10) : new Response(stream, { status: 200 }));
    const out = await loadPeekedFile("/home/dev/grew.txt");
    expect(out.status).toBe("too-large");
    // 25 MiB fits; the 26th chunk crosses the limit; nothing past that is pulled for.
    expect(pulled).toBeLessThanOrEqual(30);
  });

  it("reports an empty file without a GET", async () => {
    handler = () => head(0);
    expect(await loadPeekedFile("/home/dev/empty.txt")).toEqual({ status: "empty" });
    expect(calls.map((c) => c.method)).toEqual(["HEAD"]);
  });

  it("treats a NUL in the first 8 KiB as binary", async () => {
    handler = (c) => (c.method === "HEAD" ? head(4) : bytes([0x41, 0x00, 0x42, 0x43]));
    expect(await loadPeekedFile("/home/dev/app.sqlite")).toEqual({ status: "binary", size: 4 });
  });

  it("treats bytes that are not valid UTF-8 as binary", async () => {
    handler = (c) => (c.method === "HEAD" ? head(3) : bytes([0xff, 0xfe, 0x41]));
    expect((await loadPeekedFile("/home/dev/blob.dat")).status).toBe("binary");
  });

  it("does not call a file binary for a NUL beyond the sniff window when it is valid UTF-8", () => {
    const b = new Uint8Array(BINARY_SNIFF_BYTES + 10).fill(97);
    b[BINARY_SNIFF_BYTES + 5] = 0;
    expect(decodeText(b)).toBe(new TextDecoder().decode(b));
  });

  it("returns media for image/video content types and .pdf without reading the body", async () => {
    handler = () => head(1234, "image/png");
    expect(await loadPeekedFile("/home/dev/a.png")).toEqual({ status: "media", kind: "image", size: 1234 });
    handler = () => head(99, "application/octet-stream");
    expect(await loadPeekedFile("/home/dev/doc.pdf")).toEqual({ status: "media", kind: "pdf", size: 99 });
    expect(calls.every((c) => c.method === "HEAD")).toBe(true);
  });

  it.each([
    [403, { error: "x", reason: "outside-home" }, "outside-home"],
    [404, { error: "x", reason: "not-file" }, "not-file"],
    [404, { error: "x", reason: "missing" }, "missing"],
    [403, { error: "x", reason: "permission" }, "permission"],
    [503, { error: "x", reason: "changed" }, "changed"],
    [503, { error: "x", reason: "unavailable" }, "unavailable"],
  ])("maps a %i with reason %j to %s", async (status, body, reason) => {
    handler = (c) => (c.method === "HEAD" ? new Response(null, { status }) : json(status, body));
    const out = await loadPeekedFile("/home/dev/x");
    expect(out).toEqual({ status: "failed", reason });
    // The probe is a 1-byte ranged GET (HEAD answers carry no body).
    expect(calls[1].method).toBe("GET");
    expect(calls[1].headers.range).toBe("bytes=0-0");
    expect(calls[1].headers.authorization).toBe("Bearer tok123");
  });

  it("falls back to the status code when the failure body has no reason", async () => {
    handler = (c) => (c.method === "HEAD" ? new Response(null, { status: 404 }) : new Response("nope", { status: 404 }));
    expect(await loadPeekedFile("/home/dev/x")).toEqual({ status: "failed", reason: "missing" });
    handler = (c) => (c.method === "HEAD" ? new Response(null, { status: 500 }) : new Response("", { status: 500 }));
    expect(await loadPeekedFile("/home/dev/x")).toEqual({ status: "failed", reason: "unavailable" });
  });

  it("reports a network failure", async () => {
    handler = () => {
      throw new TypeError("fetch failed");
    };
    expect(await loadPeekedFile("/home/dev/x")).toEqual({ status: "failed", reason: "network" });
  });

  it("rejects (rather than reporting a failure) when aborted", async () => {
    const ctrl = new AbortController();
    handler = async (c) => {
      await new Promise((_, reject) => c.signal?.addEventListener("abort", () => reject(new DOMException("a", "AbortError"))));
      return head(1);
    };
    const p = loadPeekedFile("/home/dev/x", ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow();
    expect(calls[0].signal).toBe(ctrl.signal);
  });
});

describe("helpers", () => {
  it("mediaKindOf prefers the content type, falls back to the extension", () => {
    expect(mediaKindOf("image/svg+xml", "x")).toBe("image");
    expect(mediaKindOf("video/mp4", "x")).toBe("video");
    expect(mediaKindOf("application/pdf", "x")).toBe("pdf");
    expect(mediaKindOf("application/octet-stream", "a.PDF")).toBe("pdf");
    expect(mediaKindOf("application/octet-stream", "a.avif")).toBe("image");
    expect(mediaKindOf("text/plain", "notes.txt")).toBeNull();
  });

  it("reasonFromStatus follows the route table", () => {
    expect(reasonFromStatus(404)).toBe("missing");
    expect(reasonFromStatus(403)).toBe("permission");
    expect(reasonFromStatus(503)).toBe("unavailable");
  });

  it("imagePathOf drops the query/fragment and decodes", () => {
    expect(imagePathOf("img/a%20b.png?raw=1#x")).toBe("img/a b.png");
  });
});

describe("fetchPeekBlob", () => {
  it("returns a Blob with the response's type, authenticated", async () => {
    handler = () => bytes([1, 2, 3], "image/png");
    const r = await fetchPeekBlob("/home/dev/a.png");
    expect(r.ok && r.blob.type).toBe("image/png");
    expect(r.ok && r.blob.size).toBe(3);
    expect(calls[0].headers.authorization).toBe("Bearer tok123");
  });

  it("refuses a body whose declared size is over maxBytes", async () => {
    handler = () => head(500, "image/png");
    const r = await fetchPeekBlob("/home/dev/a.png", { maxBytes: 100 });
    expect(r).toEqual({ ok: false, reason: "too-large", size: 500 });
  });

  it("maps a refusal to its reason", async () => {
    handler = () => json(404, { reason: "missing" });
    expect(await fetchPeekBlob("/home/dev/a.png")).toEqual({ ok: false, reason: "missing" });
  });
});

describe("createImageResolver", () => {
  let created: string[];
  let revoked: string[];
  beforeEach(() => {
    created = [];
    revoked = [];
    URL.createObjectURL = vi.fn(() => {
      const u = `blob:img-${created.length}`;
      created.push(u);
      return u;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn((u: string) => {
      revoked.push(u);
    }) as typeof URL.revokeObjectURL;
  });

  const ok = (abs: string, size = 10) => ({ results: [{ ok: true as const, abs, kind: "file" as const, size }] });

  it("resolves relative to the Markdown file's folder, then fetches with the auth header", async () => {
    const resolvePaths = vi.fn(async () => ok("/home/dev/docs/img/a.png"));
    handler = () => bytes([1, 2], "image/png");
    const r = createImageResolver("/home/dev/docs", resolvePaths);
    expect(await r.resolveImage("img/a.png?x=1")).toBe("blob:img-0");
    expect(resolvePaths).toHaveBeenCalledWith({ base: "/home/dev/docs", paths: ["img/a.png"] });
    expect(calls[0].url).toBe("http://box.test/api/peek?path=%2Fhome%2Fdev%2Fdocs%2Fimg%2Fa.png");
    expect(calls[0].headers.authorization).toBe("Bearer tok123");
  });

  it("loads each src once", async () => {
    const resolvePaths = vi.fn(async () => ok("/home/dev/a.png"));
    handler = () => bytes([1], "image/png");
    const r = createImageResolver("/home/dev", resolvePaths);
    await Promise.all([r.resolveImage("a.png"), r.resolveImage("a.png")]);
    expect(resolvePaths).toHaveBeenCalledTimes(1);
    expect(created.length).toBe(1);
  });

  it("returns null for a missing, oversized, non-image or failing image", async () => {
    handler = () => bytes([1], "image/png");
    const r1 = createImageResolver("/h", async () => ({ results: [{ ok: false as const }] }));
    expect(await r1.resolveImage("x.png")).toBeNull();
    const r2 = createImageResolver("/h", async () => ok("/h/x.png", MAX_MARKDOWN_IMAGE_BYTES + 1));
    expect(await r2.resolveImage("x.png")).toBeNull();
    handler = () => bytes([1], "text/plain");
    const r3 = createImageResolver("/h", async () => ok("/h/x.txt"));
    expect(await r3.resolveImage("x.txt")).toBeNull();
    const r4 = createImageResolver("/h", async () => {
      throw new Error("down");
    });
    expect(await r4.resolveImage("x.png")).toBeNull();
    expect(created).toEqual([]);
  });

  it("revokes every blob URL on dispose and stays usable", async () => {
    handler = () => bytes([1], "image/png");
    const r = createImageResolver("/h", async () => ok("/h/a.png"));
    await r.resolveImage("a.png");
    r.dispose();
    expect(revoked).toEqual(["blob:img-0"]);
    expect(await r.resolveImage("a.png")).toBe("blob:img-1");
  });
});
