// Sessions as the app lists them, and the ones it opened that haven't started yet: listing (with
// panes running an agent found and adopted), words held until a session has started, a first turn
// that couldn't log in, Claude Code's question about trusting a folder asked as a card, and the
// scratch folder trusted once.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { config } from "../core/config.ts";
import { appNamed, findSession, folderName, idsOf, listSessions, namedLikeApp, notePane, numberSessions, sessionName, spoken, type Session } from "../core/sessions.ts";
import { within } from "../core/projects.ts";
import { didntType } from "../core/reach.ts";
import { COMMAND, spokenName } from "../core/name.ts";
import { agent, agentOf, agents, mainAgent } from "../agents/index.ts";
import type { Held } from "../agents/types.ts";
import { openers, terminalOf, terminals } from "../terminals/index.ts";
import type { Typed } from "../terminals/types.ts";
import type { Talk } from "../remote/talk-status.ts";
import { calledOf, StartingSessions, type Matched, type Starting } from "../core/starting.ts";
import { turnSoFar } from "../core/history.ts";
import { LoginWatch, type LoginTold } from "../core/login-check.ts";
import { flat } from "../core/text.ts";
import { answerTrust, readTrustPrompt, sameFolder, TrustCards, trustPollMs, TrustQuestion, type TrustScreen, type TrustSettled } from "../core/trust-prompt.ts";
import { ui } from "../core/ui-store.ts";
import { currentKey, keySpoken, menuKeyName } from "../terminals/tmux/keys.ts";
import { log } from "../core/log.ts";
import { writeState } from "./status.ts";
import { noteTyped, onRequest } from "./announce.ts";
import { firstWords } from "./deliver.ts";
import { idsFor, promptId } from "./phone.ts";
import { notReached, typeInto } from "./session-ops.ts";
import { cue, speakLine } from "./speech.ts";
import { standingCard } from "./standing.ts";
import { dictated, floor, nameOf, pendingRenames, refOf, state, talks, timeline, whatOf } from "./state.ts";

// ── Sessions and state ──────────────────────────────────────────────────────

// Listing sessions takes ~130ms; a key press starts a fresh listing so it's ready by key up.
// `maxAgeMs` 0 is always a fresh one (a session just started or ended), even in the same millisecond
// as a listing already under way, which was made before the change.
export function getSessions(maxAgeMs = 2000): Promise<Session[]> {
  if (!state.sessionsCache || maxAgeMs <= 0 || Date.now() - state.sessionsCache.at > maxAgeMs) {
    state.sessionsCache = {
      at: Date.now(),
      list: listSessions()
        .catch((err) => {
          log("error", { where: "list_sessions", message: err instanceof Error ? err.message : String(err) });
          return [] as Session[];
        })
        .then(adoptPanes)
        .then(withStarting)
        // Two in one folder: "kiko" and "kiko 2" (core/session-numbers.ts), the ones still starting included.
        .then((list) => numberSessions(list))
        .then(noteAppNamed),
    };
  }
  return state.sessionsCache.list;
}

/**
 * The first time a run lists a session that would be called the app's name, one line on why it's
 * shown as "Kiko project" (sessions.ts appNamed): "Kiko" said up front is always the app.
 */
let appNamedNoted = false;
function noteAppNamed(list: Session[]): Session[] {
  if (appNamedNoted) return list;
  const named = list.find(namedLikeApp);
  if (!named) return list;
  appNamedNoted = true;
  log("app_named_session", { sessionId: named.sessionId, shownAs: appNamed() });
  const name = spokenName();
  ui.info(`(the session called ${name} is shown as "${appNamed()}": "${name}, …" or "tell ${name} …" always means me, so say "the ${appNamed()}" for it)`);
  return list;
}

// ── Sessions still starting ─────────────────────────────────────────────────

// Sessions the app opened that Claude Code hasn't started yet (core/starting.ts), listed as
// "starting"; what you said for each meanwhile, typed in once it has started.
export const starting = new StartingSessions();
const heldForStart = new Map<string, Array<{ text: string; talks: readonly Talk[] }>>();
// After its SessionStart, a moment for Claude Code's prompt to be ready before held words go in.
const READY_AFTER_MS = 1000;

/**
 * The agent's list, with the sessions still starting: one now listed by its agent is matched (its
 * pane, else its folder), and what was held for it goes in; the others are added, as "starting".
 */
function withStarting(listed: Session[]): Session[] {
  for (const m of starting.match(listed)) void started(m);
  return [...starting.withAliases(listed), ...starting.sessions()];
}

