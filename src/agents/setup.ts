// Connecting your agents: every agent's setup (types.ts AgentSetup) in one list, and what the
// first-run card, settings → Agents and `kiko setup` do with them, the same way:
//
//   found         each supported agent that's on this Mac (claude, codex on PATH or their folders; T3
//                 Code's CLI), with where it stands: connected, not connected, needs repair, or
//                 automatic (T3 Code: nothing to add, found when it runs)
//   offered       the ones not connected or needing repair that you haven't answered about, ticked:
//                 Enter connects (or repairs) the ticked ones, each file backed up first. T3 Code
//                 (nothing to set up) too: ticked, nothing is written ("yes"); unticked ("no"),
//                 Kiko leaves it alone. First-run setup lists every one found as a box, the
//                 connected ones ticked: unticking one of those disconnects it (backed up, only
//                 Kiko's entries out), as settings → Agents' Disconnect does
//   remembered    an agent you unticked ("no"), or every one offered when you said later, in the
//                 settings (agentAnswers), so the card doesn't come back every start; one found later
//                 (Codex installed next month) is offered once the same way. Connecting one from
//                 settings forgets its answer; disconnecting one there remembers "no".
//   upgraded      at the app's start, an agent connected already (Kiko's entries in its file) is
//                 given each event this Kiko hooks that its file has never had (upgradeHooks:
//                 PermissionDenied, new 2026-10-30, which installs from before lacked), through the
//                 same connect, backed up first; said once. One you took out stays out: the events a
//                 file has been given are kept (hooksKnown). An agent you said no to, or one needing
//                 repair (its hook moved), is left to you as before.
//
// The adapters' `setup` is the same object (agents/index.ts): this list is for what can't load the
// adapters (the CLI, first-run setup), in the same order. A new agent (OpenCode, Pi) is one more
// entry here and on its adapter, nothing else: the card, settings and the CLI read only this list
// (its words, file, state, connect, disconnect, plan, and the optional signedIn and health checks). Imports nothing that loads .env or writes logs: the app logs what
// happened (agents_card, agent_connected, agent_disconnected, agent_repaired, hooks_upgraded).
import { COMMAND, NAME } from "../core/name.ts";
import { hooksKnownOf, loadSettings, rememberHooks, type Settings } from "../core/settings.ts";
import { andList, orList, shortPath } from "../core/text.ts";
import { claudeCodeSetup } from "./claude-code/setup.ts";
import { codexSetup } from "./codex/setup.ts";
import { opencodeSetup } from "./opencode/setup.ts";
import { t3codeSetup } from "./t3code/setup.ts";
import type { AgentSetup, Changed, HookEvents, SetupState, SetupStatus } from "./types.ts";

/** Every agent's setup, the main one (Claude Code) first. */
export const SETUPS: AgentSetup[] = [claudeCodeSetup, codexSetup, opencodeSetup, t3codeSetup];

/**
 * Where an agent stands: its status, and a connected one whose hooks don't work (its `health`) as
 * needing repair. What the card, settings and the CLI all read.
 */
export function statusOf(setup: AgentSetup): SetupStatus {
  const status = setup.status();
  if (status.state !== "connected" || !setup.health) return status;
  let problem: string | null = null;
  try {
    problem = setup.health();
  } catch {
    problem = null;
  }
  return problem ? { state: "needs repair", detail: problem } : status;
}

/** How an agent is listed where you pick the ones to connect: its `label` ("Codex CLI"), else its name. */
export const labelOf = (setup: AgentSetup): string => setup.label ?? setup.name;

/**
 * The agents Kiko works with that aren't on this Mac, in one line under setup's agents step:
 * "Also works with: Codex CLI, OpenCode (not installed here)." The same list as the card (SETUPS). Null
 * when every one is found.
 */
export function notInstalledLine(setups: AgentSetup[] = SETUPS): string | null {
  const missing = setups.filter((s) => statusOf(s).state === "not installed").map(labelOf);
  return missing.length ? `Also works with: ${missing.join(", ")} (not installed here).` : null;
}

/** A few words on whether you're signed in, when the agent can tell: " · signed in", " · not signed in", or "". */
export function signedInWords(setup: AgentSetup): string {
  const signed = setup.signedIn?.() ?? null;
  return signed === null ? "" : signed ? " · signed in" : " · not signed in";
}

