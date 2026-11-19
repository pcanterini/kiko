// New sessions: which agent one starts in (core/agent-pick.ts), opening it (startSession), the
// Kiko window's picker, and a new session asked for on the phone.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../core/config.ts";
import { andList, shortPath } from "../core/text.ts";
import { findSession, folderName, idsOf, sessionName, spoken, type Session } from "../core/sessions.ts";
import {
  freeFolder,
  listProjects,
  newProjectRoot,
  projectAmong,
  projectFolderName,
  projectRoots,
  rootFolders,
  scratchName,
  sessionFolders,
  within,
  type Project,
  type StartPlace,
} from "../core/projects.ts";
import { namedAtStart } from "../core/can.ts";
import { loadSettings, rememberLastAgent } from "../core/settings.ts";
import { NAME } from "../core/name.ts";
import { agent, agents, elsewhere, launchersIn, mainAgent, offeredStarters, starters } from "../agents/index.ts";
import { asksWhich, chooseUnasked, namesAgent, openingLine, placeWords, preselect, sessionKind, whyWords, type HowPicked, type Preselected } from "../core/agent-pick.ts";
import type { Agent } from "../agents/types.ts";
import { openers } from "../terminals/index.ts";
import type { NewSessionAsk, NewSessionOptions, NewSessionOutcome } from "../remote/new-session.ts";
import type { By } from "../core/starting.ts";
import { ui, type StartPick, type Picker, type WindowState } from "../core/ui-store.ts";
import { markOf } from "../ui/marks.ts";
import { log } from "../core/log.ts";
import { startModeFor } from "../core/permission-mode.ts";
import { DICTATED_QUEUED_MS } from "../core/dictated.ts";
import { asksOnScreen } from "../core/trust-prompt.ts";
import { allowed } from "./session-ops.ts";
import { speakLine } from "./speech.ts";
import { afterTrust, checkStarting, getSessions, scratchHint, starting, trustHint, trustingScratch, watchTrust } from "./starting.ts";
import { dictated, dictations, state, talks, timeline } from "./state.ts";

// ── Which agent a new session starts in (core/agent-pick.ts) ─────────────

/** The agent a new session starts in, how it was picked, what was preselected, and the agents that could start sessions then. */
type AgentChoice = { its: Agent; how: HowPicked; preselected: Preselected; offered: Agent[] };

/** Who asked for a new session: by voice (said), the Kiko window's picker (shown there), or the phone's New session sheet (told to it). */
/** What became of a new session asked for: opened (its ID as listed, the line said or shown of it), or not (why, as said or shown). Null: Voice can said no. */
type Opened = { opened: string; line: string } | { notOpened: string } | null;

/** An agent that starts sessions, by its id; the main one for any other. */
const starterById = (id: string) => starters().find((a) => a.id === id) ?? mainAgent;

/** What preselects among `offered`: the run's agent (`kiko codex`: asked of the window's tmux only when there's a choice), the last used, the setting. */
async function preselecting(offered: Agent[]) {
  const ids = offered.map((a) => a.id);
  const run = asksWhich(ids) ? ((await state.windowGlue?.runAgent().catch(() => null)) ?? null) : null;
  return { offered: ids, run, lastUsed: loadSettings().lastNewSessionAgent ?? null, setting: config.newSessionAgent };
}

/** A choice logged (harness_picked): the agent, how (named, only, picker, voice, preselected), from where, and what was preselected among which. */
function pickedLog(h: AgentChoice, by: By) {
  log("harness_picked", { agent: h.its.id, how: h.how, by, preselected: h.preselected.id, why: h.preselected.why, offered: h.offered.map((a) => a.id) });
}

/** The agent of a new session nobody is asked about (voice, the phone's words; the window with one to start): named, the only one, else the preselected one. */
async function agentFor(asked: string, by: By): Promise<AgentChoice> {
  const offered = offeredStarters();
  const c = chooseUnasked({ ...(await preselecting(offered)), named: asked || null, startable: starters().map((a) => a.id), by: by === "voice" ? "voice" : "window" });
  const h: AgentChoice = { its: starterById(c.id), how: c.how, preselected: c.preselected, offered };
  pickedLog(h, by);
  return h;
}

