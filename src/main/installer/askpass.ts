// askpass.ts — SSH_ASKPASS session manager for passphrase-protected keys.
//
// When the installer's preflight returns `auth-failed` because the user's SSH
// key is passphrase-protected AND not loaded in ssh-agent, this module sets
// up the OpenSSH SSH_ASKPASS mechanism so ssh can obtain the passphrase from
// a helper script instead of hanging on a terminal prompt.
//
// OpenSSH 8.4+ supports `SSH_ASKPASS_REQUIRE=force`, which makes ssh invoke
// the SSH_ASKPASS helper unconditionally — even when a controlling terminal
// is present (Electron GUI apps have none, but this is belt-and-suspenders).
// The helper is a tiny platform-native script that reads the passphrase from
// a 0600 temp file and writes it to stdout. Main writes that file after
// collecting the passphrase from the renderer's native dialog; it persists
// for the duration of the install + claim so every ssh invocation (six
// preflight probes + the install stream + `manta pair`) can reuse it without
// re-prompting.
//
// WHY a runtime-generated script (not a shipped .mjs): electron-vite bundles
// the main process into a single `out/main/index.js`. A loose .mjs file in
// src/ would either be bundled (breaking it as a standalone script) or
// require extra rollup/copy config. Generating the helper at runtime in a
// temp dir sidesteps the bundler entirely — no build config changes, works
// identically in `electron-vite dev` and in the packaged .app/.AppImage.
//
// The helper is cross-platform: `/bin/sh` on Unix, `.cmd` on Windows. Both
// are one-liners that `cat`/`type` the passphrase file — no Node, no native
// deps, no pty.

import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AskpassSession = {
  /** Env vars to merge into every ssh child's environment while this session
   *  is active: SSH_ASKPASS, SSH_ASKPASS_REQUIRE, MANTA_ASKPASS_FILE. */
  env: Record<string, string>;
  /** Delete the temp dir (helper script + passphrase file). Idempotent.
   *  Call in a finally / cleanup path — never leaves the passphrase on disk. */
  cleanup: () => void;
};

// The helper script content per platform. ssh invokes the script with the
// prompt text as argv[1]; we ignore it (we already know what the passphrase
// is for) and just emit the file's contents.
export function helperScriptContent(platform: string): string {
  if (platform === "win32") {
    return '@echo off\r\nif "%MANTA_ASKPASS_FILE%"=="" exit /b 1\r\ntype "%MANTA_ASKPASS_FILE%"';
  }
  return '#!/bin/sh\nif [ -z "$MANTA_ASKPASS_FILE" ]; then exit 1; fi\ncat "$MANTA_ASKPASS_FILE"';
}

export function helperScriptExtension(platform: string): string {
  return platform === "win32" ? ".cmd" : ".sh";
}

export type AskpassDeps = {
  platform?: string;
  tmpdirPath?: string;
  mkdtemp?: (prefix: string) => string;
  writeFile?: (path: string, data: string) => void;
  chmod?: (path: string, mode: number) => void;
  rm?: (path: string, opts: { recursive: boolean; force: boolean }) => void;
};

/**
 * Create an askpass session: a temp directory holding the helper script and
 * the passphrase file, plus the env vars ssh needs to find them.
 *
 * `passphrase` is the user's key passphrase, collected from the renderer
 * dialog BEFORE this function is called. It is written 0600 to a temp file
 * and deleted on `cleanup()`.
 */
export function createAskpassSession(
  passphrase: string,
  deps: AskpassDeps = {},
): AskpassSession {
  if (typeof passphrase !== "string") {
    throw new Error("createAskpassSession: passphrase is required");
  }
  const platform = deps.platform ?? process.platform;
  const tmpBase = deps.tmpdirPath ?? tmpdir();
  const mkdtemp = deps.mkdtemp ?? ((prefix: string) => mkdtempSync(join(tmpBase, prefix)));
  const writeFile = deps.writeFile ?? ((p, d) => writeFileSync(p, d, { mode: 0o600 }));
  const chmod = deps.chmod ?? ((p, m) => chmodSync(p, m));
  const rm = deps.rm ?? ((p, opts) => rmSync(p, opts));

  const dir = mkdtemp("manta-askpass-");
  const helperPath = join(dir, `askpass${helperScriptExtension(platform)}`);
  const passphrasePath = join(dir, "passphrase");

  writeFile(helperPath, helperScriptContent(platform));
  if (platform !== "win32") chmod(helperPath, 0o700);
  writeFile(passphrasePath, passphrase);

  const env: Record<string, string> = {
    SSH_ASKPASS: helperPath,
    SSH_ASKPASS_REQUIRE: "force",
    MANTA_ASKPASS_FILE: passphrasePath,
  };

  let cleaned = false;
  return {
    env,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try {
        rm(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}
