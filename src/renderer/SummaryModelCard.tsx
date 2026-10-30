// ===== SummaryModelCard (cold-cache handoff spec A7) =====
//
// Settings → Models "Summary model": the one model that reads conversation text
// for handoffs after a long break, session titles and remembered instructions.
// The box owns the choice (an auto-picker runs on its side); this card shows what
// it picked and why, lets the user pick any eligible model (the shortlist, or
// anything the search finds) or opt out, and says so on every outcome.
//
// States, each honest (AGENTS.md "never stub a control"):
//   - loading                → "Reading the model list…"
//   - older box (no channel) → "Update your box to use this" — no controls
//   - load failed            → the error + Try again
//   - loaded                 → the picker; a failed `set` shows the box's message.

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { SummaryModelCandidate, SummaryModelStatus } from "../shared/api";
import { Button } from "./Button";
import { Card } from "./Card";
import { Dropdown } from "./MenuItem";
import { MenuOption } from "./MenuOption";
import { Tag } from "./Tag";
import { moveMenuHighlight } from "./chatUtils";
import { UpdateBoxNote } from "./components/UpdateBoxNote";

const SEARCH_DEBOUNCE_MS = 150;
const NONE_LABEL = "None — use each conversation's own model";

type Notice = { tone: "ok" | "error"; text: string };
const NOTICE_CLS = { ok: "text-ok", error: "text-danger" } as const;

const errText = (e: unknown): string => String((e as Error)?.message ?? e ?? "") || "Something went wrong.";
const isUnsupported = (e: unknown): boolean => /unknown rpc channel/i.test(errText(e));

const sameModel = (
  a: { providerID: string; modelID: string } | null | undefined,
  b: { providerID: string; modelID: string },
): boolean => !!a && a.providerID === b.providerID && a.modelID === b.modelID;

type Load =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }
  | { kind: "ok"; status: SummaryModelStatus };

