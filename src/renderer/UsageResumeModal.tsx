// UsageResumeModal.tsx — the "resume after limit reset" management surface
// (BET-1049). One list across all providers, grouped by workspace, of the
// conversations a subscription provider limit stopped (the box-side record,
// src/server/stoppedStore.mjs). The user picks which should carry on by
// themselves when quota returns; arming writes the SAME record the sidebar
// indicator + row markers read, so everything stays in sync and survives a
// restart.
//
// Built only from existing primitives — Modal, Checkbox, Pill, Callout,
// Button, --sp/* and --r-* scales. Nothing hand-rolled: the mockup
// (docs/screens/usage-resume/mockup.html) maps every element onto these, and
// a new bespoke button/checkbox/chip/dialog here is a review defect.
//
// The row content is display-only except the checkbox: the model chip shows
// the model that was in flight (deliberately not a picker), cost is the
// cold-cache estimate (0 when the reset is inside the prompt-cache window),
// and "new" is the stoppedAt-vs-lastLooked badge. Nothing is ever enrolled
// automatically.

import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Pill } from "./Pill";
import { Callout } from "./Callout";
import { Checkbox } from "./Checkbox";
import { useStore } from "./store";
import { formatResetAt, formatResetDistance, formatTokens, selectCacheTtlMs } from "./chatUtils";
import { extractLastSnippet, groupStoppedByWorkspace, isNewStopped, resumeCosts, selectionSummary } from "./usageResume";
import type { StoppedRecord, UsageSnapshot } from "../shared/types";

function windowChipLabel(record: StoppedRecord, snapshots: readonly UsageSnapshot[]): string {
  if (!record.window) return "Limit";
  const snap = (snapshots ?? []).find((s) => s.provider === record.provider);
  const win = snap?.windows.find((w) => w.kind === record.window);
  if (win?.label) return win.label;
  return record.window.charAt(0).toUpperCase() + record.window.slice(1);
}