// Panes found running an agent's TUI, one look at a time (two listings at once would each find the same pane).
let adopting: Promise<unknown> = Promise.resolve();

/**
 * Panes of Kiko's tmux running an agent's TUI (Agent.runsAs) that no listed session is in and
 * nothing the app opened is either: `kiko codex`, or one started in a shell there. Each is kept
 * as a session starting (core/starting.ts), from its pane, so it's listed, shown when picked, and
 * typed into once its window is ready, until its agent lists it (its hooks: never, if they don't
 * fire). Not one in a folder where that agent lists a session found in no pane: that may be it.
 */
function adoptPanes(listed: Session[]): Promise<Session[]> {
  const lookFor = agents.filter((a) => a.runsAs);
  if (!lookFor.length) return Promise.resolve(listed);
  const look = adopting.then(async () => {
    const of = (command: string) => lookFor.find((a) => a.runsAs!(basename(command.replace(/^-/, ""))));
    for (const terminal of terminals) {
      if (!terminal.agentPanes) continue;
      const found = await terminal.agentPanes((command) => Boolean(of(command))).catch(() => []);
      for (const p of found) {
        const its = of(p.command);
        if (!its) continue;
        if (listed.some((s) => s.place?.via === terminal.id && s.place.id === p.handle)) continue;
        if (starting.all().some((e) => e.via === terminal.id && e.handle === p.handle)) continue;
        if (listed.some((s) => agentOf(s) === its && s.cwd === p.cwd && !s.place)) continue;
        const entry = starting.add({ cwd: p.cwd, name: "", via: terminal.id, handle: p.handle, known: listed.flatMap(idsOf), adopted: true, ...(its === mainAgent ? {} : { agent: its.id }) });
        log("session_adopted", { startingId: entry.id, folder: p.cwd, via: terminal.id, pane: p.handle, agent: its.id });
        setTimeout(() => void checkStarting(), entry.waitMs + 100).unref();
      }
    }
  });
  adopting = look.catch(() => {});
  return look.then(
    () => listed,
    (err) => {
      log("error", { where: "adopt_panes", message: err instanceof Error ? err.message : String(err) });
      return listed;
    },
  );
}

/** A session the app opened has started: listed by its agent now. */
async function started({ entry, session, by }: Matched) {
  // Its pane, for an agent that doesn't know its process (core/sessions.ts notePane): it's found there.
  if (entry.handle) notePane(session.sessionId, entry.handle);
  const name = sessionName(session);
  const words = heldForStart.get(entry.id) ?? [];
  heldForStart.delete(entry.id);
  log("session_ready", { startingId: entry.id, sessionId: session.sessionId, name, by, waitedMs: Date.now() - entry.at, held: words.length, purpose: entry.purpose });
  trustDone(entry, "session_start");
  if (state.target?.sessionId === entry.id) state.target = { sessionId: session.sessionId, cwd: session.cwd };
  if (entry.purpose === "trust") return scratchTrusted(session);
  if (entry.needsYou) ui.info(`(${name} has started)`);
  // Its first message, on its command line: watched for "Not logged in" (also told by its UserPromptSubmit hook, when that's installed).
  if (entry.prompt && loginWatched(session)) {
    openedWith.set(session.sessionId, { prompt: entry.prompt, at: entry.at });
    void loginWatch.watch(session.sessionId, entry.prompt);
  }
  // Its agent couldn't name it from the start (Codex, OpenCode): renamed once listed (renameWhenIdle:
  // by its agent where it can, else typed once it's idle). The name asked for wins over a title its
  // agent made up meanwhile (OpenCode titles a session from its first message).
  if (entry.name && agentOf(session).namesLater && session.givenName !== entry.name) {
    pendingRenames.set(session.sessionId, { name: entry.name, by: entry.by ?? "voice" });
    log("rename_pending", { sessionId: session.sessionId, name: entry.name, status: session.status, at: "start" });
  }
  if (!words.length) return;
  await new Promise((r) => setTimeout(r, READY_AFTER_MS));
  for (const w of words) {
    // Held under its starting ID: not sent after all, its entry says so (Entry.notSent).
    const went = await talks.run(w.talks, () => typeInto(session, w.text, true, true));
    if (!went) timeline.markNotSent(entry.id, w.text);
  }
}

