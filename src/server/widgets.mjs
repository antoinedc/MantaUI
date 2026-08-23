// widgets.mjs — inline widget store + read for manta-server.
//
// The remote AI authors a full standalone HTML document (an inline widget —
// e.g. a chart, a mini-app) and calls the global opencode `widget_show` tool
// (docs/opencode-tools/widget.ts), which POSTs to manta-server's /api/widgets.
// The HTML is stored under ~/.manta/widgets/<id>/index.html and served from
// manta-server itself at GET /widgets/<id> under the box's own published
// hostname. Registration announces the widget to the clients on the bus as
// ONE kind, `widget`, with an `action` discriminator — mirroring media.mjs's
// announcement pattern. servePage.mjs is the storage sibling; this module is
// servePage's storage + media's announcement.
//
// The widget id is a security boundary: 32 crypto-random bytes, hex (64
// chars). It is both the registry key and the path-traversal guard before any
// filesystem touch, mirroring servePage's isValidSubdomain.
//
// Widgets expire after a configurable TTL (default 24h); a cleanup sweep
// removes expired entries every 5 minutes (the same startPoller shape the
// neighbouring stores use).

import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { statePath } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { startPoller } from "./startPoller.mjs";

const STORE_PATH = statePath("widgets.json");
const WIDGETS_DIR = statePath("widgets");
const DEFAULT_TTL_HOURS = 24;

// Cleanup sweep interval — 5 min, matching servePage. Coarse enough to be
// cheap, fine enough that expired widgets don't linger.
const CLEANUP_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// The widget CSP — defined ONCE here and exported. The clients do not restate
// it, do not parse it, and do not carry their own copy.
// ---------------------------------------------------------------------------
//
// Three things here are load-bearing. Do not "tidy" any of them (see issue):
//   - `sandbox` WITHOUT `allow-same-origin`. `allow-scripts allow-same-origin`
//     together is a documented sandbox escape — the frame becomes same-origin
//     with its embedder and can rewrite its own sandbox attribute. Never add it.
//   - `connect-src 'none'` is the whole exfiltration defence. A widget that can
//     draw but cannot open a socket has a tiny blast radius. Never relax it,
//     and never add a "just for charts" exception — chart libraries must be
//     inlined into the widget HTML by the model, not fetched.
//   - `'unsafe-inline'` for script/style is deliberate and safe here precisely
//     because there is no network and no same-origin. Do not replace it with a
//     nonce scheme; that buys nothing and adds a code path.
export const WIDGET_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join("; ");

// Strict widget-id validator — 32 bytes of hex = 64 hex chars. Used both as
// the registry key and as the path-traversal guard before touching the
// filesystem, so a crafted `/widgets/../../etc/passwd` can never escape
// ~/.manta/widgets/.
export function isValidWidgetId(id) {
  return typeof id === "string" && /^[0-9a-f]{64}$/.test(id);
}

export function genWidgetId() {
  return randomBytes(32).toString("hex");
}

// Pure URL builder. Centralises the path shape so callers don't reconstruct
// it independently. The URL is served from manta-server itself under the box's
// own hostname (/widgets/<id>), like /pages/<sub>.
export function widgetUrl(baseUrl, id) {
  return `${baseUrl}/widgets/${id}`;
}

function resolveWidgetFile(id) {
  return join(WIDGETS_DIR, id, "index.html");
}

function resolveWidgetDir(id) {
  return join(WIDGETS_DIR, id);
}

// ---------------------------------------------------------------------------
// Store — durable registry in ~/.manta/widgets.json
// ---------------------------------------------------------------------------

export function loadWidgets(path = STORE_PATH) {
  const parsed = readJsonSync(path, {});
  return Array.isArray(parsed.widgets) ? parsed.widgets : [];
}

export function saveWidgets(widgets, path = STORE_PATH) {
  return writeJsonAtomic(path, JSON.stringify({ widgets }, null, 2));
}

// Resolve the registry's `expiresAt` from the caller-provided `ttlHours`,
// mirroring servePage's resolveExpiresAt:
//   - undefined/null → DEFAULT_TTL_HOURS from `now`
//   - 0              → null (never expires; sweep filter skips falsy)
//   - any other number → now + ttlHours * 3600 * 1000
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

