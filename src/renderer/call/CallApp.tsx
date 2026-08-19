// CallApp.tsx — the on-call CTO voice window surface (BET-1166).
//
// A small, self-contained React root. The window is frameless + draggable via
// the `.call-header` drag region; the surface renders the three states from
// docs/call-window/mockup.html — listening / working-narration /
// awaiting-voice-confirmation — plus parked-vs-listening dot states — using
// ONLY design tokens (repo rule: never a hardcoded hex).
//
// Transport: a single /call WebSocket (auth-gated, `?token=` — browsers can't
// set WS headers). Opus/PCM16 mic frames go up; transcript / audio / working /
// confirm / intent events come down. The OpenAI key lives on the box — it is
// never requested here. Window show/park/hang ride the preload `call` bridge.

import { useEffect, useRef, useState } from "react";

type CallState =
  | "disconnected"
  | "connecting"
  | "listening"
  | "working"
  | "confirm"
  | "reconnecting"
  | "parked"
  | "dropped";

type TranscriptLine = { role: "user" | "cto"; text: string };
type ConfirmInfo = { id: string; tool: string; preview: string } | null;

// pcm16 encode: Int16Array → base64 (browser btoa on a latin1 string).
function pcm16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) dv.setInt16(i * 2, samples[i], true);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// Dedicated low-latency TTS for narration is generated on the box (Groq
// Orpheus). The renderer only plays the audio the server pushes down /call.
const NARRATE_KIND = "cto.narrate";