/** Words for a session still starting: held, and typed in once it has started. Said once, as it's held. */
export function holdForStart(entry: Starting, text: string) {
  const name = calledOf(entry);
  const words = heldForStart.get(entry.id) ?? [];
  words.push({ text, talks: talks.held({ sessionId: entry.id, name }, `Waiting for ${name} to start`) });
  heldForStart.set(entry.id, words);
  log("held_for_start", { startingId: entry.id, name, text, needsYou: entry.needsYou });
  // Ready for its first message (Codex, listed only from then): typed in now, its window read again first.
  if (entry.atPrompt) return void checkAtPrompt(entry);
  ui.info(`(→ ${name} once it has started)`);
  // Its trust card up: asked out loud again after this, unless the floor still has it (asking it, or in line).
  const card = trustCards.get(entry.id);
  if (card && !floor.has(card)) {
    floor.add(card); // asked once your words are dealt with: after this line
    return speakLine(`${spoken(name)} is asking whether to trust its folder. I'll pass that on once it starts.`);
  }
  if (card) return speakLine(`${spoken(name)} is waiting for your answer about trusting its folder. I'll pass that on once it starts.`);
  return speakLine(
    entry.needsYou
      ? `${spoken(name)} is waiting for you in its window, probably asking whether to trust its folder. I'll pass that on once it starts.`
      : `${spoken(name)} is still starting. I'll pass that on once it's ready.`,
  );
}

/**
 * The sessions still starting, looked at again (with every listing, and startingWaitMs() after each
 * opened): one whose pane has ended is said and dropped with what was held for it; one that has
 * waited too long needs you, said once.
 */
export async function checkStarting() {
  for (const entry of [...starting.all()]) {
    const terminal = entry.handle ? terminals.find((t) => t.id === entry.via) : undefined;
    const state = terminal?.program ? await terminal.program(entry.handle!).catch(() => null) : null;
    if (state && starting.ended(entry, state)) void neverStarted(entry, state === "gone" ? "its window closed" : `${agentOf({ sessionId: entry.id, agent: entry.agent }).name} ended`);
    else if (state === "running") await checkAtPrompt(entry);
  }
  for (const entry of starting.stale()) void neverStarted(entry, "it never started", false);
  const due = starting.due();
  for (const entry of due) {
    const name = calledOf(entry);
    log("session_needs_you", { startingId: entry.id, name, folder: entry.cwd, waitedMs: Date.now() - entry.at, purpose: entry.purpose });
    if (entry.purpose === "trust") continue;
    state.sessionsCache = null;
    // Its trust question asked already (a card): that's what it waits for, and it was said.
    if (trustCarded.has(entry.id)) continue;
    // Another agent's (Codex): asking in its window whether to trust its folder, or its hooks, most likely.
    const asking = entry.agent ? "probably asking whether to trust its folder or its hooks" : "probably asking whether to trust its folder";
    ui.info(`(${name} hasn't started: it's waiting in its window, ${asking})`);
    void speakLine(`${spoken(name)} is waiting for you in its window, ${asking}.`);
    // Its question never came up as a card: the scratch hint it was waiting for, now.
    const by = trustHint.get(entry.id);
    trustHint.delete(entry.id);
    if (by) void scratchHint(by);
  }
  // Shown as needing you now, as it's said: not at the next look at the sessions (up to 4 seconds on).
  if (due.length) void getSessions(0).then((sessions) => ui.set({ sessions }));
}

/**
 * A session still starting whose agent lists it only from its first message (Codex: Agent.
 * readyOnScreen): its window read, and once it shows it ready, the first words held for it typed in
 * (through Terminal.placeIn, checked as any typing is). The rest wait for it to be listed, as for
 * Claude Code. Nothing is typed while its window asks anything (its folder's trust, its hooks').
 */
async function checkAtPrompt(entry: Starting) {
  const its = agentOf({ sessionId: entry.id, agent: entry.agent });
  const terminal = entry.handle ? terminals.find((t) => t.id === entry.via) : undefined;
  if (!its.readyOnScreen || !terminal?.screen || !terminal.placeIn || entry.purpose !== "work") return;
  const screen = await terminal.screen(entry.handle!).catch(() => null);
  const ready = screen !== null && its.readyOnScreen(screen);
  if (ready && !entry.atPrompt) {
    entry.atPrompt = true;
    entry.needsYou = false;
    state.sessionsCache = null;
    log("session_at_prompt", { startingId: entry.id, name: calledOf(entry), agent: its.id });
  }
  if (!ready || atPromptTyping.has(entry.id)) return;
  const words = heldForStart.get(entry.id) ?? [];
  const first = words.shift();
  if (!first) return;
  atPromptTyping.add(entry.id);
  // Said, not typed on a phone's keyboard: noted under its starting ID, which its first prompt is
  // asked under before it's listed (agentDictated), as typeInto notes words for a listed one.
  const said = !first.talks.some((t) => t.typed);
  if (said) dictated.note(entry.id, first.text);
  try {
    const place = await terminal.placeIn(entry.handle!);
    const typed: Typed = place ? await terminal.type({ ...place, bracketed: true }, first.text) : { sent: false, why: "nothing is in front in its window" };
    if (said && !typed.sent) dictated.drop(entry.id, first.text);
    log("held_typed", { startingId: entry.id, sent: typed.sent, ...(typed.sent ? {} : { why: typed.why }) });
    if (typed.sent) {
      noteTyped(entry.id, first.text);
      talks.run(first.talks, () => talks.delivered({ sessionId: entry.id, name: calledOf(entry) }, first.text));
      ui.info(`→ typed into ${calledOf(entry)}`);
    } else words.unshift(first);
  } finally {
    atPromptTyping.delete(entry.id);
  }
}