// The window's question of which agent, asked and not answered yet: its ask, where it opens, what was preselected.
let agentAsked: { ask: string; where: StartPlace; preselected: Preselected; offered: Agent[] } | null = null;

/**
 * A new session from the window's picker (c, "+ new session", the menu's New session), once its
 * folder is picked: more than one agent able to start sessions, the window asks which (a popup:
 * ui/agent-picker.ts), the preselected one chosen; one, it starts at once. An agent whose sessions
 * start in its own app is offered too, after them, only while it's open and the folder is one of its
 * projects (T3 Code, connected, in a folder that's a T3 project: agents/index.ts launchersIn).
 */
export async function startFromWindow(where: StartPlace) {
  const offered = [...offeredStarters(), ...("cwd" in where ? launchersIn(where.cwd) : [])];
  if (!asksWhich(offered.map((a) => a.id)) || !ui.state.window) return startSession(where, "", "", "window");
  const inputs = await preselecting(offered);
  const preselected = preselect(inputs.offered, inputs);
  const ask = randomUUID().slice(0, 8);
  agentAsked = { ask, where, preselected, offered };
  const rows = offered.map((a) => {
    const note = a.id === preselected.id ? whyWords(preselected.why) : "";
    const mark = markOf(a, config.icons);
    return { id: a.id, name: a.name, mark: { glyph: mark.glyph, ...(mark.color ? { color: mark.color } : {}) }, ...(note ? { note } : {}) };
  });
  log("harness_picker", { ask, folder: "cwd" in where ? where.cwd : where.kind, offered: inputs.offered, preselected: preselected.id, why: preselected.why });
  setWindow({ agentAsk: { ask, folder: placeWords(where), rows, selected: preselected.id } });
}

/** The window's question answered (an agent's id) or let go (null): the session started in it, or not. A stale answer (another ask since) does nothing. */
export function agentAnswered(ask: string, id: string | null) {
  const asked = agentAsked;
  if (!asked || asked.ask !== ask) return;
  agentAsked = null;
  setWindow({ agentAsk: null });
  if (!id) return log("harness_picker_cancelled", { ask, preselected: asked.preselected.id });
  const its = asked.offered.find((a) => a.id === id);
  if (!its) return log("harness_picker_cancelled", { ask, agent: id, why: "not offered" });
  const h: AgentChoice = { its, how: "picker", preselected: asked.preselected, offered: asked.offered };
  pickedLog(h, "window");
  const start = its.launches ? startInApp(its, asked.where, "", "", "window") : startSession(asked.where, "", "", "window", "", h);
  void start.catch((err) => state.windowGlue?.note(`I couldn't start it: ${err instanceof Error ? err.message : String(err)}`));
}

/**
 * A new session asked of an agent whose sessions start in its own app (`app.launches`: T3 Code's
 * threads, made on its server), by voice, the phone's words or the window's picker; as any start,
 * only when "Voice can" lets voice start sessions. In the app's project that the place asked for
 * names (core/projects.ts projectAmong: by its name in T3, else by its folder), else said why not:
 * not one of its projects ("pixie isn't a project in T3 Code yet."), or none named with several
 * there (which one isn't guessed). Once started it's the session your next words go to, as a
 * session opened in a terminal is, and a line says so; failing, why is said and nothing else opens.
 *
 * The app not open (T3 Code not running): a session in a terminal in its place, in the same place,
 * in the agent your words name (`asked`: "a T3 thread on Codex") else your default (agent-pick.ts,
 * the app's own never among them), and it's said ("T3 Code isn't open, so I'm starting it in
 * Claude Code."). Logged `start_elsewhere` with the agent it fell back to.
 */
