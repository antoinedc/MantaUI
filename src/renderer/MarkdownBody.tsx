// ===== Markdown renderer =====
//
// react-markdown + remark-gfm (tables, strikethrough, autolinks, task lists).
// Component overrides route fenced code blocks through CodeBlock (Prism), and
// links through window.api.openExternal so external URLs open in the user's
// default browser rather than navigating the Electron renderer.
//
// Extracted from ChatPanel.tsx (M0.5). Pure leaf module — no dependency on the
// message/tool rendering stack, so it imports cleanly from anywhere.

import { memo } from "react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components as MarkdownComponents } from "react-markdown";
import { getMantaPreload } from "./preloadAccess";
import { CopyButton } from "./CopyButton";
import { useResolvedTheme } from "./theme";

// Streamed-fence resilience: while a code block is still streaming, the
// closing ``` hasn't arrived yet. Without a recovery step, remark sees the
// fence as "no language, body until end of message" and renders the prose
// after it as monospace. We pad with a closing fence on a tail-truncation
// heuristic so the in-flight block renders as code but the trailing text
// (which may not exist yet) doesn't get swallowed.
export function preprocessForStream(text: string): string {
  // Count unescaped triple-backticks. Odd count means an unclosed fence —
  // append a synthetic close so the parser balances. This is purely a
  // streaming-display convenience; the final message will be even and skip
  // this branch.
  const matches = text.match(/```/g);
  if (matches && matches.length % 2 === 1) return text + "\n```";
  return text;
}

export function renderMarkdown(text: string): React.ReactNode {
  return <MarkdownBody text={text} />;
}

// Hoisted out so component identity is stable — re-rendering on every keystroke
// otherwise causes react-markdown to throw away CodeBlock state (the Highlight
// component would re-tokenize).
const MD_COMPONENTS: MarkdownComponents = {
  code({ inline, className, children, ...rest }: {
    inline?: boolean;
    className?: string;
    children?: React.ReactNode;
  } & React.HTMLAttributes<HTMLElement>) {
    // Inline `code` — manta's accent color, no box. Block code handled below
    // by wrapping pre.
    if (inline) {
      return (
        <code className="font-mono text-accent" {...rest}>
          {children}
        </code>
      );
    }
    // Block code: defer to the <pre> override which will pull lang from
    // className "language-xxx".
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
  pre({ children }: { children?: React.ReactNode }) {
    // Pull the language + body out of the nested <code className="language-x">.
    // react-markdown nests code inside pre for fenced blocks.
    const child = Array.isArray(children) ? children[0] : children;
    if (child && typeof child === "object" && "props" in child) {
      const codeProps = (child as { props: { className?: string; children?: React.ReactNode } }).props;
      const cls = codeProps.className ?? "";
      const lang = cls.match(/language-([\w-]+)/)?.[1];
      const body = childrenToString(codeProps.children);
      return <CodeBlock lang={lang} body={body} />;
    }
    return <pre>{children}</pre>;
  },
  a({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="underline"
        style={{ color: "var(--accent-tx)" }}
        onClick={(e) => {
          const preload = getMantaPreload();
          if (preload && href) {
            e.preventDefault();
            preload.openExternal(href);
          }
        }}
        {...rest}
      >
        {children}
      </a>
    );
  },
  // BET-413: real headings restored. MD_COMPONENTS previously downgraded every
  // heading to a <div> at near-body size. The sizes/weights below are the
  // "Balanced" values from the issue; most of the skimmability comes from the
  // space ABOVE, not the size — do not increase the sizes to "make it clearer".
  // These are the ONLY margins MarkdownBody sets (sub-issue 05 removed the
  // rest); they are intentional exceptions because heading spacing is
  // asymmetric and the container `gap` cannot express that. Values are exact
  // px (not on the 4px spacing grid) so they are written as inline styles.
  h1: ({ children }) => (
    <h1
      className="text-title font-semibold text-text"
      style={{ marginTop: "22px", marginBottom: "6px", letterSpacing: "-0.01em" }}
    >
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2
      className="text-prose font-semibold text-text"
      style={{ marginTop: "18px", marginBottom: "5px" }}
    >
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3
      className="text-body font-semibold text-text-muted"
      style={{ marginTop: "14px", marginBottom: "3px" }}
    >
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4
      className="text-body font-semibold text-text-muted"
      style={{ marginTop: "14px", marginBottom: "3px" }}
    >
      {children}
    </h4>
  ),
  // Tight list rendering: GFM "loose" lists (blank lines between items)
  // wrap each li's content in a <p>. [&_p]:m-0 collapses those inner
  // paragraphs so the visual spacing is driven only by space-y-* on the
  // ul/ol parent. The list's own spacing to its siblings is the turn gap.
  // Lists inherit the prose size from the transcript column (BET-413).
  ul: ({ children }) => <ul className="ml-2 list-disc list-inside space-y-px [&_p]:m-0">{children}</ul>,
  ol: ({ children }) => <ol className="ml-2 list-decimal list-inside space-y-px [&_p]:m-0">{children}</ol>,
  li: ({ children }) => <li className="text-text">{children}</li>,
  p: ({ children }) => <div>{children}</div>,
  blockquote: ({ children }) => (
    <blockquote
      className="pl-3 italic"
      style={{ borderLeft: "2px solid var(--border)", color: "var(--tx2)" }}
    >
      {children}
    </blockquote>
  ),
  // Tables: meta size, --border-subtle rules (BET-413).
  table: ({ children }) => (
    <div className="overflow-x-auto max-w-full">
      <table className="text-meta border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th
      className="px-2 py-px text-left text-text font-medium bg-bg-soft"
      style={{ border: "1px solid var(--border-subtle)" }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      className="px-2 py-px text-text"
      style={{ border: "1px solid var(--border-subtle)" }}
    >
      {children}
    </td>
  ),
  // Images: max-width 100%, rounded, --border-subtle (BET-413).
  img: ({ src, alt }) => (
    <img
      src={typeof src === "string" ? src : undefined}
      alt={alt ?? ""}
      className="max-w-full rounded"
      style={{ border: "1px solid var(--border-subtle)" }}
    />
  ),
  hr: () => <hr className="border-border" />,
};

// Above this many characters, skip the react-markdown AST parse entirely and
// render the text as a plain <pre>. Parsing + rendering a very large markdown
// body (a pasted log, a huge model dump) is synchronous and can block the main
// thread for seconds — and it re-runs whenever the row's memo is defeated (e.g.
// a full-transcript refetch swaps in fresh part objects). A multi-second freeze
// is far worse than losing markdown formatting on an unusually large message.
const MARKDOWN_MAX_CHARS = 50_000;

// Memoized so re-rendering a parent (AssistantPart, MessageRow) whose
// own props/state haven't changed doesn't re-parse the markdown AST
// and re-tokenize Prism inside CodeBlock. `text` is the only prop and
// is a primitive — default shallow comparator works.
export const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  if (text.length > MARKDOWN_MAX_CHARS) {
    // Oversized: bypass markdown + Prism to keep the main thread responsive.
    return (
      <pre className="whitespace-pre-wrap break-words text-code font-mono text-text">
        {text}
      </pre>
    );
  }
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {preprocessForStream(text)}
    </ReactMarkdown>
  );
});

