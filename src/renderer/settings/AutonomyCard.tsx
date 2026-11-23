// ===== AutonomyCard (Agents Phase 3, spec 2026-11-23-agents-phase3-autonomy.md §6) =====
//
// Settings → Agents autonomy: one overall mode (Cautious / Balanced / Autonomous) and, per kind of action, what the
// agents do — Auto / Tell me / Ask / Never. Every change saves the FULL block through `agentsAutonomySet` and the card
// then shows what the box returned; a failure says so and puts the last saved state back.
//
// The card exists only when the box has the channels: it renders nothing until `agentsAutonomyGet` succeeds, nothing
// at all for an older box ("unknown rpc channel"), and an inline error with Retry for any other failure.
//
// Native elements throughout (modern-web-guidance `forms`): the mode is a fieldset of real radio buttons, each row's
// answer a native <select>, the table a real <table>, results announced in a status/alert region.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../Button";
import { Card } from "../Card";
import { Tag } from "../Tag";
import {
  ACTION_KINDS,
  BINARY_KINDS,
  KIND_TITLES,
  LEVEL_TITLES,
  LEVELS,
  MODES,
  MODE_NAMES,
  MODE_TITLES,
} from "../../shared/autonomyShared.mjs";
import type { AgentAutonomy, AutonomyKind, AutonomyLevel, AutonomyMode, AutonomySettings } from "../../shared/types";

type Notice = { tone: "ok" | "error"; text: string };
type Load = { kind: "loading" } | { kind: "unsupported" } | { kind: "error"; message: string } | { kind: "ready"; settings: AutonomySettings };

const NOTICE_CLS = { ok: "text-ok", error: "text-danger" } as const;
const SAVED_TEXT = "Saved. Changes apply to new chats.";

const errText = (e: unknown): string => String((e as Error)?.message ?? e ?? "").trim() || "Something went wrong.";
const isUnknownChannel = (e: unknown): boolean => errText(e).includes("unknown rpc channel");

/** The levels a row offers: Code changes only take Auto / Never; every other kind takes all four. */
export function levelsFor(kind: AutonomyKind): readonly AutonomyLevel[] {
  return BINARY_KINDS.includes(kind) ? LEVELS.filter((l) => l === "auto" || l === "never") : LEVELS;
}

/** What a block means for every kind: the mode's row, then each override (the box does the same and sends it back). */
export function effectiveOf(block: AgentAutonomy): Record<AutonomyKind, AutonomyLevel> {
  return { ...MODES[block.mode], ...block.overrides } as Record<AutonomyKind, AutonomyLevel>;
}

/** The block to save when one row changes: choosing the mode's own answer removes the override. */
export function blockForRow(saved: AgentAutonomy, kind: AutonomyKind, level: AutonomyLevel): AgentAutonomy {
  const overrides = { ...saved.overrides };
  if (MODES[saved.mode][kind] === level) delete overrides[kind];
  else overrides[kind] = level;
  return { mode: saved.mode, overrides };
}

/** A box answer the card can show (an older or stubbed transport may answer null or something else). */
export function isAutonomySettings(v: unknown): v is AutonomySettings {
  const s = v as Partial<AutonomySettings> | null;
  return (
    !!s &&
    typeof s === "object" &&
    MODE_NAMES.includes(s.mode as AutonomyMode) &&
    !!s.effective &&
    typeof s.effective === "object" &&
    !!s.overrides &&
    typeof s.overrides === "object"
  );
}

