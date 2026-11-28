// outsideQuery.test.mjs — AC-2.8 (research layer spec): the ONE check every outgoing request to an outside destination
// passes, over the whole query or the whole URL, before any network request is made; it fails closed. Pure + injected I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutsideCheck, OUTSIDE_REFUSAL, CHECK_UNAVAILABLE, WEB_OFF } from "./outsideQuery.mjs";

const SECRET = "sk-live-9f2c41ab77d0e3158c";
const PRIVATE_ANSWER = "Halvorsen Freight signed a forty million dollar deal for the Kestrel queue rewrite in March after long talks";

function make({ webEnabled, secrets = [{ key: "K", scope: "shared", value: SECRET }], privateAnswers = async () => [], folderOf = async () => "/home/dev/projects/kestrel", records = [], scanner } = {}) {
  const check = createOutsideCheck({
    loadSecrets: async () => {
      if (secrets === "throw") throw new Error("store unreadable");
      return secrets;
    },
    privateAnswers,
    folderOf,
    record: (r) => records.push(r),
    ...(webEnabled ? { webEnabled } : {}),
    ...(scanner ? { createScanner: scanner } : {}),
  });
  return { check, records };
}
const q = (query) => ({ sessionID: "ses_a", tool: "websearch", input: { query } });
const u = (url) => ({ sessionID: "ses_a", tool: "webfetch", input: { url } });
const refused = async (f, req) => {
  const r = await f.check.check(req);
  assert.equal(r.ok, false, JSON.stringify(req));
  assert.equal(r.error, OUTSIDE_REFUSAL);
  return r;
};

// ---- a clean query and a clean URL pass ----

test("a clean query and a clean URL pass", async () => {
  const f = make();
  for (const query of ["Postgres job queue for Node, at-least-once delivery", "how do teams structure a monorepo with pnpm + turborepo", "which version of drizzle-orm supports postgres 16 and what's new in 2026"]) {
    assert.deepEqual(await f.check.check(q(query)), { ok: true }, query);
  }
  for (const url of ["https://example.com/docs/api/v1/pricing", "https://developer.mozilla.org/en-US/docs/Web/API/fetch?utm=x#section-two", "https://github.com/pnpm/pnpm/blob/main/README.md", "http://127.0.0.1:5000/docs/pricing"]) {
    assert.deepEqual(await f.check.check(u(url)), { ok: true }, url);
  }
  assert.deepEqual(f.records, []);
});

// ---- (a)–(e) in a query ----

test("(a) a secret value, or anything the secret scanner flags, in a query", async () => {
  const f = make();
  await refused(f, q(`pick a queue library for ${SECRET}`));
  // a token-shaped value the store doesn't hold: the scanner's own rules (a GitHub token, a connection string with a password)
  await refused(f, q("why is ghp_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5 rejected by the api"));
  await refused(f, q("connect postgres://admin:Sup3rS3cret@db.example.com:5432/app times out"));
  await refused(f, u("https://example.com/docs/ghp_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5"));
});

test("(b) an absolute file path, or a path under the task's folder, in a query", async () => {
  const f = make();
  await refused(f, q("why does /etc/ssl/private/kestrel.pem fail to load"));
  await refused(f, q("error in ~/projects/kestrel/src/queue.ts line 4"));
  await refused(f, q("C:\\Users\\jane\\kestrel\\notes.txt parse error"));
  await refused(f, q("what is in /home/dev/projects/kestrel"));
  await refused(f, q("ENOENT /srv/halvorsen/app/config.json"));
  const g = make({ folderOf: async () => "/work/acme-secret-project" });
  await refused(g, q("is /work/acme-secret-project a monorepo"));
  assert.equal((await g.check.check(q("is a monorepo with pnpm workspaces good"))).ok, true);
});

test("(c) an e-mail address in a query", async () => {
  await refused(make(), q("why does jane.doe@halvorsen.no get bounced by postmark"));
  assert.equal((await make().check.check(q("npm install foo@1.2.3 fails and @types/node is missing"))).ok, true, "versions and scoped packages are not e-mail addresses");
});

