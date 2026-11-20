// The classic look's frame, from the app's side of the Kiko window (src/ui/window-glue.ts): the
// window's one line, its last, rendered here (src/ui/classic.ts) and sent to the window's frame pane
// over a socket of the app's (src/ui/window-frame.ts), up to 20 times a second while you talk (the
// waveform); the caption, your words while you dictate, a box of its own over the window, made
// when words come and gone when you let go; and the voice glow under it (./window-glow.ts), a band
// with no border resting on the boxes' bottom edge, made as you start talking, kept while Kiko works
// out where your words go and while it speaks, and gone once it has faded out: its rows drawn here,
// GLOW_FPS a second, sent over the same socket, and no timer for it at all while it's gone.
import { log } from "../core/log.ts";
import { ui } from "../core/ui-store.ts";
import * as win from "../terminals/tmux/window.ts";
import { type Box, FRAME_SOCKET, glowBox } from "../terminals/tmux/classic.ts";
import { barTicks } from "./bar.ts";
import { captionLines, captionWidth, frameLines, quietLevels } from "./classic.ts";
import { colorDepth } from "./cli-style.ts";
import { GLOW_COLS } from "./dither-glow.ts";
import { BACKGROUND } from "./marks.ts";
import { pushLevel } from "./meter.ts";
import { GlowDriver, glowInput, glowPalette } from "./window-glow.ts";
import { framePath, frameServer, type FrameServer } from "./window-frame.ts";
import type { WindowShared } from "./window-glue.ts";

/** At most this often new lines for the classic look's frame (the waveform, a spinner): no tmux in the way, only the frame's own pane. */
const FRAME_EVERY_MS = 50;

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

export type ClassicFrame = {
  /** Draws the frame again soon (at most every FRAME_EVERY_MS), once it has a socket and the window is open. */
  schedule(): void;
  /** The frame's socket, once the window has the classic look (tried once). */
  start(): Promise<void>;
  /** The window's size at the last look, for the caption while no frame is connected to say it. */
  sized(size: win.Size): void;
  /** Whether a caption's pane is this run's own: made, or one being made. */
  ownsCaption(pane: string): boolean;
  /** Whether a glow's pane is this run's own, likewise. */
  ownsGlow(pane: string): boolean;
  /** The app is quitting: the frame says Kiko isn't running once its socket closes; a caption goes with the app. */
  stop(): Promise<void>;
};

