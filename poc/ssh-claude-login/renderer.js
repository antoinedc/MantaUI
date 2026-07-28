'use strict';

const $ = (id) => document.getElementById(id);

const hostEl = $('host');
const connectBtn = $('connect');
const disconnectBtn = $('disconnect');
const checkBtn = $('check');
const statusEl = $('status');
const urlBar = $('url-bar');
const urlEl = $('url');
const openUrlBtn = $('open-url');
const logEl = $('log');
const codeEl = $('code');
const sendBtn = $('send');
const checkResult = $('check-result');
const checkSummary = $('check-summary');
const beforeEl = $('before');
const afterEl = $('after');
const restartStderrEl = $('restart-stderr');

let connected = false;
let currentUrl = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function appendLog(stream, text) {
  // Use a textContent-based append to keep escape sequences as-is — the question
  // we want answered ("is the URL reliably extractable?") is precisely about
  // what the raw stream looks like, so we deliberately do NOT strip ANSI.
  if (stream === 'stderr') {
    const span = document.createElement('span');
    span.className = 'stderr';
    span.textContent = text;
    logEl.appendChild(span);
  } else {
    logEl.appendChild(document.createTextNode(text));
  }
  logEl.scrollTop = logEl.scrollHeight;
}

async function connect() {
  const host = hostEl.value.trim();
  if (!host) {
    setStatus('enter a host first');
    return;
  }
  setStatus('connecting…');
  const res = await window.poc.connect(host);
  if (!res.ok) {
    setStatus('connect failed: ' + res.error);
  }
}

async function disconnect() {
  await window.poc.disconnect();
}

async function sendCode() {
  const text = codeEl.value;
  if (!text) return;
  const res = await window.poc.input(text);
  if (res.ok) codeEl.value = '';
}

async function openUrl() {
  if (!currentUrl) return;
  await window.poc.openUrl(currentUrl);
}

async function check() {
  const host = hostEl.value.trim();
  if (!host) {
    setStatus('enter a host first');
    return;
  }
  setStatus('checking…');
  checkBtn.disabled = true;
  try {
    const res = await window.poc.check(host);
    if (!res.ok) {
      setStatus('check failed: ' + res.error);
      return;
    }
    checkResult.style.display = 'block';
    checkSummary.innerHTML =
      `<div>creds file: <b>${escapeHtml(res.creds)}</b></div>` +
      `<div>provider BEFORE restart — anthropic connected: <b>${escapeHtml(res.providerBeforeAnthropic)}</b></div>` +
      `<div>provider AFTER restart — anthropic connected: <b>${escapeHtml(res.providerAfterAnthropic)}</b></div>` +
      `<div>restart exit code: <b>${res.restart.code}</b></div>`;
    beforeEl.textContent = res.providerBefore;
    afterEl.textContent = res.providerAfter;
    restartStderrEl.textContent = res.restart.stderr;
    setStatus('check done');
  } finally {
    checkBtn.disabled = false;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
sendBtn.addEventListener('click', sendCode);
checkBtn.addEventListener('click', check);
openUrlBtn.addEventListener('click', openUrl);
codeEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendCode();
  }
});

window.poc.onData(({ stream, text }) => appendLog(stream, text));
window.poc.onUrl(({ url }) => {
  currentUrl = url;
  urlEl.textContent = url;
  urlBar.style.display = 'flex';
  // Also print in the log so the human can copy if detection is unreliable.
  appendLog('stdout', `\n[detected URL: ${url}]\n`);
});
window.poc.onOpen(({ host }) => {
  connected = true;
  setStatus(`connected to ${host}`);
});
window.poc.onClosed(({ reason, host }) => {
  connected = false;
  setStatus(`disconnected (${reason})`);
  // Also mark it in the log: without this a session death followed by a
  // reconnect looks like the prompt simply redrawing itself, and anything
  // typed in between goes to a dead process.
  appendLog('stderr', `\n[session closed: ${reason}]\n`);
});
