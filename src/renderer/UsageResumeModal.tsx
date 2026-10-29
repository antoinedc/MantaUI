// UsageResumeModal.tsx — the "resume after limit reset" management surface
// (BET-1049, server-first WS09). One list across all providers, grouped by
// workspace, of the conversations a subscription provider limit stopped. The
// BOX builds the whole screen (`usage-stopped:view`: rows, header, chips, the
// warm/cold cost, snippets) and plans the writes (`usage-stopped:apply`, with a
// dry run that decides whether the button is enabled and what it says), so the
// desktop and iOS show the same thing and unchecking the only armed row can be
// applied. This component keeps only view state: the checkbox selection, the
// request sequencing and the footer arithmetic over the box's numbers.
//
// Built only from existing primitives — Modal, Checkbox, Pill, Callout, Button.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Pill } from "./Pill";
import { Callout } from "./Callout";
import { Checkbox } from "./Checkbox";
import { formatResetAt, formatResetDistance, formatTokens } from "./chatUtils";
import { reconcileResumeSelection } from "./usageResume";
import { isUnknownChannel } from "./modelsPicker";
import { UpdateBoxNote } from "./components/UpdateBoxNote";
import type { UsageResumeApplyReply, UsageResumeRowView, UsageResumeView } from "../shared/types";

const PLAN_DEBOUNCE_MS = 150;

type Loaded = { state: "loading" } | { state: "unsupported" } | { state: "error"; message: string } | { state: "ready"; view: UsageResumeView };

