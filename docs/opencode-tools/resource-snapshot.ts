// manta-native `resource_snapshot` tool — global opencode custom tool.
//
// Install on the opencode host (the Linux box that runs manta-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/resource-snapshot.ts ~/.config/opencode/tools/resource-snapshot.ts
//   cp <repo>/docs/opencode-tools/manta-auth.ts ~/.config/opencode/tools/manta-auth.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
// DO NOT symlink — opencode resolves a tool's imports relative to the file's
// REAL path, so a symlink back into the repo fails to find @opencode-ai/plugin.
// Forgetting manta-auth.ts makes the tool silently fail to register.
//
// PURPOSE: give the model a fresh, cheap, READ-ONLY view of the box's resource
// headroom (memory, CPU load, disk, top processes, Docker containers) before it
// launches something expensive. Advisory only — it never runs, limits or kills
// anything. THIN registrar: GETs manta-server (127.0.0.1:8787, same box, no SSH
// hop); the collection lives in src/server/resourceSnapshot.mjs.

import { tool } from "@opencode-ai/plugin";
import { authHeaders } from "./manta-auth";

const MANTA_SERVER = process.env.MANTA_SERVER_URL || "http://127.0.0.1:8787";

// The request is bounded: the box may be exactly as overloaded as the model is
// trying to find out, and a hung call would stall the whole turn. The server's
// own per-source probes finish in a few seconds, so 10s is generous.
// MANTA_RESOURCE_SNAPSHOT_TIMEOUT_MS overrides it (tests only).
const REQUEST_TIMEOUT_MS = Number(process.env.MANTA_RESOURCE_SNAPSHOT_TIMEOUT_MS) || 10_000;

async function call(path: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${MANTA_SERVER}${path}`, {
      method: "GET",
      headers: authHeaders(),
      signal: controller.signal,
    });
    const text = await res.text(); // also covered by the abort signal
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text };
    }
    if (!res.ok) {
      throw new Error(json?.error || `manta-server ${res.status}`);
    }
    return json;
  } catch (e: any) {
    if (controller.signal.aborted) {
      throw new Error(
        `resource_snapshot timed out after ${REQUEST_TIMEOUT_MS / 1000}s waiting for manta-server — ` +
          "the box may be heavily loaded or manta-server may be stuck. Treat headroom as unknown: " +
          "run heavy work serially, or retry in a few seconds. " +
          "(Operator: `systemctl --user status manta-server`.)",
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function gib(bytes: number | null | undefined): string {
  if (typeof bytes !== "number") return "unknown";
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function mib(bytes: number | null | undefined): string {
  if (typeof bytes !== "number") return "?";
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function num(n: number | null | undefined, digits = 2): string {
  return typeof n === "number" ? n.toFixed(digits) : "?";
}

export const resource_snapshot = tool({
  description: [
    "Get a fresh, read-only snapshot of this box's resource headroom: memory",
    "(host total/available, plus opencode's own cgroup memory current/limit/",
    "available — the budget opencode itself can use, which can be tighter than",
    "the host), CPU count + load, free disk on the current work",
    "directory's filesystem, the top memory-consuming processes (pid, name, RSS",
    "only — never command lines or environment), and Docker container CPU/memory",
    "when Docker is available. Returns a status (ok / constrained / critical) and",
    "a conservative suggested memory allowance for ONE new heavy job, sized from",
    "the lower of host and opencode-cgroup available memory.",
    "Call it BEFORE expensive builds, full test suites, or container launches.",
    "If the status is constrained or critical, run heavy work serially and lower",
    "parallelism (fewer workers/jobs/containers). Re-check before launching",
    "additional concurrent heavy work. Values are measurements, not guarantees.",
    "A source that is unavailable (e.g. no Docker) is reported in warnings and",
    "does not hide the other readings. This tool changes nothing on the box.",
  ].join(" "),
  args: {},
  async execute(_args, context) {
    const params = new URLSearchParams();
    if (context.directory) params.set("directory", context.directory);
    const qs = params.toString();
    const r = await call(`/api/resource-snapshot${qs ? `?${qs}` : ""}`);

    const lines: string[] = [];
    lines.push(`Resource snapshot (${r.capturedAt}) — status: ${r.status}`);
    lines.push(
      `Suggested memory for ONE new heavy job: ${
        typeof r.suggestedJobMemoryBytes === "number" ? gib(r.suggestedJobMemoryBytes) : "unknown"
      } (max 20% of the lower of host and opencode-cgroup available)`,
    );
    lines.push(`Memory (host): ${gib(r.memory?.availableBytes)} available of ${gib(r.memory?.totalBytes)}`);
    const cg = r.memory?.opencodeCgroup;
    if (cg && typeof cg.currentBytes === "number") {
      lines.push(
        typeof cg.limitBytes === "number"
          ? `Memory (opencode cgroup budget): ${gib(cg.availableBytes)} available — ${gib(cg.currentBytes)} used of ${gib(cg.limitBytes)} limit`
          : `Memory (opencode cgroup budget): ${gib(cg.currentBytes)} used, no limit (host is the bound)`,
      );
    } else {
      lines.push("Memory (opencode cgroup budget): unknown");
    }
    lines.push(
      `CPU: ${r.cpu?.count ?? "?"} cores, load ${num(r.cpu?.load1)} / ${num(r.cpu?.load5)} / ${num(r.cpu?.load15)} (1/5/15 min)`,
    );
    lines.push(
      `Disk (${r.disk?.path ?? "unknown path"}): ${gib(r.disk?.availableBytes)} free of ${gib(r.disk?.totalBytes)}`,
    );

    const procs: any[] = r.topProcesses ?? [];
    if (procs.length > 0) {
      lines.push("Top processes by memory:");
      for (const p of procs) lines.push(`  • ${p.name} (pid ${p.pid}) — ${mib(p.rssBytes)} RSS`);
    } else {
      lines.push("Top processes: none reported");
    }

    if (r.containers?.available) {
      const items: any[] = r.containers.items ?? [];
      if (items.length === 0) {
        lines.push("Docker containers: none running");
      } else {
        lines.push("Docker containers:");
        for (const c of items) {
          const limit = typeof c.memoryLimitBytes === "number" ? ` / ${mib(c.memoryLimitBytes)}` : "";
          lines.push(
            `  • ${c.name} (${c.id}) — CPU ${num(c.cpuPercent, 1)}%, mem ${mib(c.memoryUsageBytes)}${limit}`,
          );
        }
      }
    } else {
      lines.push("Docker containers: unavailable");
    }

    const warnings: string[] = r.warnings ?? [];
    if (warnings.length > 0) {
      lines.push("Warnings:");
      for (const w of warnings) lines.push(`  • ${w}`);
    }
    return lines.join("\n");
  },
});
