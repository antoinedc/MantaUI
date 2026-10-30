// ===== Follow-up → routine (R6) =====
//
// "Make it a routine" on a follow-up row. The box rewrites the follow-up's
// instructions so they stand alone and turns what the chat knew into the
// routine's starting memory (`routines:convert-preview`); the user edits both
// and commits (`routines:convert-commit`), which moves the job out of the chat.

import { useEffect, useState } from "react";
import { ChevronRight, Clock, Eye, Folder, MessageCircle, Pencil, Play } from "lucide-react";
import type { FollowupRow, Routine, RoutineAccess } from "../shared/routines";
import { Button } from "./Button";
import { Field, INPUT_BASE, LABEL_CLS } from "./Field";
import { FolderPickerModal } from "./FolderPickerModal";
import { MantaLoader } from "./MantaLoader";
import { Modal } from "./Modal";
import {
  CheckLine,
  LabelledBlock,
  PickerButton,
  RoutineModalBody,
  RoutineModalFooter,
  RoutineModalHeader,
} from "./RoutinesParts";
import { routinesToast, runAction } from "./routinesData";
import { cadenceText, tildePath } from "./routinesView";
import { resolveSessionOwner, useStore } from "./store";
import { nextCronRun } from "./chatUtils";
import { nowMs } from "./clock";

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function nameFrom(f: FollowupRow): string {
  const first = (f.label || f.prompt).split("\n")[0].trim();
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}

