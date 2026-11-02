// A box path → the Artifact the preview overlay needs. Used for terminal
// absolute-path clicks, which open the EXISTING ArtifactPreview (terminal
// windows get no Explorer in v1).

import type { Artifact } from "../artifacts";

export function artifactForPath(path: string): Artifact {
  const label = path.replace(/\/+$/, "").split("/").pop() || path;
  return {
    id: `path:${path}`,
    kind: "file",
    origin: "agent",
    label,
    href: path,
    mime: null,
    size: null,
    at: 0,
    messageId: null,
    context: null,
    isHosted: false,
    expiry: null,
    plan: null,
  };
}
