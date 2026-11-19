// The sessions, as core knows them: listed by the agent (src/agents/), each matched to where a
// terminal adapter can type into it (src/terminals/). And what they're called, said and heard as.
import { agent } from "../agents/index.ts";
import type { AgentSession } from "../agents/types.ts";
import { findPlaces } from "../terminals/index.ts";
import type { Mapping, Place } from "../terminals/types.ts";
import { APP_ROOT, INSTALLED } from "./app-root.ts";
import { envVar, NAME, SLUG, spokenName } from "./name.ts";
import { loadRenames, type Renames } from "./renames.ts";
import { assignNumbers, nameNumbered, numberOf } from "./session-numbers.ts";
import { imperative, keepsWords, statement, whQuestion, yesNoQuestion } from "./direct-speech.ts";
import { nameForms } from "./wake.ts";
import { DISFLUENT } from "./words.ts";

/** Who gave a session the name it goes by: you, this app (typing /rename for you), or nobody (Claude's title and the folder). */
type NameSource = "user" | "app" | "claude";

export type Session = Omit<AgentSession, "titles"> & {
  /** Who gave it `givenName`. Internal: never shown or said. */
  nameSetBy: NameSource;
  /** Where a terminal adapter (src/terminals/) can type into it: its tmux pane, its Ghostty window, its T3 thread; null when none can (the desktop app's). */
  place: Place | null;
  mapping: Mapping;
  /**
   * Its number among the sessions that go by the same name, its folder's (session-numbers.ts): 2
   * and up is shown and said after the name ("kiko 2"); 1 is the plain one while another there
   * has a number. Left out for one alone with its name, or with a name of its own.
   */
  number?: number;
};

/**
 * The running sessions someone can talk to (the agent's list: `claude agents`), each matched to
 * where a terminal adapter can type into it, for typing into a session that isn't waiting for a reply.
 */
export async function listSessions(): Promise<Session[]> {
  const listing = agent.list();
  // Where each one whose process isn't known was last found, or opened (notePane): looked at first.
  const findable = listing.then((all) => all.map((s) => (paneHints.has(s.sessionId) ? { ...s, pane: paneHints.get(s.sessionId) } : s)));
  const [listed, placeOf] = await Promise.all([listing, findPlaces(findable)]);
  const renames = loadRenames();
  return listed.map(({ titles, program, ...session }) => {
    const found = placeOf(session.sessionId);
    if (program && found.place) notePane(session.sessionId, found.place.id);
    return { ...session, nameSetBy: nameSetBy(idsOf(session), session.givenName, renames), ...found };
  });
}

// Panes of sessions whose process their agent doesn't know (AgentSession.program), by session ID:
// where each was opened (a session the app opened or found starting in its pane: app.ts) or last
// found. The newest few.
const paneHints = new Map<string, string>();

/** `sessionId` runs in the pane `handle`: looked at first the next time it's found (Findable.pane). */
export function notePane(sessionId: string, handle: string) {
  paneHints.delete(sessionId);
  paneHints.set(sessionId, handle);
  if (paneHints.size > 100) paneHints.delete(paneHints.keys().next().value!);
}

/**
 * The status of a session the app opened that hasn't started yet (core/starting.ts): listed so it
 * can be named and shown, its words held until it's ready. Once it has waited too long, "blocked"
 * (it needs you: Claude Code is asking something in its window, whether to trust its folder).
 */
export const STARTING = "starting";

/** A session still starting (or past the wait, needing you), by the ID it has meanwhile: "starting-…". */
export const isStarting = (session: { sessionId: string }) => session.sessionId.startsWith(`${STARTING}-`);

type Identified = { sessionId: string; aliases?: string[] };

/**
 * The session an ID is for: its own ID, else one it also goes by (`aliases`: a terminal session
 * whose turns its agent moved into a background process is listed as that process). For every
 * lookup by an ID that came from elsewhere: a hook, the phone, the timeline, the target.
 */
export function findSession<T extends Identified>(sessions: readonly T[], id: string | null | undefined): T | undefined {
  if (!id) return undefined;
  return sessions.find((s) => s.sessionId === id) ?? sessions.find((s) => s.aliases?.includes(id));
}

/** Every ID a session goes by: its own, then its aliases. */
export const idsOf = (session: Identified): string[] => [session.sessionId, ...(session.aliases ?? [])];

/** The ID a session is listed under, for one it may also go by; the ID itself when none is. */
export function listedId(sessions: readonly Identified[], id: string): string {
  return findSession(sessions, id)?.sessionId ?? id;
}

/** How many listings in a row a session must be missing from to count as ended (`LeftTheList`). */
export const GONE_AFTER_LISTINGS = 2;

/**
 * Sessions that have ended, as the listings show it: listed once, then missing from `after`
 * listings in a row (its process gone: `claude agents` drops it). One listing without it isn't
 * enough: a listing that failed comes as an empty one. Asked about the IDs being watched (`look`):
 * each listing (a new array) counts once, however often it's looked at; IDs no longer watched are
 * forgotten. A session that has ended can't be answered: whatever still says it needs you goes.
 */
export class LeftTheList {
  private seen = new Set<string>();
  private misses = new Map<string, number>();
  private last: readonly Identified[] | null = null;
  private after: number;

  constructor(after = GONE_AFTER_LISTINGS) {
    this.after = after;
  }

  /**
   * The watched IDs whose session has left the list: as of this listing, or one before (a session
   * stays ended for as long as it's watched). None while nothing has been listed yet.
   */
  look(sessions: readonly Identified[], watched: Iterable<string>): string[] {
    const ids = new Set(watched);
    for (const id of this.seen) if (!ids.has(id)) this.forget(id);
    if (sessions !== this.last) {
      this.last = sessions;
      for (const id of ids) {
        if (findSession(sessions, id)) {
          this.seen.add(id);
          this.misses.delete(id);
        } else if (this.seen.has(id)) this.misses.set(id, (this.misses.get(id) ?? 0) + 1);
      }
    }
    return [...ids].filter((id) => (this.misses.get(id) ?? 0) >= this.after);
  }

  private forget(id: string) {
    this.seen.delete(id);
    this.misses.delete(id);
  }
}

/**
 * Who gave a session its name. Claude Code records a /rename the same way whoever typed it, so
 * the app's own renames are kept (renames.ts): a name that's still the one the app gave is the app's.
 * `ids`: its ID, or that and the others it goes by.
 */
export function nameSetBy(ids: string | string[], givenName: string, renames: Renames = loadRenames()): NameSource {
  if (!givenName.trim()) return "claude";
  const ours = [ids]
    .flat()
    .map((id) => renames[id]?.name)
    .find((name) => name !== undefined && sameName(name, givenName));
  return ours !== undefined ? "app" : "user";
}

