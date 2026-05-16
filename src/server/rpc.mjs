// Channel -> handler dispatch. Handlers are async (...args) => result.
// Mirrors Electron ipcMain.handle semantics.

export async function dispatch(handlers, channel, args) {
  const fn = handlers[channel];
  if (!fn) throw new Error(`unknown rpc channel: ${channel}`);
  return fn(...args);
}

// Build the full handler map. opencode/local handlers are added in later
// slices; tmux + a no-op set are wired here.
export function buildHandlers({ tmux }) {
  return {
    "tmux:list": () => tmux.listProjects(),
    "tmux:new-session": (i) => tmux.newSession(i),
    "tmux:new-window": (i) => tmux.newWindow(i),
    "tmux:rename-session": (i) => tmux.renameSession(i),
    "tmux:rename-window": (i) => tmux.renameWindow(i),
    "tmux:kill-session": (n) => tmux.killSession(n),
    "tmux:kill-window": (i) => tmux.killWindow(i),
    "tmux:select-window": (i) => tmux.selectWindow(i),
  };
}

// POST /rpc/<channel>  body: {"args":[...]}  ->  {"result":...} | {"error":"..."}
export async function handleRpcRequest(handlers, channel, req, res) {
  let body = "";
  let responded = false;

  function sendJson(status, payload) {
    if (responded) return;
    responded = true;
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify(payload));
  }

  req.on("error", (err) => {
    sendJson(400, { error: String(err) });
  });

  req.on("data", (c) => (body += c));

  req.on("end", async () => {
    try {
      const { args = [] } = body ? JSON.parse(body) : {};
      const result = await dispatch(handlers, channel, args);
      sendJson(200, { result: result ?? null });
    } catch (e) {
      sendJson(500, { error: String(e?.message ?? e) });
    }
  });
}
