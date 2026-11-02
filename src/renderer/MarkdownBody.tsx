// ===== Markdown renderer =====
//
// react-markdown + remark-gfm (tables, strikethrough, autolinks, task lists).
// Component overrides route fenced code blocks through CodeBlock (Prism), and
// links through ExternalLink so external URLs open in the user's default
// browser rather than navigating the Electron renderer.
//
// Extracted from ChatPanel.tsx (M0.5). Pure leaf module — no dependency on the
// message/tool rendering stack, so it imports cleanly from anywhere.

import { createContext, memo, useContext, useEffect, useMemo, useState } from "react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import type { Components as MarkdownComponents } from "react-markdown";
import { ExternalLink, Linkified, PathCandidate } from "./Linkified";
import { findLinks } from "./linkify";
import { findPaths, findWholePath, parsePathRef } from "./pathLinks";
import { ExplorerOwnerContext } from "./explorer/ownerContext";
import type { MarkdownFileContext } from "./explorer/types";
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

// remark-gfm already links http(s):// and www.; this adds schemeless hosts
// (`mantaui.com/downloads`) in prose. Text inside links, inline code and code
// blocks is left alone.
type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };
const NO_LINKIFY = new Set(["link", "linkReference", "inlineCode", "code", "html", "definition"]);

function linkifyTextNodes(node: MdNode): void {
  const kids = node.children;
  if (!kids || NO_LINKIFY.has(node.type)) return;
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i];
    if (kid.type !== "text" || !kid.value) {
      linkifyTextNodes(kid);
      continue;
    }
    const links = findLinks(kid.value);
    if (links.length === 0) continue;
    const parts: MdNode[] = [];
    let at = 0;
    for (const l of links) {
      if (l.start > at) parts.push({ type: "text", value: kid.value.slice(at, l.start) });
      parts.push({ type: "link", url: l.href, children: [{ type: "text", value: l.text }] });
      at = l.end;
    }
    if (at < kid.value.length) parts.push({ type: "text", value: kid.value.slice(at) });
    kids.splice(i, 1, ...parts);
    i += parts.length - 1;
  }
}

function remarkLinkifySchemeless() {
  return (tree: MdNode) => linkifyTextNodes(tree);
}

// File paths in prose (spec: 2026-11-02-file-explorer.md §Path links). Every
// candidate becomes a `manta-file:` link; the `a` override below only renders
// it as a FileLink once the box confirms the path exists, otherwise it is the
// same plain text as before. Same skip rules as the URL pass (NO_LINKIFY).
const FILE_SCHEME = "manta-file:";

function linkPathTextNodes(node: MdNode): void {
  const kids = node.children;
  if (!kids || NO_LINKIFY.has(node.type)) return;
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i];
    if (kid.type !== "text" || !kid.value) {
      linkPathTextNodes(kid);
      continue;
    }
    const found = findPaths(kid.value);
    if (found.length === 0) continue;
    const parts: MdNode[] = [];
    let at = 0;
    for (const m of found) {
      if (m.start > at) parts.push({ type: "text", value: kid.value.slice(at, m.start) });
      parts.push({
        type: "link",
        url: `${FILE_SCHEME}${encodeURIComponent(m.raw)}`,
        children: [{ type: "text", value: m.raw }],
      });
      at = m.end;
    }
    if (at < kid.value.length) parts.push({ type: "text", value: kid.value.slice(at) });
    kids.splice(i, 1, ...parts);
    i += parts.length - 1;
  }
}

function remarkLinkPaths() {
  return (tree: MdNode) => linkPathTextNodes(tree);
}

// react-markdown drops every scheme outside its allow-list; ours must pass.
function urlTransform(url: string): string {
  return url.startsWith(FILE_SCHEME) ? url : defaultUrlTransform(url);
}

const REMARK_PLUGINS = [remarkGfm, remarkLinkifySchemeless];
const REMARK_PLUGINS_PATHS = [remarkGfm, remarkLinkifySchemeless, remarkLinkPaths];
const REHYPE_PLUGINS_FILE = [rehypeSlug];

// Present only while MarkdownBody renders a FILE in the Explorer: relative
// links and images then go through the viewer instead of the browser.
const MdFileContext = createContext<MarkdownFileContext | null>(null);

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

