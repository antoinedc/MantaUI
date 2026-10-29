// TEST-ONLY: stamp `view` (runs, part activity, footers) onto raw message fixtures with the BOX's own module, so renderer
// tests exercise exactly what the box sends and no second copy of the run rules exists in the renderer.
import { annotateView } from "../server/transcriptView.mjs";
import type { OpencodeMessage } from "../shared/types";

export function viewed(
  messages: OpencodeMessage[],
  opts: { running?: boolean; ledger?: unknown; runContext?: OpencodeMessage[] | null } = {},
): OpencodeMessage[] {
  return annotateView(messages as never, opts as never) as unknown as OpencodeMessage[];
}
