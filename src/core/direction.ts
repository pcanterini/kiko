// The direction to a session taken off your words in code, once it's known where they go: "Ask
// MintBox, …", "Hey Bobby, …", "To Kikodev: …", "Let Harbor know …", "…, this is for Atlas", "…,
// send that to Harbor." And reported speech made direct where that's mechanical (direct-speech.ts):
// "Tell Bobby to restart the server" → "Restart the server.", "Tell Harbor not to push yet" →
// "Don't push yet.", "Ask Pixie if the new logo is in the repo" → "Is the new logo in the repo?".
// Only a direction to the session the words go to is cut: its name (or folder, or words of its
// title with "one"/"session" after them), or "it"/"that one" right after "tell"/"ask". "Tell me why
// the build failed", "Check with the API docs whether …" and a session named only as content ("Tell
// Bobby that MintBox already fixed the cert") keep their words. Nothing is ever added but the small
// words direct speech needs, and no "not" is lost (keepsWords); otherwise the words go as before.
import { cap, imperative, keepsWords, statement, whQuestion, yesNoQuestion, youFor } from "./direct-speech.ts";
import { heardWords, namePatterns, nameWords, NOT_SAID_TO, type Session } from "./sessions.ts";
import { DISFLUENT, NEGATION, nearDistance, tokens } from "./words.ts";

export type DirectionOff = {
  /** Your words for the session, the direction off. */
  text: string;
  /** The directions cut, as said. */
  dropped: string[];
};

// Sounds between the words of a direction: "tell, uh, Harbor", "tell Harbor, like, to".
const F = String.raw`(?:[\s,]+(?:uh+|um+|umm|er+|erm|like))*`;
const SUFFIX = String.raw`(?:one|session|instance|agent|project|thread|terminal|window)`;
// The end of a name: not more of a word, not "Atlas's".
const END = String.raw`(?![\p{L}\p{N}'’-])`;
// What may come before a direction: "Uh, so, um, tell …", "Okay, ask …".
const OPEN = String.raw`(?:(?:uh+|um+|umm|so|okay|ok|oh|and|also|alright|well|now|right|then)${END}[\s,.]*)*`;
// How it's asked of the app: "Can you ask …", "Please tell …", "Go ahead and tell …".
const PRE = String.raw`(?:(?:(?:can|could|would|will)\s+you|please|go\s+ahead\s+and|just|also|now|then)[\s,]+)*`;
const PAUSE = String.raw`\s*[,:;.!?—–]+\s*`;
// "it", "that one", "the other session": the session the words go to, said after "tell"/"ask".
const GENERIC_ONE = String.raw`(?:it|that\s+one|this\s+one|that\s+session|this\s+session|the\s+other\s+(?:one|session)|the\s+current\s+session|the\s+same\s+session)`;
// "everyone", "both": each session it goes to; "they"/"their" in what's said to them is "you"/"your".
const GENERIC_MANY = String.raw`(?:everyone|everybody|both(?:\s+of\s+them)?|all\s+of\s+them|each\s+of\s+them|all\s+(?:the\s+)?sessions|them\s+all|them\s+both)`;
const STOP = new Set("the a an and of for to on in with my your our its new old".split(" "));

/** Words of `to`'s title said as a name: "the deploy session", "the iOS one" (runs of one to three title words). */
function titlePattern(to: Session): string | null {
  const w = heardWords(to.title ?? "");
  const runs = new Set<string>();
  for (let i = 0; i < w.length; i++) {
    for (let n = 1; n <= 3 && i + n <= w.length; n++) {
      const run = w.slice(i, i + n);
      if (run.some((x) => STOP.has(x)) || run.some((x) => x.length < 3)) continue;
      runs.add(run.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]+"));
    }
  }
  return runs.size ? [...runs].sort((a, b) => b.length - a.length).join("|") : null;
}

/**
 * The ways `to` is named: by name (or folder), by its title with "one"/"session" after, and
 * (`generic`) "it", "that one", "everyone"; with `others` (the other sessions), a list of names it's
 * one of ("Atlas and Orbit"); `near`, a word speech-to-text likely made of its name ("Pixy", "Bobbie":
 * refOk checks it). Only after "tell"/"ask" or a greeting: never as the name alone.
 */