/** The agents that have hooks to connect (`connect`), by their command-line words: "claude or codex". */
export const agentWords = (setups: AgentSetup[] = SETUPS) => orList(setups.filter((s) => s.connect).map((s) => s.word ?? s.id));

/** The agent a command-line word names (its `word`, id or name, any case or dashes), or undefined. */
export function agentNamed(word: string, setups: AgentSetup[] = SETUPS): AgentSetup | undefined {
  const flat = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
  const w = flat(word);
  return setups.find((s) => [s.word ?? "", s.id, s.name].some((n) => n && flat(n) === w));
}

/**
 * What you answered about an agent the card offered: later (Esc), no (unticked), or yes (ticked, kept
 * only for one with nothing to set up: T3 Code, so it isn't asked again).
 */
type AgentAnswer = "later" | "no" | "yes";
const isAgentAnswer = (value: unknown): value is AgentAnswer => value === "later" || value === "no" || value === "yes";

/** The answers kept in the settings (agentAnswers), as far as they're answers. */
export function answersOf(saved: unknown): Record<string, AgentAnswer> {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved).filter(([, v]) => isAgentAnswer(v))) as Record<string, AgentAnswer>;
}

/**
 * One line of the card: an agent found, where it stands, a few words on it, and whether it's asked
 * about (`ask`: ticked to start with, Space unticks it). The app's card shows the others, never
 * toggled. First-run setup lists every one as a box (`ticked`: how it starts, connected ones ticked;
 * `hint`: where it stands, in words without parentheses); left out, `ask` and `detail` stand in.
 */
export type CardRow = { id: string; name: string; state: SetupState; detail: string; ask: boolean; ticked?: boolean; hint?: string };

/** Whether an agent in this state is one to offer: not connected, or needing a repair Kiko can make. */
const offerable = (state: SetupState, unreadable?: boolean) => (state === "not connected" || state === "needs repair") && !unreadable;

/**
 * The card's lines: every agent found (not installed: left out), the ones to offer asked about: not
 * connected, needing repair, or with nothing to set up (T3 Code: ticked, it stays as it is; unticked,
 * Kiko leaves it alone), unless answered before. Null when there's none to offer: no card then.
 */
export function cardRows(answers: Record<string, AgentAnswer>, setups: AgentSetup[] = SETUPS): CardRow[] | null {
  const rows = foundRows(answers, setups);
  return rows.some((r) => r.ask) ? rows : null;
}

/** The card's lines, whether or not there's one to offer (`kiko setup --all` lists them anyway). */
export function foundRows(answers: Record<string, AgentAnswer>, setups: AgentSetup[] = SETUPS): CardRow[] {
  const rows: CardRow[] = [];
  for (const s of setups) {
    const status = statusOf(s);
    if (status.state === "not installed") continue;
    const ask = (offerable(status.state, status.unreadable) || status.state === "automatic") && !answers[s.id];
    const signed = signedInWords(s);
    const detail = ask
      ? status.state === "needs repair"
        ? "needs repair: Enter fixes it"
        : status.detail
      : status.state === "connected"
        ? "connected"
        : offerable(status.state, status.unreadable)
          ? "skipped: settings → Agents connects it"
          : status.detail;
    const hint = ask ? detail : status.state === "connected" ? "connected" : status.state === "needs repair" ? `needs repair: ${status.detail}` : status.detail;
    const ticked = ask || status.state === "connected" || status.state === "automatic";
    rows.push({ id: s.id, name: labelOf(s), state: status.state, detail: `${detail}${signed}`, ask, ticked, hint: `${hint}${signed}` });
  }
  return rows;
}

/** What became of one agent: connected, repaired, disconnected (unticked in setup), or not (`error`: why; `off`: it was being disconnected), with what changed. */
export type Outcome = {
  id: string;
  name: string;
  did: "connected" | "repaired" | "disconnected" | "failed";
  changed?: Changed;
  error?: string;
  off?: boolean;
  afterConnect?: string;
  linkWords?: string;
};

/**
 * One agent connected, or repaired when it needed it (its setup's connect does both); `only`: just
 * those of its events added (upgradeHooks). A file that isn't JSON, or one that can't be written, is
 * a failed outcome: nothing was changed. Connected whole, every event of its is kept as given
 * (hooksKnown): one taken out from now on stays out at the start's upgrade.
 */
