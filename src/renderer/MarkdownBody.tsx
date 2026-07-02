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
import { CLAUDE_ORANGE } from "./chatShared";

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
    // Inline `code` — bui's accent color, no box. Block code handled below
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
        style={{ color: CLAUDE_ORANGE }}
        onClick={(e) => {
          if (window.api.openExternal && href) {
            e.preventDefault();
            window.api.openExternal(href);
          }
        }}
        {...rest}
      >
        {children}
      </a>
    );
  },
  h1: ({ children }) => <div className="text-base font-semibold text-text mt-2 mb-1">{children}</div>,
  h2: ({ children }) => <div className="text-sm font-semibold text-text mt-2 mb-1">{children}</div>,
  h3: ({ children }) => <div className="text-sm font-medium text-text mt-2 mb-1">{children}</div>,
  h4: ({ children }) => <div className="text-sm font-medium text-text mt-1 mb-0.5">{children}</div>,
  // Tight list rendering: GFM "loose" lists (blank lines between items)
  // wrap each li's content in a <p>. Without [&_p]:m-0 the inner paragraphs
  // each add an mb, stacking up to large gaps. We collapse those margins
  // inside list items so the visual spacing is driven only by space-y-* on
  // the ul/ol parent.
  ul: ({ children }) => <ul className="my-1 ml-2 list-disc list-inside space-y-0.5 [&_p]:m-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 ml-2 list-decimal list-inside space-y-0.5 [&_p]:m-0">{children}</ol>,
  li: ({ children }) => <li className="text-text">{children}</li>,
  p: ({ children }) => <div className="mb-1 last:mb-0">{children}</div>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 my-1 text-text-muted italic">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="text-[12px] border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border px-2 py-0.5 text-left text-text font-medium bg-bg-soft">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-2 py-0.5 text-text">{children}</td>
  ),
  hr: () => <hr className="my-2 border-border" />,
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
      <pre className="whitespace-pre-wrap break-words text-[13px] text-text">
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

  // Oversized block: render plain (no Prism) to keep the UI responsive.
  const tooLarge =
    cleaned.length > CODEBLOCK_MAX_CHARS ||
    // Counting newlines is O(n) but far cheaper than tokenizing; bail before
    // <Highlight> ever sees a giant body.
    countLines(cleaned) > CODEBLOCK_MAX_LINES;

  return (
    <div className="my-2 rounded border border-border bg-bg-soft overflow-hidden">
      {lang && (
        <div className="px-2 py-0.5 text-[10px] text-text-faint border-b border-border bg-bg-elev">
          {lang}
        </div>
      )}
      {tooLarge ? (
        <pre
          className="px-2 py-1.5 text-[12px] overflow-x-auto whitespace-pre"
          style={{ background: "transparent" }}
        >
          <code>{cleaned}</code>
        </pre>
      ) : (
        <Highlight
          theme={themes.vsDark}
          code={cleaned}
          language={resolved ?? ("text" as Language)}
        >
          {({ tokens, getLineProps, getTokenProps }) => (
            <pre
              className="px-2 py-1.5 text-[12px] overflow-x-auto whitespace-pre"
              // vsDark's default bg would override our bg-bg-soft — disable it.
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