/** Starting sessions whose first held words are going in now (checkAtPrompt): one at a time each. */
const atPromptTyping = new Set<string>();

/**
 * Whether a prompt a session just took in is your dictated words the app typed in or gave it
 * (Agent.dictated; core/dictated.ts): looked for under every ID it goes by, and the ID it had while
 * it started, where its first message was noted as it opened (startSession) or as it was typed in
 * at its prompt (checkAtPrompt). Its first prompt can come before the listing that tells the app
 * which one it was (StartingSessions.startedAs): then under those of every one still starting.
 */
export function agentDictated(sessionId: string, prompt: string) {
  const listed = Boolean(findSession(ui.state.sessions, sessionId));
  return dictated.take([...idsFor(sessionId), ...starting.startedAs(sessionId, listed)], prompt);
}

/** One the app opened ended before it started (`why`): said, with what becomes of the words held for it. */
function neverStarted(entry: Starting, why: string, remove = true) {
  if (remove) starting.remove(entry.id);
  state.sessionsCache = null;
  const name = calledOf(entry);
  const words = heldForStart.get(entry.id) ?? [];
  heldForStart.delete(entry.id);
  const denied = trustDenied.has(entry.id);
  trustDone(entry, "ended");
  log("session_never_started", {
    startingId: entry.id,
    name,
    folder: entry.cwd,
    why: denied ? "you didn't trust its folder" : why,
    held: words.map((w) => w.text),
    purpose: entry.purpose,
    ...(entry.adopted ? { adopted: true } : {}),
  });
  for (const w of words) for (const t of w.talks) t.failed(`${name} closed before it started: not sent`);
  if (entry.purpose === "trust") return scratchTrustEnded(why);
  // Found in its pane, not opened by the app: closed with nothing said for it, it just leaves the list.
  if (entry.adopted && !words.length) return;
  const held = !words.length ? "" : words.length === 1 ? ` I didn't send what you said for it: "${firstWords(words[0].text)}".` : ` I didn't send the ${words.length} things you said for it.`;
  ui.info(`(${name} ended before it started: ${why}${words.length ? `; not sent: ${words.map((w) => `"${flat(w.text, 60)}"`).join(", ")}` : ""})`);
  void speakLine(denied ? `${spoken(name)} closed without trusting its folder.${held}` : `${spoken(name)} closed before it started.${held}`);
}

// ── A turn that couldn't log in ─────────────────────────────────────────────

// "Not logged in · Please run /login" written in place of a reply (core/login-check.ts: Claude Code
// keeps a failed Keychain read at its start for 30 seconds). No Stop hook comes for it, so it's
// read from the transcript after each prompt; said, and a session's first message sent again once.
// Only Claude Code's sessions: another agent's (a T3 thread) has no Claude transcript to read.
const openedWith = new Map<string, { prompt: string; at: number }>();
export const loginWatched = (session: { sessionId: string; agent?: string }) => agentOf(session) === mainAgent;
export const loginWatch = new LoginWatch({
  read: async (id) => {
    const session = findSession(await getSessions(2000), id);
    return session && loginWatched(session) ? turnSoFar(agent.historyFile(session)) : { kind: "none" };
  },
  opened: (id) => openedWith.get(id) ?? null,
  typeAgain: (id, prompt) => typeAgain(id, prompt),
  tell: (id, what) => loginTold(id, what),
});

