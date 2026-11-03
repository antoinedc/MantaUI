// Test fixtures shaped like the server's `server:changelog` answer, built from
// the real CHANGELOG.md entry layout (see CHANGELOG.md 1.3.0 / 1.2.0).

import type { ChangelogEntry } from "../shared/api";

export const ROUTINES_ENTRY: ChangelogEntry = {
  version: "1.4.0",
  date: "2026-11-01",
  components: ["server", "desktop"],
  fingerprint: "fp-1.4.0",
  headline: "Routines are here",
  highlights: [
    { title: "Routines", icon: "repeat", text: "Recurring work in a fresh session each run.", action: "routines" },
    { title: "Cheaper handoffs", icon: "arrow-left-right", text: "Cold-cache handoffs use a cheap model.", action: "settings:models" },
    { title: "Catching up", icon: "refresh-cw", text: "Come back to a busy session and it syncs first.", action: null },
  ],
  markdown: [
    "### Routines",
    "",
    "- **Scheduled work in its own fresh session.** A routine runs on a schedule.",
    "- **A routine's page is a run inbox.**",
    "- **Follow up** on any run turns it into an ordinary session.",
    "- **Cheaper handoffs** when the cache has gone cold.",
    "- **Summary model setting** for handoffs and titles.",
    "- **Catching up on return.** A hidden session shows Catching up…",
    "",
    "Ships: `server-v12`, `mac-v0.0.40`",
  ].join("\n"),
};

export const NOTES_ENTRY: ChangelogEntry = {
  version: "1.3.0",
  date: "2026-10-30",
  components: ["server", "desktop", "ios"],
  fingerprint: "fp-1.3.0",
  headline: null,
  highlights: [],
  markdown: ["### Seats", "", "- **Conversations are placed by weekly-quota deadline.**", "- Model-aware routing applicability.", "", "Ships: `server-v11`"].join("\n"),
};

export const OLDER_ENTRY: ChangelogEntry = {
  version: "1.2.0",
  date: "2026-10-28",
  components: ["box"],
  fingerprint: "fp-1.2.0",
  headline: null,
  highlights: [],
  markdown: ["### Send while working", "", "- **Enter sends now, ⌥Enter after this turn.**"].join("\n"),
};
