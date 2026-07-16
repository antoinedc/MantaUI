// servePage.mjs — file server + page registry for the mobile server.
//
// The remote AI calls the global opencode `serve_page` tool
// (docs/opencode-tools/serve-page.ts), which POSTs to bui-server's
// /api/serve-page. The source file is copied into a stable directory
// under ~/.manta/pages/<subdomain>/, and an in-process HTTP server
// on 127.0.0.1:20080 serves it. Caddy reverse-proxies *.bui.antoinedc.com
// to this port, so the page is accessible at https://<sub>.bui.antoinedc.com.
//
// Server-owned so pages survive Mac-app-close / session navigation / reboot.
// Pages expire after a configurable TTL (default 24h). A cleanup sweep
// removes expired entries every 5 minutes.

import { readFile, writeFile, rename, mkdir, copyFile, stat, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname, extname } from "node:path";
import { STATE_DIRNAME } from "../shared/paths.mjs";

const STORE_PATH = join(homedir(), STATE_DIRNAME, "serve-page.json");
const PAGES_DIR = join(homedir(), STATE_DIRNAME, "pages");
const FILE_SERVER_PORT = 20080;
const FILE_SERVER_HOST = "127.0.0.1";
const DEFAULT_TTL_HOURS = 24;
const DOMAIN_SUFFIX = ".bui.antoinedc.com";

// Cleanup sweep interval — 5 min. Pages expire at TTL, sweep removes
// stale entries. 5 min is coarse enough to be cheap, fine enough that
// expired pages don't linger.
const CLEANUP_MS = 5 * 60 * 1000;

// MIME types for common file extensions.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

// ---------------------------------------------------------------------------
// Atomic write — same pattern as local.mjs / schedule.mjs
// ---------------------------------------------------------------------------

async function atomicWrite(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// Store — durable registry in ~/.manta/serve-page.json
// ---------------------------------------------------------------------------

export function loadPages(path = STORE_PATH) {
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.pages) ? parsed.pages : [];
    }
  } catch {
    // corrupt file — start fresh
  }
  return [];
}

