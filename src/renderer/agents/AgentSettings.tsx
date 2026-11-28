// ===== The profile's Settings tab (profile v5; docs/superpowers/specs/2026-11-28-agent-profile-redesign.md §5) =====
//
// Each editable field saves when the user leaves it (a select or the Works choice: when it changes) through `agents:settings-set`,
// which goes through the existing change flow — so it appears in History with Undo — and says what happened under the field:
// "Saving…", "Saved · added to History · Undo", "Waiting for your OK in Needs you" (an isolation raise waits like any raise), an error
// with Try again (the user's text is kept), or nothing when the value didn't change. Validation is the box's: no keystroke validation
// (the `forms` guide: validate on blur, never while typing); the live region is always in the page so what it says is announced.
//
// Read-only here, with the reason: the @handle, the refresh day and the team-wide learning setting. Manta and the Architect keep
// their wording "via Manta": every field but the Architect's model is plain text with one note.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, CircleAlert, Lock } from "lucide-react";
import type { AgentChange, AgentInfo, AgentProfile, AutonomyLevel } from "../../shared/types";
import { RefreshControl } from "./AgentRefresh";
import { LinkButton, QuietLink } from "./AgentsParts";
import { errText } from "./agentsView";
import { SETTINGS_MAX, editableFields, fieldValue, isUnchanged, learningLine, lockedNote, modelOptions, refreshDayLine, toWire, type EditableField } from "./settingsView";
import { useAgentsRead } from "./useAgentsRead";

type Status =
  | { k: "idle" }
  | { k: "saving" }
  | { k: "saved"; id: string }
  | { k: "waiting" }
  | { k: "error"; message: string }
  | { k: "undoing" }
  | { k: "undone" }
  | { k: "undoError"; message: string; id: string };

const INPUT =
  "w-full rounded-md border border-border bg-bg px-2 py-1.5 text-label text-text placeholder:text-text-quiet outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** The state of one field: its draft, what the last save said, and the two ways out of a problem (commit again, undo again). */
function useSettingsField(info: AgentInfo, field: EditableField, onChanged: () => void) {
  const saved = fieldValue(info, field);
  const [draft, setDraft] = useState(saved);
  const [status, setStatus] = useState<Status>({ k: "idle" });
  const dirty = useRef(false);
  const busy = useRef(false);
  // the box's word beats the field while the user isn't in the middle of typing
  useEffect(() => {
    if (!dirty.current) setDraft(saved);
  }, [saved]);

  const commit = async (value: string) => {
    if (busy.current) return;
    if (isUnchanged(info, field, value)) {
      dirty.current = false;
      setDraft(saved);
      setStatus({ k: "idle" });
      return;
    }
    busy.current = true;
    setStatus({ k: "saving" });
    try {
      const out = await window.api.agentsSettingsSet({ slug: info.slug, field, value: toWire(field, value) });
      if (out.outcome === "unchanged") {
        setStatus({ k: "idle" });
      } else if (out.outcome === "waiting") {
        setStatus({ k: "waiting" });
      } else {
        dirty.current = false;
        setDraft(value.trim());
        setStatus({ k: "saved", id: (out.change as AgentChange).id });
      }
      onChanged();
    } catch (e) {
      dirty.current = true; // the user's text stays
      setStatus({ k: "error", message: errText(e, "Couldn't save.") });
    } finally {
      busy.current = false;
    }
  };

  const undo = async (id: string) => {
    if (busy.current) return;
    busy.current = true;
    setStatus({ k: "undoing" });
    try {
      await window.api.agentsChangeUndo(id);
      dirty.current = false;
      setStatus({ k: "undone" });
      onChanged();
    } catch (e) {
      setStatus({ k: "undoError", message: errText(e, "Couldn't undo."), id });
    } finally {
      busy.current = false;
    }
  };

  return {
    draft,
    status,
    type: (v: string) => {
      dirty.current = true;
      setDraft(v);
    },
    commit,
    undo,
    retry: () => void commit(draft),
  };
}

type FieldApi = ReturnType<typeof useSettingsField>;

