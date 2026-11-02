// The ONE always-visible ⌘B control (spec §Layout → Left sidebar). Rendered once
// by App, pinned at the window's top-left above both the sidebar and the panes,
// so a hidden sidebar always has a restore control — in every pane and in the
// Explorer's Expanded mode. z-40 clears the new-session draft layer (z-30).

import { PanelLeft } from "lucide-react";
import { IconButton } from "./IconButton";
import { IS_MAC, MOD_KEY } from "./platform";
import { SIDEBAR_TOGGLE_TOP_PX, sidebarToggleLeftPx } from "./explorer/layout";

export function SidebarToggle({
  hidden,
  onToggle,
  isMac = IS_MAC,
}: {
  hidden: boolean;
  onToggle: () => void;
  isMac?: boolean;
}) {
  const label = hidden ? "Show sidebar" : "Hide sidebar";
  return (
    <div
      className="absolute z-40 titlebar-no-drag"
      style={{ top: SIDEBAR_TOGGLE_TOP_PX, left: sidebarToggleLeftPx(isMac) }}
    >
      <IconButton
        icon={<PanelLeft />}
        label={label}
        title={`${label} (${MOD_KEY}B)`}
        hook="manta-sidebar-toggle"
        onClick={onToggle}
      />
    </div>
  );
}
