// The ⌘B control (spec 2026-11-03 §2). One `IconButton`, two homes:
//   - sidebar visible → inside the sidebar's Workspace header, left of search
//     (Sidebar renders <SidebarToggleButton/> there);
//   - sidebar hidden  → the first control of the top-left pane header
//     (<SidebarRevealButton/>, rendered as the first child of every pane header).

import { PanelLeft } from "lucide-react";
import { IconButton } from "./IconButton";
import { MOD_KEY } from "./platform";
import { toggleSidebarHidden, useSidebarHidden } from "./explorer/explorerStore";

export function SidebarToggleButton({ hidden }: { hidden: boolean }) {
  const label = hidden ? "Show sidebar" : "Hide sidebar";
  return (
    <IconButton
      icon={<PanelLeft />}
      label={label}
      title={`${label} (${MOD_KEY}B)`}
      hook="manta-sidebar-toggle"
      onClick={toggleSidebarHidden}
    />
  );
}

/** The restore control a pane header carries while the sidebar is hidden; nothing while it is visible. */
export function SidebarRevealButton() {
  const hidden = useSidebarHidden();
  if (!hidden) return null;
  return (
    <span className="titlebar-no-drag inline-flex shrink-0">
      <SidebarToggleButton hidden />
    </span>
  );
}
