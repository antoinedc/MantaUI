// filePeek.ts — authenticated reads of box files through /api/peek for the
// Explorer viewer (spec §Contract → HTTP routes, §Explorer panel).
//
// The size guard runs BEFORE any bytes are fetched: a HEAD yields the size, the
// body is only requested at or under MAX_PREVIEW_BYTES, and the read stops one
// byte past the limit (a file that grew meanwhile is "too large", not an
// out-of-memory). Binary = a NUL byte in the first 8 KiB, or bytes that are not
// valid UTF-8. The Bearer token travels in a header, never in a URL.
//
// HEAD answers carry no body, so a failed HEAD is re-asked as a 1-byte ranged
// GET purely to read the server's `{ reason }`; the status code is the fallback.

import type { FsReason } from "../../shared/fsTypes";
import { MAX_PREVIEW_BYTES } from "../chatUtils";
import { authHeaders, clientToken, serverBase } from "../api/httpApi";

/** Binary sniff window. */
export const BINARY_SNIFF_BYTES = 8 * 1024;
/** Max size of one relative Markdown image. */
export const MAX_MARKDOWN_IMAGE_BYTES = 10 * 1024 * 1024;

export type PeekFailure = FsReason | "network";

export type MediaKind = "image" | "video" | "pdf";

export type PeekOutcome =
  | { status: "text"; text: string; size: number }
  | { status: "media"; kind: MediaKind; size: number }
  | { status: "empty" }
  | { status: "too-large"; size: number }
  | { status: "binary"; size: number }
  | { status: "failed"; reason: PeekFailure };

const REASONS: ReadonlySet<string> = new Set<FsReason>([
  "missing",
  "not-file",
  "permission",
  "changed",
  "too-large",
  "unavailable",
  "invalid_input",
]);

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v"]);

/** Which inline renderer a file needs, from the server's content-type with the
 *  extension as a fallback (the server's MIME table has no PDF entry). */
export function mediaKindOf(contentType: string | null, filename: string): MediaKind | null {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("application/pdf")) return "pdf";
  const i = filename.lastIndexOf(".");
  const ext = i >= 0 ? filename.slice(i).toLowerCase() : "";
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return null;
}

/** Route statuses per the spec; 403 is ambiguous without the body. */
export function reasonFromStatus(status: number): PeekFailure {
  if (status === 404) return "missing";
  if (status === 403) return "permission";
  return "unavailable";
}

function peekUrl(abs: string): string {
  return `${serverBase()}/api/peek?path=${encodeURIComponent(abs)}`;
}

