<!--
  bui-native tool guidance. Append (don't symlink) the body below into the
  user's global ~/.config/opencode/AGENTS.md so it's injected into every
  session. It tells the model when to reach for the bui-native tools.

    cat <repo>/docs/opencode-tools/AGENTS.md >> ~/.config/opencode/AGENTS.md

  (Strip this HTML comment if you like; opencode reads the file as plain text.)
-->

## bui scheduled tasks

You have a `schedule_create` tool that runs a prompt later in this same chat
session — once or on a recurring cron schedule. Use it whenever the user asks
you to do something at a later time or repeatedly, for example:

- "check on the task every 5 minutes" → `schedule_create` with `cron:"*/5 * * * *"`, `recurring:true`
- "remind me in 45 minutes to push the release" → a one-shot at the computed time, `recurring:false`
- "every weekday at 9am, summarize open PRs" → `cron:"0 9 * * 1-5"`, `recurring:true`

Convert the user's natural-language timing into a standard 5-field cron
expression (local time) yourself. When the time arrives, your prompt runs as a
fresh turn here automatically — you don't need to keep the session busy waiting.

Use `schedule_list` when the user asks what's scheduled, and `schedule_cancel`
to remove a task by id. The user can also see and delete scheduled tasks from
the bui UI (the ⏰ schedules card), so keep labels short and descriptive.

## bui serve page

You have `serve_page`, `stop_page`, and `list_pages` tools to host standalone
HTML pages publicly. When you generate a web page (design preview, demo,
mockup), call `serve_page(subdomain, filePath)` to get a public URL under
*.bui.antoinedc.com. The page auto-expires after 24h (configurable via
`ttlHours`, or `0` for no expiry). To update a page, call `serve_page` again
with the same subdomain and a new file. Call `stop_page(subdomain)` to take
it down early. `list_pages` shows all active pages.

- `serve_page(subdomain, filePath, ttlHours?)` -> "Page served at https://<sub>.bui.antoinedc.com"
- `stop_page(subdomain)` -> "Page <sub>.bui.antoinedc.com has been taken down."
- `list_pages` -> bullet list of active pages with URLs and expiry times
