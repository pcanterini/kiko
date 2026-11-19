// What Kiko said while a phone wasn't there to hear it: not connected (locked, the app closed,
// out of reach), or connected but away (the app went to the background and said so). The server
// adds each line it hears said (an announcement, a permission question, an answer) for every paired
// phone that isn't present then; a phone gets its unread ones in `missed` as it comes back, marks
// them read (`seen`), and can have them read aloud (`catch_up`).
//
// Only a record: nothing here changes what the Mac says or when. Kept per phone in missed.json
// next to phones.json, so it survives the phone reconnecting, the Phone setting going off and on,
// and Kiko restarting.
//
// An item is settled once it no longer needs the phone: a permission question answered anywhere
// (the Mac, the phone) or gone, a session's update replied to or superseded by a newer one, a line
// you took in at the Mac (seen-on-mac.ts). The
// server says so as it happens (settle*), and connected phones hear of it (missed_settled). A
// settled item stays listed, marked, and catch-ups leave it out.
//
// Two parts: MissedLog, the record itself; and PhonesMissed, the server's side of it (server.ts):
// what's said while a paired phone isn't there (not connected, or away: in the background) is kept
// for it and sent as it comes back (missed); catch_up reads it aloud through the app's speech (one
// summary, or line by line). An item that no longer needs the phone is settled, and connected phones
// are told (missed_settled). A phone still connected but away gets each line as it's kept
// (missed_line), so its app, while iOS lets it run, can post a notification: quietly (`quiet`, no
// notification) while you're at the Mac (at-mac.ts). A line you took in at the Mac (said out loud
// while you were there, or shown and Kiko used there soon after: seen-on-mac.ts) is settled as seen
// there (`seen_on_mac`).
import { readJsonFile, writeJsonAtomic } from "../core/json-file.ts";
import { agent } from "../agents/index.ts";
import { log } from "../core/log.ts";
import { NAME } from "../core/name.ts";
import { findSession, LeftTheList, spoken } from "../core/sessions.ts";
import { ui, type Line, type UiState } from "../core/ui-store.ts";
import { atMacLog, type AtMac, type MacPresence } from "./at-mac.ts";
import type { Pairing } from "./pairing.ts";
import { NEEDS_INPUT, SeenOnMac, usedAtMac, type MacUse } from "./seen-on-mac.ts";
import type { Conn, PhoneHub } from "./server.ts";

export type MissedKind = "announcement" | "permission" | "answer";

/**
 * Why an item no longer needs the phone: a permission question answered on the Mac (its keys, by
 * voice, in its terminal) or on the phone; a session's update replied to (words sent or typed to
 * it, by any path) or superseded (a newer update from the same session); closed (the question
 * went away without anyone answering it here: the session moved on, or was interrupted); or seen
 * on the Mac (said out loud there while you were at it, or shown there and Kiko used on the Mac
 * soon after: seen-on-mac.ts).
 */
export type SettledHow = "answered_on_mac" | "answered_on_phone" | "replied" | "superseded" | "closed" | "seen_on_mac";
const SETTLED_HOWS: SettledHow[] = ["answered_on_mac", "answered_on_phone", "replied", "superseded", "closed", "seen_on_mac"];
export type Settled = { how: SettledHow; at: number };

/**
 * One line Kiko said. `id` goes up with time (ms since 1970, or one more than the last), so ids
 * stay in order across restarts; `text` is as shown on screen, not respelled for the voice.
 * `settled`: it no longer needs the phone, and why. `promptId` (a permission question: the prompt
 * it asked about) and `asked` (an update: what the session was last asked then, to tell later
 * whether it's been given words since) are the hub's own, never sent (wire).
 */
export type Missed = {
  id: number;
  at: number;
  sessionId: string | null;
  name: string | null;
  kind: MissedKind;
  text: string;
  settled?: Settled;
  promptId?: string;
  asked?: string;
  /** Kiko's line ending a quick check: what it checked (the phone shows "Kiko checked: …" over the answer). */
  checked?: string;
};

/** An item as the phone gets it: without the hub's own fields. */
export function wire(item: Missed) {
  const { promptId: _p, asked: _a, ...sent } = item;
  return sent;
}

/** What a phone keeps at most: the newest, read or not (read ones go first). */
export const MAX_MISSED = 50;
const TEXT_MAX = 8000;

type PhoneLog = { items: Missed[]; seenUpTo: number };

