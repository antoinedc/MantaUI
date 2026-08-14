// servePage.mjs — page registry + read for the mobile server.
//
// The remote AI calls the global opencode `serve_page` tool
// (docs/opencode-tools/serve-page.ts), which POSTs to manta-server's
// /api/serve-page. The source file is copied into a stable directory
// under ~/.manta/pages/<subdomain>/index.html. Pages are served from
// manta-server itself at GET /pages/<subdomain> under the box's own
// published hostname (https://<gateway_host>/pages/<subdomain>) — no
// separate file server, no Host-header routing, no wildcard DNS record.
//
// Server-owned so pages survive Mac-app-close / session navigation / reboot.
// Pages expire after a configurable TTL (default 24h). A cleanup sweep
// removes expired entries every 5 minutes.

import { readFile, mkdir, copyFile, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { startPoller } from "./startPoller.mjs";

const STORE_PATH = statePath("serve-page.json");
const PAGES_DIR = statePath("pages");
const DEFAULT_TTL_HOURS = 24;

// Cleanup sweep interval — 5 min. Pages expire at TTL, sweep removes
// stale entries. 5 min is coarse enough to be cheap, fine enough that
// expired pages don't linger.
const CLEANUP_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Store — durable registry in ~/.manta/serve-page.json
// ---------------------------------------------------------------------------

export function loadPages(path = STORE_PATH) {
  const parsed = readJsonSync(path, {});
  return Array.isArray(parsed.pages) ? parsed.pages : [];
}

export function savePages(pages, path = STORE_PATH) {
  return writeJsonAtomic(path, JSON.stringify({ pages }, null, 2));
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
// hyphen. This keeps the value a safe single path segment under
// /pages/<subdomain>, so the route handler can hand it straight to the FS
// without any further traversal guard.
export function isValidSubdomain(s) {
  return typeof s === "string" && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s);
}

// Pure URL builder. Centralises the path shape so callers don't reconstruct
// it independently.
export function pageUrl(baseUrl, subdomain) {
  return `${baseUrl}/pages/${subdomain}`;
}

// Resolve the registry's `expiresAt` from the caller-provided `ttlHours`.
//   - `undefined`/`null` → DEFAULT_TTL_HOURS from `now`
//   - `0`               → `null` (never expires; sweep filter skips falsy)
//   - any other number  → `now + ttlHours * 3600 * 1000`
//   - non-number / negative / non-finite → {ok:false, error}
export function resolveExpiresAt(ttlHours, now = Date.now()) {
  if (ttlHours === undefined || ttlHours === null) {
    return { ok: true, expiresAt: now + DEFAULT_TTL_HOURS * 3600 * 1000 };
  }
  if (ttlHours === 0) {
    return { ok: true, expiresAt: null };
  }
  if (
    typeof ttlHours !== "number" ||
    !Number.isFinite(ttlHours) ||
    ttlHours < 0
  ) {
    return {
      ok: false,
      error: "ttlHours must be a non-negative number (0 = never expires)",
    };
  }
  return { ok: true, expiresAt: now + ttlHours * 3600 * 1000 };
}

// ---------------------------------------------------------------------------
// CRUD — injectable via {load, save, publish, baseUrl}
// ---------------------------------------------------------------------------

export async function registerPage(
  { subdomain, filePath, ttlHours, sessionID },
  { load = loadPages, save = savePages, publish, baseUrl } = {},
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
  // An unregistered box has no published hostname, so any URL we returned
  // would 404 silently — the exact failure this issue exists to kill.
  if (!baseUrl) {
    return {
      ok: false,
      error:
        "This box has no published public hostname (it has not registered with " +
        "the gateway), so a hosted page would not be reachable from anywhere. " +
        "Page hosting is unavailable on this box.",
    };
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

  // Validate ttlHours before any file is written. `0` means "never expires"
  // (stored as `expiresAt: null`); anything else present must be a finite
  // non-negative number.
  const now = Date.now();
  const ttlResult = resolveExpiresAt(ttlHours, now);
  if (!ttlResult.ok) {
    return { ok: false, error: ttlResult.error };
  }
  const expiresAt = ttlResult.expiresAt;

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
    url: pageUrl(baseUrl, subdomain),
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

export function listPages({ baseUrl } = {}) {
  return loadPages().map((p) => ({
    subdomain: p.subdomain,
    url: baseUrl ? pageUrl(baseUrl, p.subdomain) : "",
    expiresAt: p.expiresAt,
    createdAt: p.createdAt,
    sessionID: p.sessionID,
  }));
}

// Read a served page from disk. Returns {ok:true, html:Buffer} on success,
// or {ok:false} when the page is missing — in which case the matching
// registry entry is also pruned (the page dir may have been removed
// externally or swept), matching the file-server behaviour this replaces.
// I/O is injectable so tests don't need a real filesystem.
export async function readPage(
  subdomain,
  { load = loadPages, save = savePages } = {},
) {
  const pageFile = resolvePageFile(subdomain);
  if (!existsSync(pageFile)) {
    // Best-effort prune — a missing page dir is treated as "stop_page without
    // a stop_page call", same as the old file server did.
    try {
      const pages = load();
      const filtered = pages.filter((p) => p.subdomain !== subdomain);
      if (filtered.length < pages.length) {
        await save(filtered);
      }
    } catch {
      // best-effort
    }
    return { ok: false };
  }
  try {
    const html = await readFile(pageFile);
    return { ok: true, html };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Response headers — sandboxed + opaque-origin so a hosted page can't read
// the box_token out of the app's localStorage (which lives on the SAME
// origin now that pages share the hostname with the SPA).
// ---------------------------------------------------------------------------

export function pageResponseHeaders() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals",
  };
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
  return startPoller(sweep, { intervalMs, label: "serve-page" });
}