test("(d) a private network address or an internal host name in a query", async () => {
  const f = make();
  await refused(f, q("connect ECONNREFUSED billing.int.kestrel.lan:5432"));
  for (const host of ["db1.corp", "printer.local", "api.service.internal", "nas.home.arpa"]) await refused(f, q(`ssh to ${host} fails`));
  for (const ip of ["10.2.3.4", "172.16.0.9", "172.31.255.1", "192.168.1.20", "169.254.169.254", "127.0.0.1"]) await refused(f, q(`curl ${ip}:8080 times out`));
  await refused(f, q("listen on [::1] and fd12:3456:789a::1 fails"));
  for (const ok of ["8.8.8.8 dns resolver", "172.32.0.1 public range", "example.com cors error"]) assert.equal((await f.check.check(q(ok))).ok, true, ok);
});

test("(e) 6+ consecutive words copied verbatim from a private source's answer of this task or chat", async () => {
  const f = make({ privateAnswers: async (sid) => (sid === "ses_a" ? [PRIVATE_ANSWER] : []) });
  await refused(f, q("signed a forty million dollar deal for queue rewrite"));
  await refused(f, q("SIGNED A FORTY, MILLION dollar deal"));
  assert.equal((await f.check.check(q("a forty million dollar deal"))).ok, true, "five words in a row are not enough");
  assert.equal((await f.check.check({ sessionID: "ses_other", tool: "websearch", input: { query: "signed a forty million dollar deal for queue rewrite" } })).ok, true, "another session's private answers don't count");
});

// ---- (a)–(e) ONLY in a URL: path, host, user-info, query, fragment ----

test("(a) a secret placed only in a URL path, a host label, a query name or value, or the fragment", async () => {
  const f = make();
  await refused(f, u(`https://example.com/docs/${SECRET}/plans`));
  await refused(f, u(`https://example.com/docs/${encodeURIComponent(SECRET)}`));
  await refused(f, u(`https://${SECRET}.example.com/`));
  await refused(f, u(`https://example.com/search?${SECRET}=1`));
  await refused(f, u(`https://example.com/search?q=${SECRET}`));
  await refused(f, u(`https://example.com/docs#${SECRET}`));
});

test("(b) an absolute path or the task folder placed only in a URL (encoded slashes, a home-directory run, the folder itself)", async () => {
  const f = make();
  await refused(f, u("https://example.com/p/%2Fhome%2Fdev%2Fkestrel%2Fnotes"));
  await refused(f, u("https://example.com/Users/jane/kestrel/notes.txt"));
  await refused(f, u("https://example.com/x/home/jane/kestrel"));
  await refused(f, u("https://example.com/docs#/etc/ssl/private/kestrel.pem"));
  await refused(f, u("https://example.com/search?file=%2Fsrv%2Fhalvorsen%2Fapp%2Fconfig.json"));
  await refused(f, u("https://example.com/projects/kestrel/home/dev/projects/kestrel"));
  assert.equal((await f.check.check(u("https://example.com/home"))).ok, true, "a page called /home is not a home directory");
});

test("(c) an e-mail address placed only in a URL (path after decoding, query, fragment) or as its user-info", async () => {
  const f = make();
  await refused(f, u("https://example.com/u/jane.doe%40halvorsen.no/"));
  await refused(f, u("https://example.com/search?owner=jane.doe@halvorsen.no"));
  await refused(f, u("https://example.com/docs#jane.doe%40halvorsen.no"));
  await refused(f, u("https://jane.doe:hunter2@example.com/"));
  await refused(f, u("https://jane@example.com/"));
});

test("(d) an internal host name or private address placed only in a URL path, query, fragment — the example from the spec", async () => {
  const f = make();
  await refused(f, u("https://example.com/search/billing.int.kestrel.lan/plans"));
  await refused(f, u("https://example.com/search?host=db1.corp"));
  await refused(f, u("https://example.com/docs#printer.local"));
  await refused(f, u("https://example.com/hosts/10.2.3.4/status"));
  await refused(f, u("https://example.com/hosts/%31%30.2.3.4"));
  // the destination itself: an internal NAME would be sent to a public resolver; an IP literal is not sent anywhere
  await refused(f, u("https://billing.int.kestrel.lan/"));
  await refused(f, u("https://wiki.corp/page"));
  assert.equal((await f.check.check(u("http://192.168.1.20:8080/"))).ok, true, "a private address as the destination reveals nothing to an outsider");
});