export class MissedLog {
  private file: string | null;
  private now: () => number;
  private phones = new Map<string, PhoneLog>();
  private lastId = 0;
  /** Items just settled, per phone that has them (the server tells the connected ones). */
  onSettled: (phoneId: string, items: Missed[]) => void = () => {};

  /** `file` null: kept in memory only (tests). */
  constructor(file: string | null, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    this.load();
  }

  /**
   * Something was said, for each phone in `absent` (paired, and not here to hear it). The same line
   * said again for the same session (a prompt asked again after a press) is kept once. The item, or
   * null when no phone missed it.
   *
   * A session's newer update settles what it said before: an older update is superseded, and a
   * permission question it asked is over (the turn it was holding up has finished): closed, unless
   * it was settled already.
   */
  add(said: Omit<Missed, "id" | "at" | "settled">, absent: string[]): Missed | null {
    if (!absent.length) return null;
    const at = this.now();
    const item: Missed = { id: Math.max(at, this.lastId + 1), at, ...said, text: said.text.slice(0, TEXT_MAX) };
    this.lastId = item.id;
    const added: string[] = [];
    for (const phoneId of absent) {
      const log = this.of(phoneId);
      const last = log.items.at(-1);
      if (last && last.id > log.seenUpTo && last.sessionId === item.sessionId && last.text === item.text) continue;
      // Each phone's own copy: settling it for one never touches another's.
      log.items.push({ ...item });
      added.push(phoneId);
      if (log.items.length > MAX_MISSED) log.items.splice(0, log.items.length - MAX_MISSED);
    }
    if (item.kind === "announcement" && item.sessionId && added.length) {
      const before = (x: Missed) => x.sessionId === item.sessionId && x.id < item.id;
      this.settle((x) => before(x) && x.kind === "announcement", "superseded", { save: false, phones: added });
      this.settle((x) => before(x) && x.kind === "permission", "closed", { save: false, phones: added });
    }
    this.save();
    return item;
  }

  /**
   * Settles every unsettled item `match` picks, on every phone (only `phones`, when given), as
   * `how`: told through onSettled, per phone. The items settled (each phone's copy), none when
   * nothing matched.
   */
  settle(match: (item: Missed) => boolean, how: SettledHow, { save = true, phones }: { save?: boolean; phones?: string[] } = {}): Missed[] {
    const at = this.now();
    const all: Missed[] = [];
    for (const [phoneId, log] of this.phones) {
      if (phones && !phones.includes(phoneId)) continue;
      const items = log.items.filter((x) => !x.settled && match(x));
      for (const x of items) x.settled = { how, at };
      if (!items.length) continue;
      all.push(...items);
      this.onSettled(phoneId, items);
    }
    if (all.length && save) this.save();
    return all;
  }

  /** A permission question was answered, or went away: its items (by its prompt; else its session's). */
  settlePrompt(promptId: string, sessionIds: string[], how: SettledHow) {
    return this.settle((x) => x.kind === "permission" && (x.promptId ? x.promptId === promptId : x.sessionId !== null && sessionIds.includes(x.sessionId)), how);
  }

  /** Every unsettled item of these kinds about one session (any of the ids it goes by). */
  settleSession(sessionIds: string[], kinds: MissedKind[], how: SettledHow) {
    return this.settle((x) => x.sessionId !== null && sessionIds.includes(x.sessionId) && kinds.includes(x.kind), how);
  }

  /** Every phone's unsettled items, for the server's own checks (one copy per item id). */
  open(): Missed[] {
    const seen = new Map<number, Missed>();
    for (const log of this.phones.values()) for (const x of log.items) if (!x.settled && !seen.has(x.id)) seen.set(x.id, x);
    return [...seen.values()];
  }

  /** This phone's settled items (read or not), oldest first: sent again as it comes back. */
  settled(phoneId: string): Missed[] {
    return (this.phones.get(phoneId)?.items ?? []).filter((x) => x.settled);
  }

  /** What this phone hasn't read yet, oldest first. */
  unread(phoneId: string): Missed[] {
    const log = this.phones.get(phoneId);
    return log ? log.items.filter((x) => x.id > log.seenUpTo) : [];
  }

  /** This phone's items with these ids, read or not (catch_up from a list already opened), oldest first; without ids, its unread ones. */
  find(phoneId: string, ids?: number[] | null): Missed[] {
    if (!ids) return this.unread(phoneId);
    return (this.phones.get(phoneId)?.items ?? []).filter((x) => ids.includes(x.id));
  }