export function UsageResumeModal({
  open,
  onClose,
  nameFor,
}: {
  open: boolean;
  onClose: () => void;
  /** conversation (opencode session id) → sidebar display name. */
  nameFor: (conversation: string) => string;
}) {
  const records = useStore((s) => s.usageStopped);
  const lastLooked = useStore((s) => s.lastLookedStopped);
  const usage = useStore((s) => s.usage);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [snippets, setSnippets] = useState<Record<string, string | null>>({});

  const nowMs = Date.now();
  // Effective prompt-cache TTL is measured server-side (BET-1334); the
  // cold-vs-warm estimate falls back to the 5-minute default.
  const ttlMs = selectCacheTtlMs(null);

  const costs = useMemo(() => resumeCosts(records, usage, nowMs, ttlMs), [records, usage, nowMs, ttlMs]);
  const summary = useMemo(() => selectionSummary(records, selected, costs), [records, selected, costs]);
  const groups = useMemo(() => groupStoppedByWorkspace(records), [records]);

  const hasArmed = records.some((r) => r.armed === true);
  const newCount = records.filter((r) => isNewStopped(r, lastLooked)).length;
  const coldSelected = records.filter((r) => selected.has(r.conversation) && (costs.get(r.conversation) ?? 0) > 0).length;

  // On open: default the selection to the already-armed rows; fetch a
  // best-effort last-activity snippet per conversation. Reads the store fresh
  // so the effect only runs on the open transition.
  useEffect(() => {
    if (!open) return;
    const recs = useStore.getState().usageStopped;
    setSelected(new Set(recs.filter((r) => r.armed === true).map((r) => r.conversation)));
    let cancelled = false;
    for (const r of recs) {
      window.api.opencodeMessages(r.conversation, { limit: 5 }).then(
        (msgs) => {
          if (cancelled) return;
          setSnippets((s) => ({ ...s, [r.conversation]: extractLastSnippet(msgs) }));
        },
        () => {
          if (!cancelled) setSnippets((s) => ({ ...s, [r.conversation]: null }));
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [open]);

  const close = () => {
    void window.api.usageStoppedStampLastLooked();
    onClose();
  };

  const apply = () => {
    // Arm every currently-selected conversation; explicitly remove (disarm)
    // any that were armed but are no longer selected.
    void (async () => {
      for (const r of records) {
        if (selected.has(r.conversation)) {
          if (r.armed !== true) await window.api.usageStoppedArm(r.conversation);
        } else if (r.armed === true) {
          await window.api.usageStoppedDisarm(r.conversation);
        }
      }
    })().finally(close);
  };

  const toggleAll = () => {
    setSelected(summary.allSelected ? new Set() : new Set(records.map((r) => r.conversation)));
  };

  const toggleOne = (conversation: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(conversation);
      else next.delete(conversation);
      return next;
    });
  };

  const header = hasArmed
    ? `${records.filter((r) => r.armed === true).length} armed · ${newCount} stopped since you last looked.`
    : `${records.length} conversation${records.length === 1 ? "" : "s"} ${
        records.length === 1 ? "was" : "were"
      } stopped by a provider limit. Pick which ones should carry on by themselves when quota returns.`;

  return (
    <Modal open={open} size="lg" tall onDismiss={close} label="Resume after limit reset">
      <div className="flex flex-col min-h-0">
        <div className="p-5 pb-3">
          <h2 className="text-title font-semibold">Resume after limit reset</h2>
          <p className="mt-1 text-meta text-text-faint">{header}</p>
        </div>

        <div className="flex items-center justify-between gap-3 border-y border-border-subtle bg-bg-elev px-5 py-2">
          <button type="button" className="text-label font-medium text-accent hover:underline" onClick={toggleAll}>
            {summary.allSelected ? "Uncheck all" : "Check all"}
          </button>
          <span className="text-meta text-text-faint">
            {summary.selectedCount} of {summary.totalCount} selected
          </span>
        </div>

        <div className="overflow-auto px-3 pb-4">
          {groups.length === 0 ? (
            <p className="px-2 py-4 text-body text-text-faint">
              No conversations are stopped by a provider limit right now.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.workspace}>
                <div className="flex items-center gap-2 px-2 pb-1 pt-3 text-micro font-semibold uppercase tracking-wider text-text-quiet">
                  <span>{group.workspace}</span>
                  <span className="h-px flex-1 bg-border-subtle" />
                </div>
                {group.rows.map((r) => {
                  const cost = costs.get(r.conversation) ?? 0;
                  const resetsAt = (() => {
                    const snap = (usage ?? []).find((s) => s.provider === r.provider);
                    return snap?.windows.find((w) => w.kind === r.window)?.resetsAt;
                  })();
                  const warm = cost === 0;
                  return (
                    <div
                      key={r.conversation}
                      className={"flex gap-3 rounded-md p-3 " + (selected.has(r.conversation) ? "bg-fill border border-border-subtle" : "border border-transparent")}
                    >
                      <div className="mt-px">
                        <Checkbox
                          checked={selected.has(r.conversation)}
                          onChange={(c) => toggleOne(r.conversation, c)}
                          ariaLabel={`Resume ${nameFor(r.conversation) || r.conversation}`}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-label font-medium text-text">{nameFor(r.conversation) || r.conversation}</span>
                          {r.armed === true && <Pill tone="accent" size="meta">armed</Pill>}
                          {isNewStopped(r, lastLooked) && <Pill tone="warn" size="meta">new</Pill>}
                        </div>
                        {snippets[r.conversation] && (
                          <div className="mt-1 truncate text-meta text-text-faint">{snippets[r.conversation]}</div>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Pill tone="neutral" size="meta" border>
                            <span className="font-mono">{r.provider}</span>
                            <span className="text-text-muted">{r.model ?? "—"}</span>
                          </Pill>
                          <Pill tone="warn" size="meta">
                            {resetsAt != null
                              ? `${windowChipLabel(r, usage)} · ${formatResetAt(resetsAt, nowMs)} · in ${formatResetDistance(resetsAt - nowMs)}`
                              : windowChipLabel(r, usage)}
                          </Pill>
                          {warm ? (
                            <Pill tone="ok" size="meta">cache still warm · no extra cost</Pill>
                          ) : (
                            <Pill tone="neutral" size="meta">≈ {formatTokens(cost)} re-read</Pill>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}

          {coldSelected > 0 && (
            <Callout tone="warn" size="note">
              {coldSelected === 1
                ? "One of these resets well past your prompt-cache window, so its history is re-read from scratch. The estimate is per conversation above."
                : `${coldSelected} of these reset well past your prompt-cache window, so their history is re-read from scratch. The estimate is per conversation above.`}
            </Callout>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle bg-bg-elev px-5 py-3">
          <span className="text-meta text-text-faint">
            <b className="font-semibold text-text">{summary.selectedCount} selected</b>
            {summary.batchTotal > 0 ? ` · ≈ ${formatTokens(summary.batchTotal)} re-read` : " · no extra cost"}
          </span>
          <div className="flex gap-2">
            <Button tone="default" onClick={close}>
              {hasArmed ? "Close" : "Cancel"}
            </Button>
            <Button tone="primary" onClick={apply} disabled={summary.selectedCount === 0}>
              {hasArmed ? "Update" : `Resume ${summary.selectedCount} at reset`}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

