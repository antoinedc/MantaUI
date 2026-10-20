// Response un-prefixing (R1). The request side prefixes tool names with `mcp_`;
// the stream coming back must be un-prefixed or opencode's tool router sees
// `mcp_Shell` instead of `shell`.
//
// A network chunk can end anywhere — including in the middle of `"name":"mcp_X"`
// — so the rewrite never runs on a raw chunk. Bytes are decoded (multi-byte safe)
// and buffered up to an SSE event boundary (a blank line); only COMPLETE events
// are rewritten and emitted, and whatever is left at end-of-stream is flushed
// last. A body with no event boundary (plain JSON) is therefore rewritten once,
// whole, at the end.

import { stripToolPrefix } from "./body.ts";

/** Index just past the first event boundary in `buffer`, or -1. */
function boundaryEnd(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (crlf === -1 || (lf !== -1 && lf < crlf)) return lf + 2;
  return crlf + 4;
}

/**
 * Pure, synchronous core: feed decoded text, get back the text safe to emit.
 * `push` returns zero or more rewritten complete events; `flush` returns the rest.
 */
export function createUnprefixer(nameMap?: ReadonlyMap<string, string>) {
  let buffer = "";
  return {
    push(text: string): string {
      buffer += text;
      let out = "";
      for (;;) {
        const end = boundaryEnd(buffer);
        if (end === -1) break;
        out += stripToolPrefix(buffer.slice(0, end), nameMap);
        buffer = buffer.slice(end);
      }
      return out;
    },
    flush(): string {
      const rest = buffer;
      buffer = "";
      return rest ? stripToolPrefix(rest, nameMap) : "";
    },
  };
}

/** A copy of `response` whose body is un-prefixed at event boundaries. */
export function unprefixResponse(response: Response, nameMap?: ReadonlyMap<string, string>): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const un = createUnprefixer(nameMap);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          const tail = un.push(decoder.decode()) + un.flush();
          if (tail) controller.enqueue(encoder.encode(tail));
          controller.close();
          return;
        }
        const out = un.push(decoder.decode(value, { stream: true }));
        if (out) {
          controller.enqueue(encoder.encode(out));
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