export function connectOne(setup: AgentSetup, only?: readonly string[]): Outcome {
  const repair = statusOf(setup).state === "needs repair";
  const base = { id: setup.id, name: setup.name };
  if (!setup.connect) return { ...base, did: "failed", error: `${setup.name} needs nothing set up` };
  let changed: Changed;
  try {
    changed = setup.connect(only);
  } catch (err) {
    return { ...base, did: "failed", error: err instanceof Error ? err.message : String(err) };
  }
  if (!only) keepGiven(setup);
  return { ...base, did: repair ? "repaired" : "connected", changed, afterConnect: setup.afterConnect, ...(setup.linkWords ? { linkWords: setup.linkWords } : {}) };
}

/** Every hook event of `setup`'s kept as given its file (hooksKnown), with the ones kept before; nothing when it has none, or the settings can't be read or written. */
function keepGiven(setup: AgentSetup) {
  try {
    const all = setup.hookEvents?.().all;
    if (all) rememberHooks({ [setup.id]: [...new Set([...(hooksKnownOf(loadSettings().hooksKnown)[setup.id] ?? []), ...all])] });
  } catch {
    // Connected all the same: the start's upgrade keeps them next time.
  }
}

/**
 * What the start's upgrade did for one agent: `added` events to its file, or pointed its entries
 * still running its hook under an older name at the new one, or both (`changed`: where, the
 * backup, how many it pointed); `skipped` it (`why`: its file can't be read, or it needs repair); or `failed` to write
 * (`why`), nothing changed. An agent not connected, or with nothing new, isn't in the list.
 */
export type Upgraded = { id: string; name: string; did: "added" | "skipped" | "failed"; events: string[]; changed?: Changed; why?: string };

/**
 * Kiko's own hooks brought up to date, at the app's start: each agent connected already (some of
 * Kiko's entries in its file, their script there) is given the events this Kiko hooks that
 * its file has never been given (`missing`, less what hooksKnown has for it, or its `hooksBefore`
 * when there's no record yet), through `connectOne` with just those, as "Add the rest" would: next to
 * the hooks there, the file backed up first and written whole. Only ever adds Kiko's entries.
 * Never an agent you haven't connected, or one you said no to (agentAnswers: unticked on the card,
 * disconnected); never an event you took out. A file that can't be read is skipped as it is; one
 * whose hook moved (needs repair) is left to the card and settings → Agents, which repair it when
 * you say. Then every event each connected agent has is kept as given (hooksKnown), so one you take
 * out from now on stays out. `unsaved`: why that record couldn't be written (it is next start).
 */
export function upgradeHooks(setups: AgentSetup[] = SETUPS, saved: Settings = loadSettings()): { upgraded: Upgraded[]; unsaved?: string } {
  const answers = answersOf(saved.agentAnswers);
  const known = hooksKnownOf(saved.hooksKnown);
  const upgraded: Upgraded[] = [];
  const keep: Record<string, string[]> = {};
  for (const s of setups) {
    if (!s.hookEvents || !s.connect || s.linkWords || answers[s.id] === "no") continue;
    const base = { id: s.id, name: s.name };
    let now: HookEvents;
    try {
      now = s.hookEvents();
    } catch (err) {
      upgraded.push({ ...base, did: "skipped", events: [], why: `${s.file()} can't be read (${err instanceof Error ? err.message : String(err)}), so ${NAME} leaves it alone` });
      continue;
    }
    if (!now.ours) continue;
    if (now.gone) {
      upgraded.push({ ...base, did: "skipped", events: [], why: "needs repair: its hook points at a script that's gone (settings → Agents repairs it)" });
      continue;
    }
    const given = known[s.id] ?? [...(s.hooksBefore ?? now.all)];
    const adding = now.missing.filter((event) => !given.includes(event));
    if (adding.length || now.stale?.length) {
      const o = connectOne(s, adding);
      if (o.did === "failed") {
        upgraded.push({ ...base, did: "failed", events: adding, why: o.error });
        continue;
      }
      if (o.changed?.events.length || o.changed?.repointed || o.changed?.refreshed?.length) upgraded.push({ ...base, did: "added", events: o.changed.events, changed: o.changed });
    }
    const next = [...new Set([...given, ...now.all])];
    const had = known[s.id];
    if (!had || next.length !== had.length || next.some((e) => !had.includes(e))) keep[s.id] = next;
  }
  try {
    rememberHooks(keep);
  } catch (err) {
    return { upgraded, unsaved: err instanceof Error ? err.message : String(err) };
  }
  return { upgraded };
}

