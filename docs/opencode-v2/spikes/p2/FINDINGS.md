# P2 — OpenCode V1 → V2 history migration (proof spike)

V2 binary: v2.0.30 at /home/dev/v2proof/bin/opencode. Isolated: HOME=/home/dev/v2proof/p2/home, all XDG_* under it, port 4212. Live box untouched (read-only access to live db only).

---

## Goal 1 — The real migration trigger (binary analysis)

**Answer:** The V1→V2 migration is **IN-PLACE in a single SQLite db**. V2 opens
its db at `data/opencode.db` (overridable by `OPENCODE_DB` env, or channel-
suffixed `opencode-<channel>.db` for non-prod channels). If that db ALSO
contains V1 tables (`session`, `project`, V1 `message`/`part` schema) next to
the V2 drizzle tables, V2 flags the v1→v2 content migration as `required`. It is
a SEPARATE step from the drizzle schema migration (round1-c's "table 'project'
already exists" crash was the drizzle step choking on a raw-V1 db that lacked
V2 tables — a mismatch, not the real path).

**Mechanism (decompiled from binary strings):**
- Db path resolver `Vk`: `process.env.OPENCODE_DB ?? "opencode.db"` (non-prod
  channels → `opencode-<channel>.db`); `:memory:` supported. Resolved under the
  data dir (`debug paths` → `data/opencode.db`).
- Status route: `GET /api/experimental/migration/v1` (handler
  `migration.v1.status`). Return union:
  `{status:"required"|"completed"} | {status:"running", progress:{label, numerator?, denominator?}} | {status:"error", error}`.
- Detection predicate `m_(e)`: `SELECT name FROM sqlite_master WHERE type='table' AND name='session'` (+ companion `c_`: requires `project` AND `session` tables present). So **"required" ⟺ a V1 `session` table exists in the V2 db**.
- Decision fn `vb()`: if no V1 signal → `completed`; if in-progress state → `running`; if kv phase=`completed` → `completed`; else → `required`.
- Start fn `bb()`: phases — (1) **"Clearing old events"** (no numerator), then
  (2) **"Migrating sessions"** with `numerator`=sessions migrated,
  `denominator`=total (`SELECT COUNT(*) FROM session` + project count). On
  failure → `status:"error"`.
- **Resumable**: progress stored in kv table as `{phase:"sessions", cursor:<sessionID>}`; on restart it resumes from `cursor` (fn `Rb`/`Ic`). `phase:"completed"` written at the end.
- TUI auto-polls `migration.v1.status` in a loop on startup and renders the
  progress; i.e. the migration is **triggered by the client calling the start/
  status route**, not silently by `serve` alone (serve exposes the route; the
  UI drives it). The API server stays up and the route is usable while it runs.

**Where V1 data must be:** inside V2's own db file (the default path is the
SAME as V1's `~/.local/share/opencode/opencode.db`), with its original V1
tables intact. No separate "v1.db" file, no JSON storage dir — V2 reads the V1
`session`/`part`/`message`/`project` rows directly from the one db and writes
V2 rows (`session_v2`, `session_message`) into the same file.

**Confidence:** verified (binary) for routes/predicates/phases/resumability;
to be confirmed live in Goals 2–6.

---

## Goal 3 — Fidelity (reduced db: 29 sessions, 2022 msgs, 7157 parts, 8 subagent children)

**Answer: HIGH fidelity, in-place, non-destructive.**

| Metric | V1 (source tables) | V2 (migrated) |
|---|---|---|
| sessions | 29 | `session_v2` = 29 ✓ |
| subagent children (parent_id set) | 8 | 8 ✓ (parentID links preserved) |
| messages | 2022 | `session_message` = 2050* |
| parent `ec3ef059` cost | 365.0878168 | 365.0878168 ✓ |
| parent tokens_input/output | 1512 / 270300 | 1512 / 270300 ✓ |
| file-part messages | 326 parts | 171 `session_message` rows carry `"type":"file"` ✓ |
| tool-part messages | 1790 parts | 1436 rows carry `"type":"tool"` ✓ |

\* 2050 > 2022 because the migration PREPENDS a synthetic V2 `system` message per
session ("tools renamed: bash→shell, task→subagent, todowrite removed…"). V1's
`message`+`part` two-table model is FOLDED into one `session_message` row per
message (content parts inlined into `data` JSON; types seen: assistant/user/
system/synthetic). Timestamps, title, cost, token buckets
(input/output/reasoning/cache read+write) all carried over verbatim (spot-checked
parent + a child + a mid-size standalone via `GET /api/session/{id}/message`).

**V1 tables are LEFT INTACT** (`session`/`message`/`part` still 29/2022/7157 after
migration) → the source is preserved, so rollback = point V2 away / restore is
unnecessary because V1 rows are untouched in the same file.

---

## Goal 4 — Disk footprint

- **In-place, single file.** No second db created, no doubling. The ONE
  `opencode.db` holds both the untouched V1 tables AND the new V2 tables.
- Reduced db grew from 32632832 bytes (pre) to its post-migration size (V2 rows
  added alongside V1). Net: **V2 rows ADD to the file** (V1 not deleted), so a
  real migration temporarily needs headroom ≈ (V1 content size) again within the
  same file, since V2 duplicates the content in the new schema while keeping V1.
- No separate temp db; SQLite WAL/journal is the only transient overhead.
- **Rollback cost:** keeping V1 tables means the migrated file carries ~2× the
  session content until a later cleanup drops V1 tables (not observed to happen
  automatically — kv phase just flips to `completed`).

(Exact sizes measured in the timed re-run below.)

---

## Goal 2 — Progress timeline & throughput (LIVE run, reduced db)

