// The talk key's start in the app (native/macos/hotkey.swift through platform/macos/hotkey.ts). Its
// helper can't listen without Input Monitoring for the app it runs in (the helper app, "Kiko Dev";
// or, without it, the terminal app), and stops at once ("cannot create event tap"): until 2026-11-01
// that ended the app with a stack trace on its first start. Now it's said plainly, with where to
// turn it on, and the app goes on: the menu key and typing need no permission. With the helper app
// it's watched for: once it's on, the helper app is started again (macOS lets its tap in from its
// next launch) and the talk key with it, so nobody restarts anything.
// Never asked before, its helper does start (macOS makes the tap and shows its prompt, "… would like
// to receive keystrokes", then gives the tap nothing until it's allowed): on 2026-11-03 that prompt
// sat behind the terminal, the key did nothing, and nothing said why. So Input Monitoring is looked
// at once it's started too: not on, it's said (unheardLine, logged hotkey_unheard) and stays on the
// window's line (talkKeyBar) until it's on. macOS's prompt can't be brought forward from here
// (another process's window, owned by the system); the line says where it may be.
import { quitAndReopenLine, whereToTurnOn } from "../core/onboarding.ts";
import { COMMAND, NAME } from "../core/name.ts";
import type { Permission } from "../platform/types.ts";

/**
 * What's said when the talk key can't be heard: Input Monitoring off (`input`) for `app` (null:
 * can't be told), and where it's turned on (`pane`); anything else, why (`why`). `menu`: the menu
 * key, as said ("Ctrl+Space"), which still works. `own`: `app` is the helper app, watched for
 * (startTalkKey), so it starts by itself once it's on.
 */
export function talkKeyLine(o: { input: Permission; app: string | null; pane: string; menu: string; why: string; own?: boolean }): string {
  const rest = `${o.menu} and typing still work.`;
  if (o.input !== "granted" && o.own)
    return `The talk key needs Input Monitoring for ${o.app}: turn it on in ${whereToTurnOn(o.pane, o.app)}, and it starts by itself. ${rest} ${quitAndReopenLine(o.app ?? NAME)}`;
  if (o.input !== "granted")
    return `The talk key needs Input Monitoring for ${o.app ?? "your terminal app"}: turn it on in ${whereToTurnOn(o.pane, o.app)}, then restart ${NAME} (or run ${COMMAND} setup: it picks up at the talk key). ${rest}`;
  return `The talk key didn't start (${o.why}). ${rest}`;
}

/**
 * What's said when the talk key's helper listens but macOS doesn't let it hear yet: its prompt is up
 * (maybe behind this window) or was passed by. `key`: the talk key, as said ("Right Option").
 */
export function unheardLine(o: { app: string | null; key: string; pane: string; menu: string; own?: boolean }): string {
  const app = o.app ?? "your terminal app";
  const then = o.own ? `, and ${o.key} starts working by itself. ${o.menu} and typing still work. ${quitAndReopenLine(o.app ?? NAME)}` : `, then restart ${NAME}. ${o.menu} and typing still work.`;
  return `macOS is asking to let ${app} hear ${o.key}: its dialog may be behind this window. Allow it there, or turn it on in ${whereToTurnOn(o.pane, o.app)}${then}`;
}

/** The window's standing line while the talk key isn't heard: `asking`, its helper listens (macOS's prompt may be up); else it couldn't start. */
export function talkKeyBar(o: { app: string | null; key: string; asking: boolean }): string {
  const app = o.app ?? "your terminal app";
  return o.asking
    ? `${o.key} isn't heard: allow ${app} in macOS's dialog (maybe behind this window) or Settings → Input Monitoring`
    : `${o.key} isn't heard: turn on ${app} in System Settings → Privacy & Security → Input Monitoring`;
}

/** How often Input Monitoring is looked at again while the talk key waits for it (a new helper process each time). */
const WATCH_MS = 3000;

/**
 * Starts the talk key; when it can't, says why (talkKeyLine) and logs it, and resolves false rather
 * than throwing: the app runs on without it. `input`: Input Monitoring as it stands now.
 * `refresh` (the helper app holds the permissions): Input Monitoring is looked at every `watchMs`
 * until it's on; then the helper app is started again, the key with it, and `later` told.
 */
export async function startTalkKey(
  hotkey: { start(): Promise<void>; stop(): void },
  o: {
    input(): Promise<Permission>;
    app: string | null;
    pane: string;
    menu: string;
    /** The talk key, as said ("Right Option"). */
    key: string;
    say(line: string): void;
    /** The window's standing line about the talk key (talkKeyBar), null once there's nothing to say. */
    waits?(line: string | null): void;
    log(event: string, fields: Record<string, unknown>): void;
    refresh?: () => Promise<boolean>;
    later?: () => void;
    watchMs?: number;
  },
): Promise<boolean> {
  try {
    await hotkey.start();
  } catch (err) {
    hotkey.stop();
    const why = err instanceof Error ? err.message : String(err);
    const input = await o.input().catch((): Permission => "unknown");
    o.log("hotkey_failed", { why, input });
    const own = input !== "granted" && !!o.refresh;
    o.say(talkKeyLine({ input, app: o.app, pane: o.pane, menu: o.menu, why, own }));
    if (input !== "granted") o.waits?.(talkKeyBar({ app: o.app, key: o.key, asking: false }));
    if (own) watchForInput(hotkey, o);
    return false;
  }
  // Started; but never asked before, it hears nothing until macOS's prompt is answered. Unreadable: nothing said.
  const input = await o.input().catch(() => null);
  if (input === null || input === "granted") return true;
  o.log("hotkey_unheard", { input, app: o.app });
  o.say(unheardLine({ app: o.app, key: o.key, pane: o.pane, menu: o.menu, own: !!o.refresh }));
  o.waits?.(talkKeyBar({ app: o.app, key: o.key, asking: true }));
  if (o.refresh) watchForInput(hotkey, o);
  return true;
}

function watchForInput(hotkey: { start(): Promise<void>; stop(): void }, o: Parameters<typeof startTalkKey>[1]) {
  let looking = false;
  const timer = setInterval(async () => {
    if (looking) return;
    looking = true;
    try {
      if ((await o.input().catch(() => "unknown")) !== "granted") return;
      clearInterval(timer);
      o.waits?.(null);
      // A helper listening unheard (hotkey_unheard) goes first: its tap stays deaf until it's started again.
      hotkey.stop();
      await o.refresh!().catch(() => false);
      try {
        await hotkey.start();
        o.log("hotkey_started", { after: "input monitoring" });
        o.say("Input Monitoring is on: the talk key works now.");
        o.later?.();
      } catch (err) {
        hotkey.stop();
        const why = err instanceof Error ? err.message : String(err);
        o.log("hotkey_failed", { why, input: "granted", after: "input monitoring" });
        o.say(talkKeyLine({ input: "granted", app: o.app, pane: o.pane, menu: o.menu, why }));
      }
    } finally {
      looking = false;
    }
  }, o.watchMs ?? WATCH_MS);
  timer.unref?.();
}