export function ConvertToRoutineModal({
  followup,
  onClose,
  onConverted,
  onTestRun,
}: {
  followup: FollowupRow | null;
  onClose: () => void;
  onConverted: (routine: Routine) => void;
  onTestRun: (routine: Routine, runId: string) => void;
}) {
  const open = followup != null;
  const projects = useStore((s) => s.projects);
  const [loading, setLoading] = useState(false);
  const [rewritten, setRewritten] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [original, setOriginal] = useState("");
  const [memory, setMemory] = useState("");
  const [directory, setDirectory] = useState("");
  const [access, setAccess] = useState<RoutineAccess>("read");
  const [folderOpen, setFolderOpen] = useState(false);
  const [busy, setBusy] = useState<"commit" | "test" | null>(null);

  const id = followup?.id ?? null;
  useEffect(() => {
    if (!followup) return;
    let live = true;
    setLoading(true);
    setLoadError(null);
    setOriginal(followup.prompt);
    setInstructions(followup.prompt);
    setMemory("");
    setRewritten(true);
    setAccess("read");
    setDirectory(resolveSessionOwner(projects, followup.sessionID)?.cwd ?? "");
    window.api
      .routinesConvertPreview(followup.id)
      .then((p) => {
        if (!live) return;
        setInstructions(p.instructions);
        setMemory(p.memory);
        setRewritten(p.rewritten);
      })
      .catch((e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // The preview is per follow-up; `projects` only seeds the folder once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const cron = followup?.cron ?? "";
  const next = cron ? nextCronRun(cron, nowMs()) : null;
  const nextText = next != null ? `${DOW[new Date(next).getDay()]} at ${new Date(next).getHours()}:${String(new Date(next).getMinutes()).padStart(2, "0")}` : "";
  const valid = instructions.trim() !== "" && directory.trim() !== "";

  const input = () =>
    followup && {
      name: nameFrom(followup),
      prompt: instructions.trim(),
      directory: directory.trim(),
      cron: followup.cron,
      access,
      memory,
    };

  const commit = async () => {
    const body = input();
    if (!followup || !body || !valid) return;
    setBusy("commit");
    const r = await runAction("make it a routine", () => window.api.routinesConvertCommit(followup.id, body));
    setBusy(null);
    if (r) {
      routinesToast("info", `${r.name} is now a routine`);
      onConverted(r);
    }
  };
  const test = async () => {
    const body = input();
    if (!followup || !body || !valid) return;
    setBusy("test");
    const r = await runAction("make it a routine", () => window.api.routinesConvertCommit(followup.id, { ...body, enabled: false }));
    if (!r) {
      setBusy(null);
      return;
    }
    const run = await runAction("start the test run", () => window.api.routinesRunNow(r.id));
    setBusy(null);
    if (run) onTestRun(r, run.run.id);
    else onConverted(r);
  };

  return (
    <Modal size="lg" tall padded={false} open={open} onDismiss={onClose} label="Make it a routine">
      <div className="manta-routines-convert flex min-h-0 flex-1 flex-col">
        <RoutineModalHeader title="Make it a routine" onClose={onClose} />
        <RoutineModalBody>
          {followup && (
            <div className="flex items-center gap-3 rounded-md border border-border-subtle bg-bg-elev px-3 py-2">
              <MessageCircle size={14} className="shrink-0 text-text-faint" aria-hidden />
              <div className="min-w-0">
                <div className="truncate text-label font-semibold text-text">{nameFrom(followup)}</div>
                <div className="truncate text-meta text-text-quiet">
                  {cadenceText(followup.cron)} · runs inside “{followup.sessionName ?? "its chat"}”
                </div>
              </div>
              <span className="ml-auto flex shrink-0 items-center gap-1 text-meta font-semibold text-accent-tx">
                <ChevronRight size={14} aria-hidden />
                New session each run
              </span>
            </div>
          )}
          <LabelledBlock
            label="Instructions, rewritten to make sense without the chat"
            help={
              rewritten ? (
                "A fresh session can't see the chat, so “this week” and “billing” are spelled out. Edit freely."
              ) : (
                <span className="text-warn">Couldn't rewrite automatically — edit it so it stands alone.</span>
              )
            }
          >
            <div className="overflow-hidden rounded-md border border-border-subtle">
              <div className="bg-[var(--diff-del)] px-3 py-2 text-label text-text-muted line-through">{original}</div>
              {loading ? (
                <div className="flex items-center gap-2 px-3 py-3 text-label text-text-faint">
                  <MantaLoader size="inline" />
                  Rewriting…
                </div>
              ) : (
                <Field ariaLabel="Instructions" multiline rows={4} mono={false} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
              )}
            </div>
            {loadError && <div className="text-meta text-warn">Couldn't rewrite automatically — {loadError}</div>}
          </LabelledBlock>
          <LabelledBlock label="It will start out knowing" help="Taken from the chat. This becomes the routine's memory, and every run reads and updates it.">
            <Field ariaLabel="Starting memory" multiline rows={4} value={memory} onChange={(e) => setMemory(e.target.value)} />
          </LabelledBlock>
          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <div className="space-y-1">
              <div className={LABEL_CLS}>Folder</div>
              <PickerButton
                icon={<Folder size={14} aria-hidden />}
                text={directory ? tildePath(directory) : "Choose…"}
                mono
                label="Folder"
                onClick={() => setFolderOpen(true)}
              />
            </div>
            <div className="space-y-1">
              <div className={LABEL_CLS}>When</div>
              <div className={`${INPUT_BASE} flex items-center gap-2 whitespace-nowrap px-3 py-3 text-label overflow-hidden`}>
                <Clock size={14} className="shrink-0 text-text-faint" aria-hidden />
                {cadenceText(cron)}
              </div>
            </div>
            <div className="space-y-1">
              <div className={LABEL_CLS}>Allowed to</div>
              <button
                type="button"
                title="Click to switch"
                onClick={() => setAccess((a) => (a === "read" ? "edit" : "read"))}
                className={`${INPUT_BASE} flex items-center gap-2 whitespace-nowrap px-3 py-3 text-left text-label`}
              >
                {access === "read" ? <Eye size={14} className="shrink-0 text-text-faint" aria-hidden /> : <Pencil size={14} className="shrink-0 text-text-faint" aria-hidden />}
                {access === "read" ? "Read and report" : "Make changes"}
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1 text-meta text-text-faint">
            <CheckLine>The chat keeps the write-ups it already received. It just stops getting new ones.</CheckLine>
            <CheckLine>
              Same schedule, so the next run is still <b className="font-semibold text-text">{nextText}</b>, now on the Routines page.
            </CheckLine>
            <CheckLine>You can move it back into a chat later from the routine's page.</CheckLine>
          </div>
        </RoutineModalBody>
        <RoutineModalFooter>
          <Button tone="default" loading={busy === "test"} disabled={!valid || loading || busy === "commit"} onClick={() => void test()}>
            <Play size={14} aria-hidden />
            Test run now
          </Button>
          <span className="ml-auto" />
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" loading={busy === "commit"} disabled={!valid || loading || busy === "test"} onClick={() => void commit()}>
            Make it a routine
          </Button>
        </RoutineModalFooter>
      </div>
      <FolderPickerModal
        open={folderOpen}
        initialPath={directory || "~"}
        onSelect={(p) => {
          setDirectory(p);
          setFolderOpen(false);
        }}
        onCancel={() => setFolderOpen(false)}
      />
    </Modal>
  );
}
