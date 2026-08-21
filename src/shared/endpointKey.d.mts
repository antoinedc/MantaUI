export interface EndpointLike {
  providerID?: string;
  modelID?: string;
  id?: string;
}

/**
 * The stable machine identity of a routed endpoint: `providerID/modelID`.
 * Returns `""` when either side is missing — an empty key is "no identity"
 * and must never match another empty key at a comparison site.
 */
export function endpointKey(m: EndpointLike | null | undefined): string;