/** The classic look's frame and caption, for startWindow's shared handles. */
export function classicFrame(w: WindowShared): ClassicFrame {
  const { tmux } = w;
  // Its socket once there's one to draw for, the waveform's levels, the caption's pane (made as words come).
  let frame: FrameServer | null = null;
  let frameTimer: NodeJS.Timeout | null = null;
  let lastFrameAt = 0;
  let levels = quietLevels();
  let windowSize: win.Size | null = null;
  const caption = { pane: null as string | null, making: false, lines: 0, lift: 0 };
  // The glow's pane (made as it starts, gone once it has faded out) and its loop.
  const glow = { pane: null as string | null, making: false, closing: Promise.resolve() };
  /** The window's size as the frame says it (it's the window's one tiled pane), else as the last look saw it. */
  const sizeNow = (): win.Size | null => {
    const shown = frame?.clients().find((c) => c.role === "frame");
    return shown ? { width: shown.cols, height: shown.rows } : windowSize;
  };
  /** The glow's box now: a classic window open, with its frame, big enough for one. */
  const glowAt = (): Box | null => {
    const size = frame && w.open && w.look === "classic" ? sizeNow() : null;
    return size ? glowBox(size.width, size.height) : null;
  };
  const glowLoop = new GlowDriver({
    cols: GLOW_COLS,
    rows: 4,
    depth: colorDepth(process.stdout),
    palette: glowPalette(BACKGROUND),
    input: () => (glowAt() ? glowInput(ui.state, performance.now() / 1000) : { mode: "idle", level: 0 }),
    opened: () => keepGlow(true),
    draw: (lines) =>
      frame?.send("glow", (c) => {
        const rows = [...lines];
        glowLoop.resize(c.cols, c.rows); // the next frame at the pane's size
        return { lines: rows };
      }),
    closed: () => keepGlow(false),
  });
  const wakeGlow = () => glowLoop.wake();
  ui.on("change", wakeGlow);

  function scheduleFrame() {
    if (frameTimer || !frame || !w.open) return;
    frameTimer = setTimeout(drawFrame, Math.max(0, FRAME_EVERY_MS - (Date.now() - lastFrameAt)));
  }
  /** The line for each frame connected (at its width), and the caption: its words, and its box made, sized or gone. */
  function drawFrame() {
    frameTimer = null;
    if (!frame || !w.open || w.look !== "classic") return;
    lastFrameAt = Date.now();
    const s = ui.state;
    const now = Date.now();
    // The waveform: one more level each time it's drawn while you talk, as the full screen's (meter.ts).
    levels = s.listening ? pushLevel(levels, s.level) : quietLevels();
    const said = w.notice && now < w.notice.until ? w.notice.text : "";
    frame.send("frame", (c) => frameLines(s, c.cols, { now, notice: said, levels, keys: w.listFocused ? "list" : "stage" }));
    const size = sizeNow();
    const words = s.listening && size ? captionLines(s.interim, captionWidth(size.width)) : [];
    keepCaption(words, size);
    frame.send("caption", () => ({ lines: words }));
  }
  // Moving while it moves: the waveform while you talk, a spinner while deciding or checking, a "→ pixie" or a notice until it goes.
  const frameTicker = setInterval(() => {
    const s = ui.state;
    if (frame && (s.listening || s.deciding || s.checking || barTicks(s) || w.notice)) scheduleFrame();
  }, FRAME_EVERY_MS);
  frameTicker.unref();

  /** How far the caption sits over the boxes' bottom edge: the glow's height while there's one. */
  const captionLift = (size: win.Size) => (glow.pane || glow.making ? (glowBox(size.width, size.height)?.h ?? 0) : 0);

  /**
   * The caption's box: made once words come while you talk (not before, so a press with nothing said
   * shows none), sized to the lines it has (over the glow while there's one), gone when you let go. One
   * at a time: one being made isn't made again, and one made after you let go goes at the next draw.
   */
  function keepCaption(words: string[], size: win.Size | null) {
    const want = words.length > 0 && w.open && w.look === "classic" && Boolean(size);
    if (want && !caption.pane && !caption.making) {
      caption.making = true;
      caption.lines = words.length;
      caption.lift = -1; // placed by what tmux knows as it's made: put where it goes at the next draw
      void win
        .openCaption(tmux, words.length)
        .then((pane) => void (caption.pane = pane))
        .catch((err) => log("window_failed", { what: "caption", error: why(err) }))
        .finally(() => {
          caption.making = false;
          scheduleFrame();
        });
    } else if (!want && caption.pane) {
      const pane = caption.pane;
      caption.pane = null;
      void win.closeCaption(tmux, pane);
    } else if (want && caption.pane && size && (words.length !== caption.lines || captionLift(size) !== caption.lift)) {
      caption.lines = words.length;
      caption.lift = captionLift(size);
      void win.sizeCaption(tmux, caption.pane, size, words.length, caption.lift).catch(() => "");
    }
  }

  /**
   * The glow's pane: made as the glow starts (`on`), gone once it has faded out. One at a time, as
   * the caption: one that comes made after the glow stopped goes at once. The caption over it moves
   * at its next draw (keepCaption).
   */
  function keepGlow(on: boolean) {
    if (on && !glow.pane && !glow.making) {
      glow.making = true;
      void win
        .openGlow(tmux)
        .then((made) => {
          if (!made) return;
          glow.pane = made.id;
          glowLoop.resize(made.box.w, made.box.h);
        })
        .catch((err) => log("window_failed", { what: "glow", error: why(err) }))
        .finally(() => {
          glow.making = false;
          if (!glowLoop.running) keepGlow(false);
          scheduleFrame();
        });
    } else if (!on && glow.pane) {
      const pane = glow.pane;
      glow.pane = null;
      glow.closing = win.closeGlow(tmux, pane);
      scheduleFrame();
    }
  }

  /** The frame's socket, once the window has the classic look: listened on, and its path kept on the server for the frame to find. */
  let frameFailed = false; // tried once: the log isn't filled with it at every look
  async function startFrame() {
    if (frame || frameFailed) return;
    try {
      frame = frameServer(framePath(), scheduleFrame, (error) => log("window_failed", { what: "frame", error }));
      await tmux(["set-option", "-g", FRAME_SOCKET, frame.path]);
      log("window_frame", { path: frame.path });
    } catch (err) {
      frameFailed = true;
      log("window_failed", { what: "frame", error: why(err) });
    }
  }

  return {
    schedule: scheduleFrame,
    start: startFrame,
    sized(size) {
      windowSize = size;
    },
    ownsCaption: (pane) => pane === caption.pane || caption.making,
    ownsGlow: (pane) => pane === glow.pane || glow.making,
    async stop() {
      if (frameTimer) clearTimeout(frameTimer);
      clearInterval(frameTicker);
      ui.off("change", wakeGlow);
      glowLoop.stop();
      await glow.closing;
      if (caption.pane) await win.closeCaption(tmux, caption.pane);
      frame?.close();
      frame = null;
    },
  };
}
