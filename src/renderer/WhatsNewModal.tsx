// WhatsNewModal.tsx — the "What's new" window (spec 2026-11-03-whats-new-modal).
//
// Two looks, chosen by the NEWEST entry shown:
//   B  highlight cards — the entry carries a highlights block: a hero, up to
//      three cards (each optionally a link into the app) and one quiet row that
//      expands the entry's full notes in place;
//   A  release notes — no highlights: eyebrow, title, chips and the rendered
//      notes of every entry shown.
//
// This component is presentational: the hook (useWhatsNew) decides WHEN it opens
// and what closing it records. Every way out (Got it, ×/Escape/overlay via the
// Modal, a card link) ends in `onClose`.
//
// A card's link is rendered only when its action is in the shared allowlist AND
// this build can perform it (a handler was passed, and the section exists here):
// never a dead link.

import { useState, type ReactNode } from "react";
import {
  ArrowLeftRight,
  Bell,
  CalendarClock,
  Folder,
  Gauge,
  GitBranch,
  MessageSquare,
  Mic,
  RefreshCw,
  Repeat,
  Settings as SettingsIcon,
  Shield,
  Sparkles,
  Terminal,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Pill } from "./Pill";
import { MarkdownBody } from "./MarkdownBody";
import { useStore } from "./store";
import { SETTING_SECTIONS, type SettingSectionId } from "../shared/settingsSchema";
import { isWhatsNewAction, normalizeWhatsNewIcon } from "../shared/whatsNewAllowlist.mjs";
import { componentChips } from "../shared/whatsNew.mjs";
import type { ChangelogEntry, ChangelogHighlight } from "../shared/api";

export const CHANGELOG_URL = "https://github.com/antoinedc/MantaUI/blob/main/CHANGELOG.md";

// A static map of the allowed names: importing every lucide icon to look one up
// by name would bundle them all.
const ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  repeat: Repeat,
  "arrow-left-right": ArrowLeftRight,
  "refresh-cw": RefreshCw,
  zap: Zap,
  "message-square": MessageSquare,
  terminal: Terminal,
  folder: Folder,
  settings: SettingsIcon,
  shield: Shield,
  bell: Bell,
  mic: Mic,
  gauge: Gauge,
  "git-branch": GitBranch,
  "calendar-clock": CalendarClock,
};

// User-facing wording is "server", never "box": the Settings nav still calls this
// section "Box", but this window must not.
const LINK_LABELS: Partial<Record<SettingSectionId, string>> = { box: "Server" };

export type WhatsNewActions = {
  /** Open the Routines list. Absent → a `routines` card shows no link. */
  onOpenRoutines?: () => void;
  /** Open Settings at a section. Absent → a `settings:<id>` card shows no link. */
  onOpenSettings?: (section: SettingSectionId) => void;
};

type ResolvedAction = { label: string; run: () => void };

/** What a card's action does in THIS build, or null (then the card has no link). */
export function resolveWhatsNewAction(action: string | null, handlers: WhatsNewActions): ResolvedAction | null {
  if (action == null || !isWhatsNewAction(action)) return null;
  if (action === "routines") {
    const open = handlers.onOpenRoutines;
    return open ? { label: "Open Routines", run: open } : null;
  }
  const id = action.slice("settings:".length);
  const section = SETTING_SECTIONS.find((s) => s.id === id);
  const open = handlers.onOpenSettings;
  if (!section || !open) return null;
  return { label: `Open ${LINK_LABELS[section.id] ?? section.label} settings`, run: () => open(section.id) };
}

/** Rendered notes drop the `Ships: …` paragraph — tag names are noise. */
export function stripShips(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .filter((para) => !/^\s*Ships:/i.test(para))
    .join("\n\n")
    .trim();
}

/** Top-level bullets in the notes, less the cards already shown. */
export function countSmallerChanges(markdown: string, shownCards: number): number {
  const bullets = markdown.split("\n").filter((l) => /^[-*+]\s+\S/.test(l)).length;
  return Math.max(0, bullets - shownCards);
}

