// ctoToolCatalog.mjs — the §7 pattern catalog (BET-1395).
//
// The Adaptive CTO discovers the user's external tools generically: NO tool
// list ships with the system. This module ships the small *pattern catalog*
// the spec allows — "domain → tool-identity heuristics, issue-key regex
// shapes, CLI name list" — purely to LABEL evidence. The catalog labels; it
// never assumes presence (an entry here does not create a registry row; only
// observed evidence does). Anything the catalog doesn't recognize stays raw
// and goes through the LLM-classification fallback once (ctoToolRegistry).
//
// Pure data + pure matchers — no fs, no clock, no I/O.

// ---------------------------------------------------------------------------
// CLI catalog (channel 2). Keys are the FIRST token of a bash command; values
// are canonical tool identities (the registry's `tool` field). Only
// external-service CLIs are listed: plain dev-environment commands (git, npm,
// cargo, python …) are the user's own local toolchain, not external tools,
// and would drown the registry in noise — they live in LOCAL_CLIS and are
// never collected as evidence.
// ---------------------------------------------------------------------------

export const CLIS = Object.freeze({
  gh: "github",
  glab: "gitlab",
  aws: "aws",
  gcloud: "gcp",
  az: "azure",
  doctl: "digitalocean",
  flyctl: "flyio",
  fly: "flyio",
  vercel: "vercel",
  netlify: "netlify",
  wrangler: "cloudflare",
  railway: "railway",
  render: "render",
  heroku: "heroku",
  supabase: "supabase",
  firebase: "firebase",
  stripe: "stripe",
  sentry: "sentry-cli",
  linear: "linear",
  slack: "slack",
  notion: "notion",
  twilio: "twilio",
  shopify: "shopify",
  atlas: "mongodb-atlas",
  psql: "postgres",
  mysql: "mysql",
  redis: "redis",
});

// First tokens that are the user's own local environment — never external
// evidence, never LLM-classified.
export const LOCAL_CLIS = Object.freeze(
  new Set([
    "ls", "cd", "pwd", "cat", "echo", "grep", "rg", "sed", "awk", "head", "tail",
    "wc", "sort", "uniq", "find", "mkdir", "touch", "cp", "mv", "rm", "rmdir",
    "chmod", "chown", "ln", "tar", "zip", "unzip", "curl", "wget",
    "git", "npm", "npx", "pnpm", "yarn", "bun", "node", "deno", "python",
    "python3", "pip", "pip3", "uv", "cargo", "rustc", "go", "java", "javac",
    "make", "cmake", "gcc", "clang", "tsc", "eslint", "prettier", "vitest",
    "jest", "pytest", "sh", "bash", "zsh", "fish", "which", "env", "export",
    "set", "source", "man", "less", "more", "diff", "patch", "date", "sleep",
    "true", "false", "test", "printf", "xargs", "tee", "basename", "dirname",
    "readlink", "stat", "du", "df", "ps", "kill", "killall", "nohup", "history",
    "apt", "apt-get", "brew", "ssh", "scp", "rsync", "tmux", "systemctl",
    "journalctl", "sudo", "crontab", "nc", "netstat", "ss", "ping", "dig",
  ]),
);

// ---------------------------------------------------------------------------
// Domain catalog (channels 2+3). Keys are DNS suffixes (matched on exact host
// or dot-suffix); values are canonical identities.
// ---------------------------------------------------------------------------

export const DOMAINS = Object.freeze({
  "github.com": "github",
  "githubusercontent.com": "github",
  "githubassets.com": "github",
  "gitlab.com": "gitlab",
  "amazonaws.com": "aws",
  "aws.amazon.com": "aws",
  "azure.com": "azure",
  "azurewebsites.net": "azure",
  "googleapis.com": "gcp",
  "firebaseio.com": "firebase",
  "firebaseapp.com": "firebase",
  "cloud.google.com": "gcp",
  "digitaloceanspaces.com": "digitalocean",
  "fly.io": "flyio",
  "vercel.com": "vercel",
  "vercel.app": "vercel",
  "api.vercel.com": "vercel",
  "netlify.com": "netlify",
  "netlify.app": "netlify",
  "workers.dev": "cloudflare",
  "railway.app": "railway",
  "onrender.com": "render",
  "herokuapp.com": "heroku",
  "supabase.co": "supabase",
  "supabase.com": "supabase",
  "stripe.com": "stripe",
  "glitch.com": "glitch",
  "linear.app": "linear",
  "api.linear.app": "linear",
  "slack.com": "slack",
  "hooks.slack.com": "slack",
  "notion.so": "notion",
  "api.notion.com": "notion",
  "sentry.io": "sentry",
  "sentry.dev": "sentry",
  "twilio.com": "twilio",
  "shopify.com": "shopify",
  "myshopify.com": "shopify",
  "mongodb.net": "mongodb-atlas",
  "planetscale.com": "planetscale",
  "neon.tech": "neon",
  "cloud.mongodb.com": "mongodb-atlas",
  "atlassian.net": "atlassian",
  "jira.com": "jira",
  "figma.com": "figma",
  "npmjs.com": "npm",
  "pypi.org": "pypi",
  "docker.io": "docker",
  "ghcr.io": "github",
  "anthropic.com": "anthropic",
  "openai.com": "openai",
  "groq.com": "groq",
  "deepseek.com": "deepseek",
  "mistral.ai": "mistral",
  "x.ai": "xai",
  "huggingface.co": "huggingface",
  "upstash.io": "upstash",
  "pusher.com": "pusher",
  "ably.com": "ably",
  "auth0.com": "auth0",
  "clerk.dev": "clerk",
  "resend.com": "resend",
  "sendgrid.net": "sendgrid",
  "mailgun.org": "mailgun",
  "postmarkapp.com": "postmark",
  "tiptap.dev": "tiptap",
  "sanity.io": "sanity",
  "contentful.com": "contentful",
  "prisma.io": "prisma",
  "turso.tech": "turso",
  "xata.io": "xata",
});