/** What's told once the upgrade added something: "Added Kiko's new Claude Code hook (PermissionDenied)."; null when nothing was. */
export function upgradedMessage(upgraded: Upgraded[]): string | null {
  const lines: string[] = [];
  for (const u of upgraded) {
    if (u.did !== "added") continue;
    if (u.events.length) lines.push(`Added ${NAME}'s new ${u.name} hook${u.events.length > 1 ? "s" : ""} (${andList(u.events)}).`);
    const refreshed = u.changed?.refreshed ?? [];
    if (refreshed.length)
      lines.push(`Updated ${NAME}'s ${u.name} hook${refreshed.length > 1 ? "s" : ""} (${andList(refreshed)})${u.id === "codex" ? ": Codex asks you to trust it again at its next start" : ""}.`);
  }
  return lines.length ? lines.join(" ") : null;
}

/** The card answered: what you ticked (`connect`) of what it offered, or later. */
export type CardAnswer = { offered: string[]; connect: string[]; later: boolean };

/**
 * The card's answer carried out: later remembers every agent offered as "later"; otherwise each one
 * ticked is connected (its answer forgotten), or left as it is when it's connected already, or, with
 * nothing to set up (T3 Code), remembered as "yes"; each one unticked is remembered as "no", and one
 * that was connected (first-run setup lists those too) is disconnected: only Kiko's entries taken
 * out, its file backed up first, as settings → Agents' Disconnect does. `answers`: the patch for the
 * settings (null forgets one).
 */
export function answerCard(answer: CardAnswer, setups: AgentSetup[] = SETUPS): { outcomes: Outcome[]; answers: Record<string, AgentAnswer | null> } {
  const answers: Record<string, AgentAnswer | null> = {};
  const outcomes: Outcome[] = [];
  for (const id of answer.offered) {
    const setup = setups.find((s) => s.id === id);
    if (!setup) continue;
    if (answer.later) {
      answers[id] = "later";
      continue;
    }
    const status = statusOf(setup);
    if (answer.connect.includes(id)) {
      if (!setup.connect) answers[id] = "yes";
      else {
        // Connected: nothing to remember. Failed: offered again next time, once it can be.
        if (status.state !== "connected") outcomes.push(connectOne(setup));
        answers[id] = null;
      }
    } else if (status.state === "connected" && setup.disconnect && !status.unreadable) {
      const o = disconnectOne(setup);
      outcomes.push(o);
      // Still connected when it couldn't be taken out: nothing to remember.
      answers[id] = o.did === "failed" ? null : "no";
    } else answers[id] = "no";
  }
  return { outcomes, answers };
}

