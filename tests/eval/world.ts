// One routing-eval moment as decide() (src/core/decide.ts) sees it: the sessions, the recent lines,
// who waits or just spoke, the "Voice can" level and the words, built from a case (cases.ts). Shared
// by the routing eval (run.ts) and the relay eval (relay/run.ts), so both run the same engine on the
// same kind of state. Loads src/ modules: import it only after the eval has set its environment
// (KIKO_LOG_DIR, KIKO_SETTINGS…), with a dynamic import.
import { fixHeard } from "../../src/core/dictionary.ts";
import type { DecideState } from "../../src/core/decide.ts";
import { listProjects, sessionFolders } from "../../src/core/projects.ts";
import { asksYou } from "../../src/core/routing-rules.ts";
import { type Session, sessionName } from "../../src/core/sessions.ts";
import { type Entry, latestSend, sentWith } from "../../src/core/timeline.ts";
import { MINE } from "../support/dictionary.ts";
import { HOME, makeWorld } from "../support/fixtures.ts";
import type { Case } from "./cases.ts";

/**
 * The DecideState for case `c`, and the case's names by session id (two sessions in one folder
 * share a spoken name). `dictionary`: fix the words with the dictionary first, as the app does
 * (cases with `dictionary: true` always are).
 */
export function buildState(c: Case, opts: { dictionary: boolean; classifierMinConfidence: number }): { state: DecideState; nameOf: Map<string, string> } {
  const world = makeWorld(c.sessions);
  const nameOf = new Map(c.sessions.map((spec, i) => [world.sessions[i].sessionId, spec.name]));
  // By the case's name for it; in recent lines, by the name the app shows (two sessions in one
  // folder both show the folder: the one dealt with last).
  const get = (name: string): Session => {
    const s = world.byName.get(name.toLowerCase());
    if (s) return s;
    const shown = world.sessions.filter((x) => sessionName(x).toLowerCase() === name.toLowerCase());
    const last = c.last ? world.byName.get(c.last.toLowerCase()) : undefined;
    const pick = shown.find((x) => x === last) ?? shown[0];
    if (!pick) throw new Error(`${c.id}: no session "${name}"`);
    return pick;
  };
  const recent = c.recent ?? [];
  // The recent lines back as timeline entries (Timeline.lines in reverse), for the app's own rules
  // on what "that was for X" corrects.
  const entries: Entry[] = recent.map((line) => {
    const at = Date.now();
    let m = line.match(/^you → (.+?): ([\s\S]*)$/);
    if (m) return { at, who: "you", sessionId: m[1] === "app" ? null : get(m[1]).sessionId, folder: m[1] === "app" ? null : m[1], text: m[2] };
    m = line.match(/^app said \(about (.+?)\): ([\s\S]*)$/);
    if (m) return { at, who: "claude", sessionId: get(m[1]).sessionId, folder: m[1], text: m[2], spoken: m[2] };
    m = line.match(/^app repeated(?: \(about (.+?)\))?: ([\s\S]*)$/);
    if (m) return { at, who: "app", sessionId: m[1] ? get(m[1]).sessionId : null, folder: m[1] ?? null, text: m[2], repeated: true };
    m = line.match(/^app said: ([\s\S]*)$/);
    if (m) return { at, who: "app", sessionId: null, folder: null, text: m[1] };
    m = line.match(/^(.+?) said: ([\s\S]*)$/);
    if (m) return { at, who: "claude", sessionId: get(m[1]).sessionId, folder: m[1], text: m[2] };
    throw new Error(`${c.id}: can't read recent line ${JSON.stringify(line)}`);
  });
  // Your last words to a session, while that's the latest thing the app did for you: what "that was for X" corrects.
  let lastSent: DecideState["lastSent"] = null;
  if (c.lastSent !== undefined) {
    lastSent = c.lastSent && { sessionId: get(c.lastSent.session).sessionId, folder: c.lastSent.session, text: c.lastSent.text, ...(c.lastSent.undone ? { undone: true } : {}) };
  } else {
    const e = latestSend(entries, Infinity, true);
    // With the other sessions the same words went to in the same go.
    const also = e ? sentWith(entries, e).map((x) => ({ sessionId: x.sessionId!, folder: x.folder! })) : [];
    if (e?.sessionId) lastSent = { sessionId: e.sessionId, folder: e.folder!, text: e.text, ...(also.length ? { also } : {}) };
  }
  const lastRepeat = Boolean(entries.findLast((e) => e.who === "you" || e.repeated)?.repeated);
  const lastLine = recent[recent.length - 1] ?? "";
  const appAsked = c.appAsked ?? (lastLine.startsWith("app said: ") && asksYou(lastLine));
  const waitingName = c.permission?.session ?? c.waiting;
  const waiting = waitingName ? get(waitingName) : null;
  // What speech-to-text wrote, fixed by the dictionary as the app does before deciding.
  const text = c.dictionary || opts.dictionary ? fixHeard(c.say, MINE).text : c.say;
  const state: DecideState = {
    text,
    sessions: world.sessions,
    notes: world.notes,
    recent,
    waiting: waiting && { sessionId: waiting.sessionId, cwd: waiting.cwd, ...(c.permission ? { permission: c.permission.request } : {}) },
    justSpoke: c.justSpoke ? { id: get(c.justSpoke.session).sessionId, secondsAgo: c.justSpoke.secondsAgo } : null,
    lastId: c.last ? get(c.last).sessionId : (lastSent?.sessionId ?? null),
    appAsked,
    lastSent,
    lastRepeat,
    voiceCan: c.voiceCan ?? "messages",
    classifierMinConfidence: opts.classifierMinConfidence,
    proOnSale: c.proOnSale ?? true,
    // The running sessions' folders, and the case's other projects in ~/git (the fixtures' home), where new ones go too.
    projects: () => listProjects([...sessionFolders(world.sessions), ...(c.projects ?? []).map((name) => ({ cwd: `${HOME}/git/${name}`, names: [], lastUsed: 0 }))]),
    newProjectRoot: `${HOME}/git`,
    dictionary: MINE,
    question: c.question
      ? { text: c.question.text, offered: c.question.offered.map((name) => get(name).sessionId), line: lastLine.replace(/^app said: /, ""), ...(c.question.offer ? { offer: true } : {}) }
      : null,
  };
  return { state, nameOf };
}