/** The line under a field. Always in the page (a live region must exist before it speaks); empty when there is nothing to say. */
function StatusLine({ api, testId }: { api: FieldApi; testId?: string }) {
  const s = api.status;
  let body: ReactNode = null;
  let tone = "text-text-faint";
  if (s.k === "saving" || s.k === "undoing") body = s.k === "saving" ? "Saving…" : "Undoing…";
  else if (s.k === "saved")
    body = (
      <>
        <Check size={12} aria-hidden="true" />
        <span>Saved · added to History</span>
        <QuietLink onClick={() => void api.undo(s.id)}>Undo</QuietLink>
      </>
    );
  else if (s.k === "waiting") body = "Waiting for your OK in Needs you";
  else if (s.k === "undone") body = "Undone · back to the previous value";
  else if (s.k === "error" || s.k === "undoError") {
    tone = "text-danger";
    body = (
      <>
        <CircleAlert size={12} aria-hidden="true" />
        <span className="break-words">{s.message}</span>
        <LinkButton spaced={false} onClick={s.k === "error" ? api.retry : () => void api.undo(s.id)}>
          Try again
        </LinkButton>
      </>
    );
  }
  return (
    <div role="status" aria-live="polite" data-testid={testId} className={`mt-1 flex min-h-[1.125rem] flex-wrap items-center gap-x-2 gap-y-0 text-meta ${s.k === "saved" ? "text-ok" : tone}`}>
      {body}
    </div>
  );
}

function Row({ id, label, help, children, locked = false }: { id: EditableField | "handle" | "refresh" | "learning"; label: string; help?: string; children: ReactNode; locked?: boolean }) {
  const labelId = useId();
  return (
    <div data-testid={`settings-field-${id}`} className="grid grid-cols-1 gap-x-6 gap-y-2 py-3 [@container(min-width:640px)]:grid-cols-[13.75rem_minmax(0,1fr)]">
      <div>
        <div id={labelId} className="text-label font-semibold text-text">
          {label}
          {locked && <span className="font-normal text-text-faint"> · via Manta</span>}
        </div>
        {help && !locked && <p className="m-0 mt-0.5 text-meta leading-snug text-text-faint">{help}</p>}
      </div>
      <div className="min-w-0 max-w-[32.5rem]">{children}</div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 border-t border-border-subtle pt-4 first:mt-2">
      <h3 className="m-0 mb-1 text-meta font-semibold text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

const ReadOnly = ({ children }: { children: ReactNode }) => <div className="break-words py-1 text-body text-text-muted">{children || "—"}</div>;

function TextRow({ info, field, label, help, max, multiline, onChanged }: { info: AgentInfo; field: "name" | "description" | "useWhen" | "notFor"; label: string; help?: string; max: number; multiline: boolean; onChanged: () => void }) {
  const api = useSettingsField(info, field, onChanged);
  const id = useId();
  const common = {
    id,
    value: api.draft,
    maxLength: max,
    autoComplete: "off",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => api.type(e.target.value),
    onBlur: () => void api.commit(api.draft),
    className: INPUT,
    placeholder: field === "useWhen" ? "e.g. Code changes in this project" : field === "notFor" ? "e.g. Reviews that change nothing" : undefined,
  };
  return (
    <Row id={field} label={label} help={help}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      {multiline ? <textarea {...common} rows={2} className={`${INPUT} min-h-[3.25rem] resize-y`} /> : <input type="text" {...common} />}
      {multiline && (
        <div className="mt-0.5 text-right text-meta tabular-nums text-text-faint" aria-hidden="true">
          {api.draft.length} / {max}
        </div>
      )}
      <StatusLine api={api} testId={`settings-status-${field}`} />
    </Row>
  );
}

function ModelRow({ info, approved, locked, onChanged }: { info: AgentInfo; approved: ReadonlyArray<string>; locked: boolean; onChanged: () => void }) {
  const api = useSettingsField(info, "model", onChanged);
  const id = useId();
  if (locked) {
    return (
      <Row id="model" label="Model">
        <ReadOnly>{info.model || "Auto"}</ReadOnly>
      </Row>
    );
  }
  return (
    <Row id="model" label="Model" help="Auto lets Manta pick per task.">
      <label htmlFor={id} className="sr-only">
        Model
      </label>
      <select
        id={id}
        value={api.draft}
        onChange={(e) => {
          api.type(e.target.value);
          void api.commit(e.target.value);
        }}
        className={`${INPUT} min-w-[12.5rem] max-w-full`}
      >
        {modelOptions(approved, info.model ?? "").map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <StatusLine api={api} testId="settings-status-model" />
    </Row>
  );
}

function WorksRow({ info, onChanged }: { info: AgentInfo; onChanged: () => void }) {
  const api = useSettingsField(info, "isolation", onChanged);
  const name = useId();
  const options = [
    { value: "worktree", label: "On its own branch" },
    { value: "none", label: "Read-only" },
  ];
  return (
    <Row id="isolation" label="Works" help="On its own branch it can edit files and deliver code, mockups and docs. Read-only can only read and answer.">
      <fieldset className="m-0 flex flex-wrap gap-x-4 gap-y-1 border-0 p-0">
        <legend className="sr-only">Works</legend>
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-label text-text">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={api.draft === o.value}
              onChange={() => {
                api.type(o.value);
                void api.commit(o.value);
              }}
            />
            {o.label}
          </label>
        ))}
      </fieldset>
      <StatusLine api={api} testId="settings-status-isolation" />
    </Row>
  );
}

