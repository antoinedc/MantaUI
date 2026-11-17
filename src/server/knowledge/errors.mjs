// errors.mjs — the typed error every knowledge module throws.
//
// `code` is the machine-readable reason (the HTTP/RPC layers map it to a status
// and to the pinned bodies of spec §11.2/§11.6); `status` is the HTTP status
// the code implies. Messages are plain sentences, safe to show to the model.

export class KnowledgeError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message ?? code);
    this.name = "KnowledgeError";
    this.code = code;
    this.status = status;
    // `rpcStatus` is what rpc.mjs dispatch reads.
    this.rpcStatus = status;
    if (details !== undefined) this.details = details;
  }
}

export const isKnowledgeError = (e) => e instanceof KnowledgeError || e?.name === "KnowledgeError";
