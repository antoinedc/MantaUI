import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTailnetHosts } from "./tailnet.mjs";

test("parseTailnetHosts binds both address families a MagicDNS name resolves to", () => {
  // The regression this exists for: MagicDNS publishes the node's IPv4 AND its
  // IPv6 under one name, and a client (Apple's stack especially) tries the
  // IPv6 first. Binding only the IPv4 leaves an advertised address nothing
  // answers on, which stalls a caller rather than refusing it.
  assert.deepEqual(
    parseTailnetHosts("100.64.1.5,fd7a:115c:a1e0::1"),
    ["100.64.1.5", "fd7a:115c:a1e0::1"],
  );
});

test("parseTailnetHosts keeps the IPv4 first", () => {
  // Order is preserved so the guaranteed-reachable address is bound first and
  // a failure on the second cannot delay it.
  const hosts = parseTailnetHosts("100.64.1.5,fd7a:115c:a1e0::1");
  assert.equal(hosts[0], "100.64.1.5");
});

test("parseTailnetHosts accepts a single address unchanged", () => {
  // Back-compat with an already-installed box: its unit file carries one
  // address, and a one-element list must mean exactly what it did before.
  assert.deepEqual(parseTailnetHosts("100.64.1.5"), ["100.64.1.5"]);
});

test("parseTailnetHosts returns [] for an unset or blank value", () => {
  // The public path: no tailnet listener at all. Must be an empty list, not a
  // list containing an empty string — binding "" is a wildcard bind, which
  // would expose this listener far beyond the tailnet.
  for (const raw of ["", "   ", ",", " , , ", undefined, null, 42, {}]) {
    assert.deepEqual(parseTailnetHosts(raw), [], `expected [] for ${JSON.stringify(raw)}`);
  }
});

test("parseTailnetHosts tolerates whitespace and duplicates", () => {
  // Unit files get hand-edited; a stray space or a repeated address must not
  // produce a bind on "" or a second listener racing the first for the port.
  assert.deepEqual(
    parseTailnetHosts(" 100.64.1.5 , fd7a:115c:a1e0::1 , 100.64.1.5 "),
    ["100.64.1.5", "fd7a:115c:a1e0::1"],
  );
});
