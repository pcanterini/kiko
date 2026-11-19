// Zoom, from the app's side of the Kiko window (src/ui/window-glue.ts): settings take the whole
// window (the list's pane zoomed), and back; tmux unzooming it (a click on the other pane, the menu's
// Tab) closes settings. One at a time, in order: a zoom and a look at whether tmux unzoomed it must
// never cross. The splash as the window opens (ui/splash.ts) has the whole window too: `kiko` made
// the window zoomed (or start.ts zoomed it) before the app started, so its first frame is the
// window's size; it stays zoomed until the splash leaves, then the list's pane goes back to its
// size before the list is drawn.
import { log } from "../core/log.ts";
import { ui, type UiState } from "../core/ui-store.ts";
import * as win from "../terminals/tmux/window.ts";
import type { WindowShared } from "./window-glue.ts";

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

export type WindowZoom = {
  /** The app's state changed: zoomed for settings, or back, unless it's tmux's unzoom being taken on board. */
  changed(s: UiState): void;
  /** The window resized: if tmux unzoomed it (not the app), settings close. */
  resized(): void;
  /** As the app starts: zoomed, kept so for the splash; else the list again, unzoomed (started zoomed: first-run setup, say). */
  start(): void;
};

/** How long a splash leaving is drawn blank before the pane goes back to the list's size: two of Ink's frames (tui.ts maxFps), so tmux never shows the logo cut short. */
const BLANK_MS = 70;
/** How long the list's size is waited for once unzoomed (tmux hands it to the pane a moment after), at most. */
const SIZED_MS = 600;

/** Zoom for startWindow's shared handles; nothing to do outside the window's list. */
export function windowZoom(w: WindowShared): WindowZoom {
  const { tmux, list } = w;
  // The splash keeps it zoomed while leaving too: leaveSplash unzooms it, then takes the splash away.
  const wantsZoom = (s: UiState) => Boolean(s.window && (s.screen === "settings" || s.splash));
  let zoomed = false; // what the app asked tmux for
  let zooming: Promise<void> = Promise.resolve();
  let following = false; // taking tmux's unzoom on board: no zooming back meanwhile
  const inTurn = (step: () => Promise<void>) => (zooming = zooming.then(step, step));
  function applyZoom() {
    if (!list) return;
    void inTurn(async () => {
      const want = wantsZoom(ui.state);
      if (want === zoomed) return;
      zoomed = want;
      await win.zoom(tmux, list, want).catch((err) => log("window_failed", { what: "zoom", error: why(err) }));
      // The boxes put back for the window's size now (it may have changed while zoomed).
      if (!want && w.look === "classic") await win.place(tmux).catch(() => {});
    });
  }
  // Unzoomed by tmux, not the app (a click on the other pane, the menu's Tab): settings close then.
  // (The list's width after the window resizes is tmux's own doing: window.ts RESIZED_HOOK.)
  function resized() {
    if (!list) return;
    void inTurn(async () => {
      if (!zoomed) return;
      const flag = (await tmux(["display", "-p", "-t", list, "#{window_zoomed_flag}"]).catch(() => "1")).trim();
      if (flag === "1") return;
      zoomed = false;
      if (w.look === "classic") await win.place(tmux).catch(() => {});
      following = true;
      try {
        if (ui.state.splash && !ui.state.splash.leaving) ui.act({ type: "skipSplash" });
        if (ui.state.screen === "settings") ui.act({ type: "closeSettings" });
      } finally {
        following = false;
      }
    });
  }

  /** The pane at the list's size, as this process sees it (tmux says it a moment after it unzooms), or SIZED_MS gone by. */
  async function sized() {
    if (!list) return;
    const width = Number((await tmux(["display", "-p", "-t", list, "#{pane_width}"]).catch(() => "")).trim());
    for (let waited = 0; width && process.stdout.columns !== width && waited < SIZED_MS; waited += 25) await new Promise((r) => setTimeout(r, 25));
  }

  /**
   * The splash leaving: drawn blank a moment (tui.ts), the pane back to the list's size unless
   * settings want it whole, that size waited for, then the splash gone, so the list's first frame is
   * drawn at its own size. In turn with the zooms.
   */
  let leaving = false;
  function leaveSplash() {
    if (leaving) return;
    leaving = true;
    void inTurn(async () => {
      try {
        await new Promise((r) => setTimeout(r, BLANK_MS));
        if (list && zoomed && ui.state.screen !== "settings") {
          zoomed = false;
          await win.zoom(tmux, list, false).catch((err) => log("window_failed", { what: "zoom", error: why(err) }));
          if (w.look === "classic") await win.place(tmux).catch(() => {});
          await sized();
        }
      } finally {
        leaving = false;
        if (ui.state.splash) ui.set({ splash: null });
      }
    });
  }

  return {
    changed(s) {
      if (s.splash?.leaving) leaveSplash();
      if (list && !following && wantsZoom(s) !== zoomed) applyZoom();
    },
    resized,
    start() {
      if (!list) return;
      if (wantsZoom(ui.state)) applyZoom();
      else void inTurn(() => win.zoom(tmux, list, false).catch(() => {}));
    },
  };
}