export function AutonomyCard() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  // The block being saved, shown at once; null = show what the box has.
  const [pending, setPending] = useState<AgentAutonomy | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const savingRef = useRef(false);
  const alive = useRef(true);
  const groupId = useId();
  const helpId = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      const get = window.api?.agentsAutonomyGet;
      if (typeof get !== "function") {
        if (alive.current) setLoad({ kind: "unsupported" });
        return;
      }
      const settings = await get.call(window.api);
      if (!alive.current) return;
      setLoad(isAutonomySettings(settings) ? { kind: "ready", settings } : { kind: "unsupported" });
    } catch (e) {
      if (!alive.current) return;
      setLoad(isUnknownChannel(e) ? { kind: "unsupported" } : { kind: "error", message: errText(e) });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (load.kind === "loading" || load.kind === "unsupported") return null;

  const heading = <span className="text-micro uppercase text-text-faint">Agents autonomy</span>;
  if (load.kind === "error") {
    return (
      <div data-testid="autonomy-card">
        <Card header={heading}>
          <div className="space-y-3">
            <div role="alert" className="text-meta text-danger break-words">
              Couldn't read the autonomy settings: {load.message}
            </div>
            <Button tone="default" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const saved = load.settings;
  const view: AgentAutonomy & { effective: Record<AutonomyKind, AutonomyLevel> } = pending
    ? { ...pending, effective: effectiveOf(pending) }
    : saved;
  const isCustom = (kind: AutonomyKind): boolean => view.effective[kind] !== MODES[view.mode][kind];
  const anyCustom = ACTION_KINDS.some(isCustom);

  const save = async (block: AgentAutonomy) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setPending(block);
    setNotice(null);
    try {
      const next = await window.api.agentsAutonomySet(block);
      if (!alive.current) return;
      if (!isAutonomySettings(next)) throw new Error("The box sent back something unexpected.");
      setLoad({ kind: "ready", settings: next });
      setNotice({ tone: "ok", text: SAVED_TEXT });
    } catch (e) {
      if (alive.current) setNotice({ tone: "error", text: `Couldn't save: ${errText(e)} Your previous settings are unchanged.` });
    } finally {
      savingRef.current = false;
      if (alive.current) {
        setSaving(false);
        setPending(null);
      }
    }
  };

  const pickMode = (mode: AutonomyMode) => {
    if (savingRef.current || mode === saved.mode) return;
    void save({ mode, overrides: {} });
  };
  const pickRow = (kind: AutonomyKind, level: AutonomyLevel) => {
    if (savingRef.current || level === saved.effective[kind]) return;
    void save(blockForRow(saved, kind, level));
  };
  const resetRows = () => {
    if (savingRef.current) return;
    void save({ mode: saved.mode, overrides: {} });
  };

  return (
    <div data-testid="autonomy-card">
      <Card header={heading}>
        <div className="space-y-5" aria-busy={saving || undefined}>
          <p id={helpId} className="m-0 text-meta text-text-faint max-w-[62ch]">
            What your agents may do on their own. Manta follows this in every chat, and the background tasks it hands to your agents
            are blocked from "Ask" and "Never" actions. The blocking matches known commands (for example <code>gh pr merge</code> or{" "}
            <code>fly deploy</code>); an agent that goes out of its way, such as through a script, can get around it. It stops honest
            mistakes, not a determined agent. Changes apply to new chats.
          </p>

          <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={helpId}>
            <legend className="mb-1 block p-0 text-micro font-semibold uppercase text-text-muted">Mode</legend>
            <div className="inline-flex shrink-0 rounded-md border border-border-subtle bg-inset p-1" data-testid="autonomy-mode">
              {MODE_NAMES.map((m) => (
                <label key={m} className="relative cursor-pointer">
                  <input
                    type="radio"
                    name={`${groupId}-mode`}
                    value={m}
                    checked={view.mode === m}
                    onChange={() => pickMode(m)}
                    className="peer absolute opacity-0 [clip-path:inset(50%)] w-px h-px m-0"
                  />
                  <span className="inline-flex items-center rounded-sm px-3 py-1 text-meta font-medium text-text-faint hover:text-text peer-checked:bg-raised peer-checked:text-text peer-checked:shadow-sm peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-accent">
                    {MODE_TITLES[m]}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <table className="w-full border-collapse text-left" data-testid="autonomy-table">
            <caption className="sr-only">What your agents do for each kind of action</caption>
            <thead>
              <tr className="text-micro font-semibold uppercase text-text-muted">
                <th scope="col" className="py-1 pr-3 text-left font-semibold">
                  Action
                </th>
                <th scope="col" className="py-1 text-left font-semibold">
                  Answer
                </th>
              </tr>
            </thead>
            <tbody>
              {ACTION_KINDS.map((kind) => {
                const selectId = `${groupId}-${kind}`;
                const tagId = `${groupId}-${kind}-custom`;
                const custom = isCustom(kind);
                return (
                  <tr key={kind} className="border-t border-border-subtle" data-kind={kind} data-custom={custom || undefined}>
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      <label htmlFor={selectId} className="text-body text-text">
                        {KIND_TITLES[kind]}
                      </label>
                      {custom && (
                        <span id={tagId} className="ml-2 align-middle" data-testid="autonomy-custom">
                          <Tag size="sm">custom</Tag>
                        </span>
                      )}
                    </th>
                    <td className="py-2">
                      <select
                        id={selectId}
                        name={kind}
                        value={view.effective[kind]}
                        onChange={(e) => pickRow(kind, e.target.value as AutonomyLevel)}
                        aria-describedby={custom ? tagId : undefined}
                        className="rounded-md border border-border-strong bg-bg-soft px-2 py-1 text-body text-text focus:outline-none focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        {levelsFor(kind).map((l) => (
                          <option key={l} value={l}>
                            {LEVEL_TITLES[l]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="flex flex-wrap items-center gap-3">
            {anyCustom && (
              <Button tone="default" onClick={resetRows} disabled={saving}>
                Reset rows to mode
              </Button>
            )}
            <div role="status" className={`text-meta break-words ${notice?.tone === "ok" ? NOTICE_CLS.ok : "text-text-faint"}`} data-testid="autonomy-notice">
              {saving ? "Saving…" : notice?.tone === "ok" ? notice.text : ""}
            </div>
          </div>
          {notice?.tone === "error" && (
            <div role="alert" className={`text-meta break-words ${NOTICE_CLS.error}`} data-testid="autonomy-error">
              {notice.text}
            </div>
          )}
          <div className="text-meta text-text-faint max-w-[62ch]">
            Auto: does it. Tell me: does it, then mentions it. Ask: asks you first. Never: doesn't do it, even when asked.
          </div>
        </div>
      </Card>
    </div>
  );
}
