// Start a real OpenCode V2 server in a throwaway sandbox.
//
// SAFETY: this must never touch the live box's opencode. Everything the binary
// reads or writes lives under one fresh temp dir:
//   HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME
// The server password is random, the port is a free ephemeral one (never 4096 /
// 8787), and the child env is built from scratch — nothing OPENCODE_*-shaped or
// credential-shaped leaks in from the parent unless the caller passes it in
// `env` explicitly. Only the PID we spawned is ever signalled.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const FORBIDDEN_PORTS = new Set([4096, 8787]);

/** Ask the OS for a free loopback port (and never hand back a reserved one). */
export async function freePort() {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
      });
    });
    if (!FORBIDDEN_PORTS.has(port)) return port;
  }
  throw new Error("could not find a free port");
}

/** Environment for the sandboxed child: deliberately minimal, fully redirected. */
export function sandboxEnv(root, { password, extra = {} } = {}) {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg", "config"),
    XDG_DATA_HOME: join(root, "xdg", "data"),
    XDG_CACHE_HOME: join(root, "xdg", "cache"),
    XDG_STATE_HOME: join(root, "xdg", "state"),
    OPENCODE_PASSWORD: password,
    // Keep the sandbox from importing the box's Claude Code skills / checking
    // for updates / reaching out for model catalogues.
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    ...extra,
  };
}

export function basicAuthHeader(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

async function waitReady(url, auth, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`opencode exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(`${url}/api/plugin`, { headers: { authorization: auth } });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = String(e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`opencode not ready after ${timeoutMs}ms (${last})`);
}

/**
 * @param {object} opts
 * @param {string} opts.binary        absolute path to the opencode V2 binary
 * @param {(string|{src:string,name:string})[]} [opts.plugins]
 *        plugin files/dirs copied into $XDG_CONFIG_HOME/opencode/plugins/
 *        (under their basename, or `name` when given)
 * @param {Record<string,string>} [opts.env]  extra env for the child (e.g. ANTHROPIC_API_KEY)
 * @param {object} [opts.config]      written as $XDG_CONFIG_HOME/opencode/opencode.jsonc (plain JSON)
 * @param {string[]} [opts.dirs]      extra empty project dirs to create inside the sandbox
 * @returns {Promise<{url:string,auth:string,password:string,root:string,projectDir:string,
 *   dirs:Record<string,string>,logPath:string,pid:number,stop:()=>Promise<void>}>}
 */
export async function startSandbox({ binary, plugins = [], env = {}, dirs = [], config, readyTimeoutMs = 60_000 }) {
  const root = await mkdtemp(join(tmpdir(), "manta-v2-sandbox-"));
  const password = randomBytes(24).toString("base64url");
  let child;
  const cleanup = async () => {
    await rm(root, { recursive: true, force: true });
  };
  try {
    const e = sandboxEnv(root, { password, extra: env });
    for (const d of [e.HOME, e.XDG_CONFIG_HOME, e.XDG_DATA_HOME, e.XDG_CACHE_HOME, e.XDG_STATE_HOME]) {
      await mkdir(d, { recursive: true });
    }
    const pluginsDir = join(e.XDG_CONFIG_HOME, "opencode", "plugins");
    await mkdir(pluginsDir, { recursive: true });
    if (config !== undefined) {
      await writeFile(join(e.XDG_CONFIG_HOME, "opencode", "opencode.jsonc"), JSON.stringify(config, null, 2));
    }
    for (const p of plugins) {
      const { src, name } = typeof p === "string" ? { src: p, name: basename(p) } : p;
      await cp(src, join(pluginsDir, name), { recursive: true });
    }

    const projectDir = join(root, "project");
    await mkdir(projectDir, { recursive: true });
    const extraDirs = {};
    for (const name of dirs) {
      extraDirs[name] = join(root, "dirs", name);
      await mkdir(extraDirs[name], { recursive: true });
    }

    const port = await freePort();
    const logPath = join(root, "serve.log");
    const log = createWriteStream(logPath);
    child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: projectDir,
      env: e,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group so we can reap shell children of OUR server only
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });

    // If THIS process dies without reaching stop() (SIGINT/SIGTERM/crash), the
    // detached server must not be orphaned: reap its process group (our PID only).
    const reap = () => {
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    process.once("exit", reap);

    const url = `http://127.0.0.1:${port}`;
    const auth = basicAuthHeader(password);
    await waitReady(url, auth, child, readyTimeoutMs);

    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, 5000);
        await exited;
        clearTimeout(timer);
      }
      process.removeListener("exit", reap);
      log.end();
      await cleanup();
    };
    return { url, auth, password, root, projectDir, dirs: extraDirs, logPath, pid: child.pid, stop };
  } catch (err) {
    try {
      const tail = (await readFile(join(root, "serve.log"), "utf8")).split("\n").slice(-30).join("\n");
      err.message += `\n--- opencode serve.log (tail) ---\n${tail}`;
    } catch {
      /* no log yet */
    }
    if (child && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    await cleanup();
    throw err;
  }
}
