// A stand-in for manta-server's /api routes, for exercising the Manta tools
// without a real box. `cannedResponse` is the single source of canned JSON; it
// is served over HTTP by `startFakeMantaServer` (e2e harness, records every
// request) and also called directly by the unit tests' fake `fetch`.

import { createServer } from "node:http";

const json = (body, status = 200) => ({ status, body });

/** Route + canned JSON. `req` = { method, pathname, query (URLSearchParams), body }. */
export function cannedResponse(req) {
  const { method, pathname: p, query, body } = req;
  const is = (m, path) => method === m && p === path;

  if (is("POST", "/api/schedule")) return json({ id: "job12345" });
  if (is("GET", "/api/schedule"))
    return json({
      jobs: [
        { id: "job12345", label: "deploy check", prompt: "check deploy", cron: "*/5 * * * *", recurring: true },
        { id: "job67890", label: "", prompt: "push release", cron: "30 14 15 3 *", recurring: false },
      ],
    });
  if (is("DELETE", "/api/schedule")) {
    return query.get("id") === "nope0000" ? json({ deleted: false }) : json({ deleted: true });
  }

  if (is("POST", "/api/notify")) return json({ ok: true });

  if (is("GET", "/api/secrets"))
    return json({
      secrets: [
        { key: "github_pat", scope: "shared", hint: "GitHub PAT" },
        { key: "deploy_key", scope: "project", project: "manta" },
        { key: "scratch", scope: "session" },
      ],
    });
  if (is("POST", "/api/secrets/provide"))
    return json({ key: body?.key, path: `/home/u/.manta-secrets/${body?.key}`, hint: "use by reference" });

  if (is("POST", "/api/webhook")) return json({ id: "hook1234", url: "https://box.example/hook/tok", secret: "s3cr3t" });
  if (is("GET", "/api/webhook"))
    return json({
      hooks: [
        { id: "hook1234", label: "ci green", url: "https://box.example/hook/tok", unsigned: false, lastDeliveredAt: 1700000000000, deliveries: 3 },
        { id: "hook5678", label: "open", url: "https://box.example/hook/t2", unsigned: true },
      ],
    });
  if (is("DELETE", "/api/webhook")) return json({ deleted: query.get("id") !== "nope0000" });

  if (is("POST", "/api/delegate")) {
    if (body?.prompt === "decline-me") return json({ ok: false, error: "user declined" });
    return json({ ok: true, id: "abc12345", job: { id: "abc12345", name: "bg-job" } });
  }
  if (is("GET", "/api/delegate"))
    return json({
      jobs: [
        { id: "abc12345", name: "bg-job", status: "running", branch: "delegate/x", worktree: "/w" },
        { id: "def67890", name: "other", status: "done" },
      ],
    });
  {
    const m = /^\/api\/delegate\/([^/]+)\/stop$/.exec(p);
    if (method === "POST" && m) {
      return decodeURIComponent(m[1]) === "boom0000"
        ? json({ error: "job boom0000 is not running" }, 409)
        : json({ ok: true });
    }
  }

  if (is("GET", "/api/peers")) {
    if (query.get("target")) {
      return json({
        peer: {
          name: query.get("target"),
          type: "chat",
          status: "working",
          branch: "feat/x",
          cwd: "/work/x",
          git: { count: 2, files: [{ status: " M", path: "a.ts" }, { status: "??", path: "b.ts" }] },
          todos: [{ status: "completed", content: "one" }, { status: "in_progress", content: "two" }, { status: "pending", content: "three" }],
          turns: [{ role: "assistant", text: "hi", tools: ["read"] }, { role: "user", text: "" }],
        },
      });
    }
    return json({
      workspace: "ws",
      peers: [
        { name: "peer-a", type: "chat", status: "working", branch: "feat/x", gitChanges: 3, activity: "editing" },
        { name: "peer-b", type: "tui", status: "idle", gitChanges: 0, activity: "idle" },
      ],
    });
  }
  if (is("POST", "/api/peers")) return json({ to: body?.target, workspace: "ws" });

  if (is("POST", "/api/media")) {
    if (body?.action === "begin") return json({ handle: "mh_1" });
    return json({ path: "/home/u/x.png", mime: "image/png", width: 640, height: 480, size: 1234 });
  }
  if (is("POST", "/api/plan-render")) return json({ url: "https://box.example/pages/plan-1" });
  if (is("POST", "/api/progress")) return json({ ok: true });
  if (is("POST", "/api/outbox/push")) return json({ row: { name: "export.csv", expiresAt: 1700000000000 } });
  if (is("POST", "/api/cto/inbound")) return json({ parked: true });
  if (is("POST", "/api/cto/facts")) return json({ queued: false, proposalId: "p1", outcome: { action: "accepted", reason: "evidence ok" } });
  if (is("POST", "/api/cto/verdict")) return json({ effects: { facts: 1, trust: 2 } });
  if (is("POST", "/api/cto")) return json({ ok: true, data: { sessions: ["a", "b"] } });

  if (is("POST", "/api/serve-page")) return json({ url: "https://box.example/pages/preview" });
  if (is("GET", "/api/serve-page"))
    return json({ pages: [{ url: "https://box.example/pages/a", expiresAt: 1700000000000 }, { url: "https://box.example/pages/b" }] });
  if (is("DELETE", "/api/serve-page")) return json({ deleted: query.get("subdomain") !== "nope" });
  if (is("POST", "/api/widgets")) return json({ url: "https://box.example/widgets/w1" });

  if (is("GET", "/api/plugins/registry"))
    return json({
      rows: [
        {
          name: "ios-app",
          description: "Build the iOS app",
          inputs: [
            { id: "scheme", description: "Xcode scheme", type: "string", required: true },
            { id: "mode", type: "enum", values: ["debug", "release"], default: "debug" },
          ],
          valid: true,
          yaml: "name: ios-app\n",
          stepCount: 3,
          timeoutMs: 600000,
        },
        { name: "broken", description: "", inputs: [], valid: false, error: "bad yaml", yaml: "x", stepCount: 0, timeoutMs: null },
      ],
    });
  if (is("POST", "/api/cap")) return json({ id: "job1" });
  {
    const m = /^\/api\/cap\/([^/]+)$/.exec(p);
    if (method === "GET" && m) {
      return json({ id: decodeURIComponent(m[1]), capability: "ios-app", status: "done", log: ["line1\n", "line2\nline3"] });
    }
  }
  if (is("GET", "/api/plugins/docs")) return json({ docs: "# Plugin docs" });

  if (is("POST", "/api/forge-rules")) {
    if (body?.yaml === "invalid") return json({ ok: false, errors: [{ path: "on.x", message: "unknown key" }, { message: "bad" }] });
    return json({ ok: true, webhook: { registered: true, url: "https://github.com/hook" } });
  }
  if (is("GET", "/api/forge-rules/docs")) return json({ docs: "# Forge rules docs" });
  if (is("GET", "/api/forge-rules")) {
    if (query.get("repo")) return query.get("repo") === "github.com/o/missing" ? json({}) : json({ yaml: "on: {}\n" });
    return json({ rules: [{ repoKey: "github.com/o/r", valid: true }, { repoKey: "github.com/o/bad", valid: false, error: "oops" }] });
  }

  if (is("POST", "/api/app-control")) {
    switch (body?.action) {
      case "compact-session":
        return json({ ok: true });
      case "switch-model":
        return body.query === "nomodel"
          ? json({ ok: false, error: "no model matches nomodel" })
          : json({ ok: true, model: { modelID: "claude-opus-5-5" } });
      case "rename-session":
        return json({ ok: true, name: body.name });
      case "list-sessions":
        return json({
          ok: true,
          workspace: "ws",
          sessions: [
            { name: "main", index: 0, chat: true, branch: "main", caller: true },
            { name: "shell", index: 1, chat: false, branch: null, caller: false },
          ],
        });
      default:
        return json({ ok: false, error: `unknown action ${body?.action}` }, 400);
    }
  }

  if (is("GET", "/api/resource-snapshot"))
    return json({
      capturedAt: "2026-10-16T00:00:00.000Z",
      status: "ok",
      suggestedJobMemoryBytes: 2 * 1024 ** 3,
      memory: {
        totalBytes: 16 * 1024 ** 3,
        availableBytes: 10 * 1024 ** 3,
        opencodeCgroup: { currentBytes: 2 * 1024 ** 3, limitBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 },
      },
      cpu: { count: 8, load1: 0.5, load5: 0.25, load15: 0.1 },
      disk: { path: "/work", availableBytes: 30 * 1024 ** 3, totalBytes: 75 * 1024 ** 3 },
      topProcesses: [{ name: "node", pid: 123, rssBytes: 300 * 1024 ** 2 }],
      containers: { available: true, items: [{ name: "pg", id: "c1", cpuPercent: 1.5, memoryUsageBytes: 100 * 1024 ** 2, memoryLimitBytes: 512 * 1024 ** 2 }] },
      warnings: ["docker slow"],
    });

  return json({ error: `fake manta-server: no route ${method} ${p}` }, 404);
}

/**
 * HTTP server around `cannedResponse`. `requests` records, per call:
 * { method, url, pathname, query (object), body, authorization }.
 */
export async function startFakeMantaServer({ token } = {}) {
  const requests = [];
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://fake");
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({
        method: req.method,
        url: req.url,
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        authorization: req.headers.authorization ?? null,
      });
      const out =
        token && req.headers.authorization !== `Bearer ${token}`
          ? json({ error: "unauthorized" }, 401)
          : cannedResponse({ method: req.method, pathname: url.pathname, query: url.searchParams, body });
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reset: () => void (requests.length = 0),
    stop: () => new Promise((resolve) => srv.close(() => resolve())),
  };
}
