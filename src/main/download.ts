// download.ts (desktop) — the ONE laptop-download path (BET-1156).
//
// A box file ("/api/download?path=<remotePath>") is pulled to the desktop's
// downloads dir over the direct HTTPS connection. This is the single place a
// desktop download lands — the outbox toast Save, the inline-media preview +
// hover overlay, and the artifacts panel all funnel through it (they reach
// main via the `downloadFileToDownloads` IPC channel exposed on the preload).
//
// Before BET-1156, the "save" was a renderer-side blob <a download> with no
// main-process handler, so nothing ever landed on the Mac. The pure bits here
// (download-dir resolution + filename dedupe) are extracted for testability;
// the HTTP+fs orchestration takes injectable deps so the whole path is
// verifiable without a live box or Electron.

import { basename, join } from "node:path";
import { existsSync, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

/**
 * Resolve the destination directory for a pulled file. Absent / empty
 * `downloadsDir` (from config) falls back to `defaultDir` (the caller's
 * `app.getPath("downloads")`, i.e. ~/Downloads). A leading "~" is NOT
 * expanded here — the config contract (src/shared/types.ts) requires an
 * absolute path or absent.
 */
export function resolveDownloadDir(
  downloadsDir: string | undefined,
  defaultDir: string,
): string {
  return downloadsDir && downloadsDir.trim() !== "" ? downloadsDir : defaultDir;
}

/**
 * Return an absolute path inside `dir` for `filename` that does not collide
 * with an existing file. On collision we append a numeric suffix before the
 * extension — `report.pdf` → `report (1).pdf` → `report (2).pdf` — the
 * smallest dedupe that never clobbers a prior download.
 */
export function uniqueLocalPath(
  dir: string,
  filename: string,
  exists: (p: string) => boolean,
): string {
  const safe = basename(filename) || "file";
  const dot = safe.lastIndexOf(".");
  // `dot > 0` so a leading-dot hidden file (".env") isn't treated as no extension.
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  let candidate = safe;
  let n = 1;
  while (exists(join(dir, candidate))) {
    candidate = `${stem} (${n})${ext}`;
    n++;
  }
  return join(dir, candidate);
}

/** Minimal fs surface the orchestration needs (injectable for tests). */
export type DownloadFs = {
  exists: (p: string) => boolean;
  mkdir: (dir: string) => Promise<void>;
  writeStream: (target: string, body: ReadableStream | null) => Promise<void>;
};

export type DownloadInput = {
  /** https://<box_id>.boxes.mantaui.com — the box's direct URL. */
  serverUrl: string;
  /** Bearer token — always the live box_token from config, never caller-supplied. */
  boxToken: string;
  /** Resolved destination dir; empty → caller's ~/Downloads. */
  downloadsDir?: string;
  /** Fallback dir when `downloadsDir` is absent (app.getPath("downloads")). */
  defaultDir: string;
  /** Remote box path to pull via /api/download. */
  remotePath: string;
  /** Desired local filename (basename of the remote file). */
  filename: string;
};

export const realFs: DownloadFs = {
  exists: (p) => existsSync(p),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeStream: async (target, body) => {
    if (!body) throw new Error("no body");
    await pipeline(Readable.fromWeb(body as ReadableStream<Uint8Array>), createWriteStream(target));
  },
};

/**
 * Pull a box file to the desktop's downloads dir and return its saved local
 * absolute path, or "" on any failure (unreachable box, bad token, write
 * error). Pure of Electron deps — `fetchImpl` / `fs` are injectable so tests
 * can drive both success and failure without a live box.
 */
export async function downloadFileToDownloads(
  input: DownloadInput,
  fetchImpl: typeof fetch = fetch,
  fs: DownloadFs = realFs,
): Promise<string> {
  const { serverUrl, boxToken, downloadsDir, defaultDir, remotePath, filename } = input;
  if (!serverUrl || !boxToken || !remotePath) return "";

  const dir = resolveDownloadDir(downloadsDir, defaultDir);
  const target = uniqueLocalPath(dir, filename || remotePath.split("/").pop() || "file", fs.exists);
  const url = `${serverUrl.replace(/\/+$/, "")}/api/download?path=${encodeURIComponent(remotePath)}`;

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${boxToken}` },
    });
    if (!res.ok) return "";
    await fs.mkdir(dir);
    await fs.writeStream(target, res.body);
  } catch {
    // Non-fatal from the UI's perspective — the caller keeps showing Save with
    // a retry affordance (the source remains on the box until the TTL sweep).
    return "";
  }
  return target;
}