export function AgentSettings({ profile, onChanged }: { profile: AgentProfile; onChanged: () => void }) {
  const { info } = profile;
  const editable = new Set<EditableField>(editableFields(info));
  const locked = info.role !== "specialist";
  const models = useAgentsRead<string[]>(editable.has("model") ? () => window.api.agentsApprovedModels() : null, info.slug);
  const autonomy = useAgentsRead(() => window.api.agentsAutonomyGet(), 0);
  const level = (autonomy.data?.effective?.learn_preference ?? null) as AutonomyLevel | null;
  const approved = models.data ?? [];
  const refreshable = info.role === "specialist";

  const text = (field: "name" | "description" | "useWhen" | "notFor", label: string, max: number, multiline: boolean, help?: string) =>
    editable.has(field) ? (
      <TextRow info={info} field={field} label={label} help={help} max={max} multiline={multiline} onChanged={onChanged} />
    ) : (
      <Row id={field} label={label} locked>
        <ReadOnly>{fieldValue(info, field)}</ReadOnly>
      </Row>
    );

  return (
    <div className="[container-type:inline-size]" data-testid="profile-settings">
      {locked ? (
        <p className="m-0 flex items-start gap-2 rounded-md bg-bg-elev p-3 text-label leading-snug text-text-muted">
          <Lock size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-text-faint" />
          <span>{lockedNote(info.name)}</span>
        </p>
      ) : (
        <p className="m-0 max-w-[72ch] text-label text-text-faint">Each change saves when you leave the field, shows up in History, and can be undone.</p>
      )}
      <Group title="Identity">
        {text("name", "Name", SETTINGS_MAX.name, false)}
        <Row id="handle" label="Handle">
          <ReadOnly>@{info.slug}</ReadOnly>
          <p className="m-0 text-meta text-text-faint">Renaming it isn't available yet: its seats, history and mentions are filed under it.</p>
        </Row>
        {text("description", "Description", SETTINGS_MAX.description, true, "One or two sentences: what it does.")}
      </Group>
      <Group title="When to use it">
        {text("useWhen", "Use it when", SETTINGS_MAX.useWhen, true, "Manta reads this to decide when to hand work to it.")}
        {text("notFor", "Not for", SETTINGS_MAX.notFor, true)}
      </Group>
      <Group title="How it works">
        <ModelRow info={info} approved={approved} locked={!editable.has("model")} onChanged={onChanged} />
        {editable.has("isolation") ? (
          <WorksRow info={info} onChanged={onChanged} />
        ) : (
          <Row id="isolation" label="Works" locked>
            <ReadOnly>{info.isolation === "worktree" ? "On its own branch" : "Read-only"}</ReadOnly>
          </Row>
        )}
        {refreshable && (
          <Row id="refresh" label="Refresh with new research" help="The agent re-checks the research it rests on and proposes changes; they wait for your click.">
            <div data-testid="settings-refresh">
              <RefreshControl profile={profile} onChanged={onChanged} note={false} />
              {profile.refresh.day != null && <p className="m-0 mt-1 text-meta text-text-faint">{refreshDayLine(profile.refresh.day, Date.now())}</p>}
            </div>
          </Row>
        )}
        <Row id="learning" label="Learn from your corrections" help="When you correct its work, Manta can write the rule down (see Learned).">
          <div data-testid="settings-learning">
            <ReadOnly>{learningLine(level)}</ReadOnly>
            <LinkButton spaced={false} onClick={() => window.dispatchEvent(new CustomEvent("manta-open-settings", { detail: { section: "sessions" } }))}>
              Change in Settings
            </LinkButton>
          </div>
        </Row>
      </Group>
    </div>
  );
}
