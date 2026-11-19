// The microphone's permission at the app's start, as the talk key's Input Monitoring is (./talk-key.ts).
// The mic helper starts without it and opens the mic on each press: with the microphone off for the
// app it runs in (the helper app, "Kiko Dev"; or, without it, the terminal app), every press hears
// silence, and nothing said why. That happens once setup has done the mic: the helper app renamed
// (its grants were the old name's), `tccutil reset`, or turned off in System Settings. Now it's
// looked at once as the app starts: not allowed, it's said (micLine, logged mic_unallowed) and stays
// on the window's line (micBar) until it is. With the helper app it's watched for: once it's on,
// the line's cleared; turned on in System Settings after being off, the helper app is started again
// too (a mic engine made while it was off may stay deaf), the mic helper coming back by itself
// (platform/macos/mic.ts), so nobody restarts anything. Allowed in macOS's own dialog (never asked
// before: the first press asks), nothing's started again: that would cut off the press that asked.
import { whereToTurnOn } from "../core/onboarding.ts";
import { COMMAND, NAME } from "../core/name.ts";
import type { Permission } from "../platform/types.ts";

/**
 * What's said when the microphone isn't allowed for `app` (null: can't be told): never asked
 * (`mic` "unknown": macOS asks the first time it listens, its dialog maybe behind this window), or
 * turned off. `pane`: where it's turned on. `own`: `app` is the helper app, watched for (checkMic).
 */
export function micLine(o: { mic: Permission; app: string | null; pane: string; own?: boolean }): string {
  const app = o.app ?? "your terminal app";
  const where = whereToTurnOn(o.pane, o.app);
  const then = o.own ? `, and ${NAME} hears you once it's on.` : `, then restart ${NAME} (or run ${COMMAND} setup: it asks for it again).`;
  return o.mic === "unknown"
    ? `macOS hasn't allowed the microphone for ${app} yet: allow it when macOS asks (its dialog may be behind this window), or turn it on in ${where}${then}`
    : `The microphone is off for ${app}: turn it on in ${where}${then}`;
}

/** The window's standing line while the microphone isn't allowed. */
export const micBar = (o: { app: string | null; pane: string }) => `The mic isn't allowed: turn it on in ${whereToTurnOn(o.pane, o.app)}`;

/** How often the microphone's permission is looked at again while it's off (a new helper process each time). */
const WATCH_MS = 3000;

/**
 * Looks at the microphone's permission once (`mic`: where it stands now); not granted, says why
 * (micLine), logs it and puts micBar on the window's line (`waits`). `refresh` (the helper app holds
 * the permissions): looked at every `watchMs` until it's on; then the line's cleared, the helper app
 * started again (unless it was never asked: macOS's dialog let the mic in), and `say` told. Unreadable: nothing said. Resolves whether it's allowed (true when
 * it can't be told).
 */
export async function checkMic(o: {
  mic(): Promise<Permission>;
  app: string | null;
  pane: string;
  say(line: string): void;
  /** The window's standing line about the mic (micBar), null once there's nothing to say. */
  waits?(line: string | null): void;
  log(event: string, fields: Record<string, unknown>): void;
  refresh?: () => Promise<boolean>;
  watchMs?: number;
}): Promise<boolean> {
  const mic = await o.mic().catch(() => null);
  if (mic === null || mic === "granted") return true;
  o.log("mic_unallowed", { mic, app: o.app });
  o.say(micLine({ mic, app: o.app, pane: o.pane, own: !!o.refresh }));
  o.waits?.(micBar({ app: o.app, pane: o.pane }));
  if (o.refresh) watchForMic(o, mic);
  return false;
}

function watchForMic(o: Parameters<typeof checkMic>[0], was: Permission) {
  let looking = false;
  const timer = setInterval(async () => {
    if (looking) return;
    looking = true;
    try {
      if ((await o.mic().catch(() => "unknown")) !== "granted") return;
      clearInterval(timer);
      o.waits?.(null);
      const restarted = was !== "unknown" && (await o.refresh!().catch(() => false));
      o.log("mic_allowed", { after: "watch", was, restarted });
      o.say("The microphone is allowed now.");
    } finally {
      looking = false;
    }
  }, o.watchMs ?? WATCH_MS);
  timer.unref?.();
}