  /** Read up to `upTo`: they aren't sent again. */
  seen(phoneId: string, upTo: number) {
    const log = this.phones.get(phoneId);
    if (!log || upTo <= log.seenUpTo) return;
    log.seenUpTo = upTo;
    this.save();
  }

  /** Forgotten phones' records go. */
  forget(phoneIds: string[]) {
    if (!phoneIds.some((id) => this.phones.delete(id))) return;
    this.save();
  }

  /** Only these phones' records are kept (the paired ones). */
  keep(phoneIds: string[]) {
    this.forget([...this.phones.keys()].filter((id) => !phoneIds.includes(id)));
  }

  private of(phoneId: string): PhoneLog {
    let log = this.phones.get(phoneId);
    if (!log) this.phones.set(phoneId, (log = { items: [], seenUpTo: 0 }));
    return log;
  }

  private load() {
    if (!this.file) return;
    // None yet: empty. One that can't be read is set aside, never saved over (core/json-file.ts): empty too.
    const data = readJsonFile(this.file) as { phones?: unknown } | undefined;
    for (const [id, log] of Object.entries<any>(data?.phones ?? {})) {
      if (!Array.isArray(log?.items)) continue;
      const items: Missed[] = log.items.filter((x: any) => Number.isInteger(x?.id) && typeof x.text === "string").slice(-MAX_MISSED);
      for (const x of items) if (x.settled && !(SETTLED_HOWS.includes(x.settled.how) && Number.isInteger(x.settled.at))) delete x.settled;
      const seenUpTo = Number.isInteger(log.seenUpTo) ? log.seenUpTo : 0;
      this.phones.set(id, { items, seenUpTo });
      this.lastId = Math.max(this.lastId, seenUpTo, ...items.map((x) => x.id));
    }
  }

  private save() {
    if (!this.file) return;
    try {
      writeJsonAtomic(this.file, { phones: Object.fromEntries(this.phones) }, { mode: 0o600, compact: true });
    } catch (err) {
      // Kept in memory: the next save tries again.
      log("missed_save_failed", { error: (err as Error).message });
    }
  }
}

/** A quick check's result as said in a catch-up: "Kiko checked how much disk space is free". */
export const checkedLine = (checked: string) => `${NAME} checked ${checked.replace(/[\s.?!]+$/, "")}`;

/**
 * How a missed line is read in a catch-up: as said, with the session's name first when the line
 * doesn't say it (a second summary from the same session leaves it out, and out of context it's needed).
 */
export function catchUpLine(item: Missed): string {
  if (item.checked) return `${checkedLine(item.checked)}: ${item.text}`;
  if (!item.name) return item.text;
  const said = spoken(item.name);
  const text = item.text.toLowerCase();
  if (text.includes(item.name.toLowerCase()) || text.includes(said.toLowerCase())) return item.text;
  return `${said}: ${item.text}`;
}

// A permission question the hub let go of (its window ran out, its hook went away) waits in the
// session's terminal while the session is listed as blocked. Sessions are listed again every few
// seconds, so one let go of this long ago and not blocked has been dealt with there.
const LET_GO_MS = 15_000;

/** What the server's side of missed uses of the server. */
export type MissedSide = {
  hub: PhoneHub;
  pairing: Pairing;
  /** Every connection, as the server has them now. */
  conns: ReadonlySet<Conn>;
  send(c: Conn, message: Record<string, unknown>): void;
  /** Whether you're at the Mac, for what goes to an away phone; null when it can't be told. */
  macPresence: MacPresence | null;
  /** Whether the Mac says what's said out loud now (PhoneServerOptions.macHears). */
  macHears?: () => boolean;
  /** Where it's kept (missed.json); in memory when null. */
  file: string | null;
};

/**
 * What the phones missed, and what of it was settled, as the server keeps it and tells them: each
 * spoken line kept for the phones not there (record), sent as one comes back (sendMissed), read aloud
 * (catchUp), settled as the app says (promptSettled, sessionReplied) or as it sees for itself
 * (watchSettled, and checkSettled before a phone hears what it missed).
 */
export class PhonesMissed {
  /** What each paired phone missed while it wasn't there. */
  readonly missed: MissedLog;
  private s: MissedSide;
  /** Which kept lines you took in at the Mac (seen-on-mac.ts). */
  private seenOnMac: SeenOnMac;
  // The permission prompt shown last (its id), when each one stopped being asked (let go of,
  // answered), and the sessions listed as blocked (a prompt waiting in their terminal): for when a
  // question the phone missed was dealt with at the Mac.
  private promptShown: string | null = null;
  private letGo = new Map<string, number>();
  private blocked = new Set<string>();
  // The sessions listed blocked, or with questions a phone missed, that have left the list since.
  private leftList = new LeftTheList();

