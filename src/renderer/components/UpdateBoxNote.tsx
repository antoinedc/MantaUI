// The one-line "Update your box to use this" note shown where a surface needs a
// server-first capability the connected box does not advertise (WS11 D1).

export const UPDATE_BOX_NOTE_TEXT = "Update your box to use this";

export function UpdateBoxNote({
  text = UPDATE_BOX_NOTE_TEXT,
  className = "text-meta text-text-faint",
}: {
  text?: string;
  className?: string;
}) {
  return (
    <div className={className} role="note">
      {text}
    </div>
  );
}
