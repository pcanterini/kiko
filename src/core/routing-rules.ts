// The rules and thresholds that decide where your words go, around the models: shared by the
// decision step (decide.ts), the app that carries it out (app.ts), and the tests.
import type { ApprovalDecision } from "./decisions.ts";
import { NAME, spokenName } from "./name.ts";
import type { VoiceCan } from "./settings.ts";
import { nameForms } from "./wake.ts";

export { isClosing } from "./closing-words.ts";

// The bars below were tuned on Jev's confidences and hold for d1-ultra, which now decides your words
// (checked on the benchmark, the live shadow logs and the routing eval).
// How sure the classifier must be that you're wrapping up or taking something back.
export const INTENT_MIN_CONFIDENCE = 0.7;
// At or above this, the classifier hears parts meant for the app in words for a session, and a quick model
// call trims them. On the logs, real routing asides scored 0.49–0.86 and normal messages 0.04–0.46;
// a wrong flag only costs the call's ~0.8s, since the trim must name a session to cut anything.
export const APP_PARTS = 0.5;
// Words that end by taking themselves back ("…if the build Actually, never mind.") are dropped when
// the text rule (retraction, below) finds that ending and the classifier's `retracted` question is at least this
// sure. The rule is what keeps it narrow; the classifier only gets a veto, so a clear lean is enough, above a
// coin flip since a wrong drop loses your words. Unchecked on the live model yet: the question was
// added after words that took themselves back were typed into a session.
export const RETRACTED_MIN = 0.6;
// When a session is waiting for your reply or just spoke, the classifier must be at least this sure to send
// your words to another one (and its own setting, if higher). On the eval, its wrong picks of
// another session scored 0.76–0.80 while one waited ("Sounds good." typed into the wrong session).
export const OTHER_THAN_PENDING = 0.9;
// Your words call a session by its name (sessions.ts calledByName) and the classifier picked that one
// too, at least this sure if below its bar: they go there (decide.ts). The case: 0.74 for kiko-dev
// on words that said "Kiko Dev" and "the Kikodev session", and the router sent them elsewhere.
export const NAMED_MIN_CONFIDENCE = 0.5;
// Without the classifier: the phrases that mean "repeat that", "yes" and "no".
export const REPEAT_FALLBACK = /\b(repeat( that| it)?|say (that|it) again|come again|what did you say)\b/i;
export const YES_FALLBACK = /^(yes|yeah|yep|sure|ok(ay)?|go ahead|do it|allow( it)?|approve( it)?)\b/i;
export const NO_FALLBACK = /^(no|nope|don'?t|deny|stop|cancel)\b/i;
// How long after the app asks you a question your next words are taken as the answer.
export const APP_QUESTION_MS = 45_000;
/** Whether the app's line asks you something: it ends in a question, or in "Say its name." after one. */
export const asksYou = (line: string) => /\?(?:\s+Say its name\.)?\s*$/.test(line.trim());
// "Ask all of them", "both sessions", "every project": words that want more than one session.
export const EVERY =
  /\b(?:all|every|each|both)\b(?:\s+(?:of\s+)?(?:the|my|them|these|those|two|three|four))*\s+(?:sessions?|ones?|projects?|instances?|claudes?|terminals?)\b|\b(?:everyone|everybody|all of them|each of them|both of them)\b|\b(?:ask|tell|check with)\s+(?:them\s+)?(?:all|both|each)\b/i;
// "Start a session in pixie", "open a new one", "start a Codex session": words that ask for a new
// session rather than work.
export const ASKED_FOR_NEW =
  /\b(start|open|launch|spin up|kick off) (up )?(a |an )?(new |another |fresh |separate )?(claude |codex |codecs |open ?code )?(code |cli )?(session|one|window|terminal|instance|claude|codex|open ?code)\b|\b(new|another|fresh|separate|second) (claude |codex |codecs |open ?code )?(code |cli )?(session|window|terminal|instance)\b/i;
/**
 * The app's names as one pattern, no groups: the product's (NAME) and the one you call it
 * (name.ts spokenName), with the spellings speech-to-text gives them (wake.ts nameForms). Made
 * again when the spoken name changes.
 */
let names: { spoken: string; forms: string } | null = null;
function appNames(): string {
  const spoken = spokenName();
  if (names?.spoken !== spoken) names = { spoken, forms: [...new Set([nameForms(NAME), nameForms(spoken)])].join("|") };
  return names.forms;
}
/** A pattern made from the app's names (appNames), kept until the spoken name changes. */
function withNames(make: (names: string) => RegExp): () => RegExp {
  let made: { forms: string; re: RegExp } | null = null;
  return () => {
    const forms = appNames();
    if (made?.forms !== forms) made = { forms, re: make(forms) };
    return made.re;
  };
}

// "Trust the scratch folder", "okay, trust Kiko's scratch area": the one-time step that has Claude
// Code trust the scratch folder (app/starting.ts trustScratch). Only the request itself, said to the app: in
// words for a session ("tell pixie to trust the scratch folder") it's that session's.
const trustScratchRe = withNames(
  (names) =>
    new RegExp(
      `^\\W*(?:(?:ok(?:ay)?|yes|yeah|sure|so|please|go ahead and|can you|could you)[\\s,]+)*trust\\s+(?:the\\s+|my\\s+|(?:${names})['’]?s\\s+|your\\s+)?scratch(?:\\s+(?:folder|area|directory|space))?(?:\\s+(?:folder|once|now|please))*\\W*$`,
      "iu",
    ),
);
/** Whether `text` asks the app to trust the scratch folder, as a whole ("Trust the scratch folder."). */
export const asksTrustScratch = (text: string) => trustScratchRe().test(text);
// "Upgrade to Pro", "buy Kiko Pro", "I'd like to upgrade": Kiko Pro's checkout opened in the
// browser (app/settings/account.ts startCheckout), while Pro is on sale. Only the request itself,
// said to the app; "upgrade" alone (or "upgrade now") only when no session waits for a reply or just
// spoke, since there it may answer it ("Should I upgrade the dependency?" "Upgrade."). Words for a
// session ("upgrade the dependencies", "tell pixie to upgrade to pro") are that session's.
const LEAD = `(?:(?:ok(?:ay)?|yes|yeah|sure|so|please|hey|alright|go ahead and|can you|could you|let's|let me|i(?:'d| would) like to|i want to|i wanna)[\\s,]+)*`;
// "…yearly", "…on the annual plan", "…for a year", "…monthly": which plan (upgradeInterval).
const INTERVAL = `(?:[\\s,]+(?:(?:on\\s+)?(?:the\\s+)?(?:yearly|annual|monthly)(?:\\s+plan)?|annually|(?:for|per)\\s+(?:a|one|the)\\s+(?:year|month)|(?:a|per)\\s+(?:year|month)))?`;
const TAIL = `${INTERVAL}(?:[\\s,]+(?:please|now|then|today|for me))*\\W*$`;
const upgradeProRe = withNames(
  (names) =>
    new RegExp(
      `^\\W*${LEAD}(?:upgrade(?:\\s+(?:me|this|my\\s+account))?\\s+to\\s+(?:(?:${names})\\s+)?pro|(?:buy|get|subscribe\\s+to|start)\\s+(?:(?:${names})\\s+)?pro(?:\\s+subscription)?|upgrade\\s+(?:${names}))${TAIL}`,
      "iu",
    ),
);
const UPGRADE_BARE = new RegExp(`^\\W*${LEAD}upgrade${TAIL}`, "iu");
/**
 * Whether `text` asks the app for Kiko Pro (above): "upgrade to Pro", "buy Kiko Pro" always; a bare
 * "upgrade" only when `bare` (nothing waits for a reply, nor just spoke).
 */
export const asksUpgrade = (text: string, o: { bare: boolean }) => upgradeProRe().test(text) || (o.bare && UPGRADE_BARE.test(text));
/** The plan asked for with it: yearly when the words say so ("upgrade to Pro yearly", "for a year"), else monthly. */
export const upgradeInterval = (text: string): "month" | "year" => (/\b(?:year|yearly|annual|annually)\b/i.test(text) ? "year" : "month");

// "Pair my phone", "connect my iPhone to Kiko", "how do I set up the iPhone app?", "turn on the
// phone": the app asked about the phone, answered in one line while the iPhone app isn't out
// (core/env.ts phoneLive; app/deliver.ts). Only the request itself, the whole of what was said:
// words for a session ("connect the phone number field to the form") are that session's.
const PHONE_LEAD = `(?:(?:ok(?:ay)?|so|please|hey|alright|can you|could you|would you|will you|let's|let me|help me|how (?:do|can) i|i(?:'d| would) like to|i want to|i wanna|i need to)[\\s,]+)*`;
const PHONE = `(?:(?:my|the|a|an)\\s+)?(?:new\\s+)?(?:i\\s?phone|phone)(?:\\s+app)?`;
const PHONE_ASK = `(?:(?:pair|connect|link|hook\\s+up|set\\s+up|add)\\s+${PHONE}|${PHONE}\\s+(?:pairing|set\\s?up)|turn\\s+(?:on\\s+${PHONE}|${PHONE}\\s+on)|(?:show\\s+(?:me\\s+)?)?the\\s+(?:pairing|qr)\\s+code(?:\\s+for\\s+${PHONE})?)`;
const phoneAskRe = withNames(
  (names) => new RegExp(`^\\W*${PHONE_LEAD}${PHONE_ASK}(?:[\\s,]+(?:to|with)\\s+(?:(?:this|the|my)\\s+)?(?:mac|computer|laptop|you|${names}))?(?:[\\s,]+(?:please|now|for me))*\\W*$`, "iu"),
);
/** Whether `text` (the app's name left out) asks the app to pair or set up the phone (above). */
export const asksPhone = (text: string) => phoneAskRe().test(text);
// "Stop", "stop it", "okay stop that": you cutting the app off, never a request to interrupt a session.
export const BARE_STOP = /^[\s,.!]*(?:(?:ok(?:ay)?|no|hey|wait|uh|um)[\s,.!]+)*(?:stop|cancel|enough|quiet|shush)(?:\s+(?:it|that|this|talking|now|please))*[\s.!]*$/i;
// Words that point at a session other than the one waiting without naming it ("tell that instance
// to stop", "ask the other one"), or say they aren't a reply to it ("unrelated, but …"): the
// waiting session doesn't take them over the pick of another (decide.ts keepWaiting).
export const POINTS_ELSEWHERE =
  /\b(?:the other|another|that|those) (?:one|session|instance|project|agent|terminal|window|claude)s?\b|\b(?:unrelated|on a different (?:note|topic)|(?:different|separate|another) (?:topic|subject|question)|chang(?:e|ing) (?:the )?(?:topic|subject))\b/i;
// Words said to the app by name in the middle or at the end of words for a session: "…, and Kiko,
// slow down when you read the results", "… Kiko, read me just the summary.", "…, Kiko, you don't need
// to read back the reply", "Thanks Kiko.", "… hold on Kiko, let me think, …", "…, Kiko." The name is who
// they're said to: a pause after it (or the end), and before it the start, a pause, or only words
// that open what's said to someone ("and", "oh", "hey", "hold on", "thanks"). Never the name as what
// the work is about: "the Kiko overlay doesn't show the latest text", "make Kiko's bars wider",
// "restart Kiko, then check the logs". The name up front is taken off before (wake.ts leadingName).
const TO_APP_OPENERS = "(?:and|but|so|oh|also|okay|ok|hey|hi|yo|wait|hold on|hang on|actually|alright|right|well|please|now|thanks|thank you|thanks again|thank you so much|thanks a lot)";
// Before the name: the start or a pause, then any openers; or, with no pause written, "and", "but",
// "oh" or "thanks" ("… run the tests and Kiko, slow down").
const appVocativeRe = withNames(
  (names) =>
    new RegExp(`(?<before>(?:(?:^|[,.;:!?…—–])\\s*|\\s+(?=(?:and|but|oh|thanks|thank you)\\s))(?:${TO_APP_OPENERS}[\\s,]+)*)(?<name>${names})(?![\\p{L}\\p{N}'’-])(?=\\s*(?:[,:;.!?…—–]|$))`, "giu"),
);
const startsSaidToAppRe = withNames((names) => new RegExp(`^\\W*(?:${TO_APP_OPENERS}[\\s,]+)*(?:${names})(?![\\p{L}\\p{N}'’-])`, "iu"));
/**
 * Where `text` says the app's name to it (above), past its start: each as the character range of
 * the name. Empty when it doesn't. For the trim (trim.ts), which may leave out a part said to the app
 * only when it starts at one of these.
 */
export function namesSaidToApp(text: string): Array<{ start: number; end: number }> {
  return [...text.matchAll(appVocativeRe())].map((m) => {
    const start = m.index + m.groups!.before.length;
    return { start, end: start + m.groups!.name.length };
  });
}
// What ends the words by thanking the app, or calling it by name: "… Thanks Kiko.", "…, thank you
// Kiko!", "…, Kiko." Never content: what's left is the words without it (appLeftOff).
const appAtEndRe = withNames(
  (names) => new RegExp(`(?:(?:^|[.!?…,;])\\s*(?:(?:ok(?:ay)?|oh|and)[\\s,]+)?(?:thanks|thank\\s+you)(?:\\s+(?:so\\s+much|a\\s+lot|again))?[\\s,]+|,\\s*)(?:${names})[\\s.!…]*$`, "iu"),
);
/**
 * `text` without a thanks to the app or its name at the very end ("Roll back. Thanks Kiko." → "Roll
 * back.", "Check the overlay, Kiko." → "Check the overlay."), read in code: the plain forms, which
 * need no model. Null when it doesn't end that way, or too little would be left (two words).
 */
export function appLeftOff(text: string): { text: string; dropped: string } | null {
  const m = appAtEndRe().exec(text);
  if (!m) return null;
  const before = text.slice(0, m.index);
  const kept = before.replace(/[\s,;:—–-]+$/, "");
  if (kept.split(/[^\p{L}\p{N}']+/u).filter(Boolean).length < 2) return null;
  const end = /[.!?]$/.test(kept) || !/[.!?…]/.test(m[0]) ? "" : /^[.!?]/.test(m[0]) ? m[0][0] : ".";
  return { text: `${kept}${end}`, dropped: m[0].replace(/^[\s.!?…,;]+/, "").trim() };
}

// What the app itself does with your words and its own: reading out, speaking, its voice and speed,
// answering aloud, listening, waiting. A "don't" said to the app is about this only when the words
// say so ("Kiko, you don't need to read back the reply"); "Kiko, don't change the colours" is most
// likely still for the session, and a "don't" lost there loses an instruction.
const APP_BEHAVIOUR =
  /\b(?:read(?:s|ing)?|say(?:s|ing)?|speak(?:s|ing)?|talk(?:s|ing)?|voice|slow(?:er|ly)?|fast(?:er)?|quick(?:er|ly)?|loud(?:er|ly)?|quiet(?:er|ly)?|speed|aloud|out\s+loud|listen(?:s|ing)?|wait(?:s|ing)?|summar(?:y|ies|ize|ise|izing|ising)|announce(?:s|ment)?|beep(?:s|ing)?|repeat(?:s|ing)?|reply|replies|replying|tell\s+me)\b/i;
/** Whether words said to the app are about its own behaviour (APP_BEHAVIOUR): reading out, voice, speed, listening, waiting. */
export const aboutAppBehaviour = (part: string) => APP_BEHAVIOUR.test(part);

const SAYS_NOT = /\b(?:not|no|never|don['’]?t|doesn['’]?t|didn['’]?t|can['’]?t|cannot|won['’]?t|shouldn['’]?t|isn['’]?t|nothing|none|without)\b/i;

/**
 * Each part of `text` said to the app by its name (namesSaidToApp), past the start: from the openers
 * before the name ("and Kiko, …") to the end of its sentence, as character ranges; `name`, the range
 * of the name itself. For what's cut in code (appWordsOff) and what the router's words may not carry
 * (decide.ts routerWordsOr).
 */
function appParts(text: string): Array<{ start: number; end: number; nameStart: number; nameEnd: number }> {
  const out: Array<{ start: number; end: number; nameStart: number; nameEnd: number }> = [];
  for (const m of text.matchAll(appVocativeRe())) {
    const before = m.groups!.before;
    const lead = /^(?:[,.;:!?…—–]\s*|\s+)?/.exec(before)![0];
    const nameStart = m.index + before.length;
    const nameEnd = nameStart + m.groups!.name.length;
    const stop = /[.!?…](?=\s|$)/g;
    stop.lastIndex = nameEnd;
    const end = stop.exec(text)?.index ?? text.length;
    out.push({ start: m.index + lead.length, end, nameStart, nameEnd });
  }
  return out;
}

/** The parts of `text` said to the app by name past its start ("and Kiko, slow down when you read the results"), as said. */
export function saidToAppParts(text: string): string[] {
  return appParts(text).map((p) => text.slice(p.start, p.end).trim());
}

/**
 * `text` without what's said to the app by name past its start, cut in code where it's plain: a
 * part about the app's own behaviour (aboutAppBehaviour: "…, and Kiko, slow down when you read the
 * results", "Kiko, read me just the summary.", "Kiko, you don't need to read back the reply") goes
 * whole; one with a "not" about anything else ("…, Kiko, don't change the colours", "Kiko, never push
 * to main") loses only the name, the instruction staying for the session (a lost "don't" is the worst
 * thing a cut can do). Others ("hold on Kiko, let me think") are left for the trim. Null when nothing's cut.
 */
export function appWordsOff(text: string): { text: string; dropped: string[] } | null {
  let out = text;
  const dropped: string[] = [];
  for (const p of appParts(text).reverse()) {
    const part = text.slice(p.nameStart, p.end);
    if (aboutAppBehaviour(part)) {
      dropped.unshift(text.slice(p.start, p.end).trim());
      out = `${out.slice(0, p.start)}${out.slice(p.end)}`;
    } else if (SAYS_NOT.test(part)) {
      const after = /^[\s,:;—–-]*/.exec(out.slice(p.nameEnd))![0];
      // The name only: "and", "oh" before it stay with the instruction ("…, and don't change …").
      dropped.unshift(text.slice(p.nameStart, p.nameEnd).trim());
      const tail = out.slice(p.nameEnd + after.length);
      const head = out.slice(0, p.nameStart);
      out = `${head}${/[.!?]\s*$/.test(head) || !head.trim() ? tail.charAt(0).toUpperCase() + tail.slice(1) : tail}`;
    }
  }
  if (!dropped.length) return null;
  const tidy = out
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/([.!?])\.+/g, "$1")
    .replace(/([,;])\1+/g, "$1")
    .replace(/[\s,;:—–-]+$/, "")
    .trim();
  const text2 = /[\p{L}\p{N}]/u.test(tidy) && !/[.!?…]$/.test(tidy) && /[.!?…]\s*$/.test(text) ? `${tidy}${text.trim().slice(-1)}` : tidy;
  return { text: text2.charAt(0).toUpperCase() + text2.slice(1), dropped };
}

/** A part that starts by saying the app's name to it ("and Kiko, slow down …", "Thanks Kiko"), as the trim may pick it. */
export const startsSaidToApp = (part: string) => startsSaidToAppRe().test(part);

// "The voice app's status bar", "this voice app", "the Kiko app": the session working on this app's code.
const voiceAppRe = withNames((names) => new RegExp(`\\bvoice[\\s-]?app\\b|(?<![\\p{L}\\p{N}])(?:${names})(?![\\p{L}\\p{N}])`, "iu"));
/** Whether `text` is about this app: "the voice app", or one of its names ("the Kiko app", "kiku's screen"). */
export const aboutVoiceApp = (text: string) => voiceAppRe().test(text);
// Phrases that take back or redirect what was just said ("never mind", "that was for clipkit")
// quoted as examples: "phrases like never mind", "support something like cancel that", "e.g.
// scratch that". Talk about the phrases, for a session, never the app's undo or redirect. A cue
// right before the phrase (or quotes) is what counts: a take-back of its own after one ("…like
// cancel that. Never mind.") stays ambiguous, and the classifier's read of it stands.
const TAKE_BACK =
  /\b(?:never ?mind|cancel (?:that|it)|scratch that|forget (?:it|that)|undo that|take (?:that|it) back|ignore (?:that|it)|wrong (?:session|one)|that was(?:n['’]?t| not)? (?:for|supposed|meant)|(?:i )?meant (?:that )?for|not that one|(?:send|move) (?:that|it) to [\w ]+ instead)\b/gi;
const QUOTE_CUE = /(?:\b(?:like|such as|e\.g\.?|for example|for instance|phrases?|phrasings?|examples?|support(?:s|ing)?|handle[sd]?|recogni[sz]e[sd]?|understands?)\W+|["“‘']\s*)$/i;

/**
 * Whether every take-back or correction phrase in the words is quoted as an example: after a cue,
 * or in a list after one ("phrases like never mind, or scratch that").
 */
export function quotesTakeBack(text: string) {
  const found = [...text.matchAll(TAKE_BACK)];
  let after = -1; // where the last quoted phrase ended
  for (const m of found) {
    const listed = after >= 0 && /^[\s,]*(?:and|or)?[\s,]*$/i.test(text.slice(after, m.index));
    if (!listed && !QUOTE_CUE.test(text.slice(0, m.index))) return false;
    after = m.index + m[0].length;
  }
  return found.length > 0;
}

// "Move that to lacy", "send it to clipkit instead": the last message, to another session, when
// the words name one ("send that to production" doesn't, and is a deploy).
export const MOVE_IT =
  /^\W*(?:(?:no|oops|sorry|actually|uh|um|wait|okay|ok)\W+)*(?:(?:move|put)\s+(?:that|it|this)(?:\s+(?:one|message))?\s+(?:over\s+)?to\b|(?:send|give|pass)\s+(?:that|it|this)(?:\s+(?:one|message))?\s+(?:over\s+)?to\b[^.?!]*\binstead\b)/i;
// "Never mind" alone, right after your words went to a session: take them back, not a wrap-up.
export const NEVER_MIND = /\bnever ?mind\b/i;
// "No, that's for Lacy, and also ask it whether it deployed": a correction with a request of its
// own after it, which only the router can carry out too (resend_to, then ask_session).
export const AND_ALSO = /\b(?:and|also|plus)\b[\s,]+(?:also\s+|then\s+)?(?:ask|tell|have|make|check|can you|could you|see|find out|let)\b/i;
// "Try again", "send it again": your words that just failed to reach a session (its terminal on
// Claude Code's agents list, say), sent there again as they were (decide.ts `retry`). Only the
// request itself: "try again with the other API" is words for a session.
export const TRY_AGAIN =
  /^[\s,.!]*(?:(?:ok(?:ay)?|now|so|yes|yeah|alright|please|uh|um)[\s,.!]+)*(?:try(?:\s+(?:it|that|sending\s+(?:it|that)))?\s+again|retry|resend(?:\s+(?:it|that))?|send\s+(?:it|that)\s+again)(?:[\s,]+(?:please|now|then))*[\s.!]*$/i;
// "Try again" counts for this long after your words failed to reach a session.
export const RETRY_MS = 120_000;
// "Send it", "send them now", "send my last message to Rowan": words kept when the router couldn't
// answer (core/kept.ts), sent (decide.ts keptFor, 2026-11-12). `name`, a session named after "to";
// one that's none is said ("I don't see a session called Bob."), the words still kept. Only the
// request itself: "send it to staging after the tests pass" is words for a session.
export const SEND_KEPT =
  /^\W*(?:(?:ok(?:ay)?|now|so|yes|yeah|yep|sure|alright|please|just|uh|um|go ahead and|you can)[\s,.!]+)*(?:send|pass|forward)\s+(?:it|that|them|those|(?:the|my)\s+(?:last\s+)?(?:message|messages|words|one))(?:\s+(?:now|again|along|on|over|through))*(?:\s+(?:to|for)\s+(?<name>[\w'’-]+(?:\s+[\w'’-]+){0,3}?))?(?:[\s,]+(?:now|please|then|again))*[\s.!]*$/i;
// "Never mind" takes back what went to a session within this long.
export const UNDO_WITHIN_MS = 120_000;
// "No, that was for clipkit" sends on what went to a session within this long.
export const REDIRECT_WITHIN_MS = 180_000;
// For this long after a finished turn is read out, your words most likely answer it, even once its
// reply window has closed: you were still thinking, or pressed the key a moment late.
export const JUST_SPOKE_MS = 45_000;
// For this long after an announcement starts making a sound, a press counts as one before it was
// heard (floor.ts deferUnheard): you were answering what came before it, not its first few words.
export const UNHEARD_FOR_MS = 1500;
/**
 * Whether an announcement has been heard by `at`: it made a sound (at `soundAt`), and has played
 * for `graceMs` since, or is over.
 */
export const heardBy = (soundAt: number | null, at: number, playing: boolean, graceMs = UNHEARD_FOR_MS) => soundAt !== null && (!playing || at - soundAt >= graceMs);

// Words with no request of their own: "Yeah.", "No.", "Sure, go ahead." mean something only to the
// session they answered.
const BARE = new Set(
  "yes yeah yep yup ya no nope nah sure ok okay alright right fine cool great good perfect sounds thanks thank you please go ahead do it that that's correct absolutely definitely uh um oh so and let's".split(
    " ",
  ),
);

/** Whether a reply is only yes, no or okay: meaningless sent anywhere but where it was said. */
export function bareReply(text: string) {
  const words = text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .split(/[^a-z']+/)
    .filter(Boolean);
  return words.length > 0 && words.length <= 6 && words.every((w) => BARE.has(w));
}

/**
 * Whether the "Voice can" level allows sending to a session that isn't waiting for a reply
 * ("message"), starting, stopping and renaming sessions ("manage"), quick read-only checks on
 * the computer ("check"), or changing the dictionary ("dictionary"). Replies to a waiting session
 * and answers to permission prompts always are. The dictionary rewrites everything you say from
 * then on, a change to the app's settings rather than a message, so it's with the other changes
 * at "everything"; the settings screen edits it at any level.
 */
export function voiceAllows(level: VoiceCan, what: "message" | "manage" | "check" | "dictionary") {
  return what === "message" ? level !== "replies" : level === "everything";
}

// "Add to dictionary: ghosty means Ghostty", "add clip kit to my dictionary as clipkit", "remove
// ghosty from the dictionary", "Dictionary: …": said as an instruction to the app, up front. These
// skip the classifier and go to the router (which may still pass them on: "add a search box to the dictionary
// page" is a project's work), and speech-to-text leaves them as said: the dictionary would fix the
// very word being added.
const DICT = "(?:the\\s+|my\\s+|your\\s+|our\\s+|this\\s+)?(?:app['’]?s\\s+|speech\\s+|voice\\s+)?dictionar(?:y|ies)";
export const DICTIONARY_REQUEST = new RegExp(
  `^\\W*(?:(?:ok(?:ay)?|uh|um|so|and|hey|also|please|can you|could you|would you|will you|go ahead and)[\\s,]+)*` +
    `(?:(?:add|put|save|remove|delete|drop|take|forget)\\b[^.?!]{0,80}?\\b(?:to|in|into|from|out of|off)\\s+${DICT}\\b|` +
    `(?:add|new)\\s+(?:an?\\s+)?${DICT}\\s+(?:entry|word)\\b|${DICT}\\s*[:,.—–-])`,
  "i",
);

/** Words about a dictionary at all: only then does the router offer the dictionary tools. */
export const MENTIONS_DICTIONARY = /\bdictionar(?:y|ies)\b/i;

// A request that starts with a change ("kill whatever's on port 3000", "can you delete the old
// screenshots"): a quick task can only look, so the app offers a session without running one.
export const CHANGE_REQUEST =
  /^\W*(?:(?:please|ok(?:ay)?|uh|um|so|and|hey|can you|could you|would you|will you|go ahead and)[\s,]+)*(?:kill|delete|remove|uninstall|install|move|rename|edit|write|create|commit|push|restart|reboot|shut ?down|empty|clean|clear|free up|update|upgrade|change|set|turn (?:on|off)|stop|start|launch|open|close|quit|copy|download|unzip|format|erase|eject)\b/i;

// While a quick task runs: "stop", "cancel that", "never mind", "stop checking" end it.
export const QUICK_CANCEL =
  /^[\s,.!]*(?:(?:ok(?:ay)?|no|hey|wait|uh|um|actually)[\s,.!]+)*(?:stop|cancel|never ?mind|forget)(?:\s+(?:it|that|this|the check|checking|the task|looking|now|please))*[\s.!]*$/i;

// While a send the app wasn't sure of is held (app/deliver.ts holdIf): "cancel", "never mind", "don't send
// that", "scratch that" drop it before it goes.
export const HELD_CANCEL =
  /^[\s,.!]*(?:(?:ok(?:ay)?|no|nope|hey|wait|uh|um|actually|oh)[\s,.!]+)*(?:stop|cancel|never ?mind|forget(?:\s+about)?|scratch|don'?t send|do not send)(?:\s+(?:it|that|this|please|now))*[\s.!]*$/i;

// The app asking which session your words are for: "Which session should it go to, Lacy or
// Kiko?", "Who's that for?", "Where should that go?" (decide.ts asksWhere). It also counts when
// the question names two sessions or more ("Lacy or Kiko?").
export const WHICH_SESSION =
  /\b(?:which|what)\s+(?:session|one|project|claude|terminal|instance|window)s?\b|\bwho(?:['’]s|\s+is|\s+was)?\s+(?:that|this|it)\s+(?:for|meant for)\b|\bwhere\s+(?:should|do|does|would|did)\b|\bshould\s+(?:it|that|this|I\s+send\s+(?:it|that|this))\s+go\b|\bfor\s+which\b/i;
// The app checking a name it guessed ("Did you mean Lacy?": decide.ts confirm_session, or the
// router's own words): yes sends the words it was about there, no drops them (decide.ts answerQuestion).
export const DID_YOU_MEAN = /\b(?:did|do)\s+you\s+mean\b|\bwas\s+(?:that|it|this)\s+(?:for|meant\s+for)\b/i;
// The app (or the router in its own words) offering to send your words to a session: "Want me to send
// that to Bobby?" (decide.ts offer_session), "I can pass your question along to Bobby if you want." A
// yes sends the words it was about there (decide.ts answerQuestion, Question.offer). The case: the
// router's free-text offer, and "Yes, pass it to Bobby." typed into Bobby by itself.
export const OFFERS_SESSION = /\b(?:i\s+can|i\s+could|i'?ll|i\s+will|want\s+me\s+to|shall\s+i|should\s+i|happy\s+to)\s+(?:\w+\s+){0,2}?(?:pass|send|forward|hand|relay|ask|bring)\b/i;
// A yes to that offer, and nothing else: "Yes.", "Yeah, pass it to Bobby.", "Send it.", "Go ahead.",
// "Do it, please." (with the offered session's name, decide.ts offerAccepted). A word of its own
// ("Yes, and ask it about WireGuard") makes it more than a yes: the router reads that.
export const OFFER_YES = new Set("yes yeah yep yup ya sure ok okay alright please do go ahead send pass forward give hand absolutely definitely".split(" "));
export const OFFER_FILLER = new Set("it it's that this them there along on over to for him her thanks thank you just then now right of course thing uh um oh so well and the session one".split(" "));
// "No", "not", "don't", "wait": never a yes, whatever else is in it.
export const OFFER_NOT = new Set("no nope nah not don't dont never wait stop cancel".split(" "));
// A question about something other than a message ("Which one should I stop, Lacy or Clipkit?"):
// a bare name after it isn't an answer that sends your words anywhere.
export const NOT_A_MESSAGE_QUESTION = /\b(?:stop|interrupt|rename|start|open|close)\b/i;
// For this long after the app asks where your words go, an answer that picks a session sends them
// there; your next words settle it either way (app/deliver.ts deliver).
export const QUESTION_MS = 60_000;
// "Neither", "none of them", "nowhere": no session gets the words the app asked about.
const NONE_OF_THEM =
  /^[\s,.!]*(?:(?:ok(?:ay)?|no|nope|nah|uh|um|oh|actually|hmm)[\s,.!]+)*(?:neither(?:\s+(?:one|of\s+them))?|none(?:\s+of\s+(?:them|those))?|nowhere|nobody|no\s*one|no\s+session)(?:[\s,]+(?:please|thanks|actually|then|of\s+them))*[\s.!]*$/i;

/**
 * "Never mind", "cancel", "neither", or an answer that ends by taking itself back ("Lacy, actually,
 * never mind", "Yes. Never mind."): the words the app asked about ("which session?", "Did you mean
 * Lacy?") go nowhere. A take-back with a pick after it ("Lacy. Never mind, Kiko.") picks again.
 */
export const dropsQuestion = (text: string) => HELD_CANCEL.test(text) || NONE_OF_THEM.test(text) || (endsInTakeBack(text) && answerTakenBack(text) !== null);

/** Whether the words end in a take-back ("…never mind.", "…forget it, sorry"), whatever comes before it. */
export const endsInTakeBack = (text: string) => RETRACT_END.test(text);

// The take-back that ends the words, and anything after it that changes nothing ("…never mind, sorry").
const RETRACT_END = /\b(?:never[\s-]?mind|forget (?:it|that)|scratch that|disregard (?:it|that))(?:[\s,.!]+(?:sorry|then))*[\s.!…]*$/i;
// A word right before it that turns away from what was being said. "Actually" and "oh" do anywhere
// ("if the build Actually, never mind"); the rest only after a pause or at the start ("check the,
// wait, never mind"; "No, never mind."), since "make you wait, never mind" and "the answer is no,
// never mind" use them as words.
const RETRACT_CUE = /(?<sep>[^\p{L}\p{N}']*)\b(?<cue>actually|oh|wait|nope|no|uh|um|umm|hmm|ah)[\s,]*$/iu;
const STRONG_CUE = /^(?:actually|oh|wait|nope|no)$/i;
// Words cut off before it: "So what about the — forget it.", "Can you check the… never mind."
const CUT_OFF = /(?:—|–|--|\s-|…|\.\.\.)[\s,]*$/;
// Right before the take-back, words that quote it: "the button says, actually, never mind".
const SAYS = /\b(?:say|says|said|saying|word|words|phrase|called|reads?|typed?)\W*$/i;
// What the take-back may belong to rather than take back (only trusted on a cue like "actually"):
// "Tell Lacy to, um, scratch that." tells Lacy; "If the build fails, uh, never mind." is a condition.
const GOVERNED = /\b(?:to|tell|ask|have|let|get)\W*$|^\W*(?:(?:ok(?:ay)?|so|and|please|uh|um)\W+)*(?:tell|ask|have|get|let)\b[^.?!]{0,40}$/i;
const CONDITION = /\b(?:if|when|unless|once|in case|otherwise)\b[^.?!]*$/i;
// Words that say nothing of their own before a take-back: "Okay, actually, never mind." is a bare
// take-back (isClosing, the classifier's undo), not words taking themselves back.
const NOTHING_SAID = new Set("ok okay so yeah yes yep no nope um umm uh oh wait actually hmm ah cool alright right sure well sorry and but".split(" "));

/**
 * Whether the words end by taking themselves back after saying something ("So just to confirm, if
 * the tests pass … Actually, never mind."). "strict": a cue right before the take-back ("actually, never mind", "oh, forget it",
 * "wait, scratch that", "No, never mind."); "loose": only a filler ("um, never mind") or words cut
 * off ("what about the — forget it"). Null for words that only end in the phrase ("…something like
 * cancel that. Never mind."; "if the build fails, never mind"), use it as words
 * ("never mind the tests, just deploy", "tell Lacy to forget it"), quote it, or say nothing else.
 */
export function retraction(text: string): "strict" | "loose" | null {
  const end = RETRACT_END.exec(text);
  if (!end) return null;
  let before = text.slice(0, end.index);
  let strong = false;
  let weak = false;
  for (let m = RETRACT_CUE.exec(before); m; m = RETRACT_CUE.exec(before)) {
    const { sep, cue } = m.groups!;
    const anywhere = /^(?:actually|oh)$/i.test(cue);
    // "wait", "no" and the fillers: after a pause (a comma, a stop, a dash) or at the start.
    if (!anywhere && m.index > 0 && !/[^\s]/.test(sep)) break;
    if (STRONG_CUE.test(cue)) strong = true;
    else weak = true;
    before = before.slice(0, m.index + sep.length);
  }
  if (!strong && !weak && !CUT_OFF.test(before)) return null;
  const said = before
    .toLowerCase()
    .replace(/[’]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
  if (!said.some((w) => !NOTHING_SAID.has(w))) return null;
  if (QUOTE_CUE.test(before) || SAYS.test(before)) return null;
  if (strong) return "strict";
  return GOVERNED.test(before) || CONDITION.test(before) ? null : "loose";
}

// A take-back said as one, a pause or the end after it: "Yes, never mind.", "forget it, sorry"; not
// "never mind the tests" or "forget that test" (words of their own).
const TAKE_BACK_SAID = /\b(?:never[\s-]?mind|forget (?:it|that)|scratch that|disregard (?:it|that))(?=\s*(?:[,.!?;:…—–-]|$))/gi;
// "Don't forget it", "I won't disregard that": not one.
const NEGATED = /\b(?:don'?t|do not|won'?t|will not|never|not)\s*$/i;
// After a take-back, only a clear yes takes it back in turn: "Yeah, never mind, do it." Not "okay"
// or "sure", which as often only acknowledge.
const CLEAR_YES = /^(?:yes|yeah|yep|yup|do it|go ahead|go for it|please do)(?:[\s,]+(?:yes|yeah|do it|go ahead|please|then|now))*[\s.!]*$/i;
// Before a take-back, words that only say no ("No, never mind.", "Nope, forget it."): it's a no.
const NO_WORDS = new Set("no nope nah um umm uh oh ah hmm actually wait well so".split(" "));

/**
 * An answer to a question asked with a yes or a no ("Stop Lacy?", "Did you mean Lacy?", "Allow?")
 * that takes itself back, read in code, never a model: "taken" when it says something first ("Yes.
 * Actually, never mind.", "Yeah, forget it.", "Lacy, oh, never mind", "Yeah, never mind, I'll do it
 * myself"), so a "yes" up front confirms nothing; "no" when only a no or fillers come before it
 * ("Never mind.", "No, never mind."). Null with none, or when a clear yes ends it ("Yeah, never mind,
 * do it": what comes last stands), or the phrase is quoted, negated or told to someone ("Yes, and
 * tell it to forget it"). Wider than retraction(): an answer is short and only confirms or doesn't,
 * so a wrong read costs only being asked again; acting on a yes that was taken back can stop a session.
 */
export function answerTakenBack(text: string): "taken" | "no" | null {
  if (retraction(text) === "strict") return "taken";
  const last = [...text.matchAll(TAKE_BACK_SAID)]
    .filter((m) => {
      const before = text.slice(0, m.index);
      return !QUOTE_CUE.test(before) && !SAYS.test(before) && !GOVERNED.test(before) && !NEGATED.test(before);
    })
    .at(-1);
  if (!last) return null;
  const after = text.slice(last.index + last[0].length).replace(/^[\s,.;:!?…—–-]+/, "");
  if (CLEAR_YES.test(after)) return null;
  const said = text
    .slice(0, last.index)
    .toLowerCase()
    .replace(/[’]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
  return said.every((w) => NO_WORDS.has(w)) ? "no" : "taken";
}

// "Can you hear me?", "Are you there?", "Testing, one, two, three.", "Hello?": checking that the app
// hears you. Only the app hears you, so it answers, at once and with no model ("Yes, I hear you.",
// "I'm here."), whoever you dealt with last: left to the classifier, such a check right after a
// session spoke was typed into that session, which answered it as best it could. Only words made of
// nothing else: each part (between commas, full stops, question marks) is a check, or filler around
// one ("hey", "okay", "one more time", the app's name). So "testing the api endpoint now", "can you
// hear the audio in the video" and "can you hear me? Also fix the build" stay a session's, as does a
// check that names one ("Lacy, are you there?"; "Test, are you there?" with a session called test).
// Less clear ones ("did you get that?", "testing a setting, just confirm you can hear me") are the
// classifier's (decisions.ts names these checks as the app's) and the router's.
const NUMBER = String.raw`one|two|three|four|five|six|seven|eight|nine|ten|\d+`;
const HEAR_ME = String.raw`(?:(?:can|could|do|did)\s+)?you\s+(?:(?:still|actually|even|really|now)\s+)?(?:hear|hearing)\s+me|are\s+you\s+(?:(?:still|actually)\s+)?hearing\s+me`;
const HEAR_TAIL = String.raw`(?:\s+(?:now|still|okay|ok|alright|all\s+right|clearly|properly|fine|well|at\s+all|right\s+now|there|again|too|yet))*`;
const THERE = String.raw`(?:are\s+)?you\s+(?:(?:still|actually|even)\s+)?(?:there|here|listening|awake|with\s+me|around|on)|(?:is\s+)?(?:any(?:one|body)|some(?:one|body))\s+(?:there|here|listening|home)|(?:do\s+)?you\s+copy`;
const TESTING = String.raw`(?:(?:i'?m|i\s+am|we'?re|just|only|this\s+is|it'?s)\s+)*(?:testing|test|a\s+test|a\s+mic\s+check|mic\s+check)(?:\s+(?:testing|test))*(?:\s+(?:the\s+|my\s+)?(?:mic|microphone))?(?:\s+(?:${NUMBER}))*`;
const WORKING = String.raw`(?:is\s+)?(?:this(?:\s+thing)?|the\s+mic|my\s+mic|the\s+microphone|my\s+microphone)\s+(?:on|working)|(?:just\s+)?(?:checking|making\s+sure|seeing)\s+(?:(?:that|if|whether)\s+)?(?:you\s+(?:can\s+)?hear\s+me|(?:this|it|the\s+mic)\s+(?:works|is\s+working|is\s+on))`;
const HEAR_CHECK = new RegExp(`^(?:${HEAR_ME})${HEAR_TAIL}$|^(?:${TESTING})$|^(?:${WORKING})$`, "i");
const THERE_CHECK = new RegExp(`^(?:${THERE})(?:\\s+(?:still|now|right\\s+now))*$`, "i");
// "Hello?", "Anyone?", "Hello, hello.": a check when asked, or said twice; "Hello." alone is filler.
const HELLO = /^(?:hello|hey|hi|anyone|anybody)(?:\s+(?:hello|hey|there))*$/i;
const livenessFiller = withNames(
  (names) =>
    new RegExp(
      `^(?:hey|hi|hello|yo|ok(?:ay)?|so|and|uh+|um+|oh|ah|hm+|well|yeah|yes|yep|alright|all\\s+right|what'?s\\s+up|one\\s+more\\s+time|once\\s+more|again|sorry|still|now|quick(?:\\s+check)?|just\\s+checking|checking|${NUMBER}|(?:hey\\s+)?(?:${names}))$`,
      "iu",
    ),
);

/**
 * Whether the whole of `text` only checks the app hears you, and how it's best answered: "hear"
 * ("Can you hear me?", "Testing.", "Is this on?"), "here" ("Are you there?", "Hello?"); null when
 * it's anything more, or a part of it is a session's name (`isSession`), which then gets it.
 */
export function livenessCheck(text: string, isSession: (part: string) => boolean = () => false): "hear" | "here" | null {
  const parts = [
    ...text
      .toLowerCase()
      .replace(/[’‘`]/g, "'")
      .replace(/["“”]/g, "")
      .matchAll(/([^,.!?;:…—–]+)([,.!?;:…—–]*)/g),
  ]
    .map((m) => ({ words: m[1].trim().replace(/\s+/g, " ").replace(/-/g, " "), asked: m[2].includes("?") }))
    .filter((p) => p.words);
  if (!parts.length || parts.reduce((n, p) => n + p.words.split(" ").length, 0) > 16) return null;
  let kind: "hear" | "here" | null = null;
  const hellos = parts.filter((p) => HELLO.test(p.words)).length;
  for (const p of parts) {
    if (isSession(p.words)) return null;
    if (HEAR_CHECK.test(p.words)) kind = "hear";
    else if (THERE_CHECK.test(p.words) || (HELLO.test(p.words) && (p.asked || hellos > 1))) kind ??= "here";
    else if (!livenessFiller().test(p.words)) return null;
  }
  return kind;
}

/** What the app says to a liveness check: short, and not the same twice in a row (`n`, a count the caller keeps). */
export function livenessLine(kind: "hear" | "here", n: number): string {
  const lines = kind === "hear" ? ["Yes, I hear you.", "Loud and clear.", "I hear you.", "Yep, I can hear you."] : ["I'm here.", "Yes, I'm here.", "Still here.", "Here."];
  return lines[Math.abs(Math.trunc(n)) % lines.length];
}

// "Skip that", "skip it", "okay, just skip this one": while an announcement you haven't heard waits
// (your press put it back, or it's next in line), it isn't made (app/deliver.ts skip). Only "skip": "never
// mind" takes back your last words, and "stop" or "cancel" only cut the app off, or drop a held send.
export const SKIP =
  /^[\s,.!]*(?:(?:ok(?:ay)?|no|nah|nope|hey|wait|uh|um|actually|oh|yeah|just)[\s,.!]+)*(?:just\s+)?skip(?:\s+(?:it|that|this|that one|this one|the announcement|the rest))?(?:[\s,]+(?:please|now|for now|thanks))*[\s.!]*$/i;

// "More", "tell me more", "details", "what else?", "more about the failing tests", "what did it say
// about the migration?", "Lacy, more": a longer summary of the reply you last heard summed up (or the
// named session's), or all it says about one part (summarizer.ts more). A command to the app, read in
// code like "skip that", never words for the session: "tell me more" typed into Claude would get a new
// turn about it, not what it already said. Only the whole of your words, so "what else is left to
// test?" and "what about Germany?" still go to the session as they always did.
const MORE_LEAD = String.raw`^\W*(?:(?:ok(?:ay)?|so|and|hey|uh|um|oh|yeah|yes|wait|hmm|cool|great|nice|right|alright|all right|sorry)[\s,.!]+)*`;
const MORE_NAME = String.raw`(?:([\p{L}\p{N}' .-]{1,40}?)[,:]\s*)?`;
const MORE_ASK = String.raw`(?:(?:can|could|would|will) you\s+|please\s+)?`;
const MORE_CORE = String.raw`(?:(?:tell|give) me (?:a (?:little |bit )?|some )?more(?: details?| info(?:rmation)?)?|say (?:a (?:little |bit )?)?more|(?:a (?:little |bit )?|some )?more(?: details?| info(?:rmation)?)?|go on|keep going|(?:more |the |some |any )?details|what else(?: did (?:it|he|she|they) say)?|elaborate|expand(?: on (?:that|it|this))?)`;
const MORE_TAIL = String.raw`(?:[\s,]+(about|on|regarding|for|from|in|of)\s+(.+?))?(?:[\s,]+please)?[\s.!?]*$`;
const MORE = new RegExp(`${MORE_LEAD}${MORE_NAME}${MORE_ASK}${MORE_CORE}${MORE_TAIL}`, "iu");
const SAID_ABOUT = new RegExp(
  String.raw`${MORE_LEAD}${MORE_NAME}(?:so\s+)?what (?:else |exactly )?did (?:it|he|she|they|(.{1,40}?)) (?:say|mention|write|find|tell (?:me|you)) (?:about|on|regarding) (.+?)[\s.!?]*$`,
  "iu",
);
// "More about that": the reply as a whole, not a topic called "that".
const NO_TOPIC = /^(?:that|this|it|them|those|these|the reply|what it said|its reply|that one|this one)$/i;

/**
 * "More" (MORE, SAID_ABOUT), read: `topic`, what you want more about in your words (null: the whole
 * reply); `names`, words that may name the session it's about ("Lacy, more", "more from Lacy", "what
 * did Lacy say about…"), for decide() to match to one; `lead`, the first of them came up front, where
 * it must be a session's name for the words to be a "more" at all. Null: not a "more".
 */
export function moreRequest(text: string): { topic: string | null; names: string[]; lead: boolean } | null {
  const said = SAID_ABOUT.exec(text);
  if (said) {
    const names = [said[1], said[2]].filter((n): n is string => Boolean(n?.trim())).map((n) => n.trim());
    const topic = said[3].trim();
    return { topic: NO_TOPIC.test(topic) ? null : topic, names, lead: Boolean(said[1]?.trim()) };
  }
  const m = MORE.exec(text);
  if (!m) return null;
  const names = m[1]?.trim() ? [m[1].trim()] : [];
  let topic: string | null = null;
  const [prep, rest] = [m[2]?.toLowerCase(), m[3]?.trim()];
  if (rest) {
    if (prep === "from" || prep === "in") names.push(rest);
    else {
      // "More about the failing tests in Lacy": the topic, and the session after it.
      const where = /^(.+?)\s+(?:in|from)\s+(.+)$/i.exec(rest);
      topic = where ? where[1] : rest;
      if (where) names.push(where[2]);
      // "More about Lacy": the session, when it's one's name (decide.ts checks).
      if (!where) names.push(rest);
    }
  }
  return { topic: topic && !NO_TOPIC.test(topic) ? topic : null, names, lead: Boolean(m[1]?.trim()) };
}

/** Your answer to a permission prompt: the classifier's when it's sure, else unclear; phrases without the classifier. */
export function permissionAnswer(text: string, d: ApprovalDecision | null): ApprovalDecision["answer"] {
  if (d) return d.confidence >= INTENT_MIN_CONFIDENCE ? d.answer : "unclear";
  return REPEAT_FALLBACK.test(text) ? "repeat" : YES_FALLBACK.test(text) ? "allow" : NO_FALLBACK.test(text) ? "deny" : "unclear";
}

// "Kiko, say nginx as engine-x", "pronounce tmux like tee mux", "from now on say Vite as veet":
// how the voice should say a word (pronunciation.ts), for the voice in use. "Kiko, forget how to
// say nginx": as written again. Only said to the app by name (decide.ts): without it, "say X as Y"
// could be words for a session. Never a model: the phrasing is distinctive enough.
const OPENERS = "(?:(?:ok(?:ay)?|so|and|also|please|hey|uh|um|from now on|can you|could you|would you|will you|go ahead and)[\\s,]+)*";
const PRONOUNCE = new RegExp(`^\\W*${OPENERS}(?:say|pronounce)\\s+(.+?)[\\s,]+(?:as|like)(?:\\s+in)?[\\s,:]+(.+?)(?:[\\s,]+(?:from now on|please|instead))*[\\s.!?]*$`, "i");
const FORGET_PRONUNCIATION = new RegExp(
  `^\\W*${OPENERS}(?:forget|stop)\\s+(?:how\\s+(?:to|you)\\s+(?:say|pronounce)|(?:the\\s+)?(?:pronunciation|respelling)\\s+(?:of|for)|respelling|pronouncing)\\s+(.+?)[\\s.!?]*$`,
  "i",
);
// "Say it like you mean it", "say that again like before": not a word to respell.
const NOT_A_WORD = /^(?:it|that|this|them|those|these|something|anything|everything|again|hi|hello|yes|no|so)$/i;

/** A word to say differently, or to say as written again; null when the words aren't that. */
export function pronunciationRequest(text: string): { op: "add"; word: string; say: string } | { op: "forget"; word: string } | null {
  const unquote = (s: string) =>
    s
      .trim()
      .replace(/^["'“‘]+|["'”’]+$/g, "")
      .trim();
  const forget = FORGET_PRONUNCIATION.exec(text);
  if (forget) {
    const word = unquote(forget[1]);
    return word && word.split(/\s+/).length <= 4 && !NOT_A_WORD.test(word) ? { op: "forget", word } : null;
  }
  const m = PRONOUNCE.exec(text);
  if (!m) return null;
  const word = unquote(m[1]);
  const say = unquote(m[2]);
  // A word, or letters said one by one ("T M U X"); what to say, a few words at most.
  if (!word || !say || word.split(/\s+/).length > 4 || say.split(/\s+/).length > 6 || NOT_A_WORD.test(word)) return null;
  return { op: "add", word, say };
}