function refOf(to: Session, generic: boolean, others: Session[] = [], near = false): { re: string; many: string } {
  const names = namePatterns(to);
  const title = titlePattern(to);
  const any = [...names, ...others.filter((x) => x !== to).flatMap(namePatterns)];
  const forms = [
    ...(others.length && names.length ? [String.raw`(?<list>(?:${any.join("|")})(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*)(?:${any.join("|")}))+)`] : []),
    ...(names.length ? [String.raw`(?:(?:the|a|an)\s+)?(?:${names.join("|")})(?:\s+${SUFFIX})?`] : []),
    ...(title ? [String.raw`(?:the\s+)?(?:${title})\s+${SUFFIX}`] : []),
    ...(generic ? [GENERIC_ONE, GENERIC_MANY] : []),
    ...(near ? [String.raw`(?<near>\p{L}[\p{L}'’]{3,})`] : []),
  ];
  return { re: forms.length ? `(?<ref>${forms.join("|")})${END}` : "(?!)", many: GENERIC_MANY };
}

// Words that are never a name heard wrong.
const NOT_A_NAME = new Set("that this them they there these those what when where which whether everyone everybody someone somebody something about again".split(" "));

/**
 * A match whose name is `to`'s: a list holds it ("Atlas and Orbit" for Atlas), a near word is close
 * to one of its names (words.ts nearDistance: "Pixy" for pixie, "Bobbie" for Bobby) and no other
 * session's or a common word.
 */
