# Forge rules — authoring guide

Forge rules tell MantaUI what to do when a forge event arrives on the box. The
file is **written by a tool** (the `forge_rules` opencode tool), lives **on the
box** at `~/.manta/forge-rules/<host>/<owner>/<repo>.yaml`, and never travels
with the repository — nothing a pull request can edit ever reaches a rules
file. The whole subsystem is gated by one global toggle (Settings → Plugins
area), default off.

## The grammar — complete

One `on:` block. Three verbs. Nothing else.

```yaml
on:
  issue.labeled:
    label: manta
    do: delegate
    prompt: "Complete {{url}}. Open a draft PR."
  checks.failed:
    branch: mine
    do: notify
  review.requested:
    do: inbox
```

- **Events.** `issue.labeled`, `checks.failed`, `review.requested`. No others.
  A rule is keyed by one of these.
- **Verbs** (`do:`). `delegate` — start a background agent job in its own
  worktree. `notify` — ping a human. `inbox` — surface in the work inbox. No
  others.
- **Conditions.** `issue.labeled` may carry `label:` (match only that label).
  `checks.failed` may carry `branch:` (e.g. `mine` to only fire on your own
  PRs). A rule with no condition fires for every event of its type.
- **prompt.** Only on a `delegate` rule. The only placeholders are the fixed
  `{{url}}` and `{{title}}`. No expressions, no scripting, no shell.

## Rules

Unknown keys fail validation by name (`unknown key "lable"`), an unknown verb
is rejected, and a stray `prompt:` on a non-delegate rule is an error. Typo
protection matters more than flexibility in a file that can start an agent.

If a use case seems to need a new event, verb, or grammar form, that is a
MantaUI change (the adapter + ingest must understand it), not a rules change —
raise it rather than working around the grammar.

## The forge token

Registering the webhook needs a GitHub API token **on the box** (it never
reaches the desktop or phone). Set `MANTA_GITHUB_TOKEN` in the server env, or
store it as a shared secret whose key is `github.token` (`gitlab.token` for
GitLab) in the box secrets vault. The device-flow / `gh`-CLI legs of the token
ladder arrive with the GitHub adapter.

## Where it lives

- **Box-side storage** (`~/.manta/forge-rules/`), never a repository file. This
  is the security property: the AI wrote it, so nothing in a repo can change
  what runs on your machine.
- **One global toggle** (default off), not a per-repo trust dialog. With it off
  the subsystem is dormant: nothing registers, nothing ingests, nothing
  dispatches.

## Authoring loop

1. `forge_rules_save({ repo, yaml })` — validates, writes the file, registers
   or updates the webhook on the forge, hot-reloads. Returns "saved and valid"
   or the validator's errors verbatim (nothing written on an error).
2. `forge_rules_get({ repo })` — the current source, for editing.
3. `forge_rules_list()` — every repo with rules, **including invalid ones with
   their reason** — a rules file that silently fails to load is worse than one
   that loudly refuses.
4. `forge_rules_docs()` — this guide.

The validator is a single shared module (`src/shared/forgeRules.mjs`) imported
by the tool, the server and the tests — never a second copy.
