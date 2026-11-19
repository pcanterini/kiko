// What Kiko says when the "Voice can" setting (Settings → Control → Voice can) stops something you
// asked by voice: what's off, exactly where it's turned on, and an offer to turn it on now. The
// words are the app's, never the router's: it's told to call the tool anyway (router.ts), and a
// line of its own that says something is off in settings is replaced with one of these (decide.ts).
// "Turn it on" (or a plain yes, with no session waiting for a reply) right after sets Voice can to
// Everything and carries out what was asked (app/session-ops.ts allowed, deliver.ts "voice_on"). Said
// as a statement, not a question: a question would have the app read whatever you say next as its
// answer (decide.ts appAsked), and words for a session would go the router's way instead.
import type { VoiceCan } from "./settings.ts";

/** What Voice can stopped: starting, stopping or renaming a session, a quick check, the dictionary, a message, a folder's trust. */
type VoiceOff = "start" | "stop" | "rename" | "check" | "dictionary" | "message" | "trust";

/** The level that allows everything: what "turn it on" sets. */
export const VOICE_ON: VoiceCan = "everything";

/** The setting's path, as shown on screen. */
export const VOICE_CAN_PATH = "Settings → Control → Voice can";

const OFF: Record<Exclude<VoiceOff, "message">, string> = {
  start: "Starting sessions by voice is off.",
  stop: "Stopping sessions by voice is off.",
  rename: "Renaming sessions by voice is off.",
  check: "Checking your computer by voice is off.",
  dictionary: "Changing the dictionary by voice is off.",
  trust: "Trusting a folder by voice is off.",
};

/**
 * How each line ends: the offer. `carries`: what was asked is kept and done once it's on (else
 * you're asked to say it again then). A message's is sent; a trust prompt's answer is given.
 */
export function turnOnSay(what: VoiceOff, carries = true): string {
  if (!carries) return "Say turn it on to allow it now.";
  return `Say turn it on, and I'll ${what === "message" ? "send it" : what === "trust" ? "answer it" : "do it now"}.`;
}

/** The setting's path, as said: the voice reads no arrows. */
export const VOICE_CAN_SAID = "In Settings, under Control, Voice can: Everything turns it on.";

/**
 * The line said when Voice can stops `what`: what's off, where it's turned on, and the offer.
 * `name`: the session a message was for, when another one waits (Replies only: it isn't waiting
 * for a reply). `carries`: what was asked is kept for then (turnOnSay). `off`: the first sentence instead of the usual one ("Stopping sessions by voice is
 * off, so Lacy will carry on with that.").
 */
export function voiceOffLine(what: VoiceOff, { name, off, carries = true }: { name?: string; off?: string; carries?: boolean } = {}): string {
  const first =
    off ?? (what === "message" ? `${name ? `${name} isn't waiting for a reply` : "Nothing's waiting for a reply right now"}, and your voice can only answer a session that's waiting.` : OFF[what]);
  return `${first} ${VOICE_CAN_SAID} ${turnOnSay(what, carries)}`;
}

/** The same, as shown: the path with arrows, and what to say. */
export function voiceOffShown(what: VoiceOff): string {
  const doing = what === "message" ? "Sending to a session that isn't waiting" : OFF[what].replace(/ by voice is off\.$/, "");
  return `(${doing} by voice: ${VOICE_CAN_PATH} → Everything turns it on. Say “turn it on” to allow it now.)`;
}

// "Turn it on", "yes, turn it on", "enable it", "allow it", "switch it on", "turn on everything",
// "set it to everything": taking the offer. A plain yes is read with YES_FALLBACK (decide.ts).
export const TURN_ON =
  /^\W*(?:(?:yes|yeah|yep|sure|ok(?:ay)?|please|go ahead and|and)[\s,.!]+)*(?:turn (?:it|that) (?:back )?on|switch (?:it|that) on|enable (?:it|that)|allow (?:it|that)|(?:set|change|make) it (?:to )?everything|turn on everything|turn (?:it )?on\W*$|everything\W*$)/i;

// Words the router wrote that claim something is off in the settings ("Starting sessions is off in
// settings.", "That's turned off in the app's settings."): the app says its own line instead.
export const SAYS_OFF_IN_SETTINGS = /\b(?:is|are|'s|’s)\s+(?:turned\s+|switched\s+)?(?:off|disabled|not allowed)\b[^.?!]*\bsettings?\b|\boff in (?:the )?(?:app['’]?s )?settings\b/i;

/** What a router line that claims something is off in settings was most likely about, from the words you said. */
export function offFromWords(text: string): Exclude<VoiceOff, "message" | "trust"> {
  if (/\bdictionar(?:y|ies)\b/i.test(text)) return "dictionary";
  if (/\b(?:start|open|launch|spin up|create|make)\b|\bnew (?:session|project|one|thread|window)\b/i.test(text)) return "start";
  if (/\b(?:rename|call (?:it|this|that)|name (?:it|this|that))\b/i.test(text)) return "rename";
  if (/\b(?:stop|interrupt|cancel|kill)\b/i.test(text)) return "stop";
  return "check";
}
