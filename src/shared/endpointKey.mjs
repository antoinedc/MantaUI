/**
 * The stable machine identity of a routed endpoint: `providerID/modelID`.
 *
 * The SINGLE definition. Two conventions for a model id are in circulation —
 * the router's internal catalogue shape uses `id`, everything crossing the RPC
 * boundary uses `modelID` (see toDeliverModel). Accepting both here is what
 * makes them one identity rather than two that silently disagree.
 *
 * An empty key means "no identity": a routing comparison must never treat two
 * empty keys as matching (see routingBoundary's incumbentIndex guard).
 */
export function endpointKey(m) {
  if (!m) return "";
  const provider = m.providerID ?? "";
  const model = m.modelID ?? m.id ?? "";
  return provider && model ? `${provider}/${model}` : "";
}
