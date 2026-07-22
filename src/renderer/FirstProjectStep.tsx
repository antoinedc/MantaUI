import { useState } from "react";
import {
  defaultCwdForName,
  nextCwdOnNameChange,
  isManualDirEdit,
  canCreateProject,
} from "./firstProjectLogic";
import { useStore } from "./store";
import { StepFooter } from "./onboardingUi";

// FirstProjectStep.tsx — Step 4 (First project) of the desktop onboarding shell
// (BET-49-T5). Mounts into Onboarding.tsx's step-4 slot.
//
// A deliberately simple name + working-directory form (per docs/onboarding/
// mockup.html — NO worktree fan-out, NO path autocomplete; the first project is
// usually a fresh checkout and power users get the full Sidebar flow later). The
// directory is prefilled `~/projects/<name>` and keeps tracking the name until
// the user manually edits it, at which point their path wins. All that
// name→dir bookkeeping is pure + unit-tested in firstProjectLogic.ts.
//
// Creation routes through the EXISTING project-creation path — the same
// window.api.tmuxNewSession the Sidebar uses (tmux session + first window) — so
// there is no parallel creation code. We pass `createDir: true` (onboarding
// opt-in) so a missing ~/projects/<name> is `mkdir -p`'d server-side before
// tmux new-session runs, instead of the Sidebar's strict "directory must exist"
// rejection (see the tmuxNewSession handlers in src/main/index.ts + the server
// tmux.newSession in src/server/tmux.mjs). We pass the raw `cwd` string (never
// the literal "~") straight through; tilde expansion happens at the single
// creation chokepoint, per the AGENTS.md "cwd inheritance" gotcha.
//
// On success we refresh the projects tree and mark the new session active, so
// the success screen's "Open manta" drops into the normal shell with this project
// selected. A creation failure (bad path, mkdir permission denied, tmux error)
// renders inline and leaves the user on the form — the flow is never lost.
//
// Owns its OWN footer (Back + Create project), like PairStep/ProvidersStep/
// ModelStep, because Create is gated on a name + directory. The shell suppresses
// its footer here.
//
// Props:
//   onBack    — go back to Step 3 (Model).
//   onCreated — project created; the shell advances to the success screen.

const DANGER = "#FF7A88"; // inline error text (matches PairStep/ModelStep)

export function FirstProjectStep({
  onBack,
  onCreated,
}: {
  onBack: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  // The directory follows the name until manually edited (dirEdited latch).
  const [cwd, setCwd] = useState(() => defaultCwdForName(""));
  const [dirEdited, setDirEdited] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onNameChange = (value: string) => {
    setName(value);
    setCwd((prev) => nextCwdOnNameChange(value, prev, dirEdited));
    setError(null);
  };

  const onCwdChange = (value: string) => {
    setCwd(value);
    // Latch "user owns the dir" the instant they deviate from the auto-fill, so
    // further name edits stop clobbering their path. Typing the exact auto-fill
    // value is not a deviation (keeps the field following the name).
    if (isManualDirEdit(name, value)) setDirEdited(true);
    setError(null);
  };

  const canCreate = canCreateProject(name, cwd) && !creating;

  const create = async () => {
    // Mirror the pure gate so an Enter keypress can't fire from a non-ready
    // state (the button is also disabled, but Enter bypasses that).
    if (!canCreateProject(name, cwd) || creating) return;
    setCreating(true);
    setError(null);
    const projectName = name.trim();
    try {
      // Existing creation path (tmux session + first window). createDir opts
      // into server-side mkdir -p for a fresh onboarding project. chatMode:true
      // opens the window pinned to an opencode chat session using the model the
      // user just picked in Step 3 — the whole point of onboarding is to land
      // them chatting.
      await window.api.tmuxNewSession({
        name: projectName,
        cwd: cwd.trim(),
        windowName: "default",
        chatMode: true,
        createDir: true,
      });
      // Populate the store's projects tree and select the new session so "Open
      // manta" lands in the normal shell with this project active.
      await useStore.getState().refresh();
      useStore.getState().setActive(projectName);
      setCreating(false);
      onCreated();
    } catch (e) {
      setCreating(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void create();
  };

  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight text-text mb-1.5">
        Create your first project
      </h2>
      <p className="text-sm text-text-muted leading-relaxed mb-8 max-w-md">
        Give your project a name and pick where it lives. You can add more
        projects anytime.
      </p>

      <form onSubmit={onFormSubmit} className="flex flex-col gap-5">
        {/* Project name */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="project-name" className="text-xs font-medium text-text-muted">
            Project name
          </label>
          <input
            id="project-name"
            type="text"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            placeholder="my-app"
            disabled={creating}
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            className="w-full rounded-md bg-bg-soft border border-border px-3 py-2.5 text-sm text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
          />
        </div>

        {/* Working directory */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="project-cwd" className="text-xs font-medium text-text-muted">
            Working directory
          </label>
          <input
            id="project-cwd"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="~/projects/my-app"
            disabled={creating}
            value={cwd}
            onChange={(e) => onCwdChange(e.target.value)}
            className="w-full rounded-md bg-bg-soft border border-border px-3 py-2.5 font-mono text-sm text-text outline-none transition-colors focus:border-accent disabled:opacity-60"
          />
          <p className="text-xs text-text-faint">
            If the directory doesn't exist, it will be created automatically.
          </p>
        </div>

        {error && (
          <div role="alert" className="text-sm" style={{ color: DANGER }}>
            {error}
          </div>
        )}

        <StepFooter
          onBack={onBack}
          onContinue={() => void create()}
          continueLabel={creating ? "Creating…" : "Create project"}
          continueDisabled={!canCreate}
        />
      </form>
    </div>
  );
}
