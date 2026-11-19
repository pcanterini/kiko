// What's said when the router can't answer (offline, a timeout, an error), and when the words kept
// then go, or can't. Added 2026-11-12: the Mac's internet dropped and two messages for Rowan were lost with "Something went wrong, and I didn't
// send that." Now the words are kept (core/kept.ts) and routed again by themselves until the router
// answers (app/deliver.ts retryKept). No session is ever guessed: only the router or a name sends them.

/** Why the router gave no answer: the network known to be down, or anything else (a timeout, an error). */
export type FallbackWhy = "offline" | "failed";

/** Words routed again later this long after they were said are asked about first: the session may have moved on. */
export const STALE_MS = 2 * 60_000;

/** Said once as the words are kept: they're retried by themselves. */
export function keptLine(why: FallbackWhy) {
  return why === "offline" ? "I'm offline. I'll send that when I'm back." : "I couldn't work out where that goes. Trying again.";
}

/** Said for words that were the app's to deal with (a question about a session, the dictionary): nothing to keep. */
export function notDoneLine(why: FallbackWhy) {
  return why === "offline" ? "I'm offline, so I couldn't do that. Ask again once I'm back." : "Something went wrong, so I couldn't do that. Ask again in a moment.";
}

/** The retries stopped with words still unsent (kept.ts RETRY_MAX, RETRY_FOR_MS): kept for "send it" or a name. */
export function gaveUpLine(count: number) {
  return count > 1 ? "I couldn't send those. Say send them to try again." : "I couldn't send that. Say send it to try again.";
}

/** A retry got them there. */
export const sentLine = (name: string) => `Sent to ${name}.`;

/** A retry would send them long after they were said (STALE_MS): asked first, a yes sends them. */
export const staleLine = (words: string, name: string) => `Still send "${words}" to ${name}?`;

/** "Send it." when nothing is kept, and the router can't say what else it could mean. */
export const NOTHING_KEPT_LINE = "There's nothing waiting to send.";

/** Anything else that went wrong while your words were dealt with (app/talk.ts act): kept all the same. */
export const FAILED_KEPT_LINE = "Something went wrong, so I didn't send that. Say send it to try again.";

/** Said once as the network comes back, only while words are kept that the retries gave up on. */
export function backLine(count: number) {
  return count > 1 ? `I'm back online. Your last ${count} messages are still waiting: say send them.` : "I'm back online. Your last message is still waiting: say send it, or the session's name.";
}