/** Said about a session that couldn't log in: its first message going in again, or what you can do (and "try again" kept for its words). */
async function loginTold(sessionId: string, what: LoginTold) {
  const session = findSession(await getSessions(1000), sessionId);
  if (!session) return;
  // Named by its folder (a new scratch one, not titled yet): without the date, as while it started.
  const name = spoken(sessionName(session) === folderName(session.cwd) ? calledOf({ name: "", cwd: session.cwd }) : sessionName(session));
  if (what.kind === "retrying") {
    const when = what.inMs >= 1000 ? `in ${Math.ceil(what.inMs / 1000)} seconds` : "now";
    const line = `${name} couldn't log in to Claude, so it hasn't started on that. I'll send it again ${when}.`;
    ui.info(`(${line})`);
    return speakLine(line);
  }
  const line = `${name} ${what.again ? "still couldn't" : "couldn't"} log in to Claude, so your words didn't go through. Run /login in its window, then say try again.`;
  ui.info(`(${line})`);
  talks.failed(`${sessionName(session)} couldn't log in to Claude`);
  return notReached(session, what.prompt, line, true);
}

/**
 * A session's first message typed in again, after it couldn't log in (LoginWatch): its terminal's
 * own checked path, as typeInto, but without Voice can (you asked for it as it opened). Whether it went in.
 */
async function typeAgain(sessionId: string, prompt: string): Promise<boolean> {
  const session = findSession(await getSessions(0), sessionId);
  const place = session?.place;
  const terminal = place && terminalOf(place);
  if (!session || !place || !terminal) {
    log("send_failed", { sessionId, text: prompt, why: session ? "nothing can type into it now" : "session closed" });
    if (session)
      await notReached(
        session,
        prompt,
        `${spoken(sessionName(session))} couldn't log in to Claude, and I can't type into it now to send it again. Run /login in its window, then say try again.`,
        true,
      );
    return false;
  }
  noteTyped(session.sessionId, prompt);
  const typed = await terminal.type(place, prompt);
  if (typed.sent) {
    ui.info(`→ ${sessionName(session)}: its first message, sent again`);
    return true;
  }
  const line = didntType(session, null, typed.why);
  log("send_failed", { sessionId, name: sessionName(session), text: prompt, via: place.via, why: typed.why, said: line });
  await notReached(session, prompt, line, false);
  return false;
}

// ── An agent's trust question, as a card ────────────────────────────────────

// A session the app opened in tmux, still starting, has its pane read (core/trust-prompt.ts): once
// its agent's "trust this folder?" (Claude Code's, Codex's) or Codex's "Hooks need review" is on
// it, it's held like a permission prompt (TrustQuestion)
// and asked as one: the card, by voice, the phone. Its card stays up until it's settled (TrustCards):
// answered here, answered in its window, or the session ended; then it goes from the Mac and every
// phone at once (trustSettled). The floor asks it out loud for its permission window like any
// prompt; once that runs out (or something else comes first) the card stays, and words held for the
// session ask it again. The ones seen but not asked (another folder than its own, or Permissions by
// voice off) are logged once.
export const trustCards = new TrustCards((question, how) => trustSettled(question, how));
const trustSeen = new Set<string>();
const trustWatched = new Set<string>();
// Asked as a card at least once: the 10s "waiting in its window" line isn't said for it.
const trustCarded = new Set<string>();
// Denied here (and the keys took): it ended because of that, said so.
const trustDenied = new Set<string>();
// Its keys being pressed (your answer): its screen is changing because of that, so the look leaves it alone.
const trustAnswering = new Set<string>();
// A scratch session whose trust question will be asked: the hint to trust the scratch folder waits
// for its answer (by how it was opened), rather than coming before the question.
export const trustHint = new Map<string, "voice" | "window">();
// How long a question gone from the screen is looked for again before it counts as answered there:
// one read between two draws isn't an answer.
const TRUST_GONE_RECHECK_MS = 300;

/**
 * Reads the pane of `entry` (one the app opened, still starting) every 500ms for its first 15
 * seconds, then every 3 (every 3 while its card is up), until it starts, ends or its pane goes; asks
 * the trust question once it's there, and settles its card once the question has left the screen
 * (answered in its window). False when its terminal can't read it (Ghostty): it says it's waiting in
 * its window, as before.
 */
