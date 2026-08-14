// src/server/forge/webhook.mjs — repository webhook registration for a forge
// (BET-797 + BET-799). Forge hooks are per-repo and POST straight to the box's
// own public hostname (`https://<box_id>.boxes.mantaui.com/hook/<token>`) — no
// gateway fan-out, no GitHub App. The box's own hostname is read via
// publicBaseUrl() (the same primitive servePage.mjs / the gateway use), never
// re-derived.
//
// Security contract (design spec §5): the forge request carries ONLY the box's
// public hostname plus a per-repo HMAC secret. A forge token never reaches the
// Electron renderer or the iOS app — all forge access is box-side, resolved
// here by the caller. The per-repo secret is the HMAC secret the forge signs
// deliveries with; the box stores it on the matching webhook record so ingest
// verification (webhooks.mjs) shares the same secret.
//
// Provider-aware since BET-799: GitHub and GitLab register hooks on different
// endpoints with different auth (Bearer vs PRIVATE-TOKEN) and different event
// booleans. The one part that MUST differ is whether a disabled hook is
// re-enabled: GitHub never auto-disables, but GitLab disables a failing hook
// permanently with no auto-recovery — so the health check has to turn it back
// on here.

import { randomBytes } from "node:crypto";

// The Manta webhook URL under a box's public hostname. `<token>` is the
// 128-bit capability that resolves to the hook record at ingest.
export function forgeHookUrl(publicBase, token) {
  return `${publicBase.replace(/\/+$/, "")}/hook/${token}`;
}

// The Hooks API base + credential header for a forge host. Hosted roots are
// canonical; a self-hosted host serves the conventional mount points.
export function githubApiBase(host) {
  if (host === "github.com") return "https://api.github.com";
  return `https://api.${host}`;
}
export function gitlabApiBase(host) {
  if (host === "gitlab.com") return "https://gitlab.com/api/v4";
  return `https://${host}/api/v4`;
}
export function forgeApiBase(kind, host) {
  return kind === "gitlab" ? gitlabApiBase(host) : githubApiBase(host);
}