function formatDate(date: string | null): string | null {
  const m = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const EYEBROW = "font-mono text-micro font-semibold tracking-wider text-accent-tx";

function Notes({ markdown }: { markdown: string }) {
  const text = stripShips(markdown);
  if (!text) return null;
  return (
    <div className="flex flex-col gap-2 text-body text-text">
      <MarkdownBody text={text} />
    </div>
  );
}

function HighlightCard({ item, handlers, onPerform }: { item: ChangelogHighlight; handlers: WhatsNewActions; onPerform: (run: () => void) => void }) {
  const Icon = ICONS[normalizeWhatsNewIcon(item.icon)] ?? Sparkles;
  const action = resolveWhatsNewAction(item.action, handlers);
  return (
    <div className="flex flex-col rounded-lg border border-border-subtle bg-bg p-3">
      <div className="mb-3 grid h-[30px] w-[30px] place-items-center rounded-md bg-accent-bg text-accent-tx">
        <Icon size={15} aria-hidden />
      </div>
      <h3 className="text-label font-semibold text-text">{item.title}</h3>
      <p className="mt-1 text-meta text-text-faint">{item.text}</p>
      {action && (
        <button
          type="button"
          className="mt-2 self-start text-meta text-accent-tx hover:underline"
          onClick={() => onPerform(action.run)}
        >
          {action.label} →
        </button>
      )}
    </div>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="shrink-0 text-meta text-accent-tx hover:underline" onClick={onClick}>
      {children}
    </button>
  );
}

export function WhatsNewModal({
  entries,
  previous,
  onClose,
  onOpenRoutines,
  onOpenSettings,
}: {
  /** The entries to show, newest first (at least one). */
  entries: ChangelogEntry[];
  /** The version the user last had, for A's eyebrow; null when unknown. */
  previous: string | null;
  onClose: () => void;
} & WhatsNewActions) {
  const push = useStore((s) => s.pushAppToast);
  const [notesOpen, setNotesOpen] = useState(false);
  const [olderOpen, setOlderOpen] = useState(false);

  const newest = entries[0];
  const older = entries.slice(1);
  const handlers: WhatsNewActions = { onOpenRoutines, onOpenSettings };
  const highlights = newest.highlights;
  const cards = highlights.length > 0;
  const chips = componentChips(newest.components);
  const date = formatDate(newest.date);
  const title = newest.headline ?? `What's new in Manta ${newest.version}`;

  // A card's link performs its action, then closes (acknowledging).
  const perform = (run: () => void) => {
    run();
    onClose();
  };

  const openChangelog = async () => {
    try {
      await window.api.openExternal(CHANGELOG_URL);
    } catch (e) {
      console.warn("[whats-new] couldn't open the changelog:", e);
      push({ tone: "error", message: "Couldn't open the changelog in your browser." });
    }
  };

  const smaller = countSmallerChanges(newest.markdown, highlights.length);
  const hasNotes = stripShips(newest.markdown) !== "";

  return (
    <Modal size="lg" tall padded={false} onDismiss={onClose} label={title}>
      <div className="flex min-h-0 flex-col">
        {cards ? (
          <div
            className="px-6 pb-2 pt-6"
            style={{ background: "radial-gradient(120% 140% at 0% 0%, rgb(var(--accent-rgb) / 0.2), transparent 60%)" }}
          >
            <div className={EYEBROW}>MANTA {newest.version}</div>
            <h2 tabIndex={-1} className="mt-2 text-title font-semibold text-text outline-none">{title}</h2>
            <p className="mt-1 text-meta text-text-faint">New on your server.</p>
          </div>
        ) : (
          <div className="border-b border-border-subtle px-6 pb-3 pt-5">
            <div className={EYEBROW}>{previous ? `UPDATED · ${previous} → ${newest.version}` : `UPDATED · ${newest.version}`}</div>
            <h2 tabIndex={-1} className="mt-2 text-title font-semibold text-text outline-none">{title}</h2>
            {(chips.length > 0 || date) && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-meta text-text-quiet">
                {chips.map((c) => (
                  <Pill key={c} tone="neutral" size="meta" border>
                    {c}
                  </Pill>
                ))}
                {date && <span>{chips.length > 0 ? `· ${date}` : date}</span>}
              </div>
            )}
          </div>
        )}

        <div className="min-h-0 overflow-auto px-6 py-4">
          {cards ? (
            <>
              <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(highlights.length, 3)}, minmax(0, 1fr))` }}>
                {highlights.slice(0, 3).map((item, i) => (
                  <HighlightCard key={`${item.title}-${i}`} item={item} handlers={handlers} onPerform={perform} />
                ))}
              </div>

              {hasNotes && (
                <div className="mt-3 rounded-md border border-dashed border-border-subtle px-3 py-2">
                  <div className="flex items-center justify-between gap-3 text-meta text-text-faint">
                    <span>{smaller > 0 ? `+ ${smaller} smaller ${smaller === 1 ? "change" : "changes"}` : "Full release notes"}</span>
                    <LinkButton onClick={() => setNotesOpen((o) => !o)}>{notesOpen ? "Hide" : "See all"}</LinkButton>
                  </div>
                  {notesOpen && (
                    <div className="mt-2 border-t border-border-subtle pt-2">
                      <Notes markdown={newest.markdown} />
                    </div>
                  )}
                </div>
              )}

              {older.length > 0 && (
                <div className="mt-3">
                  <div className="flex items-center justify-between gap-3 text-meta text-text-quiet">
                    <span>Also new since you last looked: {older.map((e) => e.version).join(", ")}</span>
                    <LinkButton onClick={() => setOlderOpen((o) => !o)}>{olderOpen ? "Hide" : "See notes"}</LinkButton>
                  </div>
                  {olderOpen && (
                    <div className="mt-2 flex flex-col gap-4">
                      {older.map((e) => (
                        <EntryNotes key={e.version} entry={e} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-5">
              {entries.length > 1 ? (
                entries.map((e) => <EntryNotes key={e.version} entry={e} />)
              ) : (
                <Notes markdown={newest.markdown} />
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle bg-bg-elev px-6 py-3">
          <button type="button" className="text-meta text-accent-tx hover:underline" onClick={() => void openChangelog()}>
            Full changelog ↗
          </button>
          <Button tone="primary" onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EntryNotes({ entry }: { entry: ChangelogEntry }) {
  const date = formatDate(entry.date);
  return (
    <section>
      <div className="mb-1 flex items-baseline gap-2 border-b border-border-subtle pb-1">
        <span className="text-label font-semibold text-text">{entry.version}</span>
        {date && <span className="text-meta text-text-quiet">{date}</span>}
      </div>
      <Notes markdown={entry.markdown} />
    </section>
  );
}