export function SummaryModelCard() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const [found, setFound] = useState<{ query: string; models: SummaryModelCandidate[] } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const searchSeq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fetchStatus = () => {
    setLoad({ kind: "loading" });
    window.api
      .summaryModelStatus()
      .then((status) => {
        if (!alive.current) return;
        // A transport that answers nothing (the demo, a pre-feature box) has no Summary model to show.
        setLoad(status && Array.isArray(status.candidates) ? { kind: "ok", status } : { kind: "unsupported" });
      })
      .catch((e) => {
        if (!alive.current) return;
        setLoad(isUnsupported(e) ? { kind: "unsupported" } : { kind: "error", message: errText(e) });
      });
  };
  useEffect(fetchStatus, []);

  // Search: every eligible model, not just the shortlist. Debounced; a stale
  // answer (an older query finishing late) is dropped by the sequence guard.
  const trimmed = query.trim();
  useEffect(() => {
    if (!open || !trimmed) {
      setFound(null);
      setSearchError(null);
      return;
    }
    const seq = ++searchSeq.current;
    const t = setTimeout(() => {
      window.api
        .summaryModelSearch({ query: trimmed })
        .then((r) => {
          if (seq !== searchSeq.current || !alive.current) return;
          setFound({ query: trimmed, models: Array.isArray(r?.models) ? r.models : [] });
          setSearchError(null);
        })
        .catch((e) => {
          if (seq !== searchSeq.current || !alive.current) return;
          setFound(null);
          setSearchError(errText(e));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [open, trimmed]);

  const status = load.kind === "ok" ? load.status : null;
  const rows: SummaryModelCandidate[] = useMemo(() => {
    if (!status) return [];
    if (!trimmed) return status.candidates;
    return found && found.query === trimmed ? found.models : [];
  }, [status, trimmed, found]);
  const searching = !!trimmed && !(found && found.query === trimmed) && !searchError;

  const closeMenu = () => {
    setOpen(false);
    setQuery("");
    setHighlight(-1);
  };

  const choose = async (input: { providerID: string; modelID: string } | { none: true }, label: string) => {
    closeMenu();
    setSaving(true);
    setNotice(null);
    try {
      const next = await window.api.summaryModelSet(input);
      if (!next) throw new Error("The box didn't return the Summary model.");
      if (!alive.current) return;
      setLoad({ kind: "ok", status: next });
      setNotice({ tone: "ok", text: "none" in input ? "Summary model turned off." : `Summary model set to ${label}.` });
    } catch (e) {
      if (alive.current) setNotice({ tone: "error", text: `Couldn't change the Summary model: ${errText(e)}` });
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const header = <span className="text-micro uppercase text-text-faint">Summary model</span>;

  if (load.kind === "loading") {
    return (
      <Card header={header}>
        <div className="text-meta text-text-faint">Reading the model list…</div>
      </Card>
    );
  }
  if (load.kind === "unsupported") {
    return (
      <Card header={header}>
        <UpdateBoxNote />
      </Card>
    );
  }
  if (load.kind === "error") {
    return (
      <Card header={header}>
        <div role="alert" className="text-meta text-danger break-words">
          Couldn't read the Summary model: {load.message}
        </div>
        <div className="mt-3">
          <Button tone="default" onClick={fetchStatus}>
            Try again
          </Button>
        </div>
      </Card>
    );
  }

  const st = load.status;
  const noneSelected = st.state === "opted-out";
  const triggerLabel = noneSelected ? NONE_LABEL : st.current?.name || "Choose a model";
  const recommended = st.candidates.find((c) => c.recommended);
  // The auto pick can be better than the current one only while the current one is auto-picked.
  const showBetter = st.betterAvailable && st.current?.source === "auto" && !!recommended && !sameModel(st.current, recommended);

  // Roving highlight: row 0 is "None", then the visible models.
  const options: Array<{ id: string; select: () => void }> = [
    { id: "none", select: () => void choose({ none: true }, NONE_LABEL) },
    ...rows.map((c) => ({
      id: `${c.providerID}/${c.modelID}`,
      select: () => void choose({ providerID: c.providerID, modelID: c.modelID }, c.name),
    })),
  ];
  const highlightedId = highlight >= 0 && highlight < options.length ? options[highlight].id : undefined;
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => moveMenuHighlight(h, 1, options.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => moveMenuHighlight(h, -1, options.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlight >= 0 && highlight < options.length) options[highlight].select();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
    }
  };

  const reasonTone = st.state === "opted-out" ? "text-text-faint" : "text-warn";

  return (
    <Card header={header}>
      <div className="space-y-3" data-testid="summary-model-card">
        <div className="text-meta text-text-faint max-w-[62ch]">
          Writes handoffs after a long break, session titles and remembered instructions. Conversation text is sent to this model.
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span ref={triggerRef} className="inline-flex max-w-full">
            <Button
              tone="default"
              hook="manta-summary-model-trigger"
              disabled={saving}
              onClick={() => (open ? closeMenu() : setOpen(true))}
            >
              <span className="truncate">{triggerLabel}</span>
              {st.current?.source === "auto" && !noneSelected && <Tag numeric>auto</Tag>}
              <ChevronDown size={14} aria-hidden="true" className="flex-none text-text-faint" />
            </Button>
          </span>
          {saving && <span className="text-meta text-text-faint">Saving…</span>}
        </div>

        <Dropdown
          open={open}
          onClose={closeMenu}
          anchorRef={triggerRef}
          hook="manta-summary-model-dropdown"
          role="listbox"
          placement="below"
          align="start"
          width="wide"
          search={
            <>
              <Search size={14} aria-hidden="true" className="flex-none text-text-faint" />
              <input
                autoFocus
                value={query}
                placeholder="Search models"
                aria-label="Search summary models"
                aria-activedescendant={highlightedId}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlight(-1);
                }}
                onKeyDown={onSearchKeyDown}
                className="flex-1 min-w-0 bg-transparent border-none outline-none text-label text-text placeholder:text-text-faint"
              />
            </>
          }
          header={
            <MenuOption
              id="none"
              selected={noneSelected}
              active={highlight === 0}
              label={NONE_LABEL}
              onSelect={() => void choose({ none: true }, NONE_LABEL)}
            />
          }
        >
          {searchError ? (
            <div role="alert" className="px-2 py-2 text-meta text-danger break-words">
              Couldn't search: {searchError}
            </div>
          ) : searching ? (
            <div className="px-2 py-2 text-text-faint">Searching…</div>
          ) : rows.length === 0 ? (
            <div className="px-2 py-2 text-text-faint">{trimmed ? "No models match" : "No models available"}</div>
          ) : (
            rows.map((c, i) => {
              const selected = st.state === "ok" && sameModel(st.current, c);
              return (
                <MenuOption
                  key={`${c.providerID}/${c.modelID}`}
                  id={`${c.providerID}/${c.modelID}`}
                  selected={selected}
                  active={highlight === i + 1}
                  label={c.name}
                  sub={c.priceLabel ?? undefined}
                  trailing={
                    <span className="flex items-center gap-1 flex-none">
                      {c.recommended && <Tag numeric tone="accent">recommended</Tag>}
                      {!c.qualityKnown && <Tag numeric>not rated</Tag>}
                    </span>
                  }
                  onSelect={() => void choose({ providerID: c.providerID, modelID: c.modelID }, c.name)}
                />
              );
            })
          )}
        </Dropdown>

        {st.state !== "ok" && st.reason && (
          <div className={`text-meta break-words ${reasonTone}`} data-testid="summary-model-reason">
            {st.reason}
          </div>
        )}

        {showBetter && recommended && (
          <div className="flex items-center gap-3 flex-wrap" data-testid="summary-model-better">
            <span className="text-meta text-text-muted">A cheaper capable model is available.</span>
            <Button
              tone="default"
              disabled={saving}
              onClick={() => void choose({ providerID: recommended.providerID, modelID: recommended.modelID }, recommended.name)}
            >
              Switch to {recommended.name}
            </Button>
          </div>
        )}

        {notice && (
          <div
            className={`text-meta break-words ${NOTICE_CLS[notice.tone]}`}
            role={notice.tone === "error" ? "alert" : "status"}
            data-testid="summary-model-notice"
          >
            {notice.text}
          </div>
        )}
      </div>
    </Card>
  );
}
