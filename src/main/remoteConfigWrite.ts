// Pure command-builder for writing a config file on the remote host over a
// single `ssh` invocation. Extracted from index.ts so it can be unit-tested
// without electron (same rationale as forwardHeal.ts).
//
// THE bug this fixes (regression): the original site did
//
//   `printf '%s' ${JSON.stringify(content)} > ~/.config/opencode/opencode.jsonc`
//
// where `content` was ALREADY `JSON.stringify(merged, null, 2)`. So the value
// interpolated into the shell command was `JSON.stringify` applied to a JSON
// string — i.e. double-encoded: real newlines became the two literal
// characters backslash-n, every `"` became `\"`, and the whole payload was
// wrapped in quotes. `printf '%s'` then wrote that escaped representation
// verbatim. Result on disk:
//
//   {\n  "skills": {\n    "urls": []\n  }\n}      ← literal backslash-n
//
// which is not valid JSON(C). opencode then failed to start with
// `ConfigJsonError`, taking down every session on the host (root cause of the
// 2026-05-18 leasebot wedge; opencode.jsonc mtime matched the corruption).
//
// Correct approach: write the bytes of `content` UNCHANGED. We use a
// single-quoted heredoc delimiter so the remote shell performs NO expansion
// or interpolation on the body — arbitrary JSON (quotes, $, backticks,
// backslashes, newlines) passes through byte-for-byte. This mirrors the
// established quoted-heredoc remote-write pattern in pty.ts (`<<'BUI_EOF'`).

// Long, unique delimiter. A heredoc terminates on a line that is EXACTLY the
// delimiter; making it long + improbable means well-formed JSON config can
// never accidentally contain a line equal to it. Exported so the test can
// assert the contract and locate the body.
export const REMOTE_CONFIG_HEREDOC_DELIM = "BUI_OPENCODE_JSONC_EOF_b3f1a9";

// Build the remote command that writes `content` verbatim to `remotePath`
// (creating the parent dir). `remotePath` is emitted unquoted so a leading
// `~` still expands to $HOME on the remote — callers pass a fixed, trusted
// path (not user input), so this is safe and intentional.
//
// Guard: a quoted heredoc cannot represent a body that contains a line equal
// to the delimiter. That's effectively impossible for JSON config with this
// delimiter, but we assert it rather than silently emit a broken command.
export function buildRemoteConfigWriteCmd(
  content: string,
  remotePath: string,
): string {
  const dir = remotePath.replace(/\/[^/]*$/, "");
  const delim = REMOTE_CONFIG_HEREDOC_DELIM;
  if (content.split("\n").some((line) => line === delim)) {
    throw new Error(
      `content contains a line equal to the heredoc delimiter (${delim}); refusing to emit a corrupt write command`,
    );
  }
  // Heredoc body must end with a newline so the closing delimiter sits on its
  // own line. `cat` writes the body (without that trailing terminator line)
  // exactly, so the file gets `content` with a single trailing newline.
  return (
    `mkdir -p ${dir} && cat > ${remotePath} <<'${delim}'\n` +
    `${content}\n` +
    `${delim}`
  );
}

// Test helper: given a command produced by buildRemoteConfigWriteCmd, return
// the exact bytes the remote `cat` would write (the heredoc body). Lets the
// test prove the round-trip: build → "execute" → original content, with NO
// double-encoding. Pure string manipulation; mirrors what a POSIX shell does
// with a single-quoted heredoc (no expansion).
export function extractHeredocBody(cmd: string): string {
  const delim = REMOTE_CONFIG_HEREDOC_DELIM;
  const open = `<<'${delim}'\n`;
  const start = cmd.indexOf(open);
  if (start < 0) throw new Error("no heredoc open found in command");
  const bodyStart = start + open.length;
  const end = cmd.lastIndexOf(`\n${delim}`);
  if (end < bodyStart) throw new Error("no heredoc close found in command");
  return cmd.slice(bodyStart, end);
}
