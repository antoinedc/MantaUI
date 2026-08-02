The terminal page in this folder hosts the existing xterm.js terminal in a
WKWebView, per DECISIONS.md §9 (the webview is the terminal surface; Swift
never emulates a terminal). The vendored JavaScript/CSS here are the upstream
xterm.js UMD builds, not original work:

  - xterm.js              — @xterm/xterm v5.5.0 (lib/xterm.js UMD)
  - xterm-addon-fit.js    — @xterm/addon-fit v0.10.0 (lib/addon-fit.js UMD)
  - xterm.css             — @xterm/xterm v5.5.0 (css/xterm.css; its MIT
                            header is retained in the file and inlined into
                            terminal.html)

License: MIT (c) 2014 The xterm.js authors and contributors
https://github.com/xtermjs/xterm.js/blob/master/LICENSE

These are shipped as committed app resources so the iOS app builds offline
with no CDN / node_modules dependency. Do not hand-edit the minified UMD
files; update them by re-vendoring the matching @xterm/* package.
