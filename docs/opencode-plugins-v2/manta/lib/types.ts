// Shared shapes for the `manta` V2 plugin. Kept free of any `@opencode/plugin`
// import so every tools/*.ts module (and the unit tests that import them under
// plain Node) loads without the binary's bundled package.

/** A JSON Schema object (draft 2020-12 subset the model providers accept). */
export type JsonSchema = Record<string, unknown>;

/**
 * What a Manta tool needs to know about the call. `sessionID` / `messageID`
 * come straight from the V2 execute context; `directory` is resolved by
 * lib/context.ts (V2 does not put it in the execute context).
 */
export interface ToolContext {
  sessionID: string;
  messageID?: string;
  directory?: string;
}

/**
 * One Manta tool. `execute` returns EXACTLY the string the V1 tool returned
 * (index.ts wraps it as `{ content }`) and throws with the V1 message on error.
 */
export interface ToolDef<I = any> {
  name: string;
  description: string;
  input: JsonSchema;
  execute(input: I, context: ToolContext): Promise<string>;
}