export async function startInApp(app: Agent, where: StartPlace, name: string, prompt: string, by: By, asked = ""): Promise<Opened> {
  if (by === "voice" && !(await allowed("start", { then: () => startInApp(app, where, name, prompt, by, asked) }))) return null;
  const launcher = app.launches!;
  const not = notOpened(by);
  const folder = "cwd" in where ? where.cwd : null;
  if (!launcher.ready()) {
    // The window and the phone only offer it while it's open: it closed meanwhile.
    if (by !== "voice") return not(`${app.name} isn't open, so nothing was started.`);
    const h = await agentFor(asked, "voice");
    log("start_elsewhere", { agent: app.id, ready: false, fallback: h.its.id, folder, said: "said" in where ? where.said : null });
    await speakLine(`${app.name} isn't open, so I'm starting it in ${h.its.name}.`);
    return startSession(where, name, prompt, "voice", asked, h);
  }
  const projects = launcher.projects();
  const match = projectAmong(where, projects);
  if (match === "unnamed" || "unknown" in match) {
    const names = [...projects].sort((a, b) => b.lastUsed - a.lastUsed).map((p) => spoken(p.names[0] || folderName(p.cwd)));
    const line =
      match !== "unnamed"
        ? `${spoken(match.unknown)} isn't a project in ${app.name} yet. Add it in ${app.name} first.`
        : !names.length
          ? `${app.name} has no projects yet. Add one in ${app.name} first.`
          : `Which project? ${app.name} has ${andList(names.slice(0, 5))}${names.length > 5 ? ", and more" : ""}. Ask again with one: a new ${app.name} thread in ${names[0]}.`;
    log("start_elsewhere", { agent: app.id, ready: true, folder, said: "said" in where ? where.said : null, project: null, projects: projects.length });
    return not(line);
  }
  const cwd = match.project.cwd;
  log("start_elsewhere", { agent: app.id, ready: true, folder: cwd, how: match.how, runsOn: asked || null, name: name || null, prompt: Boolean(prompt), by });
  const started = await launcher.start({ cwd, name, prompt, agent: asked });
  if (!started.started) {
    log("session_open_failed", { agent: app.id, folder: cwd, by, error: started.why });
    return not(started.why);
  }
  // The session your next words go to, as one opened in a terminal is, and named in the conversation.
  const project = spoken(match.name || folderName(cwd));
  state.target = { sessionId: started.sessionId, cwd };
  state.sessionsCache = null;
  const kind = `a ${app.name} thread`;
  timeline.add({
    who: "app",
    sessionId: started.sessionId,
    folder: name || folderName(cwd),
    text: `opened ${kind}${name ? ` named ${name}` : ""} in ${folderName(cwd)}${prompt ? `: ${prompt}` : ""}`,
  });
  log("session_open", { folder: cwd, how: match.how, name: name || null, prompt: Boolean(prompt), via: app.id, by, sessionId: started.sessionId, agent: app.id });
  ui.info(`→ new ${app.name} thread in ${shortPath(cwd)}`);
  void getSessions(0).then((sessions) => ui.set({ sessions }));
  const close = match.how === "close" && match.said ? `, the closest to ${match.said}` : "";
  const line = `Started ${kind} in ${project}${close}.`;
  await toldBy(by)(line);
  return { opened: started.sessionId, line };
}

/** How a line about a new session reaches whoever asked for it: said, shown under the window's list, or noted for the phone (its sheet shows it: new_session_status). */
const toldBy = (by: By) => (line: string) => (by === "voice" ? speakLine(line) : by === "window" ? state.windowGlue?.note(line) : ui.info(`(phone: ${line})`));

/** Why a new session didn't open, told as toldBy tells it, and returned (the phone is told it in words). */
const notOpened =
  (by: By) =>
  async (why: string): Promise<Opened> => {
    await toldBy(by)(why);
    return { notOpened: why };
  };

/** "a, b and c". */