function MdAnchor({ href, children }: { node?: unknown } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const file = useContext(MdFileContext);
  if (href?.startsWith(FILE_SCHEME)) {
    return <PathCandidate match={parsePathRef(safeDecode(href.slice(FILE_SCHEME.length)))} mono fallback={children} />;
  }
  if (!file || !href || HAS_SCHEME.test(href)) {
    // http(s)/mailto open externally; any other scheme renders as plain text
    // (ExternalLink's own rule, and the same for the transcript).
    return <ExternalLink href={href}>{children}</ExternalLink>;
  }
  return (
    <a
      href={href}
      className="underline"
      style={{ color: "var(--accent-tx)" }}
      onClick={(e) => {
        // Relative file link or `#heading`: navigate the Explorer, never the renderer.
        e.preventDefault();
        e.stopPropagation();
        file.openLink(href);
      }}
    >
      {children}
    </a>
  );
}

const IMG_CLASS = "max-w-full rounded-xs";
const IMG_STYLE = { border: "1px solid var(--border-subtle)" };

function RelativeImage({ src, alt, resolve }: { src: string; alt: string; resolve: MarkdownFileContext["resolveImage"] }) {
  const [loaded, setLoaded] = useState<{ src: string; url: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    resolve(src).then(
      (url) => live && setLoaded({ src, url }),
      () => live && setLoaded({ src, url: null }),
    );
    return () => {
      live = false;
    };
  }, [src, resolve]);
  if (loaded?.src === src && loaded.url) return <img src={loaded.url} alt={alt} className={IMG_CLASS} style={IMG_STYLE} />;
  return <span className="text-text-faint">{alt}</span>;
}

function MdImage({ src, alt }: { node?: unknown } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const file = useContext(MdFileContext);
  const url = typeof src === "string" ? src : undefined;
  if (!file) return <img src={url} alt={alt ?? ""} className={IMG_CLASS} style={IMG_STYLE} />;
  // The box's files only: an external image is never loaded (CSP blocks it
  // anyway), it is a link showing its alt text.
  if (!url) return <>{alt ?? ""}</>;
  if (HAS_SCHEME.test(url)) return <ExternalLink href={url}>{alt || url}</ExternalLink>;
  return <RelativeImage src={url} alt={alt ?? ""} resolve={file.resolveImage} />;
}

// Inline code: unstyled on purpose. URLs inside it become links, and when the
// WHOLE span is a path the box confirms (`src/a.ts:12`, `AGENTS.md`) the span
// holds a FileLink instead — the <code> keeps its styling either way.
function InlineCode({ text }: { text: string }) {
  const owner = useContext(ExplorerOwnerContext);
  const file = useContext(MdFileContext);
  const asPath = owner != null && file == null;
  const match = useMemo(() => (asPath ? findWholePath(text) : null), [text, asPath]);
  const plain = <Linkified text={text} schemeless="whole" />;
  return <code>{match ? <PathCandidate match={match} fallback={plain} /> : plain}</code>;
}

