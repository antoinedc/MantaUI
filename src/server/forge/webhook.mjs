// src/server/forge/webhook.mjs — repository webhook registration for a forge
// (BET-797). Forge hooks are per-repo and POST straight to the box's own
// public hostname (`https://<box_id>.boxes.mantaui.com/hook/<token>`) — no
// gateway fan-out, no GitHub App. The box's own hostname is read via
// publicBaseUrl() (the same primitive servePage.mjs / the gateway use), never
// re-derived. The GitLab adapter (a later issue) drops into this same seam:
// the URL is unwrap-from-reverse-proxy-able and the health-check exists
// because GitLab permanently disables a hook after repeated failures.
//
// Security contract (design spec §5): the forge request carries ONLY the box's
// public hostname plus a per-repo HMAC secret. A forge token never reaches the
// Electron renderer or the iOS app — all forge access is box-side, resolved
// here by the caller. The per-repo secret is the HMAC secret GitHub signs web
// deliveries with; the box stores it on the matching webhook record so ingest
// verification (webhooks.mjs) shares the same secret.

import { randomBytes } from "node:crypto";

// The Manta webhook URL under a box's public hostname. `<token>` is the
// 128-bit capability that resolves to the hook record at ingest.
export function forgeHookUrl(publicBase, token) {
  return `${publicBase.replace(/\/+$/, "")}/hook/${token}`;
}

// Build the request for creating a repo webhook. Pure — the caller runs it
// through an injectable GitHub API client. Returns { url, headers, body }.
// `deliveryToken` is the manta capability that appears in the box's /hook URL;
// `githubToken` is the box's forge credential used for the Authorization
// header. They are DIFFERENT tokens and must never be conflated.
export function buildCreateHookRequest({ host, owner, repo, githubToken, deliveryToken, secret, events, publicBase }) {
  if (!publicBase) {
    throw new Error(
      "no public hostname — this box cannot receive webhooks (Tailscale-only / macOS boxes " +
        "deliberately skip public TLS; polling covers them)",
    );
  }
  const base = githubApiBase(host);
  return {
    url: `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
    headers: githubAuthHeaders(githubToken),
    body: {
      name: "web",
      active: true,
      events,
      config: {
        url: forgeHookUrl(publicBase, deliveryToken),
        content_type: "json",
        secret,
      },
    },
  };
}

// The GitHub Hooks API base for a host. `github.com` maps to api.github.com;
// a self-hosted host would map to its own API root. Hosted GitHub is the only
// case this issue registers against.
export function githubApiBase(host) {
  if (host === "github.com") return "https://api.github.com";
  return `https://api.${host}`;
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

// Register (or re-register) a repository webhook. `api` is the injectable
// (method, url, headers, body) → parsed-json client; injectable so unit tests
// never touch the network. On an existing hook with the same URL it PATCHes
// (so the secret/events are refreshed) rather than creating a duplicate.
export async function ensureRepoHook(
  { host, owner, repo, githubToken, deliveryToken, publicBase, events },
  { api = githubFetch, now = () => new Date().toISOString() } = {},
) {
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  let req;
  try {
    req = buildCreateHookRequest({ host, owner, repo, githubToken, deliveryToken, secret, events, publicBase });
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }

  const url = forgeHookUrl(publicBase, deliveryToken);
  try {
    const list = await api("GET", `${githubApiBase(host)}/repos/${owner}/${repo}/hooks`, githubAuthHeaders(githubToken));
    const existing = (Array.isArray(list) ? list : []).find(
      (h) => h?.config?.url === url,
    );
    let hook;
    if (existing?.id != null) {
      hook = await api("PATCH", `${githubApiBase(host)}/repos/${owner}/${repo}/hooks/${existing.id}`, req.headers, {
        active: true,
        events,
        config: { url, content_type: "json", secret },
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

// Health-check a registered hook. GitHub disables nothing automatically, but
// GitLab disables a hook permanently after repeated failures — so the check
// exists before the GitLab adapter lands. Returns the hook's active state plus
// the recent delivery outcomes when the API exposes them.
export async function healthCheckRepoHook(
  { host, owner, repo, token, hookId },
  { api = githubFetch } = {},
) {
  try {
    const hook = await api(
      "GET",
      `${githubApiBase(host)}/repos/${owner}/${repo}/hooks/${hookId}`,
      githubAuthHeaders(token),
    );
    let deliveries = [];
    try {
      const dlv = await api(
        "GET",
        `${githubApiBase(host)}/repos/${owner}/${repo}/hooks/${hookId}/deliveries?per_page=5`,
        githubAuthHeaders(token),
      );
      deliveries = Array.isArray(dlv) ? dlv : [];
    } catch {
      // Deliveries endpoint is optional; a failure here is not a hook failure.
    }
    return { ok: true, active: hook?.active !== false, deliveries };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// Default GitHub API client — a thin fetch wrapper. Injected as `api` in tests.
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
    const msg = json?.message || json?.raw || `github ${res.status}`;
    throw new Error(msg);
  }
  return json;
}