/**
 * Opens a new session in a new terminal window: in Kiko's tmux, shown in a new Ghostty window
 * (else Ghostty's own, without tmux); in the project you named, a new one, your home folder, or a
 * fresh scratch folder (core/projects.ts), and says where. Its name and first message go on the
 * agent's command line: nothing is typed into it. One that couldn't start anything (tmux failed)
 * is tried in the next that opens windows. In the agent `asked` names ("a Codex session":
 * decide.ts namedAgent), else the only one that can start sessions, else the one preselected
 * (core/agent-pick.ts: the run's, the last used, the setting), or `chosen` (the window's picker);
 * what's said names it when more than one can start sessions. The agent is remembered as the last used.
 * `dictatedPrompt`: whether the first message is your dictated words (by voice, unless they were
 * typed on a phone's keyboard; from the phone's sheet, a dictated press's), so its agent is told so
 * as it takes them in (core/dictated.ts).
 */
export async function startSession(
  where: StartPlace,
  name: string,
  prompt: string,
  by: By = "voice",
  asked = "",
  chosen?: AgentChoice,
  dictatedPrompt = by === "voice" && !talks.current().some((t) => t.typed),
): Promise<Opened> {
  // Picked in the Kiko window or on the phone: not a voice action (Voice can doesn't apply), shown rather than said.
  if (by === "voice" && !(await allowed("start", { then: () => startSession(where, name, prompt, by, asked, chosen, dictatedPrompt) }))) return null;
  // The phone's sheet is a picker like the window's: its hints are shown, not said.
  const shown = by === "phone" ? "window" : by;
  const choice = chosen ?? (await agentFor(asked, by));
  const its = choice.its;
  const not = notOpened(by);
  const all = openers();
  if (!all.length) return not("I can't open a new terminal on this computer.");
  // Claude Code is open in the scratch folder for its trust prompt (trustScratch): this opens once
  // that's answered, so it doesn't ask too.
  if (where.kind === "scratch" && trustingScratch() && its === mainAgent) {
    afterTrust.push(() => startSession(where, name, prompt, by, asked, choice, dictatedPrompt).then(() => {}));
    log("session_open_deferred", { name: name || null, why: "trusting the scratch folder" });
    return not("I'll open it once the scratch folder is trusted: answer Claude Code's question in its window.");
  }
  const how = where.kind === "project" ? where.how : where.kind;
  const said = "said" in where ? where.said : null;
  // Its agent named in what's said when more than one can start sessions ("Starting a Codex session in pixie.").
  const kind = namesAgent(
    choice.offered.map((a) => a.id),
    its.id,
  )
    ? sessionKind(its.name)
    : null;
  let opening: { cwd: string; line: string };
  try {
    opening = folderFor(where, name, prompt, kind);
  } catch (err) {
    log("session_open_failed", { how, said, error: err instanceof Error ? err.message : String(err) });
    return not("I couldn't make a folder for it.");
  }
  const { cwd, line } = opening;
  // In the "Permission mode" setting's mode (Accept edits unless set: core/permission-mode.ts); a
  // scratch session, while that's left unset, in auto where its agent offers it (startModeFor).
  const scratch = within(cwd, config.scratchFolder);
  const { mode, autoUnavailable } = await startModeFor({
    scratch,
    setting: config.newSessionMode,
    chosen: config.newSessionModeChosen,
    offersMode: its.offersMode?.bind(its),
  });
  if (autoUnavailable) log("scratch_auto_unavailable", { agent: its.id, mode, why: `${its.name} here doesn't list auto mode, or its help couldn't be read` });
  // A fresh scratch folder Kiko just made: its agent may trust it for this launch (Codex's -c); a folder you chose, never.
  const command = its.startCommand({ prompt, name, mode, ...(where.kind === "scratch" ? { madeFolder: cwd } : {}) });
  // What's listed now: a session in its folder that's listed later is the one it starts (starting.ts).
  const known = (await getSessions()).flatMap(idsOf);
  let note: string | void = undefined;
  let via = "";
  let handle: string | null = null;
  for (const terminal of all) {
    try {
      note = await terminal.open(cwd, command, (h) => (handle = h));
      via = terminal.id;
      break;
    } catch (err) {
      log("session_open_failed", { how, said, via: terminal.id, error: err instanceof Error ? err.message : String(err) });
      if (terminal === all.at(-1)) throw err;
    }
  }
  // What "last used" preselects next time, by whatever route this one came.
  try {
    rememberLastAgent(its.id);
  } catch (err) {
    log("settings_failed", { what: "lastNewSessionAgent", error: err instanceof Error ? err.message : String(err) });
  }
  // Listed as starting until its agent lists it (Claude Code: once its folder is trusted).
  const entry = starting.add({ cwd, name, prompt, via, handle, known, by, ...(its === mainAgent ? {} : { agent: its.id }) });
  // Its first message, said: its agent takes it in once it has started (Claude Code's UserPromptSubmit
  // comes for one on the command line too, the logs of 2026-10-29 on), under an ID the app doesn't
  // know yet, so it's noted under this one (app/starting.ts agentDictated), for as long as it may
  // take to start.
  if (prompt && dictatedPrompt) dictated.note(entry.id, prompt, DICTATED_QUEUED_MS);
  state.sessionsCache = null;
  setTimeout(() => void checkStarting(), entry.waitMs + 100).unref();
  // Its pane read for its agent's trust questions (Claude Code's folder; Codex's folder and hooks),
  // asked as a card (tmux: core/trust-prompt.ts); Claude Code's scratch hint after its answer.
  const asks = asksOnScreen(entry.agent) && config.voicePermissions && watchTrust(entry);
  if (asks && scratch && its === mainAgent) trustHint.set(entry.id, shown);
  log("session_open", {
    folder: cwd,
    how,
    said,
    name: name || null,
    prompt: Boolean(prompt),
    via,
    by,
    startingId: entry.id,
    mode,
    ...(handle ? { pane: handle } : {}),
    ...(its === mainAgent ? {} : { agent: its.id }),
  });
  // Its name in the conversation, not only its folder: the router takes what it's called from here.
  const opened = its === mainAgent ? "a session" : sessionKind(its.name);
  const called = name ? `${opened} named ${name} in ${folderName(cwd)}` : `${opened} in ${folderName(cwd)}`;
  timeline.add({ who: "app", sessionId: entry.id, folder: name || folderName(cwd), text: `opened ${called}${prompt ? `: ${prompt}` : ""}` });
  ui.info(`→ new session in ${shortPath(cwd)}${via === "tmux" ? " (tmux)" : ""}`);
  void getSessions(0).then((sessions) => ui.set({ sessions }));
  if (by === "voice") await speakLine(note ? `${line} ${note}.` : line);
  else if (note) state.windowGlue?.note(`${note}.`);
  // Named by voice in an agent Kiko isn't connected to (its hooks not set up): it starts, but none of
  // its turns or prompts reach Kiko, which is said rather than left to be found out.
  const unheard = by === "voice" ? notConnected(its) : null;
  if (unheard) {
    log("session_open_not_connected", { agent: its.id, startingId: entry.id });
    await speakLine(unheard);
  }
  if (scratch && !asks && its === mainAgent) await scratchHint(shown);
  return { opened: entry.id, line: note ? `${line} ${note}.` : line };
}