export function CallApp() {
  const [status, setStatus] = useState<CallState>("connecting");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmInfo>(null);
  const [listening, setListening] = useState(true); // mic mute (push-to-barge default: user toggles)
  const [spend, setSpend] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const outNodeRef = useRef<AudioWorkletNode | null>(null);
  const initialSetRef = useRef(false);

  // ----- connect the /call WS + mic + audio-out -----
  //
  // StrictMode safety (BET-1185): the async body awaits BEFORE it creates the
  // socket, so a StrictMode unmount (cleanup sets `cancelled`) during that
  // await would otherwise leave the body to run to completion and open a
  // socket the cleanup never sees — leaking a second Realtime session that
  // talks over the live one. We check `cancelled` after EVERY await and bail
  // (closing anything this run created), for the socket, the mic stream, and
  // the audio context alike.
  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pre = (window as any).__mantaPreload?.call;
      if (!pre) {
        setStatus("dropped");
        return;
      }
      const cfg = await pre.getConfig();
      if (isCancelled()) return; // cleanup ran during the await — create nothing
      if (!cfg?.serverUrl || !cfg?.boxToken) {
        setStatus("dropped");
        setError("Not connected to a box.");
        return;
      }
      const url = cfg.serverUrl.replace(/^http/, "ws") + "/call?token=" + encodeURIComponent(cfg.boxToken);
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => setStatus((s) => (s === "parked" || s === "disconnected" ? s : "listening"));
      ws.onclose = () => {
        if (!cancelled) setStatus("disconnected");
      };
      ws.onerror = () => setStatus("dropped");
      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        handleServerMessage(msg);
      };
      if (isCancelled()) {
        ws.close();
        return;
      }

      // Capture and playback run on ONE shared AudioContext so the browser's
      // echo canceller has a reference to what is being played (BET-1185).
      await startMic(ws, isCancelled);
      if (isCancelled()) {
        ws.close();
        return;
      }
      await setupAudioOut(isCancelled);
      if (isCancelled()) {
        ws.close();
        return;
      }
    })();
    return () => {
      cancelled = true;
      wsRef.current?.close();
      cleanupMic();
      cleanupAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleServerMessage(msg: Record<string, unknown>) {
    const type = String(msg.type ?? "");
    switch (type) {
      case "config": {
        // The box tells us its cto profile (push-to-barge default, voice,
        // transport). Spec #8: respect cto.alwaysListening — never hardcode
        // always-listening. Only the first config (the connect-time one) sets
        // the initial mic state, so a user toggle mid-call is never clobbered.
        const always = (msg.cto as { alwaysListening?: boolean } | undefined)?.alwaysListening;
        setListening((on) => (initialSetRef.current ? on : Boolean(always)));
        initialSetRef.current = true;
        return;
      }
      case "state": {
        const s = String(msg.state ?? "disconnected");
        setStatus(mapState(s));
        if (s === "reconnecting") {
          setError("Call dropped — reconnecting…");
        } else if (error && s === "live") {
          setError(null);
        }
        if (s === "parked") setWorking(null);
        return;
      }
      case "connstate": {
        if (String(msg.state) === "reconnecting") {
          setStatus("reconnecting");
          setError("Call dropped — reconnecting…");
        } else if (String(msg.state) === "dropped") {
          setStatus("dropped");
          setError(String(msg.reason ?? "Call dropped."));
        }
        return;
      }
      case "transcript":
        setTranscript((t) =>
          appendTranscript(t, String(msg.role) === "user" ? "user" : "cto", String(msg.delta ?? "")),
        );
        return;
      case "transcript-finished":
      case "stt":
        return; // handled via deltas / the user line above
      case "working":
        setWorking(String(msg.tool ?? ""));
        setStatus("working");
        return;
      case "confirm":
        setConfirm({ id: String(msg.id ?? ""), tool: String(msg.tool ?? ""), preview: String(msg.preview ?? "") });
        setStatus("confirm");
        return;
      case "confirm-resolved":
        setConfirm(null);
        setStatus("listening");
        return;
      case "audio":
        playPcm(String(msg.delta ?? ""));
        return;
      case "barge":
        outNodeRef.current?.port.postMessage({ kind: "clear" });
        return;
      case NARRATE_KIND:
        // Narration (spec #6): the box synthesized (Groq Orpheus) + streamed
        // this as audio; decode + play it. The working line stays visible.
        playNarration(String(msg.audio ?? ""), String(msg.mime ?? "audio/mpeg"));
        return;
      case "cost":
        setSpend(Number(msg.usd ?? 0));
        return;
      case "error":
        // A non-fatal error frame from the Realtime session (one rejected
        // event) must not kill a working call — set the error text and leave
        // the status alone; only "dropped" transitions the window to dropped.
        setError(String(msg.error ?? msg.reason ?? "Call error."));
        return;
      case "dropped":
        setError(String(msg.error ?? msg.reason ?? "Call dropped."));
        setStatus("dropped");
        return;
      default:
        return;
    }
  }

  async function startMic(ws: WebSocket, isCancelled: () => boolean = () => false) {
    if (!listening) return;
    if (micStreamRef.current) return;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 24000, echoCancellation: true, noiseSuppression: true },
      });
      if (isCancelled()) {
        stopStream(stream);
        return;
      }
      micStreamRef.current = stream;
      // Same shared AudioContext as playback, so echo cancellation works.
      const ctx = getOrCreateAudioCtx();
      if (!ctx) {
        stopStream(stream);
        micStreamRef.current = null;
        return;
      }
      const src = ctx.createMediaStreamSource(stream);
      // Keep the graph pulling (src + worklet must stay connected to the
      // destination to process) but emit no sound: route both capture nodes
      // to a zero-gain monitor instead of the raw destination.
      const monitor = ctx.createGain();
      monitor.gain.value = 0;
      monitor.connect(ctx.destination);
      src.connect(monitor);
      const worklet = await makePcmWorklet(ctx, (samples) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "audio", delta: pcm16ToBase64(samples) }));
        }
      });
      if (isCancelled()) {
        stopStream(stream);
        micStreamRef.current = null;
        return;
      }
      src.connect(worklet);
      worklet.connect(monitor);
    } catch {
      setError("Microphone unavailable.");
    }
  }

  function setupAudioOut(isCancelled: () => boolean = () => false) {
    const ctx = getOrCreateAudioCtx();
    if (!ctx) return;
    const workletSrc = `
      class Out extends AudioWorkletProcessor {
        constructor(){ super(); this.buf = new Float32Array(0); this.port.onmessage=(e)=>{ const d=e.data; if(d.kind==='push'){ const a=new Float32Array(d.samples); const n=new Float32Array(this.buf.length+a.length); n.set(this.buf); n.set(a,this.buf.length); this.buf=n; } if(d.kind==='clear'){ this.buf=new Float32Array(0); } }; }
        process(inputs, outputs){
          const out = outputs[0][0]; if(!out) return true;
          if(this.buf.length>0){ const n=Math.min(out.length,this.buf.length); out.set(this.buf.subarray(0,n)); this.buf=this.buf.subarray(n); }
          return true;
        }
      }
      registerProcessor('pcm-out', Out);
    `;
    const blob = new Blob([workletSrc], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    ctx.audioWorklet.addModule(url).then(() => {
      if (isCancelled()) {
        cleanupAudio();
        return;
      }
      const node = new AudioWorkletNode(ctx, "pcm-out");
      node.connect(ctx.destination);
      outNodeRef.current = node;
      URL.revokeObjectURL(url);
    }).catch(() => {
      URL.revokeObjectURL(url);
    });
  }

  // A single shared AudioContext for both mic capture and playback, so the
  // browser's echo canceller sees what is being played (BET-1185).
  function getOrCreateAudioCtx(): AudioContext | null {
    if (audioCtxRef.current) return audioCtxRef.current;
    try {
      const ctx = new AudioContext({ sampleRate: 24000 });
      audioCtxRef.current = ctx;
      return ctx;
    } catch {
      return null;
    }
  }

  function cleanupMic() {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
  }

  function cleanupAudio() {
    outNodeRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }

  function stopStream(stream: MediaStream) {
    stream.getTracks().forEach((t) => t.stop());
  }

  function playPcm(base64: string) {
    const buf = base64ToInt16(base64);
    if (!buf || buf.length === 0) return;
    // WebAudio writes float samples in −1…1; the wire carries raw PCM16
    // (−32768…32767), so convert once here and hand the worklet a
    // (transferred) Float32Array instead of a JS number array.
    const f = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) f[i] = buf[i] / 32768;
    outNodeRef.current?.port.postMessage({ kind: "push", samples: f }, [f.buffer]);
  }

  // Narration (spec #6): the box streamed fully-encoded audio (mp3) it made
  // with Groq Orpheus. Decode + play it through the shared AudioContext.
  function playNarration(base64: string, _mime: string) {
    if (!base64) return;
    const ctx = getOrCreateAudioCtx();
    if (!ctx) return;
    const bytes = base64ToBytes(base64);
    if (!bytes) return;
    ctx.decodeAudioData(bytes.buffer as ArrayBuffer).then(
      (buffer) => {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start();
      },
      () => {
        /* mime not decodable here — silent, never breaks the call */
      },
    );
  }

  function makePcmWorklet(ctx: AudioContext, onSamples: (s: Int16Array) => void): Promise<AudioWorkletNode> {
    const src = `
      class In extends AudioWorkletProcessor {
        constructor(){ super(); this.frame=new Float32Array(0); }
        process(inputs){
          const ch=inputs[0] && inputs[0][0]; if(!ch) return true;
          const a=new Float32Array(this.frame.length+ch.length); a.set(this.frame); a.set(ch,this.frame.length); this.frame=a;
          const n=Math.floor(this.frame.length/480);
          if(n>=1){ const use=n*480; const head=this.frame.subarray(0,use); this.frame=this.frame.slice(use); this.port.postMessage(head,[head.buffer]); }
          return true;
        }
      }
      registerProcessor('pcm-in', In);
    `;
    const blob = new Blob([src], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    return ctx.audioWorklet.addModule(url).then(() => {
      const node = new AudioWorkletNode(ctx, "pcm-in", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (ev) => {
        const f = ev.data as Float32Array;
        const i = new Int16Array(f.length);
        for (let k = 0; k < f.length; k++) i[k] = Math.max(-32768, Math.min(32767, Math.round(f[k] * 32768)));
        onSamples(i);
      };
      URL.revokeObjectURL(url);
      return node;
    });
  }

  // ----- controls -----
  function toggleMic() {
    setListening((on) => {
      const next = !on;
      if (!next) {
        micStreamRef.current?.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
      } else {
        const ws = wsRef.current;
        if (ws) void startMic(ws);
      }
      return next;
    });
  }

  function barge() {
    wsRef.current?.send(JSON.stringify({ type: "barge" }));
  }

  async function hangup() {
    // Tell the box to tear the call down BEFORE closing the socket: the
    // server's control:hangup path hangs up the engine, and the ws.on("close")
    // teardown remains as the backstop for a window that vanishes without
    // warning.
    wsRef.current?.send(JSON.stringify({ type: "control", action: "hangup" }));
    setStatus("disconnected");
    wsRef.current?.close();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mantaPreload?.call?.hangup?.();
  }

  function park() {
    // Park must actually stop the call from the box's perspective: send the
    // control:park frame (the server tears down the Realtime session + clears
    // the call-active flag so inbound CTO events go to push, not to a hidden
    // window) and stop the mic so nothing keeps streaming/billing.
    wsRef.current?.send(JSON.stringify({ type: "control", action: "park" }));
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    // Mic is off once parked, so the indicator reads "off" (the manual spec:
    // "the mic indicator is off"). A parked call's engine is torn down anyway;
    // if the window is later re-shown the user toggles Talk to restart the mic.
    setListening(false);
    setStatus("parked");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__mantaPreload?.call?.park?.();
  }

  return (
    <div className={"call " + statusClass(status)}>
      <div className="call-header">
        <span className={"call-dot " + (status === "parked" ? "parked" : status === "listening" ? "listening" : "busy")} />
        <span className="call-title">On-call CTO</span>
        <span className="call-spend">{spend > 0 ? `$${spend.toFixed(2)}` : ""}</span>
      </div>

      <div className="call-body">
        {error ? (
          <div className="call-error">{error}</div>
        ) : status === "confirm" && confirm ? (
          <div className="confirm-banner">
            <div className="confirm-preview">{confirm.preview}</div>
            <div className="confirm-hint">Go ahead, or say "no".</div>
          </div>
        ) : status === "working" && working ? (
          <div className="working-line">Working… {working}</div>
        ) : (
          <div className="listening-line">{status === "listening" ? "Listening" : "Connect…"}</div>
        )}

        <div className="transcript">
          {transcript.map((l, i) => (
            <div key={i} className={"tline " + (l.role === "user" ? "user" : "cto")}>
              <span className="trole">{l.role === "user" ? "You" : "CTO"}</span>
              <span className="ttext">{l.text}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="call-controls">
        <button
          className={"ctl " + (listening ? "on" : "off")}
          onClick={toggleMic}
          title={listening ? "Mute" : "Unmute"}
        >
          {listening ? "Mute" : "Talk"}
        </button>
        <button className="ctl" onClick={barge} title="Barge in">
          Barge
        </button>
        <button className="ctl park" onClick={park} title="Park">
          Park
        </button>
        <button className="ctl danger" onClick={hangup} title="Hang up">
          Hang up
        </button>
      </div>
    </div>
  );
}

function mapState(s: string): CallState {
  if (s === "live") return "listening";
  if (s === "parked") return "parked";
  if (s === "reconnecting") return "reconnecting";
  if (s === "idle") return "disconnected";
  if (s === "connecting") return "connecting";
  if (s === "dropped") return "dropped";
  return "disconnected";
}

function statusClass(s: CallState): string {
  return `call--${s}`;
}

function appendTranscript(list: TranscriptLine[], role: "user" | "cto", delta: string): TranscriptLine[] {
  const last = list[list.length - 1];
  if (last && last.role === role) {
    const copy = [...list];
    copy[copy.length - 1] = { role, text: last.text + delta };
    return copy;
  }
  return [...list, { role, text: delta }];
}

function base64ToInt16(b64: string): Int16Array | null {
  try {
    const bytes = base64ToBytes(b64);
    if (!bytes) return null;
    const samples = new Int16Array(bytes.length / 2);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < samples.length; i++) samples[i] = dv.getInt16(i * 2, true);
    return samples;
  } catch {
    return null;
  }
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