export function UsageResumeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pristine, setPristine] = useState(true);
  const [plan, setPlan] = useState<UsageResumeApplyReply | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{ message: string; ok: boolean } | null>(null);
  const viewSeq = useRef(0);
  const planSeq = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const pristineRef = useRef(pristine);
  pristineRef.current = pristine;

  // Load the box's view; only the newest response is applied. Every applied view
  // reconciles the selection (shared rule) and invalidates the dry-run plan.
  const load = useCallback(async () => {
    const seq = ++viewSeq.current;
    try {
      const view = await window.api.usageStoppedView();
      if (seq !== viewSeq.current) return;
      const rows = view.groups.flatMap((g) => g.rows);
      setSelected((prev) =>
        reconcileResumeSelection({
          selected: prev,
          pristine: pristineRef.current,
          viewIds: new Set(rows.map((r) => r.conversation)),
          armedIds: new Set(rows.filter((r) => r.armed).map((r) => r.conversation)),
        }),
      );
      setPlan(null);
      setLoaded({ state: "ready", view });
    } catch (e) {
      if (seq !== viewSeq.current) return;
      setLoaded(isUnknownChannel(e) ? { state: "unsupported" } : { state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  // On open: reset view state and load. While open: reload on the box's change
  // hint and on the client's reconnect signal (`resync`).
  useEffect(() => {
    if (!open) return;
    setPristine(true);
    setResult(null);
    setLoaded({ state: "loading" });
    void load();
    const offUpdated = window.api.onUsageStoppedUpdated?.(() => void load());
    const offStream = window.api.onStreamEvent?.((ev) => {
      if (ev.sub === "resync") void load();
    });
    return () => {
      viewSeq.current += 1;
      offUpdated?.();
      offStream?.();
    };
  }, [open, load]);

  // The dry-run plan: debounced, seq-guarded, recomputed after every selection or view change.
  const view = loaded.state === "ready" ? loaded.view : null;
  useEffect(() => {
    if (!open || !view || view.totalCount === 0) return;
    const seq = ++planSeq.current;
    const timer = setTimeout(() => {
      window.api.usageStoppedApply({ selected: [...selected], dryRun: true }).then(
        (r) => {
          if (seq === planSeq.current) setPlan(r);
        },
        () => {
          if (seq === planSeq.current) setPlan(null);
        },
      );
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, view, selected]);

  const rows: UsageResumeRowView[] = useMemo(() => view?.groups.flatMap((g) => g.rows) ?? [], [view]);
  const selectedRows = rows.filter((r) => selected.has(r.conversation));
  const batchTotal = selectedRows.reduce((n, r) => n + r.cost.reReadTokens, 0);
  const coldSelected = selectedRows.filter((r) => !r.cost.warm).length;
  const allSelected = rows.length > 0 && selectedRows.length === rows.length;

  const close = () => {
    window.api.usageStoppedStampLastLooked().catch((e) => console.warn("[usage-resume] stamp-last-looked failed:", e));
    onClose();
  };

  const apply = async () => {
    setApplying(true);
    setResult(null);
    try {
      const r = await window.api.usageStoppedApply({ selected: [...selected] });
      if (r.ok && !(r.failed && r.failed.length > 0)) {
        close();
        return;
      }
      // Failures keep the modal open with the box's message (it names the row).
      setResult({ ok: false, message: r.message ?? "Couldn't update." });
      void load();
    } catch (e) {
      setResult({ ok: false, message: `Couldn't update — ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setApplying(false);
    }
  };

  const toggleAll = () => {
    setPristine(false);
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.conversation)));
  };

  const toggleOne = (conversation: string, checked: boolean) => {
    setPristine(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(conversation);
      else next.delete(conversation);
      return next;
    });
  };

  const nowMs = Date.now();
  const title = view?.title ?? "Resume after limit reset";
  const hasArmed = view?.hasArmed ?? false;

  return (
    <Modal open={open} size="lg" tall onDismiss={close} label={title}>
      <div className="flex flex-col min-h-0">
        <div className="p-5 pb-3">
          <h2 className="text-title font-semibold">{title}</h2>
          {view && <p className="mt-1 text-meta text-text-faint">{view.header}</p>}
        </div>

        {loaded.state === "unsupported" ? (
          <p className="px-5 py-4"><UpdateBoxNote className="text-body text-text-faint" /></p>
        ) : loaded.state === "error" ? (
          <p role="alert" className="px-5 py-4 text-body text-danger">
            Couldn't load the list — {loaded.message}
          </p>
        ) : !view ? (
          <p className="px-5 py-4 text-body text-text-faint">Loading…</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 border-y border-border-subtle bg-bg-elev px-5 py-2">
              <button type="button" className="text-label font-medium text-accent hover:underline" onClick={toggleAll}>
                {allSelected ? "Uncheck all" : "Check all"}
              </button>
              <span className="text-meta text-text-faint">
                {selectedRows.length} of {rows.length} selected
              </span>
            </div>

            <div className="overflow-auto px-3 pb-4">
              {view.groups.length === 0 ? (
                <p className="px-2 py-4 text-body text-text-faint">{view.emptyText}</p>
              ) : (
                view.groups.map((group) => (
                  <div key={group.workspace}>
                    <div className="flex items-center gap-2 px-2 pb-1 pt-3 text-micro font-semibold uppercase tracking-wider text-text-quiet">
                      <span>{group.workspace}</span>
                      <span className="h-px flex-1 bg-border-subtle" />
                    </div>
                    {group.rows.map((r) => (
                      <div
                        key={r.conversation}
                        className={"flex gap-3 rounded-md p-3 " + (selected.has(r.conversation) ? "bg-fill border border-border-subtle" : "border border-transparent")}
                      >
                        <div className="mt-px">
                          <Checkbox
                            checked={selected.has(r.conversation)}
                            onChange={(c) => toggleOne(r.conversation, c)}
                            ariaLabel={`Resume ${r.name}`}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-label font-medium text-text">{r.name}</span>
                            {r.armed && <Pill tone="accent" size="meta">armed</Pill>}
                            {r.isNew && <Pill tone="warn" size="meta">new</Pill>}
                          </div>
                          {r.snippet && <div className="mt-1 truncate text-meta text-text-faint">{r.snippet}</div>}
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Pill tone="neutral" size="meta" border>
                              <span className="font-mono">{r.provider ?? "—"}</span>
                              <span className="text-text-muted">{r.model ?? "—"}</span>
                            </Pill>
                            <Pill tone="warn" size="meta">
                              {r.window.resetsAt != null
                                ? `${r.window.label} · ${formatResetAt(r.window.resetsAt, nowMs)} · in ${formatResetDistance(r.window.resetsAt - nowMs)}`
                                : r.window.label}
                            </Pill>
                            <Pill tone={r.cost.warm ? "ok" : "neutral"} size="meta">
                              {r.cost.label}
                            </Pill>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}

              {coldSelected > 0 && (
                <Callout tone="warn" size="note">
                  {coldSelected === 1 ? view.coldNote.one : view.coldNote.many.replace("{n}", String(coldSelected))}
                </Callout>
              )}
            </div>
          </>
        )}

        {result && (
          <div role="alert" className="px-5 pb-2 text-meta text-danger">
            {result.message}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle bg-bg-elev px-5 py-3">
          <span className="text-meta text-text-faint">
            <b className="font-semibold text-text">{selectedRows.length} selected</b>
            {batchTotal > 0 ? ` · ≈ ${formatTokens(batchTotal)} re-read` : " · no extra cost"}
          </span>
          <div className="flex gap-2">
            <Button tone="default" onClick={close}>
              {hasArmed ? "Close" : "Cancel"}
            </Button>
            <Button tone="primary" onClick={() => void apply()} disabled={!plan?.canApply || applying}>
              {plan?.title ?? (hasArmed ? "Update" : `Resume ${selectedRows.length} at reset`)}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
