# CTO Discovery Recovery

This is an operator procedure, not an automatic migration. Do not rewind
`lastScanTs`, erase the registry, or replay the complete transcript: that can
double-count evidence and trigger new consent asks. No live recovery has been
performed by this change.

## Internal Ownership

New headless sessions write their ID to `cto/internal-sessions.json` through the
normal atomic CTO store before prompting. Tombstones survive deletion and restart
and are deliberately not expired. A corrupt or unreadable store blocks ownership
resolution and discovery rather than treating a session as human work.

Pre-upgrade sessions cannot be identified authoritatively from their title alone.
For an existing internal session, corroborate its ID using the CTO activeEphemeral
record or a recorded internal creation/run event. With the engine stopped and a
backup taken, add only those corroborated IDs using `patchStore` and
`internalSessionsStore`; preserve all existing IDs. Do not import every session
whose title starts with `cto:`. Unknown sessions without a matching tmux owner
remain excluded from live activity even before this repair.

## Classifier Recovery

New classifications distinguish retryable failure from explicit rejection.
`cto/tool-classification.json` reserves the daily attempt before model execution
and records its safe result before registry/card writes. Failed scans replay a
recorded result without calling the model again. A crash or result-write failure
leaves the reservation in place, consuming that day's attempt; a later retry
respects exponential backoff (one day initially, capped at fourteen days).
New candidates and eligible retries alternate when both exist, with the least
recently attempted retry going first. Include this store in maintenance backups;
never erase it to bypass the daily limit.
Replaying a saved result does not consume a new daily attempt. Applied outcomes
older than 90 days can be pruned, at most 1,000 per scan; pending outcomes and
unapplied reservations remain durable. Registry consent and aliases are untouched.
Legacy `unclassifiable` records have no such distinction. The regular scan may
retry one untouched legacy record only after evidence newer than its original
classification arrives. The original timestamp and recovery basis are preserved.
An explicit new `unknown` verdict is not retried by this migration. Human consent,
previous asks, integrated tools and resolved identities are never reset.

Without newer evidence or an operation-specific failure record, leave the legacy
record alone. A nearby generic ephemeral failure is not proof that classification
failed. This means some genuinely failed legacy classifications must wait for a
new observed use; that is intentional.

## Skipped History

1. Identify a specific failed scan interval from evidence, at most seven days.
   Record start/end timestamps, justification and the current scan cursor.
2. Stop the engine through the normal operator maintenance process. Back up
   `tool-registry.json`, `tool-usage.json`, `tool-classification.json`, and
   `internal-sessions.json` together.
   Never use an agent tool to edit these live during an active scan.
3. Open the opencode SQLite database read-only. Select at most 1,000 part rows
   inside that fixed interval, ordered by `(time_created, id)`, using
   `collectDbRows`. Use an explicit allowlist of corroborated human/worker session
   IDs for historical rows that predate durable provenance. Exclude internal IDs.
4. Run `extractFromDbRows` on that page to produce a dry-run report. Compare each
   identity against both registry canonical names and durable aliases. Report
   only missing identities, their source references and timestamps. Do not print
   transcript bodies, tool output, credentials or raw provider errors.
5. Review the report before applying anything. Restore only missing identities
   as unresolved `observed` candidates with ONE evidence observation each (even
   if the page has many occurrences). Preserve all existing records byte-for-byte,
   including consent, rejections, aliases, asks and counters. Save through
   `patchStore(toolRegistryStore, ...)`, not a whole-file overwrite from a stale
   snapshot. This deliberately waits for new use before classification or asks.
6. Record the interval, last reviewed `(time_created, id)` and restored identities
   in the maintenance record. Leave the normal scan and usage watermarks unchanged.
   Restart the engine normally and verify the preserved consent and cursor.

The 1,000-row bound is per reviewed recovery operation, not a loop. Continuing
requires another reviewed page within the same fixed interval. If no trustworthy
interval or historical ownership evidence exists, do not replay speculatively.

## PR 1504 Review Disposition

The reviewer session `ses_f68fb9237ffe13SZdKxHFQSVFw` was inspected through
message metadata only. Its intermediate assistant messages have completed
timestamps and `finish: tool-calls`; its final message
`msg_0970fd567001QI3Zuh9W2h2eRS` has `finish: stop`. No new model call was made.

| Finding | Disposition |
| --- | --- |
| 1 | Absent-finish premise disproved by live metadata. Missing finish stays non-terminal; a completed tool step is not completion. |
| 2 | Shared completion classifier accepts normalized and provider-native terminal/cap spellings, reusing shared truncation classification. |
| 3 | Positive/negative ownership caching, singleflight reads, cached parsed provenance with file-stamp/generation invalidation. Internal identity supersedes cached ownership. |
| 4 | Headless creation requests carry a 10-second abort signal. Ownership barriers and reads time out fail-closed rather than indefinitely blocking activity. |
| 5 | Operational execution failures are separately ledgered, not learned as failed plans or turned into false verification-failure cards. |
| 6 | Normalized findings preserve project/cwd/sender; producers and queue enrichment retain known targets. Missing targets remain non-learning failures. |
| 7 | Unknown prompt activity conservatively closes unattended work without entering evidence/profile/segments. Known internal activity remains excluded. |
| 8 | Unsupported SQLite waits a day; transient scan failures persist exponential backoff from five minutes to one hour. No cursor advancement on failure. |
| 9 | Provenance failures emit bounded, deduplicated, sanitized ledger diagnostics. |
| 10 | Empty/schema/output-cap failures may cascade; transport, provenance and cleanup failures do not. |
| 11 | Unrecognized failures use unknown-error, not schema-invalid. |
| 12 | Bounded pruning of old applied classification outcomes; pending outcomes and consent/aliases remain intact. |
| 13 | Free result replay leaves the actual classification budget available. |
| 14 | Actual pane cwd priority is intentional: directory targets must match it; project-name selection remains distinct. Safety tests retained. |
| 15 | Full-page cursor timestamp and ID validated before committing evidence/watermark. |
| 16 | Cleanup diagnostic accompanies the primary failure; it no longer overwrites it. Structured cleanup failures are checked too. |
| 17 | No recursive telemetry consumption found. Suggestion collectors filter kinds; digest content is sourced from rollups. Regression test excludes new telemetry. |
| 18 | No consent defect: spec section 4.4 explicitly permits transcript reads. Existing summary enabled/pause/budget gates remain before evidence reads. External tool consent is unchanged. |
| 19 | Failure-path tests inject creation tracking instead of mutating the shared production-store writer. Disk/restart tests retain isolated sandbox stores. |