  constructor(side: MissedSide) {
    this.s = side;
    this.missed = new MissedLog(side.file);
    this.missed.keep(side.pairing.list().map((p) => p.id));
    this.missed.onSettled = (phoneId, items) => this.settled(phoneId, items);
    this.seenOnMac = new SeenOnMac({
      seen: (ids, why) => {
        const items = this.missed.settle((x) => ids.includes(x.id), "seen_on_mac");
        if (items.length) log("phone_seen_on_mac", { ids, why });
      },
    });
  }

  // ── What the phone missed ───────────────────────────────────────────────

  /**
   * A phone is here when one of its connections is in front (signed in and not away). One that
   * hasn't said yet counts: for that moment the Mac plays what's said (listeners), so it isn't missed.
   */
  private present(phoneId: string) {
    return [...this.s.conns].some((c) => c.phone?.id === phoneId && c.presence !== "away");
  }

  /**
   * A line Kiko said (spoken about a session, or its own): kept for every paired phone that isn't
   * here to hear it. Only spoken lines count; what a session said raw isn't Kiko speaking.
   */
  record(line: Line) {
    let kind: MissedKind;
    if (line.kind === "voice") kind = "answer";
    else if (line.kind === "spoken" && line.sessionId) kind = this.asking(line) ? "permission" : "announcement";
    else return;
    const absent = this.s.pairing
      .list()
      .map((p) => p.id)
      .filter((id) => !this.present(id));
    if (!absent.length) return;
    // The session as the phone lists it (a background process's turns come under the session it took over).
    const session = line.sessionId ? findSession(ui.state.sessions, line.sessionId) : undefined;
    const sessionId = line.sessionId ? (session?.sessionId ?? line.sessionId) : null;
    // A question: the prompt it's about. An update: what the session was last asked, to tell
    // later whether it's been given words since (typed in by hand, say).
    const promptId = kind === "permission" ? ui.state.permission?.id : undefined;
    const asked = kind === "announcement" && session ? agent.lastAsked(session) || undefined : undefined;
    const checked = kind === "answer" && line.checked ? { checked: line.checked.slice(0, 200) } : {};
    // Kiko's own words in the phone's, where the Mac's name its keys (Line.phone), as the announcement has them.
    const item = this.missed.add({ sessionId, name: line.name ?? null, kind, text: line.phone ?? line.text, ...checked, ...(promptId ? { promptId } : {}), ...(asked ? { asked } : {}) }, absent);
    if (!item) return;
    // First, so a line seen at the Mac goes to an away phone already settled (quiet, no notification).
    this.checkSeen(item);
    this.tellAway(item);
  }

  /**
   * A line just kept: seen on the Mac if it said it out loud while you were there; shown there with
   * the screen unlocked and awake, seen once you use Kiko on the Mac soon after (seen-on-mac.ts).
   * Read with the same reading tellAway uses. Not when the Mac can't tell.
   */
  private checkSeen(item: Missed) {
    const macPresence = this.s.macPresence;
    if (!macPresence) return;
    const aloud = this.s.macHears ? this.s.macHears() : ui.state.macPlays && !ui.state.muted;
    void macPresence.check().then((at) => this.seenOnMac.said(item.id, item.at, aloud, at.reading));
  }

  /**
   * You used Kiko on the Mac (`by`, seen-on-mac.ts MacUse): what it showed in the last 2 minutes
   * was seen there. A use that might have come from elsewhere counts only with input at the Mac
   * just then.
   */
  macUsed(by: MacUse) {
    const macPresence = this.s.macPresence;
    if (!macPresence) return;
    if (!NEEDS_INPUT.includes(by)) return this.seenOnMac.used(by);
    void macPresence.check().then((at) => usedAtMac(at.reading) && this.seenOnMac.used(by));
  }

