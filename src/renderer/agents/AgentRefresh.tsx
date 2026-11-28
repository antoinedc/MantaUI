// "Refresh with new research": Monthly | Off, a row of the profile's Settings tab. The box owns the
// routine; the control shows its word, says "Saving…" while it asks, and a refusal is a sentence under it (never silence).

import { useEffect, useRef, useState } from "react";
import type { AgentProfile } from "../../shared/types";
import { Segmented } from "../Segmented";
import { errText } from "./agentsView";

/** `note`: the sentence under the control saying what Monthly does. */
export function RefreshControl({ profile, onChanged, note = true }: { profile: AgentProfile; onChanged: () => void; note?: boolean }) {
  const slug = profile.info.slug;
  const [override, setOverride] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  // Turned off from the Routines page (or on again): the box's word beats an answer we kept.
  useEffect(() => setOverride(null), [profile.refresh.enabled]);
  const enabled = override ?? profile.refresh.enabled;

  const set = async (next: "monthly" | "off") => {
    const want = next === "monthly";
    if (busyRef.current || want === enabled) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await window.api.agentsRefreshSet({ slug, enabled: want });
      setOverride(r.enabled);
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div data-testid="profile-refresh">
      <div className="flex items-center gap-3">
        <Segmented
          label="Refresh with new research"
          options={[
            { id: "monthly", label: "Monthly" },
            { id: "off", label: "Off" },
          ]}
          value={enabled ? "monthly" : "off"}
          onChange={(v) => void set(v)}
        />
        {busy && <span className="text-meta text-text-faint">Saving…</span>}
      </div>
      {note && (
        <p className="m-0 mt-2 text-meta text-text-faint">
          {enabled ? "Once a month the agent checks the research it rests on and proposes changes. They wait for your click." : "The agent is not refreshed on its own."}
        </p>
      )}
      {error && (
        <div role="alert" data-testid="refresh-error" className="mt-1 break-words text-meta text-danger">
          {error}
        </div>
      )}
    </div>
  );
}