export function watchTrust(entry: Starting): boolean {
  const terminal = entry.handle ? terminals.find((t) => t.id === entry.via) : undefined;
  if (!terminal?.screen || !terminal.press || entry.purpose !== "work") return false;
  if (trustWatched.has(entry.id)) return true;
  trustWatched.add(entry.id);
  const read = () => terminal.screen!(entry.handle!).catch(() => null);
  const look = async () => {
    const now = starting.get(entry.id);
    const screen = now ? await read() : null;
    // Its card up and its pane unreadable: gone (checkStarting says it ended, and settles it), or
    // tmux didn't answer this once; looked at again while the card is up, until it's settled.
    if (now && screen === null && trustCards.get(entry.id)) void checkStarting();
    else if (!now || screen === null) return void trustWatched.delete(entry.id);
    if (screen !== null && !trustAnswering.has(entry.id)) {
      const seen = readTrustPrompt(screen, entry.agent);
      // Its agent drew it: its program ran, so the shell in front again means it ended (starting.ts ended).
      if (seen) now.seenRunning = true;
      const card = trustCards.get(entry.id);
      // Its card's question, still on its screen (another one in its place, Codex's hooks after its folder, isn't).
      const still = (s: TrustScreen | null) => s !== null && s.kind === card?.kind;
      if (card && !still(seen)) {
        // Gone from its screen with its card up: answered in its window, once a second look agrees.
        await new Promise((r) => setTimeout(r, TRUST_GONE_RECHECK_MS));
        const again = starting.get(entry.id) && !trustAnswering.has(entry.id) ? await read() : null;
        if (again !== null && !still(readTrustPrompt(again, entry.agent))) trustCards.settle(entry.id, "terminal");
      } else if (seen && !card && !trustSeen.has(`${entry.id} ${seen.kind}`) && starting.get(entry.id)) {
        // Another folder than the one it opened in may be another question: left in its window, as before.
        const why = seen.kind === "folder" && !sameFolder(seen.cwd ?? seen.folder, entry.cwd, homedir()) ? "not its folder" : !config.voicePermissions ? "permissions by voice off" : null;
        if (why) {
          trustSeen.add(`${entry.id} ${seen.kind}`);
          log("trust_prompt", { startingId: entry.id, kind: seen.kind, folder: seen.folder, shown: false, why, ...(entry.agent ? { agent: entry.agent } : {}) });
        } else askTrustOf(entry, seen);
      }
    }
    setTimeout(() => void look(), trustPollMs(Date.now() - entry.at, Boolean(trustCards.get(entry.id)))).unref();
  };
  setTimeout(() => void look(), trustPollMs(0)).unref();
  return true;
}

/** Its trust question is on its screen: held and asked as a permission prompt; its card up until it's settled. */
function askTrustOf(entry: Starting, seen: TrustScreen) {
  const folder = seen.kind === "hooks" ? entry.cwd : seen.folder;
  const about = { kind: seen.kind, ...(seen.hooks !== undefined ? { hooks: seen.hooks } : {}), ...(entry.agent ? { agent: entry.agent } : {}) };
  const question = new TrustQuestion(entry.id, entry.cwd, folder, (allow) => void answerTrustOf(entry, question, allow), about);
  if (!trustCards.add(question)) return;
  const again = trustCarded.has(entry.id);
  trustCarded.add(entry.id);
  log("trust_prompt", {
    startingId: entry.id,
    kind: seen.kind,
    folder,
    shown: true,
    ...(seen.hooks !== undefined ? { hooks: seen.hooks } : {}),
    ...(entry.agent ? { agent: entry.agent } : {}),
    ...(again ? { again } : {}),
  });
  onRequest(question);
}

/**
 * Your answer to its trust card, on the Mac's card, by voice or on a phone: the card settled (gone
 * from everywhere), and its keys pressed (answerTrustOf). False when it was settled already.
 */
export function answerTrustCard(question: TrustQuestion, allow: boolean, how: "card" | "voice" | "phone", text: string) {
  const name = nameOf(refOf(question));
  const what = whatOf(question);
  if (!trustCards.settle(question.sessionId, how, allow)) return false;
  timeline.add({ who: "you", sessionId: question.sessionId, folder: name, text: allow ? `yes to ${what}` : `no to ${what}: ${text}`, permission: true });
  const it = question.kind === "hooks" ? "its hooks" : "its folder";
  ui.info(allow ? `→ trusting ${it}` : `→ not trusting ${it}`);
  cue("sent", state.pressAt);
  return true;
}

/**
 * Its card settled (TrustCards): off the floor, and gone from the Mac and every phone (the store's
 * card goes; a phone's notification of it with it: promptSettled). Logged with how.
 */
function trustSettled(question: TrustQuestion, how: TrustSettled) {
  log("trust_settled", { startingId: question.sessionId, how, ...(question.answered !== null ? { allow: question.answered } : {}) });
  if (floor.unqueue(question)) floor.dropped(question, `trust_${how}`);
  floor.drop(question);
  state.phone?.promptSettled(promptId(question), question.sessionId, how === "phone" ? "answered_on_phone" : how === "ended" ? "closed" : "answered_on_mac");
  writeState();
  floor.drain();
}