/** Short spoken-friendly name for a session: its folder. */
export function folderName(cwd: string) {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

/** A session started without a folder, in one its agent made up (the desktop app's scratch folders): it goes by its title. */
export const inScratch = (cwd: string) => agent.madeUpFolder(cwd);

type Named = { sessionId: string; aliases?: string[]; cwd: string; givenName?: string; title?: string; name?: string; number?: number };

/** The same name, said or written differently: "Cloud Speech" and "cloud-speech". */
export const sameName = (a: string, b: string) => words(a).join(" ") === words(b).join(" ");

/**
 * What a session named like the name you call the app (name.ts spokenName: "Kiko", given that
 * name, or in a folder called kiko) is called instead, on screen, on the phone, out loud and in
 * the router's list. "Kiko, …" up front means the app (wake.ts), so what's shown is what to say
 * for the session: "the Kiko project" (or "the Kiko session"); "To Kiko, …" and "Tell Kiko to …"
 * go there too (namedLikeAppName). Without it, a test message said "To Kiko, …" went into a
 * session listed as "Kiko", and the trim typed only its last sentence.
 */
export const appNamed = () => `${spokenName()} project`;

/**
 * What a session is called out loud and on screen: the name you (or the app) gave it with /rename,
 * else its folder, or for a desktop session in a made-up folder, its title (Claude Code's session
 * name if it has none); `appNamed()` for one that would be called the app's spoken name. Asked of the agent
 * (its transcript) when the caller only knows the folder and ID.
 */
export function sessionName(session: Named) {
  const { base, number } = naming(session);
  return number > 1 ? `${base} ${number}` : base;
}

/**
 * The sessions called by the name you call the app (name.ts spokenName), or a name that starts with
 * it: its name or its folder ("Kiko project" in the kiko folder, "kiko-dev", "Juno web" when you
 * call the app Juno). Where "To Kiko, …" and "Tell Kiko to …" go (decide.ts, wake.ts directedAtName),
 * and who "Kiko, …" up front may be about (the router's <name_up_front>).
 */
export function namedLikeAppName(sessions: Session[]): Session[] {
  const said = heard(spokenName());
  if (!said.length) return [];
  const starts = (name: string) => {
    const w = heard(name);
    return w.length >= said.length && said.every((word, i) => w[i] === word);
  };
  return sessions.filter((session) => {
    const { own, base } = naming(session);
    const folder = inScratch(session.cwd) ? "" : folderName(session.cwd);
    return [own, base, folder].some((name) => name && starts(name));
  });
}

/** Whether a session is listed as `appNamed()`, to tell apart from the app. */
export const namedLikeApp = (session: Named) => sameName(ownName(session), spokenName());

/** The session's name as given or found, before `sessionName` tells it apart from the app's. */
function ownName(session: Named) {
  return naming(session).own;
}

/**
 * What a session goes by: `own`, as given or found; `base`, that told apart from the app's name
 * (`appNamed()`); `number`, its number among those sharing the name, for one called by its folder
 * (session-numbers.ts: 0 for none, 1 for the plain one while another there has one).
 */
function naming(session: Named) {
  const info = session.givenName === undefined ? agent.names(session) : null;
  const given = (session.givenName ?? info!.givenName).trim();
  const scratch = inScratch(session.cwd);
  const own = given || (!scratch ? folderName(session.cwd) : session.title || session.name || info?.title || folderName(session.cwd));
  const base = sameName(own, spokenName()) ? appNamed() : own;
  const byFolder = !given && !scratch;
  return { own, base, byFolder, number: byFolder ? (session.number ?? storedNumber(session, base)) : 0 };
}

/** A session known only by its ID and folder (a hook, the timeline): its number as the last listing gave it. */
function storedNumber(session: Named, base: string) {
  const n = numberOf(idsOf(session));
  return n > 1 || (n === 1 && nameNumbered(nameKey(base))) ? n : 0;
}

// Names as numbers group them: "Kiko project" and "kiko-project" share one.
const nameKey = (name: string) => words(name).join(" ");

/** A session's number after its name ("kiko 2": 2), 0 for none: the plain one, one alone with its name, or one with a name of its own. */
export function sessionNumber(session: Named) {
  const { number } = naming(session);
  return number > 1 ? number : 0;
}

/**
 * The sessions listed, numbered where they'd go by the same name (session-numbers.ts): each
 * session called by its folder keeps the number it has, and a new one takes the next free one.
 * Kept by session ID next to the settings, so a restart doesn't change them.
 */
export function numberSessions(list: Session[], now = Date.now()): Session[] {
  const rows = list.map((s) => ({ s, key: groupOf(s), number: 0 }));
  const got = assignNumbers(
    rows.flatMap((r) => (r.key === null ? [] : [{ ids: idsOf(r.s), name: r.key }])),
    list.flatMap(idsOf),
    now,
  );
  for (const r of rows) r.number = got.get(r.s.sessionId) ?? 0;
  return labelled(rows);
}

/**
 * Numbers for sessions made up without the app's record of them (the tests' and the routing
 * eval's lists): in the order listed, a number one already has kept, the others the next free one.
 */
export function numberAsListed<T extends Session>(list: T[]): T[] {
  const rows = list.map((s) => ({ s, key: groupOf(s), number: s.number ?? 0 }));
  for (const r of rows) {
    if (r.key === null || r.number) continue;
    const taken = new Set(rows.filter((o) => o.key === r.key).map((o) => o.number));
    let n = 1;
    while (taken.has(n)) n++;
    r.number = n;
  }
  return labelled(rows);
}

/** The name a session called by its folder shares with others there (`nameKey`); null for one with a name of its own. */
function groupOf(session: Session): string | null {
  const n = naming({ ...session, number: 0 });
  return n.byFolder ? nameKey(n.base) : null;
}

/** Each with its number when it has one to show (2 and up), or is the plain one of a name that's numbered (1). */
function labelled<T extends Session>(rows: Array<{ s: T; key: string | null; number: number }>): T[] {
  const numbered = new Set(rows.flatMap((r) => (r.key !== null && r.number > 1 ? [r.key] : [])));
  return rows.map(({ s, key, number }) => {
    const keep = key !== null && number > 0 && (number > 1 || numbered.has(key));
    if (keep) return s.number === number ? s : { ...s, number };
    if (s.number === undefined) return s;
    const { number: _, ...rest } = s;
    return rest as T;
  });
}

/**
 * What the screen shows dimmed after a session's name: its folder when it has a name of its own,
 * else Claude's title for it, cut short (two unnamed sessions in one folder differ by it). Nothing
 * for a desktop session named by its title.
 */
export function sessionDetail(session: Named, max = 32) {
  if (inScratch(session.cwd)) return "";
  const name = ownName(session);
  const folder = folderName(session.cwd);
  if (!sameName(name, folder)) return folder;
  return session.title && !sameName(session.title, name) ? shorten(session.title, max) : "";
}

/** At most `max` characters, cut between words: "ClipKit Library focus…". */
export function shorten(text: string, max: number) {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  // The cut may fall right at the end of a word.
  const space = t[max - 1] === " " ? cut.length : cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, "")}…`;
}

/**
 * A session for a model prompt: its name, with its folder when that isn't the name and Claude's
 * title for it, any of which the user may call it by: `cloud speech (folder claude-code-speech, title "Idea file")`.
 * A numbered one with its folder: `kiko 2 (folder kiko, title "Session colours")`.
 */
export function sessionLabel(session: Named) {
  const name = sessionName(session);
  const folder = inScratch(session.cwd) ? "" : folderName(session.cwd);
  const more = [folder && !sameName(folder, name) ? `folder ${folder}` : "", session.title && !sameName(session.title, name) ? `title "${session.title}"` : ""].filter(Boolean);
  return more.length ? `${name} (${more.join(", ")})` : name;
}

/**
 * Its name said, and for one called by its folder, Claude's title for it, which tells apart two in
 * one folder: "claude code speech, Capital of France", "kiko 2, Session colours".
 */
export function spokenWithTitle(session: Named) {
  const name = sessionName(session);
  const byFolder = !inScratch(session.cwd) && sameName(ownName(session), folderName(session.cwd));
  return spoken(byFolder && session.title && !sameName(session.title, name) ? `${name}, ${session.title}` : name);
}

/**
 * What a session answers to: by name, its name and its folder ("cloud speech" or "claude code
 * voice" for a renamed session there); by title, Claude's title for it. "folder" is only its folder,
 * which every session there shares; "own" only what's its alone: a name other than the folder, its title.
 * A session on this app's own code also answers to the app's names (the product's and the one you
 * call it), like its folder ("tell the Kiko session to run the tests"), whatever the folder is called. Up front and said to the app
 * ("Kiko, …"), the name is taken off before anything looks for sessions (decide.ts, wake.ts);
 * after a direction ("To Kiko, …", "Tell Kiko to …"), it's a session's when one is named like it
 * (namedLikeAppName). One listed as "Kiko project" answers to that and to its own name.
 */
function namesOf(session: Named, by: NamedBy): string[] {
  const folder = inScratch(session.cwd) ? "" : folderName(session.cwd);
  const { own, base, number } = naming(session);
  const name = number > 1 ? `${base} ${number}` : base;
  const app = folder === APP_FOLDER ? [NAME, spokenName()].filter((n) => !sameName(folder, n)) : [];
  // Its number tells it from the others with its name, and is its alone: "kiko 2" (and "Kiko project 2"
  // for one called the app's name); "kiko 1" for the plain one.
  const numbered = number ? [...new Set([`${base} ${number}`, `${own} ${number}`])] : [];
  // The plain name ("Kiko project") is all of theirs: said alone, it names each of them.
  const byName = [name, ...numbered, base, own, folder, ...app];
  const byTitle = [session.title ?? ""];
  if (by === "folder") return [folder, ...app].filter(Boolean);
  if (by === "own") return [...numbered, folder && sameName(own, folder) ? "" : own, ...byTitle].filter(Boolean);
  return (by === "name" ? byName : by === "title" ? byTitle : [...byName, ...byTitle]).filter(Boolean);
}

type NamedBy = "name" | "title" | "either" | "folder" | "own";

/**
 * Sessions that share one numbered name ("Kiko project", "Kiko project 2"), the plain one first,
 * then by number; null unless that's all of them.
 */
export function sameNumberedName<T extends Session>(sessions: readonly T[]): T[] | null {
  if (sessions.length < 2) return null;
  const keys = new Set(sessions.map((x) => (naming(x).number ? nameKey(naming(x).base) : null)));
  if (keys.size !== 1 || keys.has(null)) return null;
  return [...sessions].sort((a, b) => naming(a).number - naming(b).number);
}

/**
 * For a session whose name is numbered, what after a name of it (as `heard` gives words, each
 * followed by a space) makes it another session's: a number, after any more words of the name
 * ("kiko 2", "kiko project 2" aren't the plain Kiko project). Null for one whose name isn't.
 */
function numberAfter(session: Named): string | null {
  const { own, base, number } = naming(session);
  if (!number) return null;
  const more = [...new Set([...heard(base), ...heard(own)])].map(escape).join("|");
  return `(?:(?:${more}) )*\\d`;
}

/**
 * The words a session answers to by name (its name, its folder, the app's name for the one on the
 * app's code), or by `by`, as speech gives them: "cloud" for "claude", "atlas agents" for "atlas-agents".
 */
export function nameWords(session: Named, by: NamedBy = "name"): string[] {
  return [...new Set(namesOf(session, by).flatMap(heard))];
}

/**
 * The names a session answers to, whole ("Rowan", "atlas-agents", "Kiko project", its folder), never
 * the app's own name alone: what a name heard as other words is held against (heard-as.ts).
 */
export function callNames(session: Named): string[] {
  return [...new Set(namesOf(session, "name").filter((n) => !appsName(n)))];
}

/** Words as `nameWords` compares them: lower case, letters and digits, "claude" for what speech hears for it. */
export const heardWords = (text: string) => heard(text);

// "atlas-agents" → "atlas agents", for speech.
export const spoken = (name: string) => name.replace(/[-_]+/g, " ");

/**
 * The folder this app's own code is in, wherever it was put: asking for a change to the app is
 * work for a session there. KIKO_APP_FOLDER pins it for the tests and the routing eval, whose
 * recorded sessions have the app's code in claude-code-speech. An installed copy has no code folder
 * of its own: a clone of it would be called kiko.
 */
export const APP_FOLDER = envVar("APP_FOLDER") ?? (INSTALLED ? SLUG : folderName(APP_ROOT));

// Speech gives "atlas agents" for "atlas-agents", so compare letters and digits only.
const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

// What speech-to-text hears for "Claude": "cloud code speech", "clawed speech".
const CLAUDE = ["claude", "cloud", "clawed", "clod", "claud"];
const SOUNDS_LIKE: Record<string, string> = { claude: `(?:${CLAUDE.join("|")})` };
const heard = (text: string) => words(text).map((w) => (CLAUDE.includes(w) ? "claude" : w));
// What was said, without "uh" and "um": "tell, uh, Lacy" names Lacy as "tell Lacy" does.
const fluent = (text: string) =>
  ` ${heard(text)
    .filter((w) => !DISFLUENT.has(w))
    .join(" ")} `;
// One word of a name as a pattern: what speech-to-text hears for it, and with or without a plural
// "s" ("the atlas agent session" for atlas-agents).
const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordPattern = (word: string) => {
  if (SOUNDS_LIKE[word]) return SOUNDS_LIKE[word];
  if (word.length <= 3 || !/^\p{L}+$/u.test(word)) return escape(word);
  return word.endsWith("s") ? `${word.slice(0, -1)}s?` : `${word}s?`;
};
const FILLER = "(?:(?:ah|uh|um|umm|oh|okay|ok|so|and|also|alright|hey|now|yeah|yes|right|well)\\W+)*";
const SUFFIX = "(?:one|session|instance|agent|project|thread|terminal|window)";
// A pause after a name: punctuation, or a hyphen standing apart ("Atlas - check the build"), never
// one joining it to more of a name ("tell kiko-dev the overlay …" isn't "tell kiko", pause, "dev …").
const PAUSE = "(?:\\s*[,:;.!?—–]+|\\s*-+(?![\\p{L}\\p{N}]))\\s*";
// "To …" rather than "for …" (addressedTo's phrase for either).
const isTo = (m: RegExpMatchArray) => m.groups?.prep?.toLowerCase() === "to";
// Words that say the last ones went to the wrong session: "to X" before them says where they belonged.
const CORRECTS = /\b(?:didn['’]?t|did not) mean\b|\bthat was(?:n['’]?t| not)? (?:for|supposed|meant)\b|\bmeant (?:that |it )?for\b|\bwrong (?:session|one)\b|\bsupposed to (?:go|be)\b/i;
const THIS_IS = "(?:(?:this|that|it)(?:\\s+(?:one|message|question|part))?(?:\\s+is|['’]s)\\s+(?:for|to)|this\\s+goes\\s+to)";
// Sessions said without a name; only in phrases that are plainly instructions to the app.
const GENERIC = ["this session", "that session", "the current session", "the other session", "the other one", "the other project"];
// Not something to pass on by itself: "The atlas agents one, please" leaves nothing for Claude.
const EMPTY = new Set(["uh", "um", "umm", "ah", "er", "erm", "hmm", "please", "thanks", "thank", "you"]);

// ── Numbers said ─────────────────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const SPELLED = Object.keys(NUMBER_WORDS).filter((w) => w !== "one");
// A number said after a name: "kiko 2", "kiko two", "kiko #2", "kiko number two", "kiko no. 2";
// "number one" or "#1" for the plain one. Never "kiko one" ("the kiko one"), nor "kiko 1" or "kiko
// 1st" ("Kiko, 1st commit the changes").
const SAID_NUMBER = `(?:(?:number|no\\.?|#)\\s*(?:\\d+|${Object.keys(NUMBER_WORDS).join("|")})|[2-9]|[1-9]\\d|${SPELLED.join("|")})`;
// Up front, where a name says who it's for: "Kiko 2, …", "To kiko 2: …", "Tell kiko 2, …", "Uh, the kiko 2 one".
const ADDRESS_LEAD =
  /^[\s"'“‘]*(?:(?:hey|hi|ok(?:ay)?|oh|um+|uh+|so|and|also|now|yeah|yes|alright|well)[\s,.!]+)*(?:(?:to|two|2|for|tell|ask)(?:[\s,]+(?:uh+|um+|er+))*[\s,]+)?(?:(?:the|a|an)\s+)?$/iu;
// After "to" or "too" heard for "two": "kiko too, run the tests", "tell kiko too to …", "the kiko too session".
const AFTER_TWO = {
  word: /^\s+(?:to|that)\b|^\s+(?:session|instance|agent|thread|terminal|window)s?(?![\p{L}\p{N}-])/iu,
  pause: /^\s*[,:;.!?…—–-]+\s*(?!(?:uh+|um+|er+|erm|ah)\b)\S/iu,
  end: /^[\s,.!?…]*$/u,
};

/**
 * Words with a number said after a numbered name written as that name's number, so every rule
 * reads one form: "Kiko two, run the tests" → "Kiko project 2, run the tests" (the session's name,
 * since "Kiko" alone is the app: wake.ts), "tell atlas agents number two to …" → "tell atlas agents 2
 * to …". Speech-to-text writes "two" as "to", "too" or "2", which are often just those words ("tell
 * kiko to run the tests", "Kiko, to atlas agents: …", "Kiko 2 atlas agents, …"): those count only where
 * there's a "kiko 2" and they can't be the word, before "to", "that" or "session", or up front
 * with a pause after them ("kiko too, run the tests"), or as all that's said ("kiko too."). Words
 * with no numbered name in them come back as they were.
 */
export function asNumbered(text: string, sessions: readonly Session[]): string {
  const groups = new Map<string, { base: string; forms: Map<string, boolean>; numbers: Set<number> }>();
  for (const session of sessions) {
    const { own, base, number } = naming(session);
    if (!number) continue;
    const key = nameKey(base);
    const group = groups.get(key) ?? { base, forms: new Map(), numbers: new Set() };
    group.numbers.add(number);
    // Each way it's said, and whether that's its name as shown: the others become it ("kiko" → "Kiko project").
    const forms: Array<[string, boolean]> = [
      [heard(base).map(wordPattern).join("[\\s-]+"), true],
      [heard(own).map(wordPattern).join("[\\s-]+"), sameName(own, base)],
    ];
    if (sameName(own, spokenName())) forms.push([`(?:${nameForms()})`, false]);
    for (const [form, shown] of forms) if (!group.forms.has(form)) group.forms.set(form, shown);
    groups.set(key, group);
  }
  let out = text;
  for (const group of groups.values()) {
    // The longest first: "Kiko project two" is the project's whole name, not "Kiko" and more.
    for (const [form, shown] of [...group.forms].sort((a, b) => b[0].length - a[0].length)) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])(?<name>${form})(?:(?<sep>[\\s-]*)(?<num>${SAID_NUMBER})|\\s+(?<two>to|too))(?![\\p{L}\\p{N}])`, "giu");
      out = out.replace(re, (...args) => {
        const m = args[0] as string;
        const at = args.at(-3) as number;
        const all = args.at(-2) as string;
        const g = args.at(-1) as { name: string; sep?: string; num?: string; two?: string };
        const said = (g.num ?? g.two ?? "").toLowerCase();
        const n = g.two ? 2 : numberIn(said);
        // Only a number one of them has: "kiko 3" with none there stays as said (and names no other).
        if (!group.numbers.has(n)) return m;
        // "2", "to", "too": the number only where it can't be the word.
        if (g.two !== undefined || (said === "2" && /\s/.test(g.sep ?? ""))) {
          const before = all.slice(0, at);
          const after = all.slice(at + m.length);
          const up = ADDRESS_LEAD.test(before);
          const told = g.two === "to" && /\b(?:tell|ask)\W+(?:the\W+)?$/i.test(before);
          if (!AFTER_TWO.word.test(after) && !(up && !told && AFTER_TWO.pause.test(after)) && !(up && AFTER_TWO.end.test(after))) return m;
        }
        return `${shown ? g.name : group.base} ${n}`;
      });
    }
  }
  return out;
}

/** "2", "two", "#2", "number two" as 2. */
function numberIn(said: string): number {
  const w = said.replace(/^(?:number|no\.?|#)\s*/, "");
  return /^\d+$/.test(w) ? Number(w) : (NUMBER_WORDS[w] ?? 0);
}

/** A number said for a session ("two", "2", "#2", "number two"): what it is, else 0. For answers that pick one by its number. */
export function saidNumber(word: string): number {
  return numberIn(word.toLowerCase().trim());
}

export type Addressed = {
  /** The sessions the phrase names: one, several sharing a name, or none ("the other one"). */
  sessions: Session[];
  /** What was said, minus the phrase. */
  rest: string;
  dropped: string;
  /** Said as an instruction to the app ("tell X to", "X, …"), not just a mention ("for the X one"). */
  sure: boolean;
};

/**
 * Words that only say which session something is for, cut from what was said:
 * "Atlas agents, check the build", "Ah, for the in-app settings one. Let's merge",
 * "Tell the other one to run the tests", "Let's try the first idea. This is for claude code speech."
 * Each phrase needs a session's folder name or title (or "the other one" in an instruction to the
 * app) and a pause or "to"/"that" after it, so a reply that merely begins with the same words
 * isn't cut. Only `sure` phrases are enough to route on; the others are cut only from words
 * already going to the session they name.
 */
export function addressedTo(sessions: Session[], text: string): Addressed | null {
  const said = text.trim();
  // A session's name (or folder) beats another's title: "random" is the desktop session called
  // random, not a terminal session that also has the title "random".
  const found = new Map<string, { words: string[]; byName: Session[]; byTitle: Session[] }>();
  for (const session of sessions) {
    const all = [...namesOf(session, "name").map((n) => [n, "byName"] as const), ...namesOf(session, "title").map((n) => [n, "byTitle"] as const)];
    for (const [name, by] of all) {
      // As heard: "cloud speech" and "claude speech" are the same name.
      const w = heard(name);
      if (!w.length) continue;
      const entry = found.get(w.join(" ")) ?? { words: w, byName: [], byTitle: [] };
      if (!entry[by].includes(session)) entry[by].push(session);
      found.set(w.join(" "), entry);
    }
  }
  const names = new Map<string, { words: string[]; sessions: Session[] }>();
  for (const [key, { words: w, byName, byTitle }] of found) names.set(key, { words: w, sessions: byName.length ? byName : byTitle });
  for (const generic of GENERIC) names.set(generic, { words: generic.split(" "), sessions: [] });

  // Longest name first, so "claude code speech" wins over a session called "voice".
  for (const { words: w, sessions: named } of [...names.values()].sort((a, b) => b.words.length - a.words.length)) {
    const generic = !named.length;
    const x = w.map((word) => (generic ? escape(word) : wordPattern(word))).join("[^\\p{L}\\p{N}]+");
    const lead = (form: string) => `^\\W*${FILLER}${form}`;
    const phrases: Array<{ src: string; sure: boolean; ok?: (m: RegExpMatchArray) => boolean; sureIf?: (m: RegExpMatchArray) => boolean }> = [
      // "Atlas agents, check the build"
      { src: `^\\W*${x}${PAUSE}`, sure: !generic, ok: () => !generic },
      // "Tell the in-app settings, um, to add a test", "ask the other one to …"
      {
        src: lead(
          `(?:(?:can|could|would)\\s+you\\s+|please\\s+|go\\s+ahead\\s+and\\s+)?(?:tell\\s+(?:the\\s+)?${x}(?:\\s+${SUFFIX})?(?:\\W+(?:uh|um))*(?:\\s*,?\\s*(?:to|that)\\s+|${PAUSE})|ask\\s+(?:the\\s+)?${x}(?:\\s+${SUFFIX})?(?:\\W+(?:uh|um))*\\s*,?\\s*to\\s+)`,
        ),
        sure: true,
      },
      // "Send this to atlas agents: …"
      { src: lead(`(?:send|pass|forward|give)\\s+(?:this|that|it)(?:\\s+on)?\\s+to\\s+(?:the\\s+)?${x}(?:\\s+${SUFFIX})?${PAUSE}`), sure: true },
      // "In the clipkit session, let's …", "On the atlas agent session, can we …"
      { src: lead(`(?:in|on)\\s+(?:the\\s+|a\\s+)?${x}\\s+${SUFFIX}${PAUSE}`), sure: !generic, ok: () => !generic },
      // "This is for atlas agents. …", "Question for the claude code speech one: …"
      { src: lead(`${THIS_IS}\\s+(?:the\\s+)?${x}(?:\\s+${SUFFIX})?${PAUSE}`), sure: true },
      { src: lead(`(?:a\\s+)?(?:question|message|note|request)\\s+for\\s+(?:the\\s+)?${x}(?:\\s+${SUFFIX})?${PAUSE}`), sure: true },
      // "To atlas agents: …", "For the in-app settings one, …", "For claude code speech, …":
      // a one-word name needs "one"/"session" or a colon ("for logs, …" is usually about logs).
      // "To" up front says who it's said to ("To Lacy, …", "To a Kiko project. …", with "the", "a" or
      // "uh" before the name), so it's sure, and any pause will do; but never the app's own name alone
      // ("To Kiko, …" is the app: wake.ts), nor before a correction ("to cloud code speech. I didn't
      // mean for this session": where the last words belonged). Without the "a", "to a Kiko project. …"
      // with a request to check the logs went to the router, which answered itself.
      {
        src: lead(`(?<prep>for|to)[\\s,]+(?:(?:the|a|an|uh|um)\\W+)*${x}(?:\\s+(?<suffix>${SUFFIX}))?(?<pause>${PAUSE})`),
        sure: false,
        ok: (m) => !generic && Boolean(m.groups?.suffix || w.length > 1 || m.groups?.pause.includes(":") || (isTo(m) && !sameName(w.join(" "), spokenName()))),
        sureIf: (m) => isTo(m) && !CORRECTS.test(m.groups!.rest),
      },
      // "And the atlas agents instance. …"
      { src: lead(`(?:the\\s+)?${x}\\s+${SUFFIX}${PAUSE}`), sure: false, ok: () => !generic },
    ];
    for (const { src, sure, ok, sureIf } of phrases) {
      const m = said.match(new RegExp(`${src}(?<rest>[\\s\\S]+)$`, "iu"));
      if (!m || (ok && !ok(m))) continue;
      const rest = cleanStart(m.groups!.rest);
      if (!substantive(rest)) continue;
      return { sessions: named, rest, dropped: said.slice(0, said.length - m.groups!.rest.length).trim(), sure: sure || Boolean(sureIf?.(m)) };
    }
    if (generic) continue;
    // At the end, as its own sentence: "Let's try the first idea. This is for claude code speech."
    const endings = [`${THIS_IS}\\s+(?:the\\s+)?${x}(?:\\s+${SUFFIX})?`, `(?:for|to)\\s+(?:the\\s+)?${x}${w.length > 1 ? `(?:\\s+${SUFFIX})?` : `\\s+${SUFFIX}`}`, `(?:the\\s+)?${x}\\s+${SUFFIX}`];
    for (const ending of endings) {
      const m = said.match(new RegExp(`^(?<kept>[\\s\\S]+?[.!?])\\s+${FILLER}${ending}[\\s.!?]*$`, "iu"));
      const rest = m?.groups?.kept.trim() ?? "";
      if (m && substantive(rest)) return { sessions: named, rest, dropped: said.slice(m.groups!.kept.length).trim(), sure: false };
    }
  }
  return null;
}

/** One session's part of words that give several sessions a part each (splitBySession). */
export type SessionPart = { session: Session; text: string; dropped: string[] };

// Fillers said between words of a direction: "and, uh, tell", "tell, um, Atlas".
const SOUNDS_BETWEEN = "(?:[\\s,]+(?:uh+|um+|umm|er+|erm))*";
// Where one session's part ends and the next one's starts: "and", "and then", ", and also", "then"
// (`and`), or a full stop and what may open the next sentence (". Also", ". And, uh,": `stop`).
const JOIN = `(?<join>(?:\\s*,)?\\s+(?<and>and(?:\\s+(?:then|also))?|then|also|plus)${SOUNDS_BETWEEN}[\\s,]+|\\s*[.;!?]+\\s+(?<stop>(?:(?:and|also|then|so|oh|okay|ok|now)${SOUNDS_BETWEEN}[\\s,]+)*))`;
// "Tell", "ask", "please tell", "tell, uh,": the direction before a session's name.
const DIRECT = `(?:(?:please|now|also)\\s+)?(?<verb>tell|ask)${SOUNDS_BETWEEN}[\\s,]+`;
// After ". Atlas, …": words that make the name what the sentence is about, not who it's said to
// ("Atlas, for example, did it that way", "Atlas, too, uses it").
export const NOT_SAID_TO = /^(?:for|too|as|who|which|that|is|was|has|had|did|does|already|said|says|and|or|but|though|however|like|by|in|on|at|of|with|the|a|an|its|it's)\b/i;
// Up front: "Tell …", "Okay, can you ask …", "Go ahead and tell …".
const DIRECT_LEAD = `^\\W*${FILLER}(?:(?:can|could|would)\\s+you\\s+|please\\s+|go\\s+ahead\\s+and\\s+)?`;

/** The patterns a session's names are said by, for splitBySession: as heard, words apart or run together; never the app's own name. */
export function namePatterns(session: Session): string[] {
  const out = new Set<string>();
  for (const name of namesOf(session, "name")) {
    const w = heard(name);
    if (!w.length || appsName(name)) continue;
    out.add(w.map(wordPattern).join("[^\\p{L}\\p{N}]+"));
    if (w.length > 1) out.add(escape(w.join("")));
  }
  return [...out];
}

/** The session whose name `text` starts with ("the atlas session …"), the longest name said; and how long that is. */
function nameAtStart(sessions: Session[], text: string): { session: Session; length: number } | null {
  let best: { session: Session; length: number } | null = null;
  for (const session of sessions) {
    for (const x of namePatterns(session)) {
      const m = new RegExp(`^(?:the\\s+)?(?:${x})(?:\\s+${SUFFIX})?(?![\\p{L}\\p{N}'’-])`, "iu").exec(text);
      if (m && (!best || m[0].length > best.length)) best = { session, length: m[0].length };
    }
  }
  return best;
}

/**
 * Words that give two or more sessions a part each, one after the other, cut into those parts:
 * "Tell Harbor to deploy and tell Atlas to tag the release v3.2.0." (harbor: "Deploy.", atlas: "Tag
 * the release v3.2.0."), "Tell Mintbox to add the export button and Pixie to update the screenshots.",
 * "Tell Harbor to roll back. Atlas, hold the release." And one direction to several by name, "Tell
 * Atlas and Harbor to pull main.": each gets "Pull main." Deletion only: each part is a piece of what
 * was said, less the direction to it (what addressedTo cuts for one session: "tell Atlas to", "Atlas,"),
 * the "and" joining it and the other sessions' parts. A part said to its session another way ("and ask
 * Atlas whether it's tagged") goes as said, as it would alone.
 *
 * `first`: who a first part that names no session is for (the session waiting for a reply: "Merge it,
 * and tell Harbor to deploy."), or null. Null back: the words don't speak to two sessions in turn, as
 * one session's words that only mention another don't ("Tell Bobby that MintBox already fixed the
 * cert", "Tell Harbor to deploy what Atlas merged"): they stay that session's, whole. `unclear`, with
 * the sessions named: they do, but don't cut into one part each (a first part for nobody, a part with
 * nothing in it), so nothing should go anywhere yet.
 */
export function splitBySession(sessions: Session[], text: string, first: Session | null = null): { parts: SessionPart[] } | { unclear: Session[] } | null {
  const said = text.trim();
  const several = toSeveral(sessions, said);
  if (several) return several;
  // Where each later part starts: after an "and" or a full stop, "tell X …", "ask X …", "X to …" or "X, …".
  type Start = { at: number; from: number; session: Session; elliptic: boolean };
  const starts: Start[] = [];
  for (const session of sessions) {
    for (const x of namePatterns(session)) {
      const re = new RegExp(`${JOIN}(?:${DIRECT})?(?:the\\s+)?(?:${x})(?:\\s+${SUFFIX})?(?![\\p{L}\\p{N}'’-])(?<after>\\s*,?\\s*(?:to|that)\\s+|\\s*[,:]\\s+|\\s+)`, "giu");
      for (const m of said.matchAll(re)) {
        const g = m.groups!;
        const after = g.after.toLowerCase();
        const how = /\bto\s+$/.test(after) ? "to" : /\bthat\s+$/.test(after) ? "that" : /[,:]/.test(after) ? "pause" : "space";
        const verb = g.verb?.toLowerCase();
        // "and tell Atlas to …", "and ask Atlas whether …"; "and Pixie to …" (after a "tell X to" first
        // part); ". Atlas, …" (a new sentence said to it). Not "and Pixie said …", nor "compare Juniper and Orbit to …".
        const ok = verb
          ? true
          : how === "to"
            ? g.and !== undefined && !endsInName(sessions, said.slice(0, m.index))
            : how === "pause" && g.stop !== undefined && !NOT_SAID_TO.test(said.slice(m.index + m[0].length));
        if (!ok) continue;
        // The direction cut as addressedTo cuts it for one: "tell X to", "tell X that", "tell X,", "ask X to",
        // "X,", "X to"; otherwise ("ask Atlas whether …", "tell Atlas the …") its part goes as said.
        const cuts = verb === "ask" ? how === "to" : how !== "space";
        starts.push({ at: m.index, from: cuts ? m.index + m[0].length : m.index + g.join.length, session, elliptic: !verb && how === "to" });
      }
    }
  }
  if (!starts.length) return null;
  // In the order said; where two names start at one place, the longer.
  starts.sort((a, b) => a.at - b.at || b.from - a.from);
  const later: Start[] = [];
  for (const s of starts) if (!later.length || s.at >= later.at(-1)!.from) later.push(s);
  // The first part: said to a session up front ("Tell Harbor to …", "Ask Atlas whether …"), else `first`.
  const head = said.slice(0, later[0].at);
  const lead = leadPart(sessions, head);
  // "… and Pixie to …" only after "tell X to …" up front.
  if (later.some((s) => s.elliptic) && !lead?.told) return null;
  const firstSession = lead?.session ?? first;
  const named = [...new Set([...(firstSession ? [firstSession] : []), ...later.map((s) => s.session)])];
  if (named.length < 2) return null;
  if (!firstSession) return { unclear: named };
  const end = /[.!?]$/.test(said) ? said.slice(-1) : "";
  const pieces = [
    { session: firstSession, text: lead ? lead.rest : head, from: 0, to: later[0].at, direction: lead?.direction ?? "" },
    ...later.map((s, i) => {
      const to = later[i + 1]?.at ?? said.length;
      return { session: s.session, text: said.slice(s.from, to), from: s.at, to, direction: said.slice(s.at, s.from) };
    }),
  ];
  const parts: SessionPart[] = [];
  for (const [i, p] of pieces.entries()) {
    const body = cleanStart(p.text.replace(/[\s,;:—–-]+$/, ""));
    if (!substantive(body)) return { unclear: named };
    const text = /[.!?]$/.test(body) || !end ? body : `${body}${i === pieces.length - 1 ? end : "."}`;
    // All that was said and isn't its part: what came before, the direction to it, what comes after.
    const dropped = [said.slice(0, p.from), p.direction, said.slice(p.to)].map((d) => d.trim()).filter(substantive);
    parts.push({ session: p.session, text, dropped });
  }
  // Two parts for one session aren't a split: that's one session's words.
  if (new Set(parts.map((p) => p.session)).size < parts.length) return null;
  return { parts };
}

/**
 * The session the first part is said to up front, and the part without the direction to it: as
 * addressedTo cuts it ("Tell Harbor to deploy" → "deploy", "Harbor, deploy", "tell Kikodev to …"),
 * or as said when it's directed there another way ("Ask Atlas whether the tests pass"). `told`: a
 * "tell X to" or "ask X to", after which "… and Pixie to …" gives Pixie a part. Null when the part
 * names no session up front; `rest` empty when there's nothing in it but the direction.
 */
function leadPart(sessions: Session[], part: string): { session: Session; rest: string; direction: string; told: boolean } | null {
  const phrase = addressedTo(sessions, part);
  if (phrase?.sure && phrase.sessions.length === 1) {
    return { session: phrase.sessions[0], rest: phrase.rest, direction: phrase.dropped, told: /\b(?:tell|ask)\b/i.test(phrase.dropped) };
  }
  const verb = new RegExp(`${DIRECT_LEAD}${DIRECT}`, "iu").exec(part);
  const name = verb && nameAtStart(sessions, part.slice(verb[0].length));
  if (!verb || !name) return null;
  const at = verb[0].length + name.length;
  const to = /^\s*,?\s*(?:to|that)(?:\s+|$)|^\s*[,:]\s+/i.exec(part.slice(at));
  const cut = to && (verb.groups!.verb.toLowerCase() === "tell" || /\bto(?:\s+|$)/i.test(to[0]));
  const rest = part.slice(at + (to?.[0].length ?? 0));
  if (!substantive(rest)) return { session: name.session, rest: "", direction: part, told: Boolean(cut) };
  return cut ? { session: name.session, rest: cleanStart(rest), direction: part.slice(0, at + to![0].length).trim(), told: true } : { session: name.session, rest: part, direction: "", told: false };
}

// Who a later "and tell X to …" may be said to that isn't a session: you, people, everyone.
const NOT_A_SESSION = /^(?:me|us|him|her|them|it|everyone|everybody|both|all|someone|somebody|the|a|an|my|our|your|their)$/i;

/**
 * Words said to a session up front that go on to give another one a part, by a name that's no
 * session's ("Tell Harbor to deploy and tell Atlus to tag the release"): the session up front and
 * the word said for the other's name, for decide.ts to weigh (a name heard wrong: ask, rather than
 * send it all to Harbor). Null otherwise: no direction up front, or the later one is to you ("and
 * tell me when it's done"), to everyone, or to a session (splitBySession has those).
 */
export function partForUnknown(sessions: Session[], text: string): { first: Session; heard: string } | null {
  const said = text.trim();
  const re = new RegExp(`${JOIN}${DIRECT}(?<name>[\\p{L}][\\p{L}\\p{N}-]*)(?:\\s+${SUFFIX})?(?:${SOUNDS_BETWEEN})?\\s*,?\\s*(?:to|that|whether|if)\\s`, "giu");
  for (const m of said.matchAll(re)) {
    const name = m.groups!.name;
    if (NOT_A_SESSION.test(name) || nameAtStart(sessions, said.slice(m.index + m[0].indexOf(name, m.groups!.join.length)))) continue;
    const lead = leadPart(sessions, said.slice(0, m.index));
    if (lead) return { first: lead.session, heard: name };
  }
  return null;
}

/** Whether `before` ends in a session's name ("… compare Juniper"): an "and" after it lists another, it doesn't start a part. */
function endsInName(sessions: Session[], before: string) {
  return sessions.some((session) => namePatterns(session).some((x) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${x})(?:\\s+${SUFFIX})?[\\s,]*$`, "iu").test(before)));
}

// A question about a session, asked of the app in the third person (askedAbout); X is the session's name.
const ASK_LEAD = String.raw`^\W*(?:(?:so|and|okay|ok|hey|um+|uh+|oh|also|wait|quick question|just wondering|do you know|any idea)[\s,]+)*`;
const STATE = String.raw`(?:done|finished|ready|busy|idle|working|running|stuck|waiting|blocked|deploying|building|testing|at it|on it|through|(?:still|already)\s+\p{L}+ing)`;
const FOUND = String.raw`(?:finish(?:ed)?|complete(?:d)?|wrap(?:ped)?\s+up|g[eo]t\s+done|repl(?:y|ied)|answer(?:ed)?|respond(?:ed)?|say|said|find|found|report(?:ed)?|come\s+back|came\s+back|g[eo]t\s+back|figure(?:d)?\s+(?:it\s+)?out|tell\s+me|told\s+me|done)`;
const ABOUT_IT = String.raw`(?:status|state|progress|update|updates|news|finding|findings|result|results|outcome|issue|problem|answer|verdict|conclusion|plan|word)`;
const ASKED_ABOUT = (x: string) =>
  [
    // "Is Harbor still deploying?", "Is the mintbox session done?", "Was Atlas busy?"
    String.raw`(?:is|was)\s+${x}\s+(?:(?:still|already|now|even)\s+)*${STATE}`,
    // "Is Harbor's deploy done?", "Has Atlas's build finished?"
    String.raw`(?:is|was|has|did)\s+${x}['’]s\s+\p{L}+(?:\s+\p{L}+)?\s+(?:(?:still|already|now)\s+)*(?:${STATE}|${FOUND}|over|passing|failing)`,
    // "Has Atlas finished?", "Did MintBox find anything?", "Did Harbor say anything?"
    String.raw`(?:has|have|did)\s+${x}\s+(?:(?:already|just|even|ever)\s+)?${FOUND}`,
    // "What's the status for MintBox?", "What was the finding on MintBox?"
    String.raw`what(?:['’]s|\s+is|\s+was|\s+are|\s+were)\s+(?:the\s+)?(?:(?:current|latest|last|final|main)\s+)?${ABOUT_IT}\s+(?:on|for|of|with|from|in|at)\s+${x}`,
    // "What is Atlas working on?", "What's MintBox's status?", "What's Harbor up to?"
    String.raw`what(?:['’]s|\s+is|\s+was)\s+${x}(?:['’]s\s+${ABOUT_IT}|\s+(?:doing|working\s+on|up\s+to|busy\s+with|stuck\s+on|on\s+now))`,
    // "What did MintBox say the issue was?", "What did Atlas find?"
    String.raw`what\s+did\s+${x}\s+(?:say|tell\s+(?:me|you)|find|report|conclude|decide|come\s+back\s+with|figure\s+out|end\s+up\s+with|think)`,
    // "How's Harbor doing?", "How far along is Atlas?", "Where's Atlas at?"
    String.raw`how(?:['’]s|\s+is|\s+are)\s+${x}\s+(?:doing|going|getting\s+on|coming\s+along|looking|progressing)`,
    String.raw`how\s+far\s+(?:along\s+)?is\s+${x}`,
    String.raw`where(?:['’]s|\s+is)\s+${x}\s+(?:at|with|up\s+to)`,
    // "Any news on Harbor?", "Is there an update from MintBox?"
    String.raw`(?:any|is\s+there\s+(?:any|an?)|got\s+any)\s+(?:news|updates?|word)\s+(?:on|from)\s+${x}`,
  ].join("|");

/**
 * The sessions a question asks the app about, in the third person, as its first sentence: "Is Harbor
 * still deploying?", "What's the status for MintBox?", "What was the finding on MintBox?", "What is
 * Atlas working on?", "What did MintBox say the issue was?", "Has Atlas finished?". Its status, what
 * it's doing, said or found: what the app knows from the list and the conversation. Not a question
 * said to the session ("Bobby, are you still deploying?", "MintBox, what was the issue?": addressedTo
 * has those), nor a request ("Can MintBox check the logs?", "Ask Harbor if it's done").
 */
export function askedAbout(sessions: Session[], text: string): Session[] {
  const first = text.trim().split(/(?<=[.?!])\s+/)[0] ?? "";
  return sessions.filter((session) =>
    namePatterns(session).some((x) => new RegExp(`${ASK_LEAD}(?:${ASKED_ABOUT(`(?:the\\s+)?(?:${x})(?:\\s+${SUFFIX})?(?![\\p{L}\\p{N}-])`)})(?![\\p{L}\\p{N}])`, "iu").test(first)),
  );
}

/**
 * "Tell Atlas and Harbor to pull main.", "Tell Atlas, Harbor and Juniper that the review moved.":
 * one direction to several sessions by name, as addressedTo's "tell X to" is for one; each gets the
 * rest, as direct speech where that's mechanical (direct-speech.ts): "Tell Atlas and Harbor not to
 * push" → "Don't push.", "Ask Atlas and Orbit what the timeout is" → "What is the timeout?", "Ask
 * Atlas and Orbit if they're done" → "Are you done?". A question that isn't mechanical to turn
 * around ("Ask Bobby and Kikodev if either of them changed the SSH config") isn't split here: the
 * router writes it for each, its words checked (decide.ts).
 */
function toSeveral(sessions: Session[], said: string): { parts: SessionPart[] } | null {
  const lead = new RegExp(`${DIRECT_LEAD}${DIRECT}`, "iu").exec(said);
  if (!lead) return null;
  const first = nameAtStart(sessions, said.slice(lead[0].length));
  if (!first) return null;
  const named = [first.session];
  let at = lead[0].length + first.length;
  for (;;) {
    const sep = /^(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*)/i.exec(said.slice(at));
    const next = sep && nameAtStart(sessions, said.slice(at + sep[0].length));
    if (!sep || !next) break;
    named.push(next.session);
    at += sep[0].length + next.length;
  }
  if (named.length < 2 || new Set(named).size < named.length) return null;
  const ask = lead.groups!.verb.toLowerCase() === "ask";
  const after = /^\s*,?\s*(?:(?<neg>not|never)\s+)?to\s+|^\s*,?\s*(?<that>that\s+|[,:]\s*)|^\s*,?\s*(?<q>whether|if)\s+|^\s*,?\s*(?<wh>what|which|who|whose|why|how|when|where)(?=['’]s\b|\s)/i.exec(
    said.slice(at),
  );
  if (!after) return null;
  const g = after.groups!;
  const body = said.slice(at + after[0].length);
  // "ask X and Y that …" isn't said; "tell X and Y whether …" is a question about them, not to them.
  if ((ask && g.that !== undefined) || (!ask && (g.q || g.wh))) return null;
  const neg = g.neg?.toLowerCase() as "not" | "never" | undefined;
  const whs = g.wh && /^['’]s\b/.test(body) ? `${g.wh.charAt(0).toUpperCase()}${g.wh.slice(1).toLowerCase()}${body.trim().replace(/[.?!]+$/, "")}?` : null;
  const direct = g.q ? yesNoQuestion(body, true) : g.wh ? (whs ?? whQuestion(g.wh, body, true)) : g.that !== undefined ? statement(body) : imperative(cleanStart(body), neg ?? null);
  if (!direct || !substantive(direct)) return null;
  const direction = said.slice(0, at + after[0].length - (g.wh?.length ?? 0)).trim();
  const dropped = [neg ? direction.replace(/\s+(?:not|never)(?=\s+to$)/i, "") : direction];
  if (!keepsWords(said, direct, dropped)) return null;
  return { parts: named.map((session) => ({ session, text: direct, dropped })) };
}

/**
 * Whether words name a session: a folder name or title in full ("atlas agents"; a one-word name
 * only as "for pixie" or "the pixie one", since "check the logs" isn't about a logs folder), a
 * word for a session ("the other session", "the voice agent"), or "one" with a word from a name
 * ("the settings one"). "For the settings, …" alone doesn't: that's about settings.
 */
export function namesSession(sessions: Session[], text: string) {
  if (/ (session|instance|agent|thread|terminal|window)s? /.test(fluent(text))) return true;
  return sessions.some((session) => mentionsSession(session, text));
}

/**
 * Whether words name this session in particular, by its name, folder or title (see namesSession);
 * `by` limits it to its name and folder, its title, its folder alone, or what's its alone.
 */
export function mentionsSession(session: Session, text: string, by: NamedBy = "either") {
  const said = fluent(text);
  const after = numberAfter(session);
  const end = after ? ` (?!${after})` : " ";
  const has = (phrase: string) => new RegExp(`${phrase}${end}`).test(said);
  return namesOf(session, by).some((name) => {
    const w = heard(name);
    if (!w.length) return false;
    if (w.length > 1 && has(` ${w.map(escape).join(" ")}`)) return true;
    if (w.length === 1 && has(` (?:(?:for|to|tell|ask|stop|interrupt|rename)(?: the)? ${escape(w[0])}|${escape(w[0])} (?:one|session|instance))`)) return true;
    // "The settings one": a word of its name right before "one". Not "one" anywhere with a word
    // of its title anywhere: "One more thing. … while I'm in Ivy Beta …" named a session titled
    // "… overriding Ivy Beta Cmd+E shortcut", so a send the router guessed there went unheld.
    return w.some((word) => word.length > 3 && new RegExp(` ${escape(word)} ones? `).test(said));
  });
}

/**
 * The sessions your words call by a name of theirs, anywhere in them: a name it was given or its
 * folder, as speech gives it ("kiko dev", or run together, "Kikodev", for kiko-dev; a one-word
 * name only as mentionsSession has it: "for pixie", "the pixie session"). Never by its title
 * (words about the same thing aren't its name), and never by the app's own name alone ("I
 * restarted Kiko" isn't the session in the kiko folder: wake.ts). Also one spoken to up front,
 * "Hey Bobby, …" (addressedByName). For decide.ts: a strong hint to the router, and with the
 * classifier agreeing, where the words go.
 */
export function calledByName(sessions: Session[], text: string): Session[] {
  const said = fluent(text);
  const spokenTo = new Set(addressedByName(sessions, text));
  return sessions.filter((session) => {
    if (spokenTo.has(session)) return true;
    const after = numberAfter(session);
    const has = (phrase: string) => new RegExp(`${phrase}${after ? ` (?!${after})` : " "}`).test(said);
    return namesOf(session, "name").some((name) => {
      const w = heard(name);
      if (!w.length || appsName(name)) return false;
      if (w.length > 1) return has(` (?:${w.map(escape).join(" ")}|${escape(w.join(""))})`);
      return has(` (?:(?:for|to|tell|ask)(?: the)? ${escape(w[0])}|${escape(w[0])} (?:one|session|instance))`);
    });
  });
}

// The app's own name (or the one you call it): never a session's, said alone.
const appsName = (name: string) => sameName(name, NAME) || sameName(name, spokenName());
// Before a name up front: only sounds ("uh, Bobby, …"), never words that could start a sentence.
const SOUNDS = "(?:(?:uh|um|umm|oh|ah)\\W+)*";
// A pause after it, as speech-to-text writes one; not a hyphen into another word ("api-gateway").
const SPOKEN_TO_PAUSE = "\\s*[,:;.!?…—–]+|\\s+-+";

/**
 * The sessions your words speak to, by a name of theirs at the very start: "Hey Bobby, …", "Hi
 * Bobby can you …", "Yo Bobby", "OK Bobby, …", or the name alone with a pause after it, "Bobby,
 * can you …". Its own name or folder, never its title, and never the app's name ("Hey Kiko" is the
 * app: wake.ts). A pause after the name is needed unless "hey", "hi", "hello" or "yo" comes right
 * before it: "Okay logs look fine" and "Hey, logs are failing" are about logs, not a session called
 * logs; "The api is slow, can you …" names nothing. The longest name wins ("Hey kiko dev" over a
 * session called kiko). Once, "Hey Bobby, can you also look at …" named nobody
 * (a one-word name needed "for Bobby" or "the Bobby session"), and the router ran its own quick check.
 */
export function addressedByName(sessions: Session[], text: string): Session[] {
  const said = text.trim().replace(/’/g, "'");
  let best = 0;
  let found: Session[] = [];
  for (const session of sessions) {
    // "Hey kiko 2, …" isn't the plain kiko.
    const numbered = numberAfter(session) ? "(?![\\s,]*\\d)" : "";
    for (const name of namesOf(session, "name")) {
      const w = heard(name);
      if (!w.length || appsName(name)) continue;
      const x = w.map((word) => SOUNDS_LIKE[word] ?? escape(word)).join("[\\s_-]*");
      const m = new RegExp(`^\\W*${SOUNDS}(?:(?<greet>hey|hi|hello|yo|ok|okay)(?<gap>\\W+)${SOUNDS})?(?<name>${x})(?![\\p{L}\\p{N}'])${numbered}(?<pause>${SPOKEN_TO_PAUSE})?`, "iu").exec(said);
      if (!m?.groups) continue;
      const { greet, gap, pause } = m.groups;
      const close = greet !== undefined && /^(?:hey|hi|hello|yo)$/i.test(greet) && /^\s+$/.test(gap);
      if (!pause && !close) continue;
      const length = m.groups.name.length;
      if (length > best) [best, found] = [length, []];
      if (length === best && !found.includes(session)) found.push(session);
    }
  }
  return found;
}

/**
 * The sessions words name, by name first: only when no session's name is in them, the ones whose
 * title is. So "the random session" is the desktop session called random, not another session
 * that's only titled "random". Several back means it's truly ambiguous. `loose` counts a name
 * anywhere in the words, run together or apart ("the last clip kit message"): for words already
 * about a session (which one to repeat), never for picking where words go. `nameOnly`: never by title.
 */
export function sessionsNamed(sessions: Session[], text: string, loose = false, nameOnly = false): Session[] {
  const said = heard(text);
  // `after`: what, said after the name, makes it another session's (numberAfter).
  const inWords = (name: string, after: RegExp | null) => {
    const target = heard(name).join("");
    if (!target) return false;
    for (let i = 0; i < said.length; i++) {
      let run = "";
      for (let j = i; j < said.length && run.length < target.length; j++) {
        run += said[j];
        if (run === target && !after?.test(`${said.slice(j + 1).join(" ")} `)) return true;
      }
    }
    return false;
  };
  const names = (session: Session, by: "name" | "title") => {
    const after = numberAfter(session);
    const re = after ? new RegExp(`^${after}`) : null;
    return loose ? namesOf(session, by).some((n) => inWords(n, re)) : mentionsSession(session, text, by);
  };
  const byName = sessions.filter((session) => names(session, "name"));
  return byName.length || nameOnly ? byName : sessions.filter((session) => session.title && names(session, "title"));
}

// "Uh, let's merge" → "Let's merge" once what came before it is cut.
function cleanStart(rest: string) {
  const s = rest.trim().replace(/^(?:(?:uh|um|umm|ah|er|erm)\b[\s,.]*)+/i, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function substantive(text: string) {
  return words(text).some((w) => !EMPTY.has(w));
}

/** "20s ago", "5m ago" for prompts. */
export function ago(at: number) {
  if (!at) return "unknown";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}