/** How one file's bytes are asked for. Production reads the box's /api/peek. */
export type PeekFetch = (
  abs: string,
  init: { method: "GET" | "HEAD"; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

const boxPeekFetch: PeekFetch = (abs, init) => fetch(peekUrl(abs), init);

let peekFetch: PeekFetch = boxPeekFetch;

/** The demo transport's seam: it has no box, so it answers from its own fixture. `null` restores the box. */
export function setPeekFetch(next: PeekFetch | null): void {
  peekFetch = next ?? boxPeekFetch;
}

function baseName(abs: string): string {
  return abs.slice(abs.lastIndexOf("/") + 1);
}

/** Why the server refused: the body's `reason` when readable, else the status. */
async function readFailure(res: Response): Promise<PeekFailure> {
  try {
    const body = (await res.json()) as { reason?: unknown };
    if (typeof body.reason === "string" && REASONS.has(body.reason)) return body.reason as FsReason;
  } catch {
    /* no JSON body — the status decides */
  }
  return reasonFromStatus(res.status);
}

type Head = { ok: true; size: number | null; contentType: string | null } | { ok: false; reason: PeekFailure };

async function peekHead(abs: string, signal: AbortSignal | undefined): Promise<Head> {
  const headers = authHeaders(clientToken());
  const head = await peekFetch(abs, { method: "HEAD", headers, signal });
  if (head.ok) {
    const len = head.headers.get("content-length");
    const n = len == null || len === "" ? null : Number(len);
    return {
      ok: true,
      size: n != null && Number.isFinite(n) && n >= 0 ? n : null,
      contentType: head.headers.get("content-type"),
    };
  }
  // HEAD has no body: ask again for one byte to learn the reason.
  try {
    const probe = await peekFetch(abs, { method: "GET", headers: { ...headers, range: "bytes=0-0" }, signal });
    if (!probe.ok) return { ok: false, reason: await readFailure(probe) };
    void probe.body?.cancel().catch(() => {});
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  return { ok: false, reason: reasonFromStatus(head.status) };
}

/** Read a response body, giving up the moment it exceeds `limit` bytes. */
async function readBounded(res: Response, limit: number): Promise<{ bytes: Uint8Array } | { tooLarge: true }> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > limit ? { tooLarge: true } : { bytes: buf };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      void reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return { bytes: out };
}

/** Binary = a NUL in the sniff window. (Invalid UTF-8 is checked on decode.) */
export function hasNulByte(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Decode as strict UTF-8; null when the bytes are not text. */
export function decodeText(bytes: Uint8Array): string | null {
  if (hasNulByte(bytes)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Load one file for the viewer. Rejects only when `signal` aborts; every other
 * failure is a `{ status: "failed" }` outcome.
 */
export async function loadPeekedFile(abs: string, signal?: AbortSignal): Promise<PeekOutcome> {
  try {
    const head = await peekHead(abs, signal);
    if (!head.ok) return { status: "failed", reason: head.reason };
    const media = mediaKindOf(head.contentType, baseName(abs));
    if (head.size === 0) return { status: "empty" };
    if (head.size != null && head.size > MAX_PREVIEW_BYTES) return { status: "too-large", size: head.size };
    if (media && head.size != null) return { status: "media", kind: media, size: head.size };

    const res = await peekFetch(abs, { method: "GET", headers: authHeaders(clientToken()), signal });
    if (!res.ok) return { status: "failed", reason: await readFailure(res) };
    const body = await readBounded(res, MAX_PREVIEW_BYTES);
    if ("tooLarge" in body) return { status: "too-large", size: head.size ?? MAX_PREVIEW_BYTES + 1 };
    const size = body.bytes.length;
    if (size === 0) return { status: "empty" };
    if (media) return { status: "media", kind: media, size };
    const text = decodeText(body.bytes);
    if (text == null) return { status: "binary", size };
    return { status: "text", text, size };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { status: "failed", reason: "network" };
  }
}

export type BlobOutcome =
  | { ok: true; blob: Blob }
  | { ok: false; reason: PeekFailure | "too-large"; size?: number };

/** GET a file's bytes as a Blob (media bodies, Markdown images). Never throws
 *  except on abort. */
export async function fetchPeekBlob(
  abs: string,
  opts: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<BlobOutcome> {
  const maxBytes = opts.maxBytes ?? MAX_PREVIEW_BYTES;
  try {
    const res = await peekFetch(abs, { method: "GET", headers: authHeaders(clientToken()), signal: opts.signal });
    if (!res.ok) return { ok: false, reason: await readFailure(res) };
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      void res.body?.cancel().catch(() => {});
      return { ok: false, reason: "too-large", size: declared };
    }
    const body = await readBounded(res, maxBytes);
    if ("tooLarge" in body) return { ok: false, reason: "too-large" };
    const type = res.headers.get("content-type") ?? "";
    return { ok: true, blob: new Blob([body.bytes as BlobPart], { type }) };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return { ok: false, reason: "network" };
  }
}

// ---------------------------------------------------------------------------
// Markdown images
// ---------------------------------------------------------------------------

type ResolveFn = (input: { base: string; paths: string[] }) => Promise<{
  results: Array<{ ok: true; abs: string; kind: "file" | "dir"; size: number } | { ok: false }>;
}>;

export type ImageResolver = {
  /** Resolves a relative image `src` to a blob: URL, or null (→ the alt text shows). */
  resolveImage: (src: string) => Promise<string | null>;
  /** Aborts what is in flight and revokes every blob URL handed out. The
   *  resolver stays usable afterwards (it starts fresh). */
  dispose: () => void;
};

/** `src` without its `#fragment` / `?query`, percent-decoded. */
export function imagePathOf(src: string): string {
  const cut = src.search(/[?#]/);
  const raw = cut >= 0 ? src.slice(0, cut) : src;
  try {
    return decodeURI(raw);
  } catch {
    return raw;
  }
}

/** One resolver per rendered Markdown file: relative images load through an
 *  authenticated fetch into blob URLs (≤ 10 MiB each), revoked on dispose. */
export function createImageResolver(fileDir: string, resolvePaths: ResolveFn): ImageResolver {
  let controller = new AbortController();
  let cache = new Map<string, Promise<string | null>>();
  const urls = new Set<string>();

  const load = async (src: string, signal: AbortSignal): Promise<string | null> => {
    const path = imagePathOf(src);
    if (!path) return null;
    try {
      const { results } = await resolvePaths({ base: fileDir, paths: [path] });
      const r = results[0];
      if (!r || !r.ok || r.kind !== "file" || r.size > MAX_MARKDOWN_IMAGE_BYTES) return null;
      const got = await fetchPeekBlob(r.abs, { signal, maxBytes: MAX_MARKDOWN_IMAGE_BYTES });
      if (!got.ok || signal.aborted) return null;
      if (mediaKindOf(got.blob.type, r.abs) !== "image") return null;
      const url = URL.createObjectURL(got.blob);
      urls.add(url);
      return url;
    } catch {
      return null;
    }
  };

  return {
    resolveImage(src) {
      let p = cache.get(src);
      if (!p) {
        p = load(src, controller.signal);
        cache.set(src, p);
      }
      return p;
    },
    dispose() {
      controller.abort();
      controller = new AbortController();
      cache = new Map();
      for (const u of urls) URL.revokeObjectURL(u);
      urls.clear();
    },
  };
}
