// ===== useVoicePlayback — one audio engine per conversation (BET-881) =====
//
// The <audio> element used to live INSIDE each transcript row, but the
// transcript is virtualised (Virtuoso destroys rows that scroll out of view).
// Three bugs followed from a row-owned player: playback died when the row was
// scrolled away (the effect cleanup revoked the object URL mid-sentence),
// several notes could overlap, and the clip was re-downloaded every time a row
// remounted. This provider lifts the engine OUT of the row: it owns exactly
// one <audio>, the active note, and a blob-URL cache, so scrolling has no
// effect on playback, "one note at a time" is automatic, and each clip is
// fetched exactly once per conversation.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export const SPEEDS = [1, 1.5, 2];

type PlaybackEngine = {
  activeNoteId: string | null;
  playing: boolean;
  currentMs: number;
  speedIdx: number;
  toggle: (noteId: string) => void;
  cycleSpeed: () => void;
};

const VoicePlaybackContext = createContext<PlaybackEngine | null>(null);

function useVoicePlaybackEngine(): PlaybackEngine {
  const ctx = useContext(VoicePlaybackContext);
  if (!ctx) {
    throw new Error("useVoicePlayback must be used within a VoicePlaybackProvider");
  }
  return ctx;
}

/** Wraps the transcript. `active` false (a hidden ChatPanel) pauses playback. */
export function VoicePlaybackProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlCacheRef = useRef<Map<string, string>>(new Map());
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);

  const toggle = useCallback(
    (noteId: string) => {
      const a = audioRef.current;
      if (!a) return;

      if (noteId === activeNoteId && playing) {
        a.pause();
        return;
      }
      if (noteId === activeNoteId && !playing) {
        void a.play().catch(() => {
          /* autoplay block — ignore */
        });
        return;
      }

      // A different note (or none active): pause whatever is playing, fetch +
      // cache the clip, and play it. Starting one note stops the other.
      a.pause();
      void (async () => {
        let url = urlCacheRef.current.get(noteId);
        if (!url) {
          try {
            const blob = await window.api.voiceFetchNote(noteId);
            url = URL.createObjectURL(blob);
            urlCacheRef.current.set(noteId, url);
          } catch {
            // Audio swept/expired between the list and the tap — leave it
            // silent rather than throwing.
            return;
          }
        }
        a.src = url;
        setActiveNoteId(noteId);
        setCurrentMs(0);
        a.playbackRate = SPEEDS[speedIdx];
        void a.play().catch(() => {
          /* autoplay block — ignore */
        });
      })();
    },
    [activeNoteId, playing, speedIdx],
  );

  const cycleSpeed = useCallback(() => {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[next];
  }, [speedIdx]);

  // Hidden panels (ChatPanels for other sessions stay mounted) must not keep
  // playing.
  useEffect(() => {
    if (!active) audioRef.current?.pause();
  }, [active]);

  // Unmount cleanup: stop and free every cached object URL.
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      for (const url of urlCacheRef.current.values()) URL.revokeObjectURL(url);
      urlCacheRef.current.clear();
    };
  }, []);

  const value = useMemo<PlaybackEngine>(
    () => ({ activeNoteId, playing, currentMs, speedIdx, toggle, cycleSpeed }),
    [activeNoteId, playing, currentMs, speedIdx, toggle, cycleSpeed],
  );

  return (
    <VoicePlaybackContext.Provider value={value}>
      {children}
      <audio
        ref={audioRef}
        onTimeUpdate={(e) => setCurrentMs(Math.round(e.currentTarget.currentTime * 1000))}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={() => setCurrentMs(0)}
      />
    </VoicePlaybackContext.Provider>
  );
}

/**
 * Playback state for ONE note. Returns idle values (playing false, currentMs
 * 0) whenever this note is not the active one, so an inactive row shows its
 * total duration and a Play glyph with no extra bookkeeping in the row.
 */
export function useVoicePlayback(noteId: string): {
  playing: boolean;
  currentMs: number;
  speed: number;
  toggle: () => void;
  cycleSpeed: () => void;
} {
  const engine = useVoicePlaybackEngine();
  const isActive = engine.activeNoteId === noteId;
  return {
    playing: isActive && engine.playing,
    currentMs: isActive ? engine.currentMs : 0,
    speed: SPEEDS[engine.speedIdx],
    toggle: () => engine.toggle(noteId),
    cycleSpeed: engine.cycleSpeed,
  };
}
