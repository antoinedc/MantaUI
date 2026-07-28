'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');

const URL_RE = /https:\/\/[^\s\x07\x1b]+/g;

let mainWindow = null;
let session = null; // { child: ChildProcess, host: string }

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function killSession(reason) {
  if (!session) return;
  try {
    session.child.kill('SIGTERM');
  } catch {}
  send('ssh:closed', { reason: reason ?? 'killed', host: session.host });
  session = null;
}

function detectFirstUrl(buf, seen) {
  const text = buf.toString('utf8');
  const matches = text.match(URL_RE);
  if (!matches) return;
  for (const m of matches) {
    const cleaned = m.replace(/[)\].,;]+$/, '');
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      send('ssh:url', { url: cleaned });
      return cleaned;
    }
  }
}

function startSession(host) {
  if (session) killSession('restarted');

  // -tt forces a remote PTY even though our local side is just pipes; `claude`
  // therefore believes it is interactive while we just read/write ordinary
  // streams. No pseudo-terminal library needed.
  const child = spawn('ssh', ['-tt', '-o', 'BatchMode=yes', host, 'claude'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  session = { child, host };
  send('ssh:open', { host });

  // Mirror raw output to the renderer first; then run URL detection on a
  // copy. Reliability of detection is one of the questions this POC
  // answers — making detection a separate event from the raw log keeps
  // detection failures visible.
  child.stdout.on('data', (chunk) => {
    send('ssh:data', { stream: 'stdout', text: chunk.toString('utf8') });
  });
  child.stderr.on('data', (chunk) => {
    send('ssh:data', { stream: 'stderr', text: chunk.toString('utf8') });
  });

  const seen = new Set();
  child.stdout.on('data', (chunk) => detectFirstUrl(chunk, seen));
  child.stderr.on('data', (chunk) => detectFirstUrl(chunk, seen));

  child.on('exit', (code, signal) => {
    send('ssh:closed', { reason: `exit code=${code} signal=${signal}`, host });
    session = null;
  });
  child.on('error', (err) => {
    send('ssh:data', { stream: 'stderr', text: `\n[spawn error: ${err.message}]\n` });
  });
}

function runRemote(host, command) {
  return new Promise((resolve) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', host, command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) =>
      resolve({ code: -1, stdout, stderr: stderr + `\n[spawn error: ${err.message}]` })
    );
  });
}

ipcMain.handle('ssh:connect', (_evt, host) => {
  if (typeof host !== 'string' || !host.trim()) {
    return { ok: false, error: 'host is required' };
  }
  try {
    startSession(host.trim());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('ssh:input', (_evt, text) => {
  if (!session) return { ok: false, error: 'not connected' };
  if (typeof text !== 'string') return { ok: false, error: 'text must be a string' };
  // Append \r so claude's TUI receives Enter (the same sequence a real terminal sends).
  session.child.stdin.write(text + '\r');
  return { ok: true };
});

ipcMain.handle('ssh:open-url', async (_evt, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return { ok: false, error: 'invalid url' };
  }
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('ssh:disconnect', () => {
  killSession('user-disconnect');
  return { ok: true };
});

ipcMain.handle('ssh:check', async (_evt, host) => {
  if (typeof host !== 'string' || !host.trim()) {
    return { ok: false, error: 'host is required' };
  }
  const h = host.trim();
  // Three commands over a separate, plain (non -tt) SSH connection.
  const creds = await runRemote(h, 'test -f ~/.claude/.credentials.json && echo CREDS_YES || echo CREDS_NO');
  const providerBefore = await runRemote(
    h,
    'curl -s --max-time 5 http://127.0.0.1:4096/provider'
  );
  const restart = await runRemote(
    h,
    // systemctl --user over a non-login SSH session needs XDG_RUNTIME_DIR set
    // explicitly; otherwise it silently no-ops with "Failed to connect to bus".
    'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart opencode-serve'
  );
  const providerAfter = await runRemote(
    h,
    'curl -s --max-time 5 http://127.0.0.1:4096/provider'
  );
  const flag = (text) => {
    try {
      const j = JSON.parse(text);
      const connected = Array.isArray(j.connected) ? j.connected : [];
      return connected.includes('anthropic') ? 'YES' : 'NO';
    } catch {
      return 'PARSE_ERROR';
    }
  };
  return {
    ok: true,
    creds: creds.stdout.trim(),
    providerBefore: providerBefore.stdout,
    providerBeforeAnthropic: flag(providerBefore.stdout),
    restart: { code: restart.code, stderr: restart.stderr },
    providerAfter: providerAfter.stdout,
    providerAfterAnthropic: flag(providerAfter.stdout),
  };
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'POC: SSH Claude login',
    webPreferences: {
      preload: __dirname + '/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => {
    mainWindow = null;
    killSession('window-closed');
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killSession('all-windows-closed');
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => killSession('app-quit'));