/**
 * What to say of a new session in an agent that isn't connected (its hooks not set up: kiko setup
 * declined it, or it was installed since): Kiko won't hear it, and where it's connected. Null when it
 * is, or has nothing to connect.
 */
function notConnected(its: Agent): string | null {
  if (!its.setup) return null;
  try {
    const state = its.setup.status().state;
    if (state === "connected" || state === "needs repair") return null;
  } catch {
    return null;
  }
  return `${its.name} isn't connected to ${NAME} yet, so I won't hear when it finishes or asks something. In Settings, under Agents, connect it.`;
}

// ── The Kiko window's picker ─────────────────────────────────────────────

export const setWindow = (patch: Partial<WindowState>) => ui.state.window && ui.set({ window: { ...ui.state.window, ...patch } });

/** The project picker (the window's n): the projects a session could open in, newest first, and where a new one goes. */
export function openPicker() {
  setWindow({ picker: pickerChoices(), renaming: null });
  void state.windowGlue?.focusList();
}

/** What the picker offers (the window's, and the phone's New session sheet): the projects, newest first, each with the folder it's in, and where a new one goes. */
function pickerChoices(): Picker {
  const projects = knownProjects(ui.state.sessions)
    .sort((a, b) => b.lastUsed - a.lastUsed || a.names[0].localeCompare(b.names[0]))
    .map((p) => ({ cwd: p.cwd, name: p.names[0] || folderName(p.cwd), detail: shortPath(dirname(p.cwd), homedir()) }));
  return { projects, root: newProjectRoot(config.projectsRoot, homedir()) };
}

