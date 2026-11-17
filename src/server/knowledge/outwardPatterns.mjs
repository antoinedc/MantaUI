// outwardPatterns.mjs — the §6.6 step 3 refusal, in code: a skill step that reaches outside the box
// (pushes, deploys, publishes, releases, ssh/scp/rsync, kubectl, fly, anything secret/token, curl/wget
// to a non-local host) keeps the procedure a runbook. The model's judgement is not enough, so this is
// deliberately conservative: when in doubt a command is outward.
//
//   matchOutward(command) → { outward: boolean, reasons: string[] }
//   isOutwardCommand(command) → boolean
//
// Three layers: (0) every word shellSegments produces (quotes/escapes resolved) is checked, whole or split,
// against the word rules and the outward-tool list; (1) a word scan over the whole text, so wrappers (`bash -c '…'`, `env X=1 …`, absolute
// paths, `$(…)`, backticks, `xargs`, `eval`) can't hide a word; (2) a shell-aware pass that finds curl/wget
// invocations anywhere in the (recursively unwrapped) command and checks their targets are loopback.

// Substrings of a (split) word: `deploy.sh`, `--token=x`, `GITHUB_TOKEN`.
const WORD_RULES = [
  { re: /^(?:ssh|scp|sftp|rsync|kubectl|fly|flyctl)$/, reason: (w) => `uses ${w}` },
  { re: /^(?:un)?(?:publish|deploy|release)/, reason: (w) => `${w} publishes or deploys` },
  { re: /^push(?!d$)/, reason: (w) => `${w} pushes to a remote` },
  { re: /^secret/, reason: () => "touches a secret" },
  { re: /^token/, reason: () => "touches a token" },
];
// Whole words (or basenames): tools that talk to the outside world. Only matched against a complete word,
// never a split token, so `curl http://localhost` isn't caught by `http`.
const TOOL_RE = /^(?:gh|glab|aws|gcloud|az|gsutil|nc|ncat|netcat|socat|ftp|http|https|terraform|helm|vercel|netlify|heroku)$/;
const INTERPRETER_RE = /^(?:python[\d.]*|pypy[\d]*|node|nodejs|deno|bun|ruby|perl|php|lua)$/;
const INLINE_CODE_FLAG = /^(?:-[A-Za-z]*[ceEp][A-Za-z]*|--eval|--print|--command)$/;
const MAX_DEPTH = 5;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const CURL_VALUE_FLAGS = new Set([
  "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "-o", "--output", "-X", "--request",
  "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-F", "--form", "-T", "--upload-file", "-m", "--max-time",
  "--connect-timeout", "--retry", "-w", "--write-out", "-K", "--config", "--cacert", "--cert", "--key", "-x", "--proxy", "--resolve", "-r", "--range",
  "--connect-to", "--preproxy", "--socks4", "--socks4a", "--socks5", "--socks5-hostname", "--doh-url", "--interface",
]);
const CURL_PROXY_FLAGS = new Set(["-x", "--proxy", "--preproxy", "--socks4", "--socks4a", "--socks5", "--socks5-hostname", "--doh-url"]);
const CURL_REDIRECT_FLAGS = new Set(["--resolve", "--connect-to"]);
const CURL_CONFIG_FLAGS = new Set(["-K", "--config"]);
const WGET_VALUE_FLAGS = new Set(["-O", "-P", "-U", "-e", "-a", "-i", "-B", "--post-data", "--post-file", "--header", "--user", "--password", "--output-document", "--directory-prefix", "--user-agent", "--timeout", "--tries", "--input-file", "--execute", "--base", "--bind-address"]);
const WGET_OPAQUE_FLAGS = new Set(["-i", "--input-file", "-e", "--execute", "-B", "--base"]);

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

const portLike = (p) => /^\d*$/.test(p);
const allLocal = (value) => {
  const parts = String(value).split(":").filter((p) => p !== "" && !portLike(p));
  return parts.length > 0 && parts.every((p) => isLocalHost(p.toLowerCase().replace(/^\[|\]$/g, "")));
};

/**
 * Targets of a curl/wget invocation (the words after the command that aren't flags or flag values), plus
 * `reasons` for options that point the request somewhere the target alone doesn't show (proxies, resolve/connect-to
 * redirects, config files, input files).
 */
