// Tiny JSON-Schema builders. The V1 tools declared inputs with zod; V2 wants
// plain JSON Schema. These mirror what zod's own JSON-Schema export produces
// for the constructs the V1 tools use, so the two stay comparable (the parity
// test in scripts/opencode-v2/ diffs them against the real V1 zod schemas).

import type { JsonSchema } from "./types.ts";

type Described = { description?: string };

const d = (description?: string): Described => (description === undefined ? {} : { description });

export const str = (description?: string): JsonSchema => ({ type: "string", ...d(description) });
export const num = (description?: string): JsonSchema => ({ type: "number", ...d(description) });
export const bool = (description?: string): JsonSchema => ({ type: "boolean", ...d(description) });

/** `z.number().int().positive()` */
export const posInt = (description?: string): JsonSchema => ({
  type: "integer",
  exclusiveMinimum: 0,
  ...d(description),
});

/** `z.number().positive()` */
export const posNum = (description?: string): JsonSchema => ({
  type: "number",
  exclusiveMinimum: 0,
  ...d(description),
});

export const oneOf = (values: string[], description?: string): JsonSchema => ({
  type: "string",
  enum: values,
  ...d(description),
});

export const arr = (items: JsonSchema, description?: string): JsonSchema => ({
  type: "array",
  items,
  ...d(description),
});

/** A strict nested object (`additionalProperties: false`). */
export const obj = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  description?: string,
): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
  ...d(description),
});

/**
 * The top-level tool input: an object whose `required` is every property not
 * listed in `optional`. (The V1 style is "required unless `.optional()`".)
 */
export const input = (
  properties: Record<string, JsonSchema>,
  optional: string[] = [],
): JsonSchema => {
  const required = Object.keys(properties).filter((k) => !optional.includes(k));
  return obj(properties, required);
};

/** No-argument tool. */
export const noInput = (): JsonSchema => obj({});