  /**
   * A line just kept as missed, to the connections still open but away (the app in the background
   * or the phone locked, still running there for a while): `missed_line`, so it can post a
   * notification. Only to a phone that kept it (not a repeat it already has); it still comes in
   * `missed` as the phone comes back.
   */
  private tellAway(item: Missed) {
    const conns = this.s.conns;
    const away = [...conns].filter((c) => c.phone && c.presence === "away" && this.missed.unread(c.phone.id).at(-1)?.id === item.id);
    if (!away.length) return;
    const told = (at: AtMac | null) => {
      for (const c of away) {
        if (!conns.has(c)) continue;
        const kept = this.missed.find(c.phone!.id, [item.id])[0];
        if (!kept) continue;
        // At the Mac: in its list and its badge, no notification. Settled meanwhile: no news either.
        const quiet = Boolean(at?.atMac || kept.settled);
        log("phone_missed_line", { phoneId: c.phone!.id, id: item.id, kind: item.kind, ...(quiet ? { quiet: true } : {}), ...atMacLog(at) });
        this.s.send(c, { type: "missed_line", item: wire(kept), ...(quiet ? { quiet: true } : {}) });
      }
    };
    if (!this.s.macPresence) return told(null);
    void this.s.macPresence.check().then(told);
  }

  /**
   * The phone's unread lines, oldest first: right after welcome, and as it comes back to the front.
   * Then the read ones settled meanwhile, which its list still shows.
   */
  sendMissed(c: Conn, on: "welcome" | "back") {
    this.checkSettled();
    const items = this.missed.unread(c.phone!.id);
    log("phone_missed", { phoneId: c.phone!.id, count: items.length, on, settled: items.filter((x) => x.settled).length });
    this.s.send(c, { type: "missed", items: items.map(wire) });
    this.sendSettled(
      c,
      this.missed.settled(c.phone!.id).filter((x) => !items.includes(x)),
    );
  }

  /**
   * Reads the phone's missed lines aloud (the ones it names, else its unread ones), and marks them
   * read. As one summary (`summary`), or without ids, only the ones not settled: what still needs
   * you. Named one by one (a line's play button, Read all), as named.
   */
  catchUp(c: Conn, ids: number[] | null, summary: boolean) {
    const phoneId = c.phone!.id;
    this.checkSettled();
    const named = this.missed.find(phoneId, ids);
    const items = summary || !ids ? named.filter((x) => !x.settled) : named;
    log("phone_catch_up", { phoneId, count: items.length, ids: items.map((x) => x.id), summary, settled: named.length - items.length });
    if (named.length) this.missed.seen(phoneId, named.at(-1)!.id);
    if (!items.length) return;
    if (summary) this.s.hub.catchUpSummary(items, phoneId);
    else this.s.hub.catchUp(items.map(catchUpLine), phoneId);
  }

  // ── Settled: what no longer needs the phone ─────────────────────────────

  /**
   * A permission question was answered (on the Mac: its keys or by voice; or on the phone): what a
   * phone missed of it no longer needs it.
   */
  promptSettled(promptId: string, sessionId: string, how: SettledHow) {
    this.lettingGo(promptId);
    this.missed.settlePrompt(promptId, this.idsOf(sessionId), how);
  }

  /**
   * A prompt that stood after its window (app/standing.ts) was let go unanswered, and waits in its
   * terminal now. Not gone silently from a phone that wasn't there: its question, if one kept it, is
   * superseded by `note` ("Lacy asked to run: npm test — waiting in its terminal"), kept like any
   * line for each paired phone not here (no prompt of its own, so nothing to press on it), and told
   * at once to an away one. It settles as a question let go of does once the session moves on: no
   * longer blocked (watchSettled), a newer update from it (MissedLog.add), or gone (checkSettled).
   */
  promptLetGo(promptId: string, sessionId: string, name: string, note: string) {
    this.lettingGo(promptId);
    this.missed.settle((x) => x.kind === "permission" && x.promptId === promptId, "superseded");
    const absent = this.s.pairing
      .list()
      .map((p) => p.id)
      .filter((id) => !this.present(id));
    const listed = findSession(ui.state.sessions, sessionId)?.sessionId ?? sessionId;
    const item = this.missed.add({ sessionId: listed, name, kind: "permission", text: note }, absent);
    if (item) this.tellAway(item);
  }

  /** A prompt stopped being asked now; only the latest few hundred are remembered. */
  private lettingGo(promptId: string) {
    if (this.letGo.has(promptId)) return;
    this.letGo.set(promptId, Date.now());
    if (this.letGo.size > 500) this.letGo.delete(this.letGo.keys().next().value!);
  }

  /** Words went to a session (said, typed, through its window or typed into it, from anywhere): its updates are replied to. */
  sessionReplied(sessionId: string) {
    this.missed.settleSession(this.idsOf(sessionId), ["announcement"], "replied");
  }

