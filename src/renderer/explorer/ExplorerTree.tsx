// ExplorerTree.tsx — the Explorer's file tree (spec §Tree, contract E4) on
// @headless-tree/react: async per-folder children from `fs:list`, git badges
// from `fs:git-status`, keyboard + ARIA from the library, chrome from us.
//
// Rows are the server's entries in the order it returned them (folders first,
// natural order). Two pseudo-children carry non-file facts as the last row of a
// folder: "N more not shown" (truncated listing) and a folder that could not
// be read. Their ids contain a NUL byte so they can never collide with a path.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { asyncDataLoaderFeature, hotkeysCoreFeature, type ItemInstance } from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import type { FsEntry, FsGitBadge, FsReason } from "../../shared/fsTypes";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { MOD_KEY } from "../platform";
import { Skeleton } from "../Skeleton";
import { LOADING_DELAY_MS, basename, isInsideRoot } from "./layout";
import type { ExplorerTreeProps } from "./types";

const INDENT_PX = 12;

type NodeKind = "root" | "dir" | "file" | "more" | "error";
type TreeNode = {
  id: string;
  name: string;
  kind: NodeKind;
  entry?: FsEntry;
  /** `more`: entries beyond the listing cap. `error`: the safe reason text. */
  moreCount?: number;
  message?: string;
};

const BADGE_TONE: Record<FsGitBadge, string> = {
  M: "text-warn",
  A: "text-ok",
  "?": "text-text-faint",
  "!": "text-danger",
};
const BADGE_TITLE: Record<FsGitBadge, string> = {
  M: "Modified",
  A: "Added",
  "?": "Untracked",
  "!": "Conflict",
};

export function reasonMessage(reason: FsReason): string {
  switch (reason) {
    case "missing":
    case "not-file":
      return "This folder no longer exists";
    case "permission":
      return "No permission to open this folder";
    default:
      return "Couldn’t read this folder";
  }
}

/** Dirs strictly between `root` and `abs` (parents of `abs` inside `root`), outermost first. */
export function ancestorsWithin(root: string, abs: string): string[] {
  if (!isInsideRoot(root, abs) || abs === root) return [];
  const r = root.replace(/\/+$/, "");
  const rest = abs.slice(r.length + 1).split("/").filter(Boolean);
  const out: string[] = [];
  let cur = r;
  for (const seg of rest.slice(0, -1)) {
    cur = `${cur}/${seg}`;
    out.push(cur);
  }
  return out;
}

/** The deepest folder that contains both paths. */
export function commonAncestor(a: string, b: string): string {
  const A = a.split("/").filter(Boolean);
  const B = b.split("/").filter(Boolean);
  let i = 0;
  while (i < A.length && i < B.length && A[i] === B[i]) i++;
  return "/" + A.slice(0, i).join("/");
}

function useDelayed(ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return on;
}

type Up = { state: "checking" } | { state: "ok"; abs: string } | { state: "top" } | { state: "failed" };

export function ExplorerTree(props: ExplorerTreeProps) {
  // A new root is a new tree (filter, expansion and caches start over).
  return <TreeBody key={props.root} {...props} />;
}

