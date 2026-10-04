# Resource Budget Tool

## Goal

Give opencode models a fresh, low-cost view of the box's resource headroom before they launch resource-intensive work. The initial version is advisory and read-only; it does not execute or constrain workloads.

## User-visible behavior

- A global MantaUI opencode tool, `resource_snapshot`, is available to sessions on the box.
- The tool returns a compact current snapshot: physical memory total/available, opencode's cgroup current/limit/available memory when measurable, CPU count/load, free disk on the requested work directory's filesystem, top memory-consuming processes (PID, executable name, RSS only), and Docker container CPU/memory usage when Docker is available.
- Docker absence, unavailable metrics, and per-source collection failures are represented explicitly; a failure in one source does not discard the other readings.
- Resource values are measurements, not guarantees. The response includes a conservative suggested memory allowance for one new heavy job, capped at 20% of the lower of host and opencode-cgroup available memory when cgroup limits are measurable, plus a status (`ok`, `constrained`, `critical`) based on available-memory and disk headroom.
- The tool description and `docs/opencode-tools/AGENTS.md` instruct models to call it before expensive builds, test suites, or container launches; prefer serial execution and reduce parallelism when constrained; re-check before launching additional concurrent work.

## Pinned API contract

- `GET /api/resource-snapshot?directory=<optional absolute path>` (Bearer-authenticated, class-2/operator-to-model response).
- Success: `{ ok: true, capturedAt: string, memory: { totalBytes: number|null, availableBytes: number|null, opencodeCgroup: { currentBytes: number|null, limitBytes: number|null, availableBytes: number|null } }, cpu: { count: number, load1: number|null, load5: number|null, load15: number|null }, disk: { path: string|null, totalBytes: number|null, availableBytes: number|null }, topProcesses: Array<{ pid: number, name: string, rssBytes: number }>, containers: { available: boolean, items: Array<{ id: string, name: string, cpuPercent: number|null, memoryUsageBytes: number|null, memoryLimitBytes: number|null }> }, status: "ok"|"constrained"|"critical", suggestedJobMemoryBytes: number|null, warnings: string[] }`.
- Process command lines, environment variables, Docker inspect data, and logs are never returned.
- The route is read-only, bounded by short per-source timeouts, and returns partial results rather than hanging when Docker or a metrics source is unavailable. The registrar's HTTP request is also bounded.
- Directory input is restricted to an existing absolute directory; absent input uses the server's working directory. It selects the filesystem for disk reporting only.

## Implementation boundaries

- Add a pure/injected-I/O server module for snapshot collection, REST route wiring, and focused unit tests.
- Add the thin global opencode tool registrar using shared `manta-auth.ts`; document its install/copy requirements.
- Do not change watchdog policy, process/container launch behavior, MantaUI settings, or automatic concurrency enforcement in this change.
- Preserve unrelated working-tree changes.

## Acceptance criteria

1. A model can call the tool and receive a current snapshot without needing shell access or guessing box state.
2. The tool remains bounded and returns useful partial results when Docker is absent or a probe times out.
3. Returned fields contain no command-line arguments, environment values, or container logs.
4. Status and suggested allowance are deterministic for boundary cases and covered by tests.
5. Typecheck and focused server tests pass; full project checks pass before merge.