/**
 * Your answer to its trust question (the card, voice, the phone): its keys pressed in its pane
 * (core/trust-prompt.ts answerTrust: Enter only once the option wanted is seen picked). Allowed,
 * it starts, and what was held for it goes in then (started); a folder denied, it ends (neverStarted
 * says so); Codex's hooks denied, it starts without them, unheard (said). Not done: said, and the
 * question, still on its screen, is asked again at the next look.
 */
async function answerTrustOf(entry: Starting, question: TrustQuestion, allow: boolean) {
  const terminal = entry.handle ? terminals.find((t) => t.id === entry.via) : undefined;
  const name = calledOf(entry);
  const handle = entry.handle!;
  trustAnswering.add(entry.id);
  let r: { ok: boolean; how: string; why?: string };
  try {
    r =
      terminal?.screen && terminal.press
        ? await answerTrust(
            {
              screen: () => terminal.screen!(handle).catch(() => null),
              running: () =>
                terminal.program
                  ? terminal.program(handle).then(
                      (state) => state === "running",
                      () => true,
                    )
                  : Promise.resolve(true),
              press: (key) => terminal.press!(handle, key),
              wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            },
            allow,
            { kind: question.kind, ...(entry.agent ? { agent: entry.agent } : {}) },
          )
        : { ok: false, how: "none", why: "I can't reach its window" };
  } finally {
    trustAnswering.delete(entry.id);
  }
  log("trust_answer", { startingId: entry.id, kind: question.kind, allow, how: r.how, ok: r.ok, ...(r.why ? { why: r.why } : {}), ...(entry.agent ? { agent: entry.agent } : {}) });
  const it = question.kind === "hooks" ? "its hooks" : "its folder";
  if (!r.ok) {
    const line = `I couldn't answer ${spoken(name)}'s question about trusting ${it}: ${r.why}. It's still asking in its window.`;
    ui.info(`(${line})`);
    return void speakLine(line);
  }
  // Its hooks not trusted: it starts without them, so nothing of it reaches Kiko. Said, once.
  if (!allow && question.kind === "hooks") {
    const line = `${spoken(name)} starts without its hooks, so I won't hear from it. Trust them in its window with /hooks.`;
    ui.info(`(${line})`);
    return void speakLine(line);
  }
  // Denied, it exited: said now, rather than at the next look.
  if (!allow) {
    trustDenied.add(entry.id);
    return void checkStarting();
  }
  // The scratch folder hint is Claude Code's (its trust can be given the scratch folder once).
  if (!entry.agent && within(entry.cwd, config.scratchFolder)) {
    const by = trustHint.get(entry.id);
    trustHint.delete(entry.id);
    if (by) await scratchHint(by);
  }
}

/** It started (SessionStart, listed) or ended: its card, if still up, settled by that; the rest forgotten. */
function trustDone(entry: Starting, how: "session_start" | "ended") {
  trustCards.settle(entry.id, how);
  trustSeen.delete(`${entry.id} folder`);
  trustSeen.delete(`${entry.id} hooks`);
  trustHint.delete(entry.id);
  trustCarded.delete(entry.id);
  trustDenied.delete(entry.id);
}

/** The trust card the Mac shows when the floor isn't asking anything: the oldest one up that it isn't holding. */
export function standingTrust(): TrustQuestion | null {
  return trustCards.up().find((q) => q.open && !floor.has(q)) ?? null;
}

/**
 * The permission card on the Mac (and the phones) now: the one the floor is asking, else one that
 * stays up: a trust card, or the oldest prompt standing after its window (app/standing.ts).
 */
export function cardShown(): Held | null {
  const current = floor.current;
  return current?.open && current.isPermission ? current : standingCard();
}

// ── Trusting the scratch folder ─────────────────────────────────────────────

// Claude Code asks "trust this folder?" in every new scratch folder unless the scratch folder itself
// is trusted (a trusted parent covers its subfolders). Kiko never writes Claude Code's config: it
// says so once, and offers to open Claude Code in the scratch folder, where you answer once.
let scratchHinted = false;
// Scratch sessions asked for while Claude Code is open there for its trust prompt: opened after.
export const afterTrust: Array<() => Promise<void>> = [];

/** Claude Code is open in the scratch folder for its trust prompt, and hasn't started yet. */
export const trustingScratch = () => starting.all().some((e) => e.purpose === "trust");

