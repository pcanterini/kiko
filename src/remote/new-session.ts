// A new session from the phone's New session sheet, as the Mac window's picker starts one (c,
// "+ new session"): where (a project, a new project by name, a scratch folder: ui-store.ts StartPick),
// in which agent (core/agent-pick.ts), with what first message, typed or said, and what to call it
// (where its agent can be named as it starts: core/can.ts namedAtStart). The server
// translates the messages (get_new_session_options, new_session, new_session_status); app.ts lists
// the projects and agents and starts the session with the window's own code. What's here is the
// part neither needs to know: what the phone may ask, and the words of a press said for a first
// message (talk_start `dictate`), kept until new_session asks for them. The protocol calls an agent
// a "harness" (`harnesses`, `harness`): the wire keeps that word, the phone reads it.
//
// A dictated press holds the floor like any other and goes through the same speech-to-text, but its
// words are only written down: they never go through act() or the router, so "start a session" said
// as a first message is a first message, not a command.
import type { StartPick } from "../core/ui-store.ts";

/** What the sheet offers, as new_session_options carries it. */
export type NewSessionOptions = {
  /** The picker's projects, newest first: `detail` is the folder each is in, ~ for home. */
  projects: Array<{ folder: string; name: string; detail: string }>;
  /** Where a new project is made, ~ for home; null when there's nowhere set. */
  root: string | null;
  /**
   * The agents a session can start in now, the main one first; `folders`: only in these (T3 Code's
   * projects); `canName`: one started in it can be named as it starts (the sheet's name field).
   */
  harnesses: Array<{ id: string; name: string; folders?: string[]; canName: boolean }>;
  /** The one preselected, and a few words on why ("last used"; "" for none). */
  selected: string | null;
  why: string;
};

/**
 * A new session the phone asked for: where, in which agent (null: the preselected one), its first
 * message typed (`text`) or said (`talkId`), or neither, and what to call it (null: nothing given).
 */
export type NewSessionAsk = { pick: StartPick; harness: string | null; text: string | null; talkId: string | null; name: string | null };

/** What became of it: opened (its ID as listed, its name, the first message that went in, the line the Mac says of it), or not, and why in the Mac's words. */
export type NewSessionOutcome = { started: true; sessionId: string; name: string; text: string; line: string } | { started: false; why: string };

/** new_session's fields (checked against the schema already) as an ask; why not, in words for the phone, when they don't make one. */
export function askOf(m: { folder?: string; newProject?: string; scratch?: boolean; harness?: string; text?: string; talkId?: string; name?: string }): NewSessionAsk | { invalid: string } {
  const places = [m.folder !== undefined, m.newProject !== undefined, m.scratch === true].filter(Boolean).length;
  if (places !== 1) return { invalid: "Pick where it starts: one project, a new project or a scratch folder." };
  if (m.text !== undefined && m.talkId !== undefined) return { invalid: "Type the first message or say it, not both." };
  const project = m.newProject?.trim();
  if (m.newProject !== undefined && !project) return { invalid: "Give the new project a name." };
  const pick: StartPick = m.folder !== undefined ? { project: m.folder } : project ? { newProject: project } : { scratch: true };
  const text = m.text?.trim() || null;
  // Its name on one line: a rename typed into its terminal would go in at a newline.
  const name = m.name?.replace(/\s+/g, " ").trim() || null;
  return { pick, harness: m.harness ?? null, text, talkId: m.talkId ?? null, name };
}

/** Where a pick starts, for the log: project, new or scratch. */
export const pickKind = (pick: StartPick) => ("project" in pick ? "project" : "newProject" in pick ? "new" : "scratch");

// A dictated press's words wait this long for new_session to ask for them; one asked for waits at
// most this long for its press to end (a press always ends: let go, cancelled, or its phone gone).
const KEPT_MS = 5 * 60_000;
const WAIT_MS = 60_000;

type Dictation = { at: number; words: Promise<string | null>; end: (words: string | null) => void };

/**
 * The presses said for a new session's first message, by phone and talkId: begun as the button
 * goes down, ended with their words as it goes up (null: cancelled, nothing heard to use), and
 * taken once by new_session, which may come before the words are ready (it's sent as the button
 * goes up, with talk_end).
 */
export class Dictations {
  private kept = new Map<string, Dictation>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A press begins: its words come with `end`. Old ones nobody asked for go. */
  begin(phoneId: string, talkId: string): { end: (words: string | null) => void } {
    const now = this.now();
    for (const [key, d] of this.kept) if (now - d.at > KEPT_MS) this.kept.delete(key);
    let end!: (words: string | null) => void;
    const words = new Promise<string | null>((resolve) => {
      let ended = false;
      end = (w) => {
        if (ended) return; // the first end counts: the words, or the cancel
        ended = true;
        resolve(w);
      };
    });
    this.kept.set(key(phoneId, talkId), { at: now, words, end });
    return { end };
  }

  /** Whether a press of the phone's with this id was begun and not taken yet. */
  has(phoneId: string, talkId: string) {
    return this.kept.has(key(phoneId, talkId));
  }

  /**
   * The press's words once it has ended (null: cancelled, or no such press), taken out. Waits
   * `waitMs` at most for it to end.
   */
  async words(phoneId: string, talkId: string, waitMs = WAIT_MS): Promise<string | null> {
    const d = this.kept.get(key(phoneId, talkId));
    if (!d) return null;
    this.kept.delete(key(phoneId, talkId));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
      timer.unref();
    });
    try {
      return await Promise.race([d.words, late]);
    } finally {
      clearTimeout(timer);
    }
  }
}

const key = (phoneId: string, talkId: string) => `${phoneId}\n${talkId}`;
