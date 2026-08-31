// ---------------------------------------------------------------------------
// Tailnet listener addressing.
//
// `MANTA_TAILNET_HOST` carries EVERY address the box's tailnet listener must
// bind, comma-separated — not one address. Tailscale assigns each node both an
// IPv4 (100.64.0.0/10) and an IPv6 (fd7a:…), and MagicDNS publishes BOTH under
// the node's name. A client that resolves the name therefore gets two
// candidate addresses and, on Apple's stack especially, tries the IPv6 first.
//
// Binding only the IPv4 leaves an advertised address that nothing answers on.
// That does not fail cleanly — a connection to an address that is routable but
// unbound can sit until it times out, which surfaces as an app that hangs
// rather than one that reports it cannot connect. That was invisible while the
// box advertised a bare IPv4 (one address, and it was the bound one) and became
// reachable the moment it started advertising a name.
//
// The value is a LIST rather than a second variable so an already-installed
// box's unit keeps working untouched: a single address is a valid one-element
// list, so an old unit file and a new one mean the same thing.
//
// Bind is still explicit per-address and never a wildcard: the whole point of
// this listener is that it is reachable on the tailnet and nowhere else, and
// `::`/`0.0.0.0` would expose it far more widely than intended.
// ---------------------------------------------------------------------------

/**
 * Split a `MANTA_TAILNET_HOST` value into the addresses to bind.
 *
 * Tolerant of whitespace, empty entries and duplicates (a hand-edited unit
 * file is a real thing), and order-preserving so the primary IPv4 is bound
 * first. Returns `[]` for an unset/blank value, which is the public-path case
 * where the tailnet listener is a no-op.
 *
 * @param {string|undefined|null} raw
 * @returns {string[]}
 */
export function parseTailnetHosts(raw) {
  if (typeof raw !== "string") return [];
  const seen = new Set();
  const out = [];
  for (const part of raw.split(",")) {
    const host = part.trim();
    if (host === "" || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}
