// bui mobile client. Plain JS — no build. Loaded by index.html.
//
// Two views: list (sessions/windows) and terminal. State lives in two globals
// because the surface is too small for anything more.

const ESC = "\x1b";
const KEY_SEQ = {
  esc: ESC,
  tab: "\t",
  enter: "\r",
  up: ESC + "[A",
  down: ESC + "[B",
  right: ESC + "[C",
  left: ESC + "[D",
};

// ---------- list view ----------

const $list = document.getElementById("list");
const $sessions = document.getElementById("sessions");
const $refresh = document.getElementById("refresh");

async function loadSessions() {
  $sessions.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const res = await fetch("/api/projects");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const projects = await res.json();
    renderSessions(projects);
  } catch (e) {
    $sessions.innerHTML = `<div class="error">${escapeHtml(String(e.message ?? e))}</div>`;
  }
}

function renderSessions(projects) {
  if (!projects.length) {
    $sessions.innerHTML =
      '<div class="empty">No tmux sessions running on this host.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const p of projects) {
    const card = document.createElement("div");
    card.className = "session";

    const header = document.createElement("div");
    header.className = "session-name" + (p.attached ? " attached" : "");
    header.innerHTML = `<span class="dot"></span><span></span>`;
    header.querySelector("span:last-child").textContent = p.tmuxSession;
    card.appendChild(header);

    for (const w of p.windows) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "window";
      row.style.width = "100%";
      row.style.textAlign = "left";
      row.style.borderRadius = "0";
      row.style.background = "transparent";

      const left = document.createElement("div");
      const name = document.createElement("div");
      name.className = "window-name";
      name.textContent = `${w.index}: ${w.name}`;
      const path = document.createElement("div");
      path.className = "window-path";
      path.textContent = w.paneCurrentPath || "";
      left.appendChild(name);
      left.appendChild(path);

      const right = document.createElement("div");
      right.className = "window-meta";
      if (w.active) right.textContent = "active";

      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener("click", () => openTerm(p.tmuxSession, w.index, w.name));
      card.appendChild(row);
    }
    frag.appendChild(card);
  }
  $sessions.innerHTML = "";
  $sessions.appendChild(frag);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

$refresh.addEventListener("click", loadSessions);

// ---------- terminal view ----------

const $term = document.getElementById("term");
const $termHost = document.getElementById("term-host");
const $termTitle = document.getElementById("term-title");
const $back = document.getElementById("back");
const $disconnect = document.getElementById("disconnect");
const $ctrlToggle = document.getElementById("ctrl-toggle");

let term = null;
let fit = null;
let ws = null;
let ctrlArmed = false;
let currentSession = null;