export function savePages(pages, path = STORE_PATH) {
  return mkdir(dirname(path), { recursive: true }).then(() =>
    atomicWrite(path, JSON.stringify({ pages }, null, 2)),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId() {
  return randomBytes(4).toString("hex");
}

function resolvePageFile(subdomain) {
  return join(PAGES_DIR, subdomain, "index.html");
}

function resolvePageDir(subdomain) {
  return join(PAGES_DIR, subdomain);
}

// Validate subdomain: 1-63 chars, alphanumeric + hyphen, no leading/trailing
// hyphen. This prevents injection into the Host header and ensures the
// subdomain matches the *.bui.antoinedc.com wildcard cert.
export function isValidSubdomain(s) {
  return typeof s === "string" && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s);
}

// Extract the page subdomain from an incoming Host header. Returns null when
// the host isn't under DOMAIN_SUFFIX, the subdomain is empty, or it contains a
// dot (multi-level subdomains aren't valid page names). Pure + tested.
export function extractSubdomain(hostHeader, suffix = DOMAIN_SUFFIX) {
  if (typeof hostHeader !== "string") return null;
  const host = hostHeader.split(":")[0].toLowerCase();
  if (!host.endsWith(suffix)) return null;
  const sub = host.slice(0, host.length - suffix.length);
  if (!sub || sub.includes(".")) return null;
  return sub;
}

// ---------------------------------------------------------------------------
// CRUD — injectable via {load, save, publish}
// ---------------------------------------------------------------------------

export async function registerPage(
  { subdomain, filePath, ttlHours, sessionID },
  { load = loadPages, save = savePages, publish } = {},
) {
  if (!subdomain || !isValidSubdomain(subdomain)) {
    return {
      ok: false,
      error: `Invalid subdomain "${subdomain}". Must be 1-63 lowercase alphanumeric characters or hyphens (no leading/trailing hyphens).`,
    };
  }
  if (!filePath) {
    return { ok: false, error: "filePath is required" };
  }

  // Source file must exist and be a regular file.
  try {
    const s = await stat(filePath);
    if (!s.isFile()) {
      return { ok: false, error: `"${filePath}" is not a regular file` };
    }
  } catch {
    return { ok: false, error: `Source file "${filePath}" not found or not readable` };
  }

  const ttl = ttlHours ?? DEFAULT_TTL_HOURS;
  const now = Date.now();
  const expiresAt = now + ttl * 3600 * 1000;
  const pageFile = resolvePageFile(subdomain);

  // Copy source into stable directory.
  await mkdir(dirname(pageFile), { recursive: true });
  await copyFile(filePath, pageFile);

  // Update registry: replace existing entry for this subdomain.
  const pages = load();
  const existingIdx = pages.findIndex((p) => p.subdomain === subdomain);
  const entry = {
    id: existingIdx >= 0 ? pages[existingIdx].id : genId(),
    subdomain,
    filePath,
    sessionID: sessionID ?? null,
    createdAt: existingIdx >= 0 ? pages[existingIdx].createdAt : now,
    expiresAt,
  };
  if (existingIdx >= 0) {
    pages[existingIdx] = entry;
  } else {
    pages.push(entry);
  }
  await save(pages);

  if (publish) publish({ kind: "servePage.updated" });

  return {
    ok: true,
    url: `https://${subdomain}.bui.antoinedc.com`,
    subdomain,
    expiresAt,
  };
}

export async function unregisterPage(
  subdomain,
  { load = loadPages, save = savePages, publish } = {},
) {
  const pages = load();
  const filtered = pages.filter((p) => p.subdomain !== subdomain);
  const deleted = filtered.length < pages.length;
  if (deleted) {
    await save(filtered);
    // Remove the page directory.
    try {
      const pageDir = resolvePageDir(subdomain);
      await rm(pageDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  if (publish) publish({ kind: "servePage.updated" });
  return { deleted };
}

export function listPages() {
  return loadPages().map((p) => ({
    subdomain: p.subdomain,
    url: `https://${p.subdomain}.bui.antoinedc.com`,
    expiresAt: p.expiresAt,
    createdAt: p.createdAt,
    sessionID: p.sessionID,
  }));
}

// ---------------------------------------------------------------------------
// Cleanup sweep — removes expired pages every 5 min
// ---------------------------------------------------------------------------

export function createCleanupSweep({
  load = loadPages,
  save = savePages,
  now = () => new Date(),
} = {}) {
  let inFlight = false;

  async function sweep() {
    if (inFlight) return;
    inFlight = true;
    try {
      const pages = load();
      const expired = pages.filter((p) => p.expiresAt && now().getTime() > p.expiresAt);
      if (expired.length === 0) return;

      for (const entry of expired) {
        try {
          const dir = resolvePageDir(entry.subdomain);
          if (existsSync(dir)) {
            await rm(dir, { recursive: true });
          }
        } catch {
          // best-effort per-page cleanup
        }
      }

      const remaining = pages.filter((p) => !(p.expiresAt && now().getTime() > p.expiresAt));
      await save(remaining);
    } finally {
      inFlight = false;
    }
  }

  return { sweep };
}

export function startCleanupPoller({ intervalMs = CLEANUP_MS } = {}) {
  const { sweep } = createCleanupSweep();
  // Run once immediately to clean up any leftover expired pages.
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

// ---------------------------------------------------------------------------
// HTTP file server — serves pages from disk on 127.0.0.1:20080
// ---------------------------------------------------------------------------

export function createFileServer({ host = FILE_SERVER_HOST, port = FILE_SERVER_PORT } = {}) {
  const server = createServer(async (req, res) => {
    // Extract subdomain from Host header.
    // e.g. "preview.bui.antoinedc.com" → "preview"
    const subdomain = extractSubdomain(req.headers.host ?? "");
    if (!subdomain) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown host" }));
      return;
    }

    const pageFile = resolvePageFile(subdomain);

    if (!existsSync(pageFile)) {
      // Page directory may have been deleted externally; clean up stale registry entry.
      try {
        const pages = loadPages();
        const filtered = pages.filter((p) => p.subdomain !== subdomain);
        if (filtered.length < pages.length) {
          await savePages(filtered);
        }
      } catch {
        // best-effort
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `page "${subdomain}" not found` }));
      return;
    }

    try {
      const content = await readFile(pageFile);
      const contentType = MIME[extname(pageFile).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, {
        "content-type": contentType,
        "content-length": content.length,
        "cache-control": "no-store",
      });
      res.end(content);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "failed to read page" }));
    }
  });

  return {
    start: () => new Promise((resolve) => server.listen(port, host, resolve)),
    stop: () => new Promise((resolve) => server.close(resolve)),
    server,
  };
}

export function startFileServer() {
  const { start, stop, server } = createFileServer();
  start();
  console.log(`[serve-page] file server listening on ${FILE_SERVER_HOST}:${FILE_SERVER_PORT}`);
  return { stop, server };
}