function TreeBody({ owner, root, onRootChange, selected, onOpen, width, refreshKey }: ExplorerTreeProps) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [rootLoaded, setRootLoaded] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [changes, setChanges] = useState<Record<string, FsGitBadge>>({});
  const [up, setUp] = useState<Up>({ state: "checking" });
  const alive = useRef(true);
  const nodes = useRef(new Map<string, TreeNode>());
  const expandedRef = useRef<string[]>([]);
  expandedRef.current = expanded;
  const showSkeleton = useDelayed(LOADING_DELAY_MS);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const rootNode = useMemo<TreeNode>(() => ({ id: root, name: basename(root), kind: "root" }), [root]);
  nodes.current.set(root, rootNode);

  const dataLoader = useMemo(() => {
    const errorChild = (dir: string, message: string) => {
      const node: TreeNode = { id: `${dir}\0error`, name: message, kind: "error", message };
      nodes.current.set(node.id, node);
      return [{ id: node.id, data: node }];
    };
    return {
      getItem: (id: string): TreeNode => nodes.current.get(id) ?? { id, name: basename(id), kind: "file" },
      getChildrenWithData: async (dir: string) => {
        let kids: { id: string; data: TreeNode }[];
        let error: string | null = null;
        try {
          const res = await window.api.fsList({ dir });
          if (!res.ok) {
            error = reasonMessage(res.reason);
            kids = errorChild(dir, error);
          } else {
            kids = res.entries.map((entry) => {
              const node: TreeNode = { id: entry.abs, name: entry.name, kind: entry.kind, entry };
              nodes.current.set(node.id, node);
              return { id: node.id, data: node };
            });
            if (res.truncated) {
              const more: TreeNode = {
                id: `${dir}\0more`,
                name: "more",
                kind: "more",
                moreCount: Math.max(0, res.total - res.entries.length),
              };
              nodes.current.set(more.id, more);
              kids.push({ id: more.id, data: more });
            }
          }
        } catch (e) {
          console.warn("[explorer] fs:list failed:", dir, e);
          error = "Couldn’t read this folder";
          kids = errorChild(dir, error);
        }
        if (dir === root && alive.current) {
          setRootError(error);
          setRootLoaded(true);
        }
        return kids;
      },
    };
  }, [root]);

  const tree = useTree<TreeNode>({
    rootItemId: root,
    dataLoader,
    features: [asyncDataLoaderFeature, hotkeysCoreFeature],
    getItemName: (item) => item.getItemData()?.name ?? "",
    isItemFolder: (item) => {
      const k = item.getItemData()?.kind;
      return k === "dir" || k === "root";
    },
    state: { expandedItems: expanded, focusedItem: focused },
    setExpandedItems: setExpanded,
    setFocusedItem: setFocused,
  });

  const toggle = (item: ItemInstance<TreeNode>) => {
    if (item.isExpanded()) {
      item.collapse();
      return;
    }
    const wasError = item.getChildren().length === 1 && item.getChildren()[0]?.getItemData()?.kind === "error";
    item.expand();
    // Expanding a folder that failed to read is the retry.
    if (wasError) void item.invalidateChildrenIds(true);
  };

  const activate = (item: ItemInstance<TreeNode>) => {
    const node = item.getItemData();
    if (!node) return;
    if (node.kind === "dir") toggle(item);
    else if (node.kind === "file") onOpen({ abs: node.id, owner, kind: "file" });
  };

  // --- the folder above ---
  useEffect(() => {
    let cancelled = false;
    if (root.replace(/\/+$/, "") === "") {
      setUp({ state: "top" });
      return;
    }
    setUp({ state: "checking" });
    window.api
      .fsResolvePaths({ base: root, paths: [".."] })
      .then(({ results }) => {
        if (cancelled) return;
        const r = results[0];
        if (r && r.ok) setUp(r.abs === root ? { state: "top" } : { state: "ok", abs: r.abs });
        else setUp({ state: "failed" });
      })
      .catch((e) => {
        console.warn("[explorer] resolving the parent folder failed:", e);
        if (!cancelled) setUp({ state: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  // --- git badges ---
  useEffect(() => {
    let cancelled = false;
    window.api
      .fsGitStatus({ root })
      .then((res) => {
        if (!cancelled) setChanges(res.ok ? res.changes : {});
      })
      .catch((e) => {
        console.warn("[explorer] fs:git-status failed:", e);
        if (!cancelled) setChanges({});
      });
    return () => {
      cancelled = true;
    };
  }, [root, refreshKey]);

  // --- refresh: re-list the root and every expanded folder ---
  const seenRefresh = useRef(refreshKey);
  useEffect(() => {
    if (seenRefresh.current === refreshKey) return;
    seenRefresh.current = refreshKey;
    for (const id of [root, ...expandedRef.current]) {
      void tree.getItemInstance(id).invalidateChildrenIds(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // --- reveal + select ---
  useEffect(() => {
    if (!selected) return;
    if (!isInsideRoot(root, selected)) {
      onRootChange(commonAncestor(root, selected));
      return;
    }
    if (selected === root) return;
    let cancelled = false;
    void (async () => {
      const chain = ancestorsWithin(root, selected);
      await tree.loadChildrenIds(root);
      for (const dir of chain) {
        if (cancelled) return;
        await tree.loadChildrenIds(dir);
      }
      if (cancelled) return;
      const open = [...chain];
      if (nodes.current.get(selected)?.kind === "dir") open.push(selected);
      setExpanded((prev) => [...prev, ...open.filter((d) => !prev.includes(d))]);
      await tree.getItemInstance(selected).scrollTo({ block: "nearest" });
    })().catch((e) => console.warn("[explorer] reveal failed:", selected, e));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, root]);

  const items = tree.getItems();
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? items.filter((it) => {
        const d = it.getItemData();
        return d && d.kind !== "more" && d.kind !== "error" && d.name.toLowerCase().includes(needle);
      })
    : items;

  const upDisabled = up.state !== "ok";
  const upTitle =
    up.state === "ok"
      ? `Up to ${basename(up.abs)}`
      : up.state === "top"
        ? "Already at the top folder (/)"
        : up.state === "failed"
          ? "Can’t open the parent folder"
          : "Checking the parent folder…";

  const rootFailed = rootError != null && items.length === 1 && items[0].getItemData()?.kind === "error";

  const renderRow = (item: ItemInstance<TreeNode>) => {
    const node = item.getItemData();
    if (!node) return null;
    const level = item.getItemMeta().level;
    const pad = { paddingLeft: level * INDENT_PX };

    if (node.kind === "more") {
      return (
        <div key={item.getId()} style={pad} className="manta-explorer-row h-6 pr-2 text-meta leading-6 text-text-faint">
          {node.moreCount} more not shown — use quick open ({MOD_KEY}P)
        </div>
      );
    }
    if (node.kind === "error") {
      return (
        <div key={item.getId()} style={pad} role="status" className="manta-explorer-row h-6 pr-2 text-meta leading-6 text-danger">
          {node.message}
        </div>
      );
    }

    const isFolder = node.kind === "dir";
    const isSelected = node.id === selected;
    const dim = node.entry?.ignored || node.entry?.hidden;
    const rel = isInsideRoot(root, node.id) ? node.id.slice(root.replace(/\/+$/, "").length + 1) : node.id;
    const badge = !isFolder ? changes[rel] : undefined;
    const tone = isSelected
      ? "bg-accent-bg text-text"
      : dim
        ? "text-text-faint hover:bg-fill-hover"
        : "text-text-muted hover:bg-fill-hover";
    const base = item.getProps();
    return (
      <div
        {...base}
        key={item.getId()}
        aria-selected={isSelected}
        aria-expanded={isFolder ? item.isExpanded() : undefined}
        title={node.id}
        style={pad}
        className={`manta-explorer-row flex h-6 cursor-pointer items-center gap-1 rounded-sm pr-2 text-label ${tone}`}
        onClick={() => {
          item.setFocused();
          activate(item);
        }}
        onKeyDown={(e) => {
          // The library binds arrows / Home / End; Enter and Space activate the row.
          if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
            e.preventDefault();
            activate(item);
          }
        }}
      >
        {isFolder ? (
          item.isExpanded() ? (
            <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-text-faint" />
          ) : (
            <ChevronRight size={12} aria-hidden="true" className="shrink-0 text-text-faint" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {isFolder ? (
          <Folder size={14} aria-hidden="true" className="shrink-0 text-text-faint" />
        ) : (
          <File size={14} aria-hidden="true" className="shrink-0 text-text-faint" />
        )}
        <span className="truncate">{node.name}</span>
        {badge && (
          <span title={BADGE_TITLE[badge]} className={`ml-auto font-mono text-micro font-semibold ${BADGE_TONE[badge]}`}>
            {badge}
          </span>
        )}
      </div>
    );
  };

  let content: React.ReactNode;
  if (rootFailed) {
    content = (
      <div className="flex flex-col items-start gap-2 px-2 py-2 text-meta text-text-faint">
        <span role="status" className="text-danger">
          {rootError}
        </span>
        <Button tone="default" onClick={() => void tree.getItemInstance(root).invalidateChildrenIds(false)}>
          Retry
        </Button>
      </div>
    );
  } else if (!rootLoaded) {
    content = showSkeleton ? (
      <div className="flex flex-col gap-3 px-2 py-2" role="status" aria-label="Loading">
        <Skeleton width={70} />
        <Skeleton width={50} />
        <Skeleton width={85} />
      </div>
    ) : null;
  } else if (items.length === 0) {
    content = <div className="px-2 py-2 text-meta text-text-faint">Empty folder</div>;
  } else if (visible.length === 0) {
    content = <div className="px-2 py-2 text-meta text-text-faint">No files match “{filter.trim()}”</div>;
  } else {
    content = visible.map(renderRow);
  }

  return (
    <div
      className="manta-explorer-tree flex shrink-0 flex-col border-r border-border-subtle"
      style={{ width }}
    >
      <div className="flex items-center gap-1 p-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files"
          aria-label="Filter files"
          className="min-w-0 flex-1 bg-bg border border-border px-2 py-1 text-meta rounded-xs focus:outline-none focus:border-accent placeholder:text-text-faint"
        />
        <IconButton
          icon={<ArrowUp />}
          label="Up to parent folder"
          title={upTitle}
          disabled={upDisabled}
          onClick={() => {
            if (up.state === "ok") onRootChange(up.abs);
          }}
        />
      </div>
      <div {...tree.getContainerProps("Files")} className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {content}
      </div>
    </div>
  );
}