// This box's own infrastructure (gateway/DNS/etc.) — never external evidence.
export const BOX_DOMAINS = Object.freeze(new Set(["mantaui.com", "antoinedc.com", "localhost"]));

// Hosts that are not evidence even in raw form: loopback, RFC1918, link-local,
// bare IPs, and dotless names.
const IP_SHAPE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// ---------------------------------------------------------------------------
// Issue-key shape (channel 2). One regex SHAPE per the spec ("issue-key regex
// shapes"): TEAM-123 tokens as they appear in branch names and commit
// subjects. Which tracker a specific prefix belongs to (Linear, Jira, this
// Multica workspace …) is exactly what the catalog CANNOT know — the raw
// keys are collected as evidence and the LLM fallback classifies the source
// at most once. §7 intro: "The catalog labels; it never assumes presence."
// ---------------------------------------------------------------------------

export const KEY_SHAPE = /\b[A-Z][A-Z0-9]{1,5}-\d{1,6}\b/g;

// Human display names for identities we catalog (§7.2 displayName). Anything
// absent falls back to capitalize-first-letter of the identity.
export const DISPLAY = Object.freeze({
  github: "GitHub",
  gitlab: "GitLab",
  aws: "AWS",
  gcp: "Google Cloud",
  azure: "Azure",
  digitalocean: "DigitalOcean",
  flyio: "Fly.io",
  vercel: "Vercel",
  netlify: "Netlify",
  cloudflare: "Cloudflare",
  railway: "Railway",
  render: "Render",
  heroku: "Heroku",
  supabase: "Supabase",
  firebase: "Firebase",
  stripe: "Stripe",
  "sentry-cli": "Sentry",
  sentry: "Sentry",
  linear: "Linear",
  slack: "Slack",
  notion: "Notion",
  twilio: "Twilio",
  shopify: "Shopify",
  "mongodb-atlas": "MongoDB Atlas",
  postgres: "Postgres",
  mysql: "MySQL",
  redis: "Redis",
  atlassian: "Atlassian",
  jira: "Jira",
  figma: "Figma",
  npm: "npm",
  pypi: "PyPI",
  docker: "Docker Hub",
  anthropic: "Anthropic API",
  openai: "OpenAI API",
  groq: "Groq API",
  deepseek: "DeepSeek API",
  mistral: "Mistral API",
  xai: "xAI API",
  huggingface: "Hugging Face",
  planetscale: "Planetscale",
  neon: "Neon",
  auth0: "Auth0",
  clerk: "Clerk",
  resend: "Resend",
  sendgrid: "SendGrid",
  mailgun: "Mailgun",
  postmark: "Postmark",
  sanity: "Sanity",
  contentful: "Contentful",
  prisma: "Prisma Data",
  turso: "Turso",
  xata: "Xata",
  upstash: "Upstash",
  pusher: "Pusher",
  ably: "Ably",
});

// ---------------------------------------------------------------------------
// Matchers (pure)
// ---------------------------------------------------------------------------

// First-token CLI match → identity string (catalog), null (unknown → raw
// candidate for the LLM fallback), or the sentinel "local" (never evidence).
export function matchCliIdentity(firstToken) {
  const t = String(firstToken ?? "").toLowerCase();
  if (!t) return null;
  if (LOCAL_CLIS.has(t)) return "local";
  const id = CLIS[t];
  return id ?? null;
}

function isPrivateHost(host) {
  const h = String(host ?? "").toLowerCase();
  if (!h || !h.includes(".")) return true; // dotless = localhost-ish
  if (IP_SHAPE.test(h)) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".home.arpa")
  ) {
    return true;
  }
  // RFC1918 / loopback / link-local via the IP shape above is exact; also
  // reject the .svc/.cluster.local k8s shapes.
  if (h.endsWith(".svc") || h.endsWith(".cluster.local")) return true;
  return false;
}

// Host match → identity string (catalog suffix match), null (unknown host →
// raw candidate), or undefined (host must NOT be collected at all).
export function matchDomainIdentity(host) {
  const h = String(host ?? "").toLowerCase().trim().replace(/\.$/, "");
  if (!h || isPrivateHost(h)) return undefined;
  for (const [suffix, id] of Object.entries(DOMAINS)) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return id;
  }
  for (const box of BOX_DOMAINS) {
    if (h === box || h.endsWith(`.${box}`)) return undefined;
  }
  return null;
}

// Issue-key tokens found in free text (branch names, commit subjects).
// Deduplicated, order-preserved.
export function matchIssueKeys(text) {
  const t = String(text ?? "");
  if (!t) return [];
  const out = [];
  const seen = new Set();
  for (const m of t.matchAll(KEY_SHAPE)) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
  }
  return out;
}

// Human display name for a canonical identity (§7.2 displayName).
export function displayName(identity) {
  const id = String(identity ?? "").trim();
  if (!id) return "";
  if (DISPLAY[id]) return DISPLAY[id];
  return id.charAt(0).toUpperCase() + id.slice(1);
}