/** What the window's picker picked, as where a new session opens; null (shown why) when it can't be. */
export function pickedPlace(pick: StartPick): StartPlace | null {
  const where = placeOf(pick);
  return typeof where === "string" ? (state.windowGlue?.note(where), null) : where;
}

/** Where a pick (the window's picker, the phone's sheet) opens a new session, or why it can't. */
function placeOf(pick: StartPick): StartPlace | string {
  if ("scratch" in pick) return { kind: "scratch", said: null };
  if ("project" in pick) {
    const known = knownProjects(ui.state.sessions).find((p) => p.cwd === pick.project);
    if (!known) return "That folder isn't one of your projects any more.";
    const name = known.names[0] || folderName(known.cwd);
    return { kind: "project", cwd: known.cwd, how: "exact", name, said: name };
  }
  const root = newProjectRoot(config.projectsRoot, homedir());
  if (!root) return "There's no projects folder to make it in: set one in Settings → New sessions → Projects root.";
  return { kind: "new", cwd: join(root, projectFolderName(pick.newProject)), said: pick.newProject };
}

// ── A new session from the phone ────────────────────────────────────────────

/**
 * The phone's New session sheet (remote/new-session.ts): the window's picker's projects, and the
 * agents its question offers (each that starts sessions and is connected, the main one first; an
 * app that starts them in itself while it's open, only in its own projects: T3 Code), with the one
 * the window would preselect.
 */
export async function phoneSessionOptions(): Promise<NewSessionOptions> {
  const picker = pickerChoices();
  const offered = offeredStarters();
  const inputs = await preselecting(offered);
  const preselected = preselect(inputs.offered, inputs);
  const apps = elsewhere().filter((a) => a.launches!.ready());
  return {
    projects: picker.projects.map((p) => ({ folder: p.cwd, name: p.name, detail: p.detail })),
    root: picker.root ? shortPath(picker.root, homedir()) : null,
    harnesses: [
      ...offered.map((a) => ({ id: a.id, name: a.name, canName: namedAtStart(a) })),
      ...apps.map((a) => ({ id: a.id, name: a.name, folders: a.launches!.projects().map((p) => p.cwd), canName: namedAtStart(a) })),
    ],
    selected: preselected.id || null,
    why: whyWords(preselected.why),
  };
}

/**
 * A new session from the phone's sheet, opened as the window's picker opens one (placeOf, then
 * startSession or startInApp, `by` phone: shown, not said, and Voice can doesn't apply), in the agent
 * picked there (else the one preselected), with its first message typed, said (a dictated press's
 * words, told back first), or none, and named when a name was given (where its agent can be:
 * namedAtStart). Why it didn't open, in the Mac's words, when it didn't.
 */