// react-markdown passes children as ReactNode (array of strings/elements). For
// code blocks we want a plain string so Prism can tokenize. Walk the tree.
function childrenToString(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childrenToString).join("");
  if (typeof node === "object" && "props" in node) {
    return childrenToString((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

// Map common language tags to Prism's canonical names. Prism doesn't recognize
// some bare extensions (e.g. "rs", "yml") — alias them so highlight works.
// Unknown langs render as plain monospace via the noop fallback below.
const PRISM_LANG_ALIAS: Record<string, Language> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  rs: "rust",
  rb: "ruby",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  yml: "yaml",
  md: "markdown",
  mdx: "markdown",
  proto: "protobuf",
  dockerfile: "docker",
  html: "markup",
  xml: "markup",
  svg: "markup",
  c: "c",
  cpp: "cpp",
  go: "go",
  java: "java",
  json: "json",
  css: "css",
  scss: "scss",
  sql: "sql",
  toml: "toml",
};

const PRISM_SUPPORTED: ReadonlySet<string> = new Set<Language>([
  "markup",
  "bash",
  "clike",
  "c",
  "cpp",
  "css",
  "javascript",
  "jsx",
  "coffeescript",
  "actionscript",
  "css-extras",
  "diff",
  "git",
  "go",
  "graphql",
  "handlebars",
  "json",
  "less",
  "makefile",
  "markdown",
  "objectivec",
  "ocaml",
  "python",
  "reason",
  "sass",
  "scss",
  "sql",
  "stylus",
  "tsx",
  "typescript",
  "wasm",
  "yaml",
] as Language[]);

// Above either bound, skip Prism tokenization and render the raw code in a
// plain <pre>. Prism's <Highlight> tokenizes the WHOLE body synchronously on
// render (and is superlinear for some grammars); a large pasted file / log /
// diff can block the main thread for seconds, and it re-runs every time the
// row memo is defeated (e.g. a full-transcript refetch). Syntax colors aren't
// worth a multi-second freeze on a giant block.
const CODEBLOCK_MAX_CHARS = 30_000;
const CODEBLOCK_MAX_LINES = 2_000;

export const CodeBlock = memo(function CodeBlock({ lang, body }: { lang?: string; body: string }) {
  // Trim a single trailing newline that almost always precedes the closing fence.
  const cleaned = body.replace(/\n$/, "");
  const normalized = (lang ?? "").toLowerCase();
  // Resolve alias → canonical Prism Language, falling back to a no-op token
  // mode if Prism doesn't know it (preserves spacing without throwing).
  const resolved: Language | undefined =
    PRISM_LANG_ALIAS[normalized] ??
    (PRISM_SUPPORTED.has(normalized) ? (normalized as Language) : undefined);

  // BET-409: pick the Prism theme for the resolved app theme. vsDark in dark,
  // github in light. The hook re-renders this memoized block live when the
  // theme flips (OS change in system mode, or a Settings switch) so existing
  // code blocks re-tint without a transcript refetch. Background is forced
  // transparent below in both themes so bg-bg-soft shows through.
  const resolvedTheme = useResolvedTheme();
  const prismTheme = resolvedTheme === "light" ? themes.github : themes.vsDark;

  // Oversized block: render plain (no Prism) to keep the UI responsive.
  const tooLarge =
    cleaned.length > CODEBLOCK_MAX_CHARS ||
    // Counting newlines is O(n) but far cheaper than tokenizing; bail before
    // <Highlight> ever sees a giant body.
    countLines(cleaned) > CODEBLOCK_MAX_LINES;

  return (
    <div className="rounded border border-border bg-bg-soft overflow-hidden relative">
      {lang && (
        <div className="px-2 py-px text-micro uppercase text-text-faint border-b border-border bg-bg-elev pr-8">
          {lang}
        </div>
      )}
      <CopyButton
        text={cleaned}
        className="absolute top-1 right-1 z-10 text-micro uppercase text-text-faint hover:text-text px-1 rounded"
      />
      {tooLarge ? (
        <pre
          className="px-2 py-2 pr-8 text-code font-mono overflow-x-auto max-w-full whitespace-pre"
          style={{ background: "transparent" }}
        >
          <code>{cleaned}</code>
        </pre>
      ) : (
        <Highlight
          theme={prismTheme}
          code={cleaned}
          language={resolved ?? ("text" as Language)}
        >
          {({ tokens, getLineProps, getTokenProps }) => (
            <pre
              className="px-2 py-2 pr-8 text-code font-mono overflow-x-auto max-w-full whitespace-pre"
              // The Prism theme's default bg would override bg-bg-soft — disable
              // it in both themes so the card surface shows through.
              style={{ background: "transparent" }}
            >
              <code>
                {tokens.map((line, i) => (
                  <div key={i} {...getLineProps({ line })}>
                    {line.map((token, key) => (
                      <span key={key} {...getTokenProps({ token })} />
                    ))}
                  </div>
                ))}
              </code>
            </pre>
          )}
        </Highlight>
      )}
    </div>
  );
});

// Count newlines without allocating an array (cheap O(n) line count for the
// CodeBlock size guard — body.split("\n").length would allocate a huge array
// for exactly the inputs we're trying to avoid touching).
function countLines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}
