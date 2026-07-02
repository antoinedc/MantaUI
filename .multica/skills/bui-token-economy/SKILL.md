---
name: bui-token-economy
description: Token-economy discipline for BUI agents on OpenCode runtime — batch parallel tool calls, compound shell commands, avoid re-reading after Edit, use offset/limit on large files. Load this if a task touches a long file or you find yourself making many sequential tool calls.
---

# bui-token-economy

Every turn re-reads the cached prefix. **Cache reads count fully against
the session quota.** Task cost ≈ N_turns × (initial_prefix + cumulative additions).

Discipline:

- **Batch independent tool calls in one turn.** Issue multiple
  `Read`/`Grep`/`Bash` in parallel within a single message, not
  back-to-back turns. One turn ≫ three turns.

- **Compound shell commands.** `cmd1 && cmd2 && cmd3` (or `;` for
  non-dependent) for multi-step inspection — never sequential
  single-command bash turns.

- **Don't re-Read after Edit.** `Edit` validates `old_string`; trust the
  prior Read. Re-reading the same file adds thousands of tokens to every
  subsequent turn's cache_read.

- **Use `offset`/`limit` on large Reads.** A 36KB file is ~9k tokens ×
  every later turn. Read only the relevant section.

- **No `--output json | head` / huge JSON dumps from bash.** Use
  `--output table` for inspection; project specific fields with
  `--jq`/`python3 -c` when JSON is needed.

- **Compound `git` ops.** `git status && git diff --stat && git log -3`
  in one bash call, not three turns.

- **Prefer `Grep` over `Bash` for content search.** Don't run `grep` or
  `rg` via Bash when the `Grep` tool exists — it's faster and returns
  structured results without parsing overhead.

- **Batch file reads when inspecting a directory.** If you need to
  understand the structure of `src/main/`, `src/renderer/`, etc., read
  the directory listing once and use it to plan targeted `Read`s — don't
  read files one at a time in separate turns.

- **Avoid redundant verification turns.** If you just ran `npm run
  typecheck && npm test` and both passed, don't run them again to
  "confirm" before posting results. Trust the output you just captured.