/** Once a run, when a scratch session opens and the scratch folder isn't trusted: said (or shown, from the window) how to trust it once. */
export async function scratchHint(by: "voice" | "window") {
  if (scratchHinted || agent.folderTrusted?.(config.scratchFolder) !== false) return;
  scratchHinted = true;
  log("scratch_untrusted", { folder: config.scratchFolder });
  const key = state.windowGlue ? `press ${menuKeyName()} then t` : `run ${COMMAND} trust-scratch`;
  const line = `New scratch sessions will each ask Claude Code to trust their folder. To trust ${spokenName()}'s scratch area once, say "trust the scratch folder" or ${key}.`;
  ui.info(`(${line})`);
  state.windowGlue?.note(line);
  if (by === "voice") await speakLine(line.replace(menuKeyName(), keySpoken(currentKey())));
}

/**
 * "Trust the scratch folder" (by voice, the window's t, or the phone's words): Claude Code opened in
 * the scratch folder itself, shown in the window, so you answer its trust prompt there once. Once it
 * starts there (it's trusted then), Kiko types /exit into it, and opens what was asked for meanwhile.
 */
export async function trustScratch(by: "voice" | "window" = "voice") {
  const tell = (line: string) => (by === "voice" ? speakLine(line) : (ui.info(`(${line})`), state.windowGlue?.note(line)));
  const root = config.scratchFolder;
  if (agent.folderTrusted?.(root) === true) return tell(`${spokenName()}'s scratch folder is trusted already: new scratch sessions won't ask.`);
  if (trustingScratch()) return tell(`Claude Code is open in the scratch folder already: pick "Yes, I trust this folder" there.`);
  const all = openers();
  if (!all.length) return tell("I can't open a new terminal on this computer.");
  mkdirSync(root, { recursive: true });
  const known = (await getSessions()).flatMap(idsOf);
  let note: string | void = undefined;
  let via = "";
  let handle: string | null = null;
  for (const terminal of all) {
    try {
      note = await terminal.open(root, agent.startCommand({ prompt: "", name: "" }), (h) => (handle = h));
      via = terminal.id;
      break;
    } catch (err) {
      log("scratch_trust_failed", { via: terminal.id, error: err instanceof Error ? err.message : String(err) });
      if (terminal === all.at(-1)) return tell("I couldn't open Claude Code in the scratch folder.");
    }
  }
  const entry = starting.add({ cwd: root, name: "", via, handle, known, purpose: "trust" });
  log("scratch_trust_open", { folder: root, via, startingId: entry.id, ...(handle ? { pane: handle } : {}), by });
  const line = `Opening Claude Code in ${spokenName()}'s scratch folder. Pick "Yes, I trust this folder" there; the first option is "No, exit". It's a one-time step, and I'll close it once it starts.`;
  await tell(note ? `${line} ${note}.` : line);
}

/** Claude Code started in the scratch folder: it's trusted now. /exit typed into it, and what waited for it opened. */
async function scratchTrusted(session: Session) {
  const trusted = agent.folderTrusted?.(config.scratchFolder) ?? null;
  await new Promise((r) => setTimeout(r, READY_AFTER_MS));
  const place = session.place;
  const terminal = place && terminalOf(place);
  let closed = false;
  if (place && terminal) {
    noteTyped(session.sessionId, "/exit");
    const typed = await terminal.type(place, "/exit");
    closed = typed.sent;
    if (!typed.sent) log("scratch_trust_exit_failed", { sessionId: session.sessionId, why: typed.why });
  }
  log("scratch_trusted", { sessionId: session.sessionId, trusted, closed });
  const line =
    trusted === false
      ? `Claude Code started in the scratch folder, but it doesn't say it trusts it yet.${closed ? "" : " You can close that session with /exit."}`
      : `${spokenName()}'s scratch folder is trusted now: new scratch sessions won't ask.${closed ? "" : " You can close that session with /exit."}`;
  ui.info(`(${line})`);
  state.windowGlue?.note(line);
  await speakLine(line);
  await openAfterTrust();
}

/** Claude Code in the scratch folder ended before it started (`why`): not trusted. What waited for it opens anyway. */
async function scratchTrustEnded(why: string) {
  log("scratch_trust_ended", { why });
  const line = `Claude Code in the scratch folder closed before it started, so the scratch folder isn't trusted${afterTrust.length ? ". Opening what you asked for anyway: it will ask too." : "."}`;
  ui.info(`(${line})`);
  state.windowGlue?.note(line);
  await speakLine(line);
  await openAfterTrust();
}

async function openAfterTrust() {
  for (const open of afterTrust.splice(0)) await open().catch((err) => log("error", { where: "open after trust", message: err instanceof Error ? err.message : String(err) }));
}