  /** The ids a session goes by: as given, and as the phone lists it. */
  private idsOf(sessionId: string) {
    const listed = findSession(ui.state.sessions, sessionId)?.sessionId;
    return listed && listed !== sessionId ? [sessionId, listed] : [sessionId];
  }

  /** Items just settled: the phone's connections hear of it. */
  private settled(phoneId: string, items: Missed[]) {
    log("phone_missed_settled", { phoneId, ids: items.map((x) => x.id), how: items[0].settled!.how });
    for (const c of this.s.conns) if (c.phone?.id === phoneId) this.sendSettled(c, items);
  }

  private sendSettled(c: Conn, items: Missed[]) {
    if (!items.length) return;
    this.s.send(c, { type: "missed_settled", items: items.slice(-50).map((x) => ({ id: x.id, settled: x.settled })) });
  }

  /**
   * As the store changes: the prompt being asked (one that stops being asked is let go of, or
   * answered), and sessions blocked on a prompt in their terminal. One that was, and isn't any
   * more, had its question answered there: at the Mac. One that ended instead (gone from the list:
   * core/sessions.ts LeftTheList), as any session a phone missed a question from that has: nothing
   * can answer it there any more, so its questions are closed (not one still up here).
   */
  watchSettled(s: UiState) {
    const shown = s.permission?.id ?? null;
    if (this.promptShown && this.promptShown !== shown) this.lettingGo(this.promptShown);
    this.promptShown = shown;
    for (const session of s.sessions) {
      if (session.status === "blocked") this.blocked.add(session.sessionId);
      else if (this.blocked.delete(session.sessionId) && s.permission?.sessionId !== session.sessionId) {
        this.missed.settle((x) => x.kind === "permission" && x.sessionId === session.sessionId && x.promptId !== shown && !this.up(x.promptId), "answered_on_mac");
        // Answered in its terminal, most likely: you're at the Mac, if it had input just then.
        this.macUsed("terminal");
      }
    }
    if (!s.sessionsLoaded) return;
    const asking = this.missed.open().flatMap((x) => (x.kind === "permission" && x.sessionId ? [x.sessionId] : []));
    for (const id of this.leftList.look(s.sessions, [...this.blocked, ...asking])) {
      this.blocked.delete(id);
      this.missed.settle((x) => x.kind === "permission" && x.sessionId === id && x.promptId !== shown && !this.up(x.promptId), "closed");
    }
  }

  /**
   * Before a phone hears what it missed (back, or a catch-up): what was settled without the hub
   * hearing of it. An update whose session has been asked something since (typed in by hand) is
   * replied to; a permission question the hub let go of a while ago (or before a restart), whose
   * session isn't blocked on it (or is gone), was dealt with: closed.
   */
  private checkSettled() {
    const now = Date.now();
    const lastAsked = new Map<string, string>();
    for (const x of this.missed.open()) {
      if (!x.sessionId) continue;
      const session = findSession(ui.state.sessions, x.sessionId);
      if (x.kind === "announcement" && x.asked && session) {
        if (!lastAsked.has(session.sessionId)) lastAsked.set(session.sessionId, agent.lastAsked(session));
        const asked = lastAsked.get(session.sessionId);
        if (asked && asked !== x.asked) this.missed.settle((y) => y.id === x.id, "replied");
      } else if (x.kind === "permission" && ui.state.sessionsLoaded) {
        if (x.promptId && x.promptId === this.promptShown) continue; // still being asked
        if (this.up(x.promptId)) continue; // a card that stays up (a trust question), shown or not
        if (session?.status === "blocked") continue; // waiting in its terminal
        const since = x.promptId ? this.letGo.get(x.promptId) : undefined;
        // Let go of moments ago, or (unknown to this run) asked moments ago: the list may not show it blocked yet.
        if (now - (since ?? x.at) < LET_GO_MS) continue;
        this.missed.settle((y) => y.id === x.id, "closed");
      }
    }
  }

  /** A prompt still up though maybe not the one shown (a trust card): its missed lines aren't settled by that. */
  private up(promptId: string | undefined) {
    return Boolean(promptId && this.s.hub.promptUp?.(promptId));
  }

  /** A spoken line is a permission question while that session's prompt is the one being asked. */
  private asking(line: Line) {
    const p = ui.state.permission;
    if (!p) return false;
    if (p.sessionId === line.sessionId || p.name === line.name) return true;
    return findSession(ui.state.sessions, line.sessionId!)?.sessionId === p.sessionId;
  }
}