function netTargets(args, name) {
  const valueFlags = name === "curl" ? CURL_VALUE_FLAGS : WGET_VALUE_FLAGS;
  const targets = [];
  const reasons = [];
  const option = (flag, value) => {
    if (name === "curl") {
      if (CURL_CONFIG_FLAGS.has(flag)) reasons.push(`${name} ${flag} reads URLs from a config file`);
      else if (CURL_PROXY_FLAGS.has(flag)) {
        const host = hostOf(value ?? "");
        if (host === null || !isLocalHost(host)) reasons.push(`${name} ${flag} goes through ${host || "a proxy we can't determine"}`);
      } else if (CURL_REDIRECT_FLAGS.has(flag) && !allLocal(value ?? "")) reasons.push(`${name} ${flag} points at ${value || "an address we can't determine"}`);
    } else if (WGET_OPAQUE_FLAGS.has(flag)) reasons.push(`${name} ${flag} takes its targets or commands from elsewhere`);
    else if (flag === "--proxy" || flag === "-Y") reasons.push(`${name} ${flag} goes through a proxy`);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url") {
      if (args[i + 1] !== undefined) targets.push(args[++i]);
      continue;
    }
    if (/^--url=/.test(a)) {
      targets.push(a.slice(6));
      continue;
    }
    const long = /^(--[a-z0-9-]+)=(.*)$/s.exec(a);
    if (long) {
      option(long[1], long[2]);
      continue;
    }
    if (a.startsWith("--")) {
      if (valueFlags.has(a)) {
        option(a, args[i + 1]);
        i++;
      } else option(a, undefined);
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      const short = a.slice(0, 2);
      if (a.length > 2 && valueFlags.has(short)) option(short, a.slice(2)); // `-xhost:3128`
      else if (valueFlags.has(a)) {
        option(a, args[i + 1]);
        i++;
      } else if (name === "curl" && /^-[a-zA-Z]+$/.test(a) && a.includes("K")) reasons.push(`${name} -K reads URLs from a config file`);
      else if (name === "curl" && /^-[a-zA-Z]+x$/.test(a)) {
        option("-x", args[i + 1]);
        i++;
      } else option(a, undefined);
      continue;
    }
    targets.push(a);
  }
  return { targets, reasons };
}

const wordNames = (w) => {
  const lower = String(w).toLowerCase();
  return [...new Set([lower, lower.includes("://") ? lower : base(lower)])];
};

const GIT_NETWORK_SUBCOMMANDS = new Set(["clone", "ls-remote", "fetch", "pull"]);

/** Is this word an explicit remote URL that isn't this machine (https://…, ssh://…, git@host:path)? */
function isRemoteUrlWord(w) {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(w);
  if (scheme) {
    if (scheme[1].toLowerCase() === "file") return false;
    const host = hostOf(w);
    return host === null || host === "" || !isLocalHost(host);
  }
  const scp = /^(?:[^\s/@:]+@)?([^\s/@:]+):(?!\/\/)\S/.exec(w);
  return scp !== null && !isLocalHost(scp[1].toLowerCase()) && /@/.test(w);
}

/** Reasons from git's own options and network subcommands: `git -c x=y` can run commands; clone/fetch/pull/ls-remote of a URL reach out. */
function gitOptionReasons(words, i, reasons) {
  let sub = -1;
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j];
    if (!w.startsWith("-")) {
      sub = j;
      break;
    }
    if (w === "-c" || (w.startsWith("-c") && !w.startsWith("--")) || w === "--config-env" || w.startsWith("--config-env=")) {
      reasons.add("git -c can run commands or reach remotes through configuration");
      return;
    }
    if (w === "-C" || w === "--git-dir" || w === "--work-tree" || w === "--namespace") j++;
  }
  if (sub >= 0 && GIT_NETWORK_SUBCOMMANDS.has(words[sub].toLowerCase())) {
    const url = words.slice(sub + 1).find(isRemoteUrlWord);
    if (url) reasons.add(`git ${words[sub]} reaches ${hostOf(url) || url}`);
  }
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
      // Words come out of shellSegments with quotes and escapes resolved, so `pu""sh`, `s\sh` and `git pu\sh` are
      // the plain words here, even though the raw text hides them.
      for (const n of wordNames(w)) {
        if (TOOL_RE.test(n)) reasons.add(`uses ${n}`);
        for (const token of n.split(/[^a-z]+/)) for (const r of WORD_RULES) if (token && r.re.test(token)) reasons.add(r.reason(token));
      }
      const name = base(w).toLowerCase();
      if (name === "curl" || name === "wget") {
        const { targets, reasons: extra } = netTargets(words.slice(i + 1), name);
        for (const e of extra) reasons.add(e);
        if (targets.length === 0 && extra.length === 0) reasons.add(`${name} with no target we can check`);
        for (const t of targets) {
          const host = /^[$`]/.test(t) ? null : hostOf(t);
          if (host === null || host === "" || !isLocalHost(host)) reasons.add(`${name} to ${host ? host : "a host we can't determine"}`);
        }
      } else if (name === "git") gitOptionReasons(words, i, reasons);
      else if (INTERPRETER_RE.test(name)) {
        if (words.slice(i + 1).some((a) => INLINE_CODE_FLAG.test(a) || /^--(?:eval|print|command)=/.test(a))) reasons.add(`${name} runs inline code we can't check`);
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
  if (/\/dev\/(?:tcp|udp)\b/i.test(text)) reasons.add("opens a network connection through /dev/tcp or /dev/udp");
  // `.ssh` / `ssh://` style mentions are caught by the same split; env-var spellings (GITHUB_TOKEN) too.
  analyze(text, 0, reasons);
  return { outward: reasons.size > 0, reasons: [...reasons] };
}

export const isOutwardCommand = (command) => matchOutward(command).outward;