function openTerm(session, windowIdx, windowName) {
  $list.classList.add("hidden");
  $term.classList.add("active");
  $termTitle.textContent = `${session} · ${windowIdx}: ${windowName}`;
  currentSession = session;

  // (Re-)create xterm each time so we get a clean buffer and correct size.
  if (term) { term.dispose(); term = null; }
  term = new Terminal({
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "SF Mono", Consolas, monospace',
    cursorBlink: true,
    convertEol: false,
    theme: { background: "#000000", foreground: "#e6e6e6", cursor: "#e6e6e6" },
    scrollback: 5000,
    allowProposedApi: true,
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($termHost);
  fit.fit();

  const cols = term.cols;
  const rows = term.rows;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/pty?session=${encodeURIComponent(session)}` +
    `&window=${windowIdx}&cols=${cols}&rows=${rows}`;
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") term.write(ev.data);
    else term.write(new Uint8Array(ev.data));
  };
  ws.onclose = (ev) => {
    term.write(`\r\n\x1b[33m[disconnected: ${ev.code} ${ev.reason || ""}]\x1b[0m\r\n`);
  };
  ws.onerror = () => {
    term.write(`\r\n\x1b[31m[connection error]\x1b[0m\r\n`);
  };

  term.onData((data) => {
    if (ctrlArmed) {
      data = applyCtrl(data);
      setCtrlArmed(false);
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "data", data }));
    }
  });

  // Resize on viewport changes (rotation, iOS keyboard show/hide).
  const onResize = () => {
    if (!fit || !ws) return;
    try {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    } catch { /* fit can throw if not yet measured */ }
  };
  window.addEventListener("resize", onResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onResize);
  }
  $term._onResize = onResize;

  setTimeout(() => term.focus(), 50);
}

function closeTerm() {
  if (ws) {
    try { ws.close(); } catch { /* already closed */ }
    ws = null;
  }
  if (term) { term.dispose(); term = null; fit = null; }
  if ($term._onResize) {
    window.removeEventListener("resize", $term._onResize);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", $term._onResize);
    }
    $term._onResize = null;
  }
  setCtrlArmed(false);
  currentSession = null;
  $term.classList.remove("active");
  $list.classList.remove("hidden");
}

$back.addEventListener("click", closeTerm);
$disconnect.addEventListener("click", closeTerm);

// ---------- on-screen keyboard ----------

function setCtrlArmed(v) {
  ctrlArmed = v;
  $ctrlToggle.classList.toggle("armed", v);
}

// Convert a printable byte into its Ctrl-modified control code. Ctrl+letter
// is letter & 0x1f; for non-letters we just drop to the closest mapping
// commonly produced by terminals (Ctrl+Space → NUL, Ctrl+[ → ESC, etc).
function applyCtrl(data) {
  if (!data) return data;
  const c = data.charCodeAt(0);
  if (c >= 0x40 && c <= 0x7e) {
    return String.fromCharCode(c & 0x1f);
  }
  if (c === 0x20) return "\x00"; // ctrl+space
  return data;
}

document.querySelectorAll(".term-keys button[data-key]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const k = btn.dataset.key;
    if (k === "ctrl") {
      setCtrlArmed(!ctrlArmed);
      return;
    }
    let seq = KEY_SEQ[k];
    if (!seq) return;
    if (ctrlArmed) {
      seq = applyCtrl(seq);
      setCtrlArmed(false);
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "data", data: seq }));
    }
  });
});

// ---------- file upload ----------

const $uploadBtn = document.getElementById("upload-btn");
const $uploadInput = document.getElementById("upload-input");
const $uploadStatus = document.getElementById("upload-status");

let statusHideTimer = null;

function setStatus(text, kind) {
  if (statusHideTimer) { clearTimeout(statusHideTimer); statusHideTimer = null; }
  if (!text) {
    $uploadStatus.hidden = true;
    return;
  }
  $uploadStatus.textContent = text;
  $uploadStatus.classList.toggle("err", kind === "err");
  $uploadStatus.hidden = false;
  if (kind === "ok" || kind === "err") {
    statusHideTimer = setTimeout(() => { $uploadStatus.hidden = true; }, 2500);
  }
}

$uploadBtn.addEventListener("click", () => {
  if (!currentSession) return;
  $uploadInput.click();
});

$uploadInput.addEventListener("change", async () => {
  const files = Array.from($uploadInput.files ?? []);
  $uploadInput.value = ""; // allow re-picking the same file later
  if (!files.length || !currentSession) return;

  const batch = String(Date.now());
  const paths = [];
  let done = 0;
  const fail = [];
  setStatus(`Uploading 0/${files.length}…`);

  for (const f of files) {
    try {
      const url = `/api/upload?session=${encodeURIComponent(currentSession)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(f.name),
          "X-Batch-Id": batch,
        },
        body: f,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.path) throw new Error("no path returned");
      paths.push(data.path);
    } catch (e) {
      fail.push(`${f.name}: ${e.message ?? e}`);
    }
    done++;
    setStatus(`Uploading ${done}/${files.length}…`);
  }

  if (paths.length && ws && ws.readyState === WebSocket.OPEN) {
    // Type the resulting paths into the PTY at the cursor, space-separated
    // and led with a space so they don't collide with anything already typed.
    const data = " " + paths.map(quoteIfNeeded).join(" ");
    ws.send(JSON.stringify({ type: "data", data }));
  }
  if (fail.length) {
    setStatus(`Upload failed: ${fail[0]}`, "err");
  } else {
    setStatus(`Uploaded ${paths.length} file${paths.length === 1 ? "" : "s"}`, "ok");
  }
});

// Shell-safe quoting for the path we're about to type into the PTY. Most
// paths are plain (alnum/_./-), so unquoted is fine. If anything stranger
// appears, wrap in single quotes and escape inner single quotes.
function quoteIfNeeded(p) {
  if (/^[A-Za-z0-9_./-]+$/.test(p)) return p;
  return "'" + p.replace(/'/g, `'\\''`) + "'";
}

// ---------- boot ----------

loadSessions();