function refOk(m: RegExpExecArray, to: Session, others: Session[]): boolean {
  const g = m.groups ?? {};
  if (g.list) return new RegExp(`(?<![\\p{L}\\p{N}])(?:${namePatterns(to).join("|")})(?![\\p{L}\\p{N}])`, "iu").test(g.list);
  if (g.near) {
    const w = g.near.toLowerCase().replace(/['’]/g, "");
    if (NOT_A_NAME.has(w) || others.some((x) => x !== to && nameWords(x).includes(w))) return false;
    const own = [...new Set([...nameWords(to), nameWords(to).join("")])].filter((n) => n.length >= 4);
    return own.some((n) => n !== w && nearDistance(w, n) !== null);
  }
  return true;
}

/** `loose`: with `indirect`, the question as said, the direction off, not turned around ("The notarization went through?"). */
type Lead = { text: string; dropped: string; indirect?: boolean; loose?: { text: string; dropped: string } } | null;
type Where = "start" | "sentence";

const cleanStart = (s: string) => cap(s.trim().replace(/^(?:(?:uh+|um+|umm|ah|er|erm)\b[\s,.]*)+/i, ""));
const isMany = (ref: string | undefined, many: string, list?: string) => Boolean(list || (ref && new RegExp(`^${many}$`, "iu").test(ref.trim())));

/**
 * One direction to `to` at the start of `seg` (the words' start, or a sentence's), as direct speech;
 * `indirect` when it's there but turning it direct isn't mechanical ("Ask MintBox whether the
 * notarization went through"): the words are left as they are.
 */
function leadOff(seg: string, to: Session, where: Where, others: Session[]): Lead {
  const all = refOf(to, true, others, true);
  const named = refOf(to, false);
  const greeted = refOf(to, false, [], true);
  const V = `^${OPEN}${PRE}`;
  const rest = String.raw`(?<rest>[\s\S]+)$`;
  const cut = (m: RegExpExecArray) => seg.slice(0, seg.length - m.groups!.rest.length).trim();
  const ex = (src: string) => {
    const found = new RegExp(src, "iu").exec(seg);
    return found && refOk(found, to, others) ? found : null;
  };
  let m: RegExpExecArray | null;
  // "Tell Bobby to restart the server", "ask Juniper to take a screenshot", "tell Harbor not to push yet", "have Atlas run the tests".
  m = ex(String.raw`${V}(?:tell|ask|remind|get)${F}\s+${all.re}${F}[\s,]*(?:(?<neg>not|never)\s+)?to${F}[\s,]+${rest}`);
  if (m) {
    const neg = m.groups!.neg?.toLowerCase() as "not" | "never" | undefined;
    const body = isMany(m.groups!.ref, all.many, m.groups!.list) ? plural(m.groups!.rest) : m.groups!.rest;
    return { text: imperative(body, neg ?? null), dropped: cut(m).replace(/\s+(?:not|never)(?=\s+to\s*$)/i, "") };
  }
  m = ex(String.raw`${V}have${F}\s+${named.re}\s+(?=\p{Ll})${rest}`);
  if (m && /^(?:run|check|look|fix|make|add|commit|push|deploy|merge|update|test|write|start|stop|try|use|send|change|remove|delete|open|pull|restart|build)\b/i.test(m.groups!.rest)) {
    return { text: imperative(m.groups!.rest), dropped: cut(m) };
  }
  // "Ask Pixie if the new logo is in the repo yet", "Check with Pixie whether …".
  m = ex(String.raw`${V}(?:ask|check\s+with)${F}[\s,]+(?:(?:a|the)\s+)?${all.re}${F}[\s,]*(?:whether|if)${END}${F}[\s,]*${rest}`);
  if (m) {
    const q = yesNoQuestion(m.groups!.rest, isMany(m.groups!.ref, all.many, m.groups!.list));
    return q ? { text: q, dropped: cut(m) } : { text: seg, dropped: "", indirect: true, loose: { text: looseQuestion("", m.groups!.rest), dropped: cut(m) } };
  }
  // "Ask Orbit what happens when …", "ask Bobby what it needs from me …", "Ask MintBox, what do I need …".
  m = ex(String.raw`${V}ask${F}[\s,]+(?:(?:a|the)\s+)?${all.re}${F}[\s,]*(?<wh>what|which|who|whose|why|how|when|where)(?<rest>(?:['’]s)?\s[\s\S]+)$`);
  if (m) {
    const r = m.groups!.rest;
    const dropped = seg.slice(0, seg.length - r.length - m.groups!.wh.length).trim();
    if (/^['’]s/.test(r)) return { text: `${cap(m.groups!.wh)}${r.replace(/[\s.]+$/, "").replace(/\?$/, "")}?`, dropped };
    const q = whQuestion(m.groups!.wh, r, isMany(m.groups!.ref, all.many, m.groups!.list));
    return q ? { text: q, dropped } : { text: seg, dropped: "", indirect: true, loose: { text: looseQuestion(m.groups!.wh, r), dropped } };
  }
  // "Ask MintBox about the cert" → "What about the cert?"
  m = ex(String.raw`${V}ask${F}\s+${named.re}\s+about\s+${rest}`);
  if (m && where === "start") return { text: `What about ${m.groups!.rest.replace(/[\s.?!]+$/, "")}?`, dropped: cut(m).replace(/\s+about$/i, "") };
  // "Ask Bobby, does the nightly backup still run at 3 a.m.?", "Ask Atlas. Um. What …": a direct question after the pause.
  m = ex(String.raw`${V}ask${F}[\s,]+(?:(?:a|the)\s+)?${named.re}${F}${PAUSE}${rest}`);
  if (m) return { text: cleanStart(m.groups!.rest), dropped: cut(m) };
  // "Let Harbor know the DNS change is live."
  m = ex(String.raw`${V}let${F}\s+${all.re}${F}\s+know${F}(?:\s*,?\s*that\s+|\s*[,:]\s*|\s+)${rest}`);
  if (m) return { text: statement(m.groups!.rest), dropped: cut(m) };
  // "Tell Atlas it can merge once CI passes", "Tell Bobby that MintBox already fixed the cert", "Tell Atlas, the tests are green".
  m = ex(String.raw`${V}tell${F}\s+${named.re}${F}(?<how>\s*,?\s*that\s+|\s*[,:]\s*|\s+)${rest}`);
  if (m && !/^(?:about|me|us|him|her|them|to|so|too|what|why|how|when|where|which|who|whether|if)\b/i.test(m.groups!.rest) && (where === "start" || /[,:]|that/.test(m.groups!.how))) {
    return { text: statement(m.groups!.rest), dropped: cut(m) };
  }
  // "Hey Bobby, can you …", "Okay Harbor, roll back …", "Harbor, that one's yours."; "Hey uh Harbor um …" with a greeting.
  m =
    ex(String.raw`^${OPEN}(?:(?:hey|hi|hello|yo)${END}${F}[\s,]*)?${named.re}${PAUSE}${rest}`) ??
    ex(String.raw`^${OPEN}(?:hey|hi|hello|yo)${END}${F}[\s,]*${greeted.re}${PAUSE}${rest}`) ??
    ex(String.raw`^${OPEN}(?:hey|hi|hello|yo)${END}${F}[\s,]*${named.re}\s+${rest}`);
  if (m && (!NOT_SAID_TO.test(m.groups!.rest.trim()) || /^that\s+one\b/i.test(m.groups!.rest.trim()))) return { text: cleanStart(m.groups!.rest), dropped: cut(m) };
  // "To Harbor: …", "For Pixie, …", "This is for Kikodev. …", "Question for Atlas: …", "Send this to Juniper: …", "On, uh, MintBox, …".
  const prep = String.raw`(?:(?:this|that|it)(?:\s+(?:one|message|question|part))?(?:['’]s|\s+is)\s+for|(?:a\s+)?(?:question|message|note|request)\s+for|send\s+(?:this|that|it)(?:\s+on)?\s+to|over\s+to|to|for|in|on)`;
  m = ex(String.raw`^${OPEN}${prep}${F}[\s,]+${named.re}${F}${PAUSE}${rest}`);
  if (m && where === "start") return { text: cleanStart(m.groups!.rest), dropped: cut(m) };
  return null;
}

/** A question that isn't mechanical to turn around, asked as said: "The notarization went through?", "Why handleWebhook throws on the invoice.paid event?". */
function looseQuestion(wh: string, rest: string) {
  // The first sentence is the question; what follows goes as said.
  const m = /^([\s\S]*?[.!?])(\s+[\s\S]*)$/u.exec(rest.trim());
  const head = (m?.[1] ?? rest).trim().replace(/[\s,;:.!?]+$/, "");
  const tail = m?.[2] ?? "";
  return cap(`${wh ? `${wh} ` : ""}${youFor(head)}?${tail}`);
}

/** "Commit their work" said to everyone, as said to each: "Commit your work". */
function plural(rest: string) {
  return rest.replace(/\btheir\b/gi, (w) => (w[0] === "T" ? "Your" : "your")).replace(/\bthey['’]re\b/gi, "you're");
}

/** The punctuation a sentence ends with once an aside after it is cut: "?" for a question. */
function endFor(before: string, said: string) {
  const last = before.split(/(?<=[.!?])\s+/).at(-1) ?? "";
  if (/^\W*(?:can|could|would|will|what|what's|why|how|when|where|which|who|is|are|do|does|did|should|shall|has|have)\b/i.test(last)) return "?";
  return /[.!?]$/.test(said) ? said.slice(-1) : ".";
}

/**
 * A place in the work, not who it's for: "…, in the relay.", "…, for the docs." (a bare "for/to/on/in"
 * with "the" and no "one"/"session" after the name). ", on MintBox.", ", for the Atlas session," are asides.
 */
function contentPlace(prep: string | undefined, ref: string | undefined) {
  return Boolean(prep && ref && /^(?:the|a|an)\s/i.test(ref.trim()) && !new RegExp(`\\s${SUFFIX}$`, "i").test(ref.trim()));
}

/** Asides naming `to` anywhere after the start: "…, this is for Atlas, …", "…, send that to Harbor.", "…? For Orbit.", "…, Bobby, and …". */
function asidesOff(text: string, to: Session, dropped: string[]): string {
  const named = refOf(to, false).re;
  let out = text;
  // At the end: "…, this is for Atlas by the way.", "…, send that to Harbor.", "…? For Orbit.", ". To Pixie.", ", on MintBox."
  const tail = new RegExp(
    String.raw`(?<pre>[,.!?;:]|\s[-—–])\s*(?:(?:uh+|um+)[\s,]+)?(?:and\s+)?(?:(?:this|that|it)(?:\s+(?:one|message|question|part))?(?:['’]s|\s+is)\s+(?:for|to)|this\s+goes\s+to|send\s+(?:this|that|it)(?:\s+on)?\s+to|(?<prep>for|to|on|in))\s+${named}(?:,?\s+by\s+the\s+way)?(?<end>[\s.!?]*)$`,
    "iu",
  );
  let m = tail.exec(out);
  if (m && contentPlace(m.groups!.prep, m.groups!.ref)) m = null;
  if (m) {
    const before = out.slice(0, m.index).trimEnd();
    if (tokens(before).length >= 2) {
      dropped.push(m[0].replace(/^[\s,.!?;:—–-]+/, "").replace(/[\s.!?]+$/, ""));
      out = `${before}${/[.!?]/.test(m.groups!.pre) ? m.groups!.pre : endFor(before, m.groups!.end.trim())}`;
    }
  }
  // In the middle, between commas: "…, this is for Atlas, I think …", "… and, uh, this one's for Pixie, clear …", ", for the Atlas session, and …".
  const mid = new RegExp(String.raw`,\s*(?:(?:uh+|um+)[\s,]+)?(?:(?:this|that)(?:\s+one)?(?:['’]s|\s+is)\s+for|this\s+goes\s+to|(?<prep>for))\s+${named}(?:,?\s+by\s+the\s+way)?\s*,\s*(?=\S)`, "iu");
  m = mid.exec(out);
  if (m && contentPlace(m.groups!.prep, m.groups!.ref)) m = null;
  if (m) {
    const left = out.slice(0, m.index);
    const right = out.slice(m.index + m[0].length);
    dropped.push(m[0].replace(/^[\s,]+|[\s,]+$/g, ""));
    out = /\b(?:and|but|or|then|so)$/i.test(left) || /^(?:and|but|or|then|so)\b/i.test(right) ? `${left}${/\b(?:and|but|or|then|so)$/i.test(left) ? " " : ", "}${right}` : `${left}, ${right}`;
  }
  // Said to it in passing: "Check the backup logs from last night, Bobby, and tell me …".
  const vocative = new RegExp(String.raw`,\s*(?:${namePatterns(to).join("|") || "(?!)"})${END}\s*,\s*(?=(?:and|then|so|please|can|could|would|i|we|you|tell|let)\b)`, "iu");
  m = vocative.exec(out);
  if (m) {
    dropped.push(m[0].replace(/^[\s,]+|[\s,]+$/g, ""));
    out = `${out.slice(0, m.index)}, ${out.slice(m.index + m[0].length)}`;
  }
  return out;
}

/** "If it's done, tell Atlas to open a PR." → "If it's done, open a PR.": "tell/ask X to" after a comma. */
function midOff(text: string, to: Session, dropped: string[]): string {
  const ref = refOf(to, true).re;
  const re = new RegExp(String.raw`(?<pre>,\s*(?:(?:and|then|so|but)\s+)?)(?<dir>(?:please\s+)?(?:tell|ask)${F}\s+${ref}${F}[\s,]*(?:(?<neg>not|never)\s+)?to${F}[\s,]+)(?=\p{L})`, "iu");
  const m = re.exec(text);
  if (!m) return text;
  // "it", "that one" mid-sentence is the session only when it was named before ("When Harbor finishes, tell it to …"):
  // otherwise it's likely the work's ("When the agent is stuck, ask it to summarize").
  const generic = new RegExp(String.raw`^(?:${GENERIC_ONE}|${GENERIC_MANY})$`, "iu").test(m.groups!.ref ?? "");
  const namedBefore = namePatterns(to).some((x) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${x})(?![\\p{L}\\p{N}])`, "iu").test(text.slice(0, m.index)));
  if (generic && !namedBefore) return text;
  const neg = m.groups!.neg?.toLowerCase();
  dropped.push(m.groups!.dir.trim().replace(/\s+(?:not|never)(?=\s+to$)/i, ""));
  return `${text.slice(0, m.index)}${m.groups!.pre}${neg === "not" ? "don't " : neg === "never" ? "never " : ""}${text.slice(m.index + m[0].length)}`;
}

// The words of a direction around a session's name: "Ask MintBox,", "To Kikodev,", "Hey Bobby", "for the Atlas session".
const DIRECTION_WORDS = new Set(
  "ask tell to for hey hi hello yo okay ok so and also please the a an session one instance this is its for let know check with on in send that over question message note".split(" "),
);

/**
 * Whether `part` is only a direction to `to`: its name (or folder) and direction words around it
 * ("Ask MintBox,", "To Kikodev,", "Hey Bobby", "for the Atlas session"). For the trim (trim.ts
 * removeParts), which otherwise keeps a part under three words.
 */
export function onlyDirectionTo(part: string, to: Session): boolean {
  const rest = heardWords(part).filter((w) => !DIRECTION_WORDS.has(w) && !DISFLUENT.has(w));
  const names = namePatterns(to);
  return rest.length > 0 && names.length > 0 && new RegExp(`^(?:${names.join("|")})$`, "iu").test(rest.join(" "));
}

const negations = (s: string) => tokens(s).filter((t) => NEGATION.test(t.word) || t.word === "never").length;

/**
 * `text` as it should reach `to` (`sessions`: all of them, for "Ask Atlas and Orbit whether …"): the direction to it off, reported speech made direct where that's
 * mechanical. Null when there's no direction to it to take off, or what's left wouldn't be your words
 * (keepsWords) or would lose a "not". `indirect`: a direction is there, but turning it into direct
 * speech isn't mechanical ("Ask MintBox whether the notarization went through"): the words aren't
 * changed, and the router may write them (decide.ts); `loose` has them with the direction off and
 * the question asked as said ("The notarization went through?"), for when it doesn't.
 */
export function directionOff(text: string, to: Session, sessions: Session[] = []): (DirectionOff & { indirect?: boolean; loose?: DirectionOff }) | null {
  const said = text.trim();
  const strict = strip(said, to, false, sessions);
  if (!strict.indirect) return strict.dropped.length ? checked(said, strict) : null;
  const loose = checked(said, strip(said, to, true, sessions));
  return { text: said, dropped: [], indirect: true, ...(loose ? { loose } : {}) };
}

/** `r` when it's your words less the directions (keepsWords) with every "not" kept, else null. */
function checked(said: string, r: DirectionOff): DirectionOff | null {
  if (!r.dropped.length || !tokens(r.text).length || negations(r.text) < negations(said) || !keepsWords(said, r.text, r.dropped)) return null;
  return { text: cap(r.text), dropped: r.dropped };
}

/** Every direction to `to` off `said`; `loose`: one up front that isn't mechanical taken off too, its question as said. */
function strip(said: string, to: Session, loose: boolean, sessions: Session[]): DirectionOff & { indirect: boolean } {
  const dropped: string[] = [];
  let out = said;
  let indirect = false;
  // At the start, as many as are said there: "For, uh, MintBox, please ask it to check …".
  for (let i = 0; i < 3; i++) {
    const lead = leadOff(out, to, "start", sessions);
    if (!lead) break;
    if (lead.indirect) {
      indirect = true;
      if (!loose || !lead.loose) break;
      dropped.push(lead.loose.dropped);
      out = lead.loose.text;
      break;
    }
    dropped.push(lead.dropped);
    out = lead.text;
  }
  // At the start of a later sentence: "… the window. Tell it to not start yet, …", "The build is failing on main. Harbor, that one's yours."
  if (!indirect || loose) {
    const sentences = out.split(/(?<=[.!?])\s+(?=\S)/);
    for (let i = 1; i < sentences.length; i++) {
      const lead = leadOff(sentences[i], to, "sentence", sessions);
      if (lead && !lead.indirect && lead.dropped) {
        dropped.push(lead.dropped);
        sentences[i] = lead.text;
      }
    }
    out = sentences.join(" ");
    out = midOff(out, to, dropped);
  }
  out = asidesOff(out, to, dropped);
  out = out
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
  return { text: out, dropped, indirect };
}