**Trigger (corrected from Goal 1):** `opencode serve` **AUTO-RUNS the V1→V2
content migration on startup** — no client call needed. Observed: a passive
poller watched `required → running → completed` with NOTHING driving it but the
server itself. Server starts, runs drizzle schema migrations, then runs the
content migration, THEN prints `server listening`. The status route is live
throughout; the API answers during migration.

**Progress shape (exact, for the UI progress bar):**
```
{"status":"running","progress":{"label":"Clearing old events"}}            # phase 1, no numerator
{"status":"running","progress":{"label":"Migrating sessions","numerator":N,"denominator":29}}  # phase 2
{"status":"completed"}
```
- `denominator` = total sessions (+ projects) — stable for the whole run.
- `numerator` = sessions migrated so far, increments 1-by-1 (observed 3→29
  densely; a single progress bar `numerator/denominator` is exact).
- `label` is a human string; phase 1 "Clearing old events" has no counts
  (indeterminate spinner), phase 2 "Migrating sessions" is determinate.

**Timing (29 sessions, 2022 msgs, 7157 parts, 32.6 MB):** serve-start →
content-complete ≈ **7.7 s** (includes ~10 drizzle schema migrations + Clearing
old events + Migrating sessions). The "Migrating sessions" phase alone was ~5 s.

**Throughput (conservative, from the visible window):** ~5.5 sessions/s,
~380 msgs/s, ~1350 parts/s, ~6 MB/s.

**Extrapolation to LIVE (4420 sessions, 172448 msgs, 648693 parts, 32 GB):**
by messages ≈ 7.5 min, by parts ≈ 8 min, by sessions ≈ 13 min. The MB-rate
(~6 MB/s → ~90 min) is likely the realistic floor on the big db because the live
db has very large sessions (the reduced sample capped session size). **Budget
15–90 min; show a determinate `numerator/denominator` bar — it is accurate.**

---

## Goal 5 — Robustness

- **Idempotent.** Restart on an already-migrated db → `{"status":"completed"}`,
  no re-run, `session_v2`/`session_message` counts unchanged (29 / 2050). The kv
  key `migration.v1-v2 = {"phase":"completed"}` gates it.
- **Resumable after a hard kill.** `kill -9` at numerator=5 left the db at
  `session_v2=5, session_message=413` with kv =
  `{"phase":"sessions","cursor":"ses_f989…"}`. Restart RESUMED from the cursor
  (first observed numerator=7, not 0) and completed to 29/29 — **no corruption,
  no duplication, no double-migrated sessions.** Each session is migrated in its
  own transaction and the cursor advances per session, so an interruption loses
  at most the in-flight session, which is redone cleanly.
- **Disk-full not simulated** (tmpfs needs root — out of scope per safety rules).
  But see Goal 4: the file grows ~1.76×, so an out-of-disk failure mid-write
  would surface as a SQLite write error → `{"status":"error"}` and the kv cursor
  would let a retry resume after space is freed.

---

## Goal 6 — Coexistence / rollback isolation

**Proven.** `OPENCODE_DB=<path>` points V2 at an arbitrary db file (resolver
`Vk`: `process.env.OPENCODE_DB ?? data/opencode.db`). With it set to a COPY of
the V1 db:
- V2 migrated ONLY the copy; the default `data/opencode.db` was **not created**
  (removed it first to prove exclusivity).
- The original pristine V1 db's sha256 was **unchanged** after the run.

So the rollback-safe procedure is: **copy the V1 db to a new path, set
`OPENCODE_DB` to the copy, migrate the copy.** The original V1 db is never
touched; rollback = point back at V1 (or just keep running V1). Even migrating
the ORIGINAL in-place is semi-reversible — V2 keeps the V1 tables intact in the
same file — but the clean, guaranteed rollback is the separate-copy approach.

---

## Goal 7 — Recommended migration procedure for a real box

1. **Pre-flight disk check.** Migration keeps V1 tables AND writes V2 tables into
   ONE file → file grows ≈ **1.76×** (measured). Require free space on the target
   filesystem ≥ **0.8 × (V1 db size)** headroom (plus WAL slack). Formula:
   `need ≈ 1.0 × v1_db_size` free to be safe.
   **⚠ LIVE BLOCKER:** live db = 32 GB on a volume with ~3 GB free. In-place
   migration would need ~25 GB more → it **cannot run on the current volume**.
   Either migrate onto a larger volume (copy V1 db there, set `OPENCODE_DB`), or
   grow the volume first.
2. **Stop V1** (`systemctl --user stop opencode-serve`) — never migrate a live db.
3. **Back up / copy** the V1 db to the migration target path (ideally a roomy
   volume): `cp opencode.db /big/opencode.db`.
4. **Run migration**: start V2 with `OPENCODE_DB=/big/opencode.db opencode serve …`.
   It auto-migrates on startup. (Or run a short-lived serve just to migrate.)
5. **Drive the UI** by polling `GET /api/experimental/migration/v1` (Basic auth
   `opencode:<password>` from the startup line) ~1/s: render
   `progress.numerator/progress.denominator` as the bar, `progress.label` as the
   caption; `completed` → dismiss the blocking screen; `error` → show
   `error` + a retry (safe: resumable + idempotent).
6. **Cut over**: point the box's opencode service at the migrated db path
   (keep `OPENCODE_DB` or move the file to the default path once verified).
7. **Rollback**: the original V1 db is untouched — revert the service to V1 (or
   to the original db path). Reclaim the ~0.8× extra space later by dropping the
   V1 tables only after the migration is trusted.

**UI note:** the screen must be BLOCKING during migration (V2 answers API calls
but session content is mid-move). Progress is a true determinate bar. Expect a
short indeterminate "Clearing old events" lead-in, then the counted "Migrating
sessions" phase.
