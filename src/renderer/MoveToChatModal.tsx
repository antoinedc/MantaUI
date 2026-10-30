// ===== Routine → chat (R7) =====
//
// "Inside a chat…" on a routine's destination chip. The routine's runs then
// post into a chat (the origin chat, a new one, or any other chat-mode window)
// instead of starting a fresh session; the routine's memory is posted into the
// chat once (`routines:move-to-chat`).

import { useMemo, useRef, useState } from "react";
import { CalendarClock, ChevronRight, CircleHelp, MessageCircle } from "lucide-react";
import type { Routine, RoutineMoveTarget } from "../shared/routines";
import { Button } from "./Button";
import { Callout } from "./Callout";
import { Dropdown } from "./MenuItem";
import { MenuOption } from "./MenuOption";
import { Modal } from "./Modal";
import {
  CheckLine,
  RadioCard,
  RoutineModalBody,
  RoutineModalFooter,
  RoutineModalHeader,
} from "./RoutinesParts";
import { routinesToast, runAction } from "./routinesData";
import { cadenceText, memoryLineCount } from "./routinesView";
import { useStore } from "./store";
import { formatAge } from "./chatUtils";
import { nowMs } from "./clock";

type Choice = "origin" | "new" | "other";

export function MoveToChatModal({
  routine,
  runCount,
  memory,
  onClose,
  onMoved,
}: {
  routine: Routine | null;
  runCount: number;
  memory: string;
  onClose: () => void;
  onMoved: (routine: Routine) => void;
}) {
  const open = routine != null;
  const projects = useStore((s) => s.projects);
  const status = useStore((s) => s.status);

  const origin = useMemo(() => {
    const sid = routine?.createdFrom?.sessionID;
    if (!sid) return null;
    for (const p of projects) {
      const w = p.windows.find((x) => x.opencodeSessionId === sid);
      if (w) return { sessionID: sid, project: p.tmuxSession, name: w.name, last: status[p.tmuxSession]?.[w.index]?.lastMessageAt };
    }
    return null;
  }, [routine, projects, status]);

  const chats = useMemo(
    () =>
      projects.flatMap((p) =>
        p.windows.filter((w) => w.opencodeSessionId).map((w) => ({ sessionID: w.opencodeSessionId as string, project: p.tmuxSession, name: w.name })),
      ),
    [projects],
  );

  const [choice, setChoice] = useState<Choice | null>(null);
  const [other, setOther] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const otherRef = useRef<HTMLDivElement>(null);

  const effective: Choice = choice ?? (origin ? "origin" : "new");
  const otherChat = chats.find((c) => c.sessionID === other) ?? null;
  const chatName =
    effective === "origin" ? origin?.name ?? "the chat" : effective === "other" ? otherChat?.name ?? "the chat" : routine?.name ?? "the chat";
  const canMove = effective !== "other" || other != null;
  const lines = memoryLineCount(memory);

  const move = async () => {
    if (!routine || !canMove) return;
    const target: RoutineMoveTarget =
      effective === "origin" ? { type: "origin" } : effective === "new" ? { type: "new" } : { type: "session", sessionID: other as string };
    setBusy(true);
    const r = await runAction("move the routine into a chat", () => window.api.routinesMoveToChat(routine.id, target));
    setBusy(false);
    if (r) {
      routinesToast("info", `${routine.name} now runs inside ${chatName}`);
      onMoved(r.routine);
    }
  };

  return (
    <Modal size="lg" tall padded={false} open={open} onDismiss={onClose} label="Run it inside a chat">
      <div className="manta-routines-tochat flex min-h-0 flex-1 flex-col">
        <RoutineModalHeader title="Run it inside a chat" onClose={onClose} icon={<MessageCircle size={16} className="text-accent-tx" aria-hidden />} />
        <RoutineModalBody>
          {routine && (
            <div className="flex items-center gap-3 rounded-md border border-border-subtle bg-bg-elev px-3 py-2">
              <CalendarClock size={16} className="shrink-0 text-text-faint" aria-hidden />
              <div className="min-w-0">
                <div className="truncate text-label font-semibold text-text">{routine.name}</div>
                <div className="truncate text-meta text-text-quiet">
                  {cadenceText(routine.cron)} · new session each run · {runCount} {runCount === 1 ? "run" : "runs"}
                </div>
              </div>
              <span className="ml-auto flex shrink-0 items-center gap-1 text-meta font-semibold text-accent-tx">
                <ChevronRight size={14} aria-hidden />
                Inside a chat
              </span>
            </div>
          )}
          <div className="space-y-1">
            <div className="block text-micro font-semibold uppercase text-text-muted">Which chat?</div>
            <div className="flex flex-col gap-2" role="radiogroup" aria-label="Which chat">
              {origin && (
                <RadioCard
                  selected={effective === "origin"}
                  title={origin.name}
                  sub={`${origin.project} · the chat this routine was created from${origin.last ? ` · active ${formatAge(nowMs() - origin.last)} ago` : ""}`}
                  onSelect={() => setChoice("origin")}
                />
              )}
              <RadioCard
                selected={effective === "new"}
                title="A new chat just for this"
                sub={`Shows up in the sidebar as “${routine?.name ?? ""}”. Every run adds to it.`}
                onSelect={() => setChoice("new")}
              />
              <div ref={otherRef}>
                <RadioCard
                  selected={effective === "other"}
                  title={otherChat ? `Another chat: ${otherChat.name}` : "Another chat…"}
                  sub={otherChat ? `${otherChat.project} · click to pick a different one` : "Pick any session in the sidebar."}
                  onSelect={() => {
                    setChoice("other");
                    setPickerOpen(true);
                  }}
                />
              </div>
              <Dropdown open={pickerOpen} onClose={() => setPickerOpen(false)} anchorRef={otherRef} align="start" role="listbox" width="wide">
                {chats.length === 0 ? (
                  <div className="px-3 py-2 text-meta text-text-faint">No chats in the sidebar yet.</div>
                ) : (
                  chats.map((c) => (
                    <MenuOption
                      key={c.sessionID}
                      selected={c.sessionID === other}
                      label={c.name}
                      sub={c.project}
                      onSelect={() => {
                        setOther(c.sessionID);
                        setPickerOpen(false);
                      }}
                    />
                  ))
                )}
              </Dropdown>
            </div>
          </div>
          <div className="space-y-2">
            <div className="block text-micro font-semibold uppercase text-text-muted">What changes</div>
            <div className="flex flex-col gap-1 text-meta text-text-faint">
              <CheckLine>
                Each run posts into <b className="font-semibold text-text">{chatName}</b> and can see everything said there, so you can reply to a finding directly.
              </CheckLine>
              <CheckLine>
                Its memory ({lines} {lines === 1 ? "line" : "lines"}) is posted into the chat once. From then on the chat itself is the memory. The note is kept as it was,
                in case you move it back.
              </CheckLine>
              <CheckLine>If you're in the middle of something at {routine ? cadenceTime(routine.cron) : "that time"}, the run waits until the chat is idle. It never interrupts you.</CheckLine>
              <CheckLine>
                The {runCount} past {runCount === 1 ? "run stays" : "runs stay"} in this routine's history.
              </CheckLine>
            </div>
          </div>
          <Callout tone="info" size="note">
            <span className="mr-1 inline-flex align-middle">
              <CircleHelp size={13} aria-hidden />
            </span>{" "}
            Good for check-ins you want to discuss. For independent daily reports, a new session each run keeps the chat from growing every day.
          </Callout>
        </RoutineModalBody>
        <RoutineModalFooter>
          <span className="ml-auto" />
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" loading={busy} disabled={!canMove} onClick={() => void move()}>
            Move into chat
          </Button>
        </RoutineModalFooter>
      </div>
    </Modal>
  );
}

function cadenceTime(cron: string): string {
  const f = cron.trim().split(/\s+/);
  const h = Number(f[1]);
  const m = Number(f[0]);
  return Number.isInteger(h) && Number.isInteger(m) ? `${h}:${String(m).padStart(2, "0")}` : "that time";
}