// Hoisted out so component identity is stable — re-rendering on every keystroke
// otherwise causes react-markdown to throw away CodeBlock state (the Highlight
// component would re-tokenize).
const MD_COMPONENTS: MarkdownComponents = {
  // Only ever displayed for INLINE code: fenced blocks are rendered by the
  // `pre` override below from this element's props, never from its output.
  code({ node: _node, children }: {
    node?: unknown;
    children?: React.ReactNode;
  } & React.HTMLAttributes<HTMLElement>) {
    return <InlineCode text={childrenToString(children)} />;
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
  a: MdAnchor,
  // BET-413: real headings restored. MD_COMPONENTS previously downgraded every
  // heading to a <div> at near-body size. The sizes/weights below are the
  // "Balanced" values from the issue; most of the skimmability comes from the
  // space ABOVE, not the size — do not increase the sizes to "make it clearer".
  // These are the ONLY margins MarkdownBody sets (sub-issue 05 removed the
  // rest); they are intentional exceptions because heading spacing is
  // asymmetric and the container `gap` cannot express that. Values are exact
  // px (not on the 4px spacing grid) so they are written as inline styles.
  h1: ({ id, children }) => (
    <h1
      id={id}
      className="text-title font-semibold text-text"
      style={{ marginTop: "22px", marginBottom: "6px", letterSpacing: "-0.01em" }}
    >
      {children}
    </h1>
  ),
  h2: ({ id, children }) => (
    <h2
      id={id}
      className="text-prose font-semibold text-text"
      style={{ marginTop: "18px", marginBottom: "5px" }}
    >
      {children}
    </h2>
  ),
  h3: ({ id, children }) => (
    <h3
      id={id}
      className="text-body font-semibold text-text-muted"
      style={{ marginTop: "14px", marginBottom: "3px" }}
    >
      {children}
    </h3>
  ),
  h4: ({ id, children }) => (
    <h4
      id={id}
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
  // Tables: prose size, --border-subtle rules (BET-413). The size matches the
  // surrounding transcript prose deliberately — at the old `text-meta` (12px)
  // a table read as shrunken chrome next to the 15px paragraphs around it.
  // Cell padding is on the spacing grid rather than the 1px it used to be, so
  // rows stay legible at the larger size. The vertical margin is the same kind
  // of intentional exception as the heading margins above: a bordered block
  // butted straight against the paragraph before and after it reads as cramped,
  // and the container gap alone can't open it up without moving every other
  // block too.
  table: ({ children }) => (
    <div className="overflow-x-auto max-w-full" style={{ marginTop: "14px", marginBottom: "14px" }}>
      <table className="text-prose border-collapse">{children}</table>
    </div>
  ),
  // A GFM table is REQUIRED to have a header row — the `|---|---|` delimiter
  // line is what makes the block a table at all — so the common "just give me a
  // grid of labelled rows" markdown (`|  |  |` on the first line) does not
  // produce a header-less table. It produces a table whose header cells are
  // blank, and remark faithfully emits a <thead> of empty <th>s. Rendered, that
  // is a blank bordered strip sitting above the data, which reads as a
  // rendering bug rather than as a deliberately unlabelled table. When EVERY
  // header cell is empty, drop the <thead> entirely; a partially-filled header
  // is a real header and is left alone.
  thead: ({ children }) =>
    childrenToString(children).trim() === "" ? null : <thead>{children}</thead>,
  th: ({ children }) => (
    <th
      className="px-3 py-1 text-left text-text font-medium bg-bg-soft"
      style={{ border: "1px solid var(--border-subtle)" }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      className="px-3 py-1 text-text"
      style={{ border: "1px solid var(--border-subtle)" }}
    >
      {children}
    </td>
  ),
  // Images: max-width 100%, curved corners, --border-subtle (BET-413).
  img: MdImage,
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
// is a primitive — default shallow comparator works. `fileContext`, when given,
// must be identity-stable (the Explorer viewer memoizes it).
//
// Path links need an Explorer owner (ExplorerOwnerContext) and are off while
// rendering a file in the Explorer (`fileContext`): there, links are the
// document's own and go through `fileContext`.
export const MarkdownBody = memo(function MarkdownBody({
  text,
  fileContext,
}: {
  text: string;
  fileContext?: MarkdownFileContext;
}) {
  const owner = useContext(ExplorerOwnerContext);
  if (text.length > MARKDOWN_MAX_CHARS) {
    // Oversized: bypass markdown + Prism to keep the main thread responsive.
    return (
      <pre className="whitespace-pre-wrap break-words text-code font-mono text-text">
        <Linkified text={text} />
      </pre>
    );
  }
  const body = (
    <ReactMarkdown
      remarkPlugins={owner != null && !fileContext ? REMARK_PLUGINS_PATHS : REMARK_PLUGINS}
      rehypePlugins={fileContext ? REHYPE_PLUGINS_FILE : undefined}
      urlTransform={urlTransform}
      components={MD_COMPONENTS}
    >
      {preprocessForStream(text)}
    </ReactMarkdown>
  );
  return fileContext ? <MdFileContext.Provider value={fileContext}>{body}</MdFileContext.Provider> : body;
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
    <div className="rounded-xs border border-border bg-bg-soft overflow-hidden relative">
      {lang && (
        <div className="px-2 py-px text-micro uppercase text-text-faint border-b border-border bg-bg-elev pr-8">
          {lang}
        </div>
      )}
      <CopyButton
        text={cleaned}
        className="absolute top-1 right-1 z-10 text-micro uppercase text-text-faint hover:text-text px-1 rounded-xs"
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