/** One agent disconnected: Kiko's entries out of its file (backed up first), or failed (`off`), nothing changed. */
function disconnectOne(setup: AgentSetup): Outcome {
  const base = { id: setup.id, name: setup.name };
  try {
    return { ...base, did: "disconnected", changed: setup.disconnect!(), ...(setup.linkWords ? { linkWords: setup.linkWords } : {}) };
  } catch (err) {
    return { ...base, did: "failed", off: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/** What's told about one outcome, briefly. */
export function outcomeMessage(o: Outcome): string {
  if (o.did === "failed") return `${o.name} wasn't ${o.off ? "disconnected" : "connected"}: ${o.error}.`;
  if (o.did === "disconnected") {
    if (o.linkWords) return `Disconnected ${o.name}: ${NAME} no longer listens to it.`;
    if (!o.changed?.events.length) return `${o.name} had none of ${NAME}'s hooks.`;
    return `Disconnected ${o.name}: ${NAME}'s hooks are out of ${shortPath(o.changed.file)}${o.changed.backup ? " (the old one is backed up next to it)" : ""}.`;
  }
  const file = o.changed?.file ? shortPath(o.changed.file) : "";
  const backup = o.changed?.backup ? " (the old one is backed up next to it)" : "";
  const what =
    !o.changed?.backup && !o.changed?.events.length && !o.changed?.repointed
      ? `${o.name} was connected already.`
      : `${o.did === "repaired" ? "Repaired" : "Connected"} ${o.name}: ${o.linkWords ?? `hooks in ${file}${backup}`}.`;
  return [what, o.afterConnect].filter(Boolean).join(" ");
}

/**
 * What the card's answer comes to, in two short parts. `said`: what changed, by the agents' labels
 * ("Connected Claude Code, Codex CLI and T3 Code.", "Disconnected OpenCode.", one that failed and
 * why, the ones skipped). `todo`: the one thing left to do for the ones connected now, or "": their
 * sessions already open restarted, and what they ask at their next start ("Restart Claude Code or
 * Codex sessions that are already open; Codex asks once to trust its hooks."). No files, backups or
 * how each one works: the step says the backups before asking. Setup shows them as two lines (the
 * second dim); the app's card as one (cardMessage).
 */
export function cardSaid(answer: CardAnswer, outcomes: Outcome[], setups: AgentSetup[] = SETUPS): { said: string; todo: string } {
  const setupOf = (id: string) => setups.find((s) => s.id === id);
  const label = (id: string) => {
    const s = setupOf(id);
    return s ? labelOf(s) : id;
  };
  const them = (n: unknown[]) => (n.length > 1 ? "them" : "it");
  if (answer.later) return { said: `Not now, then: settings → Agents connects ${them(answer.offered)} any time.`, todo: "" };
  // With nothing to set up (T3 Code): on or off, nothing of its own changed.
  const nothing = (id: string) => !setupOf(id)?.connect;
  const did = (d: Outcome["did"]) => outcomes.filter((o) => o.did === d).map((o) => o.id);
  const done = new Set(outcomes.map((o) => o.id));
  const unticked = answer.offered.filter((id) => !answer.connect.includes(id) && !done.has(id));
  const skipped = unticked.filter((id) => !nothing(id)).map(label);
  const alone = unticked.filter(nothing).map(label);
  const on = answer.offered.filter((id) => answer.connect.includes(id) && nothing(id));
  // In the card's order: the ones connected now and the ones with nothing to set up turned on.
  const connected = answer.offered.filter((id) => did("connected").includes(id) || on.includes(id)).map(label);
  const listed = (verb: string, ids: string[]) => (ids.length ? `${verb} ${andList(ids)}.` : "");
  const said = [
    listed("Connected", connected),
    listed("Repaired", did("repaired").map(label)),
    listed("Disconnected", did("disconnected").map(label)),
    ...outcomes.filter((o) => o.did === "failed").map((o) => `${label(o.id)} wasn't ${o.off ? "disconnected" : "connected"}: ${o.error}.`),
    skipped.length ? `Skipped ${andList(skipped)}: settings → Agents connects ${them(skipped)} any time.` : "",
    alone.length ? `Left ${andList(alone)} off: settings → Agents turns ${them(alone)} on any time.` : "",
  ];
  const fresh = [...did("connected"), ...did("repaired")].map(setupOf).filter((s): s is AgentSetup => Boolean(s));
  const restart = fresh.filter((s) => s.restartOpen).map((s) => s.name);
  const todo = [restart.length ? `Restart ${orList(restart)} sessions that are already open` : "", ...fresh.map((s) => s.nextStart ?? "")].filter(Boolean).join("; ");
  return { said: said.filter(Boolean).join(" "), todo: todo ? `${todo.charAt(0).toUpperCase()}${todo.slice(1)}.` : "" };
}

/** What the card's answer comes to, said briefly under the list (or in the conversation): cardSaid's two parts in one line. */
export function cardMessage(answer: CardAnswer, outcomes: Outcome[], setups: AgentSetup[] = SETUPS): string {
  const { said, todo } = cardSaid(answer, outcomes, setups);
  return [said, todo].filter(Boolean).join(" ");
}

/**
 * What's left to say at start, when there's no card to show: an agent whose hooks need repair
 * (you skipped it on the card), or no agent connected at all. Null when nothing.
 */
export function startWarning(setups: AgentSetup[] = SETUPS): string | null {
  const found = setups.map((s) => ({ s, status: statusOf(s) })).filter((x) => x.status.state !== "not installed");
  const broken = found.filter((x) => x.status.state === "needs repair");
  if (broken.length) return `${andList(broken.map((x) => x.s.name))}'s hooks need repair (${broken[0].status.detail}): settings → Agents fixes ${broken.length > 1 ? "them" : "it"}.`;
  const hooked = found.filter((x) => x.s.connect);
  if (hooked.length && !hooked.some((x) => x.status.state === "connected")) return `No agent is connected, so sessions won't speak up: settings → Agents, or ${COMMAND} setup.`;
  return null;
}
