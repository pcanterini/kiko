// The classic look's frame, from the app's side of the Kiko window (src/ui/window-glue.ts): the
// window's one line, its last, rendered here (src/ui/classic.ts) and sent to the window's frame pane
// over a socket of the app's (src/ui/window-frame.ts), up to 20 times a second while you talk (the
// waveform); and the caption, your words while you dictate, a box of its own over the window, made
// when words come and gone when you let go.
import { log } from "../core/log.ts";
import { ui } from "../core/ui-store.ts";
import * as win from "../terminals/tmux/window.ts";
import { FRAME_SOCKET } from "../terminals/tmux/classic.ts";
import { barTicks } from "./bar.ts";
import { captionLines, captionWidth, frameLines, quietLevels } from "./classic.ts";
import { pushLevel } from "./meter.ts";
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
  const caption = { pane: null as string | null, making: false, lines: 0 };

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
    const shown = frame.clients().find((c) => c.role === "frame");
    const size = shown ? { width: shown.cols, height: shown.rows } : windowSize;
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

  /**
   * The caption's box: made once words come while you talk (not before, so a press with nothing said
   * shows none), sized to the lines it has, gone when you let go. One at a time: one being made isn't
   * made again, and one made after you let go goes at the next draw.
   */
  function keepCaption(words: string[], size: win.Size | null) {
    const want = words.length > 0 && w.open && w.look === "classic" && Boolean(size);
    if (want && !caption.pane && !caption.making) {
      caption.making = true;
      caption.lines = words.length;
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
    } else if (want && caption.pane && size && words.length !== caption.lines) {
      caption.lines = words.length;
      void win.sizeCaption(tmux, caption.pane, size, words.length).catch(() => "");
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
    async stop() {
      if (frameTimer) clearTimeout(frameTimer);
      clearInterval(frameTicker);
      if (caption.pane) await win.closeCaption(tmux, caption.pane);
      frame?.close();
      frame = null;
    },
  };
}