test("(e) 6+ words from a private answer placed only in a URL (path words joined by - _ + or %20, query, fragment)", async () => {
  const f = make({ privateAnswers: async () => [PRIVATE_ANSWER] });
  await refused(f, u("https://example.com/signed-a-forty-million-dollar-deal-for-queue"));
  await refused(f, u("https://example.com/signed_a_forty_million_dollar_deal"));
  await refused(f, u("https://example.com/search?q=signed+a+forty+million+dollar+deal"));
  await refused(f, u("https://example.com/docs#signed%20a%20forty%20million%20dollar%20deal"));
  await refused(f, u("https://example.com/a/signed/a/forty/million/dollar/deal"));
  assert.equal((await f.check.check(u("https://example.com/forty-million-dollar-deal"))).ok, true);
});

test("an address that doesn't parse is checked as plain text", async () => {
  const f = make();
  await refused(f, u(`not a url ${SECRET}`));
  assert.equal((await f.check.check(u("example.com/docs/pricing"))).ok, true);
});

// ---- one check for every caller; fail closed; recorded without text ----

test("research_search / research_fetch inputs are checked the same way as the built-in tools", async () => {
  const f = make();
  await refused(f, { sessionID: "ses_a", tool: "research_search", input: { query: `x ${SECRET}` } });
  await refused(f, { sessionID: "ses_a", tool: "research_fetch", input: { url: `https://example.com/${SECRET}` } });
  assert.equal((await f.check.check({ sessionID: "ses_a", tool: "research_search", input: { query: "queue library" } })).ok, true);
});

test("a refusal is recorded with its kind and tool only — never the text", async () => {
  const records = [];
  const f = make({ records });
  await f.check.check(q(`secret ${SECRET}`));
  await f.check.check(u("https://example.com/u/jane%40halvorsen.no"));
  assert.deepEqual(records, [
    { kind: "secret", tool: "websearch" },
    { kind: "email", tool: "webfetch" },
  ]);
  assert.ok(!JSON.stringify(records).includes(SECRET));
});

test("fail closed: an unreadable secrets store, an unavailable scanner, a throwing reader, a malformed request", async () => {
  const unavailable = async (req) => assert.deepEqual(await req, { ok: false, error: CHECK_UNAVAILABLE });
  await unavailable(make({ secrets: "throw" }).check.check(q("clean query")));
  await unavailable(make({ scanner: () => ({ scan: async () => ({ clean: false, unavailable: true, hits: [] }) }) }).check.check(q("clean query")));
  await unavailable(make({ scanner: () => ({ scan: async () => { throw new Error("boom"); } }) }).check.check(q("clean query")));
  await unavailable(make({ privateAnswers: async () => { throw new Error("store down"); } }).check.check(q("a clean query with at least six words")));
  await unavailable(make({ folderOf: async () => { throw new Error("no session"); } }).check.check(q("clean query")));
  await unavailable(make().check.check({ sessionID: "ses_a", tool: "websearch", input: {} }));
  await unavailable(make().check.check({ sessionID: "ses_a", tool: "websearch", input: { query: 5 } }));
  await unavailable(make().check.check({ sessionID: "ses_a", tool: "mystery", input: { query: "x" } }));
  await unavailable(make().check.check(null));
});

test("a stored value shorter than 8 characters is not treated as a secret (the scanner's rule)", async () => {
  const f = make({ secrets: [{ key: "SHORT", scope: "shared", value: "pnpm" }] });
  assert.equal((await f.check.check(q("pnpm workspaces monorepo"))).ok, true);
});

test("AC-1.6: with the web source turned off websearch is refused with the Settings sentence (every session kind: the hook asks this same check); webfetch and research_* are not affected; an unreadable setting fails closed", async () => {
  const records = [];
  const off = make({ webEnabled: async () => false, records });
  assert.deepEqual(await off.check.check(q("postgres job queue library")), { ok: false, error: WEB_OFF });
  assert.equal(WEB_OFF, 'The source "web" is turned off in Settings → Research sources');
  assert.deepEqual(records, [{ kind: "web-off", tool: "websearch" }]);
  assert.equal((await off.check.check(u("https://example.com/docs"))).ok, true);
  assert.equal((await off.check.check({ sessionID: "ses_a", tool: "research_search", input: { query: "queue library" } })).ok, true);
  const on = make({ webEnabled: async () => true });
  assert.equal((await on.check.check(q("postgres job queue library"))).ok, true);
  const broken = make({ webEnabled: async () => { throw new Error("store unreadable"); } });
  assert.deepEqual(await broken.check.check(q("postgres job queue library")), { ok: false, error: CHECK_UNAVAILABLE });
});