export async function phoneNewSession(ask: NewSessionAsk, phoneId: string, heard: (text: string) => void): Promise<NewSessionOutcome> {
  const no = (why: string): NewSessionOutcome => (ui.info(`(phone: ${why})`), { started: false, why });
  let prompt = ask.text ?? "";
  if (ask.talkId) {
    const words = await dictations.words(phoneId, ask.talkId);
    if (words === null) return no("Nothing of what you said reached the Mac. Say it again, or type it.");
    if (!words.trim()) return no("I didn't hear anything. Hold the button while you say it, or type it.");
    prompt = words.trim();
    heard(prompt);
  }
  const where = placeOf(ask.pick);
  if (typeof where === "string") return no(where);
  // The agents the window's question would offer for this place.
  const offered = [...offeredStarters(), ...("cwd" in where ? launchersIn(where.cwd) : [])];
  let h: AgentChoice;
  if (ask.harness) {
    const its = offered.find((a) => a.id === ask.harness);
    if (!its) {
      const known = agents.find((a) => a.id === ask.harness);
      if (!known) return no(`${NAME} doesn't know an agent called ${ask.harness}.`);
      if (known.launches) return no(`${known.name} isn't open, or ${placeWords(where)} isn't one of its projects.`);
      return no(`${known.name} isn't connected. Connect it in ${NAME}'s settings, under Agents.`);
    }
    const inputs = await preselecting(offered);
    h = { its, how: "picker", preselected: preselect(inputs.offered, inputs), offered };
    pickedLog(h, "phone");
  } else h = await agentFor("", "phone");
  // A project the agent's history still lists but that's gone from the disk: said, rather than a
  // terminal opening somewhere else. (An app's own projects are its to know: T3 Code's.)
  if (where.kind === "project" && !h.its.launches && !existsSync(where.cwd)) return no(`${shortPath(where.cwd, homedir())} isn't there any more.`);
  // Its name: on its command line, else given once its agent lists it (started), as a session named by voice is.
  const given = ask.name?.slice(0, 80) ?? "";
  if (given && !namedAtStart(h.its)) return no(`${h.its.name} sessions can't be named from here. Leave the name empty, and rename it in ${h.its.name}.`);
  log("phone_start", { phoneId, where: where.kind, agent: h.its.id, prompt: Boolean(prompt), spoken: Boolean(ask.talkId), ...(given ? { name: given } : {}) });
  const opened = h.its.launches ? await startInApp(h.its, where, given, prompt, "phone") : await startSession(where, given, prompt, "phone", "", h, Boolean(ask.talkId));
  if (!opened) return no("It wasn't started.");
  if ("notOpened" in opened) return { started: false, why: opened.notOpened };
  const session = findSession(await getSessions(0), opened.opened);
  const name = session ? sessionName(session) : given || ("cwd" in where ? folderName(where.cwd) : placeWords(where));
  return { started: true, sessionId: session?.sessionId ?? opened.opened, name, text: prompt, line: opened.line };
}

/**
 * The folder a new session opens in, made when it's new or a scratch one, and what to say about it
 * (core/agent-pick.ts openingLine; `kind` names its agent: "a Codex session", or null).
 */
function folderFor(where: StartPlace, name: string, prompt: string, kind: string | null): { cwd: string; line: string } {
  switch (where.kind) {
    case "project":
    case "home":
      return { cwd: where.cwd, line: openingLine(where, { cwd: where.cwd, name, there: true, kind }) };
    case "new": {
      const there = existsSync(where.cwd);
      mkdirSync(where.cwd, { recursive: true });
      return { cwd: where.cwd, line: openingLine(where, { cwd: where.cwd, name, there, kind }) };
    }
    case "scratch": {
      const cwd = freeFolder(config.scratchFolder, scratchName(new Date(), name || where.said || prompt));
      mkdirSync(cwd, { recursive: true });
      return { cwd, line: openingLine(where, { cwd, name, there: false, kind }) };
    }
  }
}

/**
 * Where a new session can open by name: the running sessions' folders, the folders the agent has
 * run in, and the projects root's; not the scratch folder's, nor the home folder ("home" is said for it).
 */
export function knownProjects(sessions: Session[]): Project[] {
  const roots = projectRoots(config.projectsRoot, homedir());
  return listProjects([...sessionFolders(sessions), ...agent.knownFolders(), ...roots.flatMap(rootFolders)], (cwd) => within(cwd, config.scratchFolder) || cwd === homedir());
}
