// outwardPatterns.mjs — the §6.6 step 3 refusal, in code: a skill step that reaches outside the box
// (pushes, deploys, publishes, releases, ssh/scp/rsync, kubectl, fly, anything secret/token, curl/wget
// to a non-local host) keeps the procedure a runbook. The model's judgement is not enough, so this is
// deliberately conservative: when in doubt a command is outward.
//
//   matchOutward(command) → { outward: boolean, reasons: string[] }
//   isOutwardCommand(command) → boolean
//
// Two layers: (1) a word scan over the whole text, so wrappers (`bash -c '…'`, `env X=1 …`, absolute
// paths, `$(…)`, backticks, `xargs`, `eval`) can't hide a word; (2) a shell-aware pass that finds curl/wget
// invocations anywhere in the (recursively unwrapped) command and checks their targets are loopback.

const WORD_RULES = [
  { re: /^(?:ssh|scp|sftp|rsync|kubectl|fly|flyctl)$/, reason: (w) => `uses ${w}` },
  { re: /^(?:un)?(?:publish|deploy|release)/, reason: (w) => `${w} publishes or deploys` },
  { re: /^push(?!d$)/, reason: (w) => `${w} pushes to a remote` },
  { re: /^secret/, reason: () => "touches a secret" },
  { re: /^token/, reason: () => "touches a token" },
];
const MAX_DEPTH = 5;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const CURL_VALUE_FLAGS = new Set([
  "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "-o", "--output", "-X", "--request",
  "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-F", "--form", "-T", "--upload-file", "-m", "--max-time",
  "--connect-timeout", "--retry", "-w", "--write-out", "-K", "--config", "--cacert", "--cert", "--key", "-x", "--proxy", "--resolve", "-r", "--range",
]);
const WGET_VALUE_FLAGS = new Set(["-O", "-P", "-U", "-e", "-a", "-i", "--post-data", "--post-file", "--header", "--user", "--password", "--output-document", "--directory-prefix", "--user-agent", "--timeout", "--tries"]);

const base = (w) => String(w).replace(/^.*\//, "");

/** Split a shell string into segments of words (quotes removed). Command substitutions start new segments. */
export function shellSegments(input) {
  const segments = [];
  let words = [];
  let cur = "";
  let has = false;
  let quote = null;
  const pushWord = () => {
    if (has) words.push(cur);
    cur = "";
    has = false;
  };
  const pushSeg = () => {
    pushWord();
    if (words.length) segments.push(words);
    words = [];
  };
  const s = String(input ?? "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
      has = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
      continue;
    }
    if (c === "$" && s[i + 1] === "(") {
      pushSeg();
      i++;
      continue;
    }
    if (c === "`" || c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")" || c === "{" || c === "}") {
      pushSeg();
      continue;
    }
    if (c === " " || c === "\t") {
      pushWord();
      continue;
    }
    cur += c;
    has = true;
  }
  pushSeg();
  return segments;
}

function hostOf(target) {
  let t = String(target).trim();
  if (t === "") return null;
  t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  t = t.replace(/^[^@/]*@/, "");
  if (t.startsWith("[")) return t.slice(1, t.indexOf("]") > 0 ? t.indexOf("]") : undefined).toLowerCase();
  t = t.split(/[/?#]/)[0];
  t = t.replace(/:\d*$/, "");
  return t.toLowerCase();
}

const isLocalHost = (h) => h !== null && (LOCAL_HOSTS.has(h) || h.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(h));

/** Targets of a curl/wget invocation: the words after the command that aren't flags or flag values. */
function netTargets(args, valueFlags) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url") {
      if (args[i + 1] !== undefined) out.push(args[++i]);
      continue;
    }
    if (/^--url=/.test(a)) {
      out.push(a.slice(6));
      continue;
    }
    if (a.startsWith("-")) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function analyze(text, depth, reasons) {
  if (depth > MAX_DEPTH) {
    reasons.add("is nested too deeply to check");
    return;
  }
  for (const words of shellSegments(text)) {
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (/\s/.test(w) && w.length > 1) analyze(w, depth + 1, reasons); // `bash -c '…'`, `eval "…"`, quoted payloads
      const name = base(w).toLowerCase();
      if (name === "curl" || name === "wget") {
        const targets = netTargets(words.slice(i + 1), name === "curl" ? CURL_VALUE_FLAGS : WGET_VALUE_FLAGS);
        if (targets.length === 0) reasons.add(`${name} with no target we can check`);
        for (const t of targets) {
          const host = /^[$`]/.test(t) ? null : hostOf(t);
          if (host === null || host === "" || !isLocalHost(host)) reasons.add(`${name} to ${host ? host : "a host we can't determine"}`);
        }
      }
    }
  }
}

/**
 * Is `command` an outward action? `reasons` says why (empty when it is local).
 */
export function matchOutward(command) {
  const text = String(command ?? "");
  const reasons = new Set();
  const seen = new Set();
  for (const token of text.toLowerCase().split(/[^a-z]+/)) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    for (const r of WORD_RULES) if (r.re.test(token)) reasons.add(r.reason(token));
  }
  // `.ssh` / `ssh://` style mentions are caught by the same split; env-var spellings (GITHUB_TOKEN) too.
  analyze(text, 0, reasons);
  return { outward: reasons.size > 0, reasons: [...reasons] };
}

export const isOutwardCommand = (command) => matchOutward(command).outward;
