#!/usr/bin/env bash
# Copies xterm vendor files from the repo-root node_modules into
# mobile/www/vendor/ so Capacitor can serve them statically (the bui
# Node server normally serves these dynamically under /vendor/).
# Re-run after updating xterm. Safe to run from any cwd.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
nm="$repo_root/node_modules"
dest="$script_dir/www/vendor"

mkdir -p "$dest"

copy() {
  local src="$1" out="$2"
  if [[ ! -f "$src" ]]; then
    echo "ERROR: missing $src — run 'npm install' at repo root first" >&2
    exit 1
  fi
  cp "$src" "$dest/$out"
  echo "  $out"
}

echo "Syncing xterm vendor files -> $dest"
copy "$nm/@xterm/xterm/lib/xterm.js"        "xterm.js"
copy "$nm/@xterm/xterm/css/xterm.css"       "xterm.css"
copy "$nm/@xterm/addon-fit/lib/addon-fit.js" "addon-fit.js"
echo "Done."