// Normalise a dimensions field for storage + bus publication: any non-number
// becomes null. A widget that declares neither width/height nor aspectRatio is
// legal (the client falls back to its own default box); the tool description
// pushes the model to declare them so the client can reserve the box up front.
function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// CRUD — injectable via {load, save, publish, baseUrl}
// ---------------------------------------------------------------------------

// Routing fields published here are sessionId / messageId (lowercase `d`) —
// see the shared bus routing-field casing contract in src/shared/types.ts
// (BET-1328). The sibling `media` kind deliberately uses uppercase `ID`.
export async function registerWidget(
  { html, title, width, height, aspectRatio, ttlHours, sessionId, messageId },
  { load = loadWidgets, save = saveWidgets, publish, baseUrl } = {},
) {
  if (typeof html !== "string" || html.trim() === "") {
    return { ok: false, error: "html is required" };
  }
  // An unregistered box has no published hostname, so any URL we returned
  // would be unreachable — the same failure servePage guards against. There is
  // no stable widget URL without a base.
  if (!baseUrl) {
    return {
      ok: false,
      error:
        "This box has no published public hostname, so a widget URL would not " +
        "be reachable from anywhere. Inline widgets are unavailable on this box.",
    };
  }

  // Validate ttlHours before anything is written.
  const ttlResult = resolveExpiresAt(ttlHours);
  if (!ttlResult.ok) {
    return { ok: false, error: ttlResult.error };
  }
  const expiresAt = ttlResult.expiresAt;

  const id = genWidgetId();
  const widgetFile = resolveWidgetFile(id);

  // Write the HTML as a stable snapshot (exactly as servePage copies the
  // source file at register time).
  await mkdir(dirname(widgetFile), { recursive: true });
  await writeFile(widgetFile, html);

  const entry = {
    id,
    sessionId: sessionId ?? null,
    title: typeof title === "string" && title ? title : null,
    width: numOrNull(width),
    height: numOrNull(height),
    aspectRatio: numOrNull(aspectRatio),
    createdAt: Date.now(),
    expiresAt,
  };
  const widgets = load();
  widgets.push(entry);
  await save(widgets);

  const url = widgetUrl(baseUrl, id);
  if (publish) {
    publish({
      action: "show",
      id,
      url,
      title: entry.title,
      width: entry.width,
      height: entry.height,
      aspectRatio: entry.aspectRatio,
      sessionId: entry.sessionId,
      messageId: messageId ?? null,
    });
  }

  return { ok: true, id, url };
}

// Read a served widget from disk. Returns {ok:true, html:Buffer} on success,
// or {ok:false} when the widget is missing — in which case the matching
// registry entry is also pruned (the file may have been removed externally or
// swept), matching readPage. I/O is injectable so tests don't need a real
// filesystem.
export async function readWidget(id, { load = loadWidgets, save = saveWidgets } = {}) {
  const widgetFile = resolveWidgetFile(id);
  if (!existsSync(widgetFile)) {
    // Best-effort prune — a missing widget file is treated as "gone".
    try {
      const widgets = load();
      const filtered = widgets.filter((w) => w.id !== id);
      if (filtered.length < widgets.length) {
        await save(filtered);
      }
    } catch {
      // best-effort
    }
    return { ok: false };
  }
  try {
    const html = await readFile(widgetFile);
    return { ok: true, html };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Cleanup sweep — removes expired widgets every 5 min
// ---------------------------------------------------------------------------

export function createCleanupSweep({
  load = loadWidgets,
  save = saveWidgets,
  now = () => new Date(),
} = {}) {
  let inFlight = false;

  async function sweep() {
    if (inFlight) return;
    inFlight = true;
    try {
      const widgets = load();
      const expired = widgets.filter((w) => w.expiresAt && now().getTime() > w.expiresAt);
      if (expired.length === 0) return;

      for (const entry of expired) {
        try {
          const dir = resolveWidgetDir(entry.id);
          if (existsSync(dir)) {
            await rm(dir, { recursive: true });
          }
        } catch {
          // best-effort per-widget cleanup
        }
      }

      const remaining = widgets.filter((w) => !(w.expiresAt && now().getTime() > w.expiresAt));
      await save(remaining);
    } finally {
      inFlight = false;
    }
  }

  return { sweep };
}

export function startCleanupPoller({ intervalMs = CLEANUP_MS } = {}) {
  const { sweep } = createCleanupSweep();
  return startPoller(sweep, { intervalMs, label: "widgets" });
}