export function githubAuthHeaders(token) {
  const headers = {
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "manta-server",
  };
  if (typeof token === "string" && token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}
export function gitlabAuthHeaders(token) {
  const headers = {
    accept: "application/vnd.gitlab+json",
    "content-type": "application/json",
    "user-agent": "manta-server",
  };
  if (typeof token === "string" && token) {
    headers["PRIVATE-TOKEN"] = token;
  }
  return headers;
}
export function forgeAuthHeaders(kind, token) {
  return kind === "gitlab" ? gitlabAuthHeaders(token) : githubAuthHeaders(token);
}

// Map our normalised rule-event names to GitLab's project-hook event booleans.
// Coarse and safe (we register broadly) — the precision a GitHub `events` array
// gives is matched by GitLab's booleans, so the same rule set maps to a broad
// hook. Keep the mapping table explicit rather than an if-chain.
export function gitlabEventsFor(events) {
  const ev = new Set(Array.isArray(events) ? events : []);
  const has = (...xs) => xs.some((x) => ev.has(x));
  return {
    push_events: has("push", "pipeline", "job"),
    pipeline_events: has("pipeline", "job", "check_run", "status"),
    job_events: has("pipeline", "job", "check_run", "status"),
    merge_requests_events: has("pull_request", "merge_request"),
    issues_events: has("issues", "issue"),
    note_events: has("issues", "note"),
    tag_push_events: false,
    enable_ssl_verification: true,
  };
}

// Build the request for creating a repo webhook. Pure. `deliveryToken` is the
// manta capability in the box's /hook URL; `token` is the box's forge credential
// (never conflated). `kind` routes to the provider's endpoint + auth + body.
export function buildCreateHookRequest({ kind = "github", host, owner, repo, token, deliveryToken, secret, events, publicBase }) {
  if (!publicBase) {
    throw new Error(
      "no public hostname — this box cannot receive webhooks (Tailscale-only / macOS boxes " +
        "deliberately skip public TLS; polling covers them)",
    );
  }
  const base = forgeApiBase(kind, host);
  const headers = forgeAuthHeaders(kind, token);
  if (kind === "gitlab") {
    return {
      url: `${base}/projects/${encodeURIComponent(`${owner}/${repo}`)}/hooks`,
      headers,
      body: {
        url: forgeHookUrl(publicBase, deliveryToken),
        token: secret,
        ...gitlabEventsFor(events),
      },
    };
  }
  return {
    url: `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
    headers,
    body: {
      name: "web",
      active: true,
      events,
      config: { url: forgeHookUrl(publicBase, deliveryToken), content_type: "json", secret },
    },
  };
}

function hookListUrl(kind, base, owner, repo) {
  return kind === "gitlab"
    ? `${base}/projects/${encodeURIComponent(`${owner}/${repo}`)}/hooks`
    : `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`;
}
function hookByIdUrl(kind, base, owner, repo, id) {
  return `${hookListUrl(kind, base, owner, repo)}/${id}`;
}

// The hook's delivery URL, for matching an existing hook by the URL we set.
function hookUrlOf(kind, hook) {
  return kind === "gitlab" ? hook?.url : hook?.config?.url;
}

// Register (or re-register) a repository webhook. `api` is the injectable
// (method, url, headers, body) → parsed-json client; injectable so unit tests
// never touch the network. On an existing hook with the same URL it PATCHes
// (refreshing the secret/events) rather than creating a duplicate. `kind`
// defaults to github so existing callers are unchanged.
export async function ensureRepoHook(
  { kind = "github", host, owner, repo, token, deliveryToken, publicBase, events },
  { api = githubFetch, now = () => new Date().toISOString() } = {},
) {
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  let req;
  try {
    req = buildCreateHookRequest({ kind, host, owner, repo, token, deliveryToken, secret, events, publicBase });
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }

  const url = forgeHookUrl(publicBase, deliveryToken);
  const base = forgeApiBase(kind, host);
  const headers = forgeAuthHeaders(kind, token);
  try {
    const list = await api("GET", hookListUrl(kind, base, owner, repo), headers);
    const existing = (Array.isArray(list) ? list : []).find((h) => hookUrlOf(kind, h) === url);
    let hook;
    if (existing?.id != null) {
      hook = await api("PATCH", hookByIdUrl(kind, base, owner, repo, existing.id), headers, {
        ...(req.body ?? {}),
      });
    } else {
      hook = await api("POST", req.url, req.headers, req.body);
    }
    return {
      ok: true,
      secret,
      hookId: hook?.id ?? existing?.id,
      events,
      url,
      registeredAt: now(),
    };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Health-check a registered hook. GitHub disables nothing automatically, but
 * GitLab disables a hook permanently after repeated failures with no automatic
 * recovery — so for a gitlab hook, when the check finds `active === false` it
 * RE-ENABLES it (`PUT {active: true}`) before reporting. Returns the hook's
 * active state plus whether a re-enable was performed.
 *
 * @param {{ kind?: "github"|"gitlab", host: string, owner: string, repo: string, token: string, hookId: any }} input
 */
export async function healthCheckRepoHook(
  { kind = "github", host, owner, repo, token, hookId },
  { api = githubFetch } = {},
) {
  try {
    const base = forgeApiBase(kind, host);
    const headers = forgeAuthHeaders(kind, token);
    let hook = await api("GET", hookByIdUrl(kind, base, owner, repo, hookId), headers);
    let reenabled = false;
    if (kind === "gitlab" && hook && hook.active === false) {
      // GitLab disabled this hook for failing; there is no auto-recovery on
      // that side, so the box re-arms it (the parent's §Webhooks requirement).
      hook = await api("PUT", hookByIdUrl(kind, base, owner, repo, hookId), headers, {
        active: true,
        ...(hook.url ? { url: hook.url } : {}),
      });
      reenabled = hook?.active === true;
    }
    let deliveries = [];
    try {
      const dlv = await api(
        "GET",
        `${hookByIdUrl(kind, base, owner, repo, hookId)}${kind === "gitlab" ? "" : "/deliveries?per_page=5"}`,
        headers,
      );
      deliveries = Array.isArray(dlv) ? dlv : [];
    } catch {
      // Deliveries endpoint is optional; a failure here is not a hook failure.
    }
    return { ok: true, active: hook?.active !== false, reenabled, deliveries };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// Default API client — a thin fetch wrapper. Injected as `api` in tests. Shared
// by both providers (it is auth-agnostic).
export async function githubFetch(method, url, headers, body) {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.message || json?.raw || `${res.status}`;
    throw new Error(msg);
  }
  return json;
}
