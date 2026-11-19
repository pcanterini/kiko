// Settings → Agents and the first-run card (agents/setup.ts): connecting your agents, Kiko's own
// hooks brought up to date at start, and what each agent's row says and does.
import { andList, shortPath } from "../../core/text.ts";
import { rememberAgents, loadSettings } from "../../core/settings.ts";
import { COMMAND, NAME } from "../../core/name.ts";
import { agents } from "../../agents/index.ts";
import {
  answerCard,
  answersOf,
  cardMessage,
  cardRows,
  connectOne,
  labelOf,
  outcomeMessage,
  SETUPS,
  signedInWords,
  startWarning,
  statusOf,
  upgradeHooks,
  upgradedMessage,
  type CardAnswer,
  type Outcome,
} from "../../agents/setup.ts";
import type { Changed } from "../../agents/types.ts";
import { capital } from "../../core/settings-options.ts";
import { ui, type SettingRow } from "../../core/ui-store.ts";
import { log } from "../../core/log.ts";
import { state } from "../state.ts";
import { refreshSettings } from "../settings-screen.ts";

/** What a change to an agent's file was, for the log: the file, the events, whether it was backed up, how many entries were pointed anew. */
const changedFields = (c?: Changed) => (c ? { file: shortPath(c.file), events: c.events, backup: Boolean(c.backup), ...(c.repointed ? { repointed: c.repointed } : {}) } : {});

/** One agent's outcome in the log: agent_connected, agent_repaired, or agent_failed (nothing changed). */
function logOutcome(o: Outcome, by: "card" | "settings") {
  if (o.did === "failed") return log("agent_failed", { agent: o.id, by, error: o.error, ...(o.off ? { disconnecting: true } : {}) });
  log(o.did === "repaired" ? "agent_repaired" : o.did === "disconnected" ? "agent_disconnected" : "agent_connected", { agent: o.id, by, ...changedFields(o.changed) });
}

/**
 * An agent with nothing to set up (T3 Code) turned on or off (agentAnswers: "no" is off), its
 * adapter started or stopped now: off, Kiko's connection to it closes and its threads leave the
 * list; on, it connects (its start no longer refused) and they come back.
 */
function switchAgent(id: string, on: boolean) {
  const a = agents.find((x) => x.id === id);
  if (!a?.setup || a.setup.connect) return;
  log(on ? "agent_on" : "agent_off", { agent: id });
  // Its row says connected once the first try is through.
  if (on)
    void a.start().then(() => {
      a.onSessionsChanged();
      refreshSettings();
    });
  else {
    a.stop();
    a.onSessionsChanged();
  }
}

/**
 * The first-run card, at start: every supported agent found, the ones not connected (or needing
 * repair) and not answered about before offered, ticked (agents/setup.ts cardRows). A popup in the
 * Kiko window, after a key clash's question; a line with --plain. No card: a word when an
 * agent's hooks need repair, or none is connected.
 */
export function checkAgents() {
  let rows: ReturnType<typeof cardRows> = null;
  try {
    rows = cardRows(answersOf(loadSettings().agentAnswers));
  } catch (err) {
    log("agents_card", { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const offered = rows?.filter((r) => r.ask) ?? [];
  const where = !rows ? null : state.windowGlue?.askAgents(rows) ? "window" : "plain";
  log("agents_card", { agents: Object.fromEntries(SETUPS.map((s) => [s.id, statusOf(s).state])), offered: offered.map((r) => r.id), where });
  if (where === "plain") return ui.info(`(Found ${andList(offered.map((r) => r.name))}: ${COMMAND} setup, or settings → Agents, picks which ${NAME} talks to.)`);
  if (where) return;
  const warning = startWarning();
  if (warning) ui.error("setup", warning);
}

/**
 * Kiko's own hooks brought up to date at start, before the card looks (agents/setup.ts
 * upgradeHooks): in each agent connected already, an event new to this Kiko added next to the
 * hooks there, the file backed up first, and said once ("Added Kiko's new Claude Code hook
 * (PermissionDenied)."): installs connected before 2026-10-30 lacked PermissionDenied, and settings
 * → Agents' "Add the rest" was all that added it. Only the app does this, once a start: the CLI
 * starts the app anyway, and runs too often (each `kiko`) to write agents' files unasked.
 */
export function upgradeAgentHooks() {
  let result: ReturnType<typeof upgradeHooks>;
  try {
    result = upgradeHooks();
  } catch (err) {
    log("hooks_upgrade_failed", { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  for (const u of result.upgraded) {
    if (u.did === "added")
      log("hooks_upgraded", {
        agent: u.id,
        events: u.events,
        file: u.changed ? shortPath(u.changed.file) : null,
        backup: u.changed?.backup ? shortPath(u.changed.backup) : null,
        ...(u.changed?.repointed ? { repointed: u.changed.repointed } : {}),
        ...(u.changed?.refreshed?.length ? { refreshed: u.changed.refreshed } : {}),
      });
    else log(u.did === "failed" ? "hooks_upgrade_failed" : "hooks_upgrade_skipped", { agent: u.id, events: u.events, why: u.why });
  }
  if (result.unsaved) log("hooks_upgrade_failed", { what: "hooksKnown", error: result.unsaved });
  const message = upgradedMessage(result.upgraded);
  if (!message) return;
  state.windowGlue?.note(message);
  ui.info(`(${message})`);
}

/** An agent's setup `health`, never throwing: its problem's words, or null. */
export function safeHealth(setup: { health?: () => string | null }): string | null {
  try {
    return setup.health?.() ?? null;
  } catch {
    return null;
  }
}

/** The card answered (window.ts): carried out, remembered, and said briefly. */
export function answerAgents(answer: CardAnswer) {
  const { outcomes, answers } = answerCard(answer);
  try {
    rememberAgents(answers);
  } catch (err) {
    log("window_failed", { what: "agents_answer", error: err instanceof Error ? err.message : String(err) });
  }
  log("agents_card_answer", { ...answer });
  for (const o of outcomes) logOutcome(o, "card");
  // One with nothing to set up (T3 Code) unticked: left alone from now on.
  for (const [id, a] of Object.entries(answers)) if (a === "no") switchAgent(id, false);
  const message = cardMessage(answer, outcomes);
  state.windowGlue?.note(message);
  ui.info(`(${message})`);
  if (ui.state.screen === "settings") refreshSettings();
}

/** How an agent's row reads under Agents (`nothing`: nothing to set up, T3 Code: not connected is off). */
function agentValue(state: string, detail: string, nothing = false): string {
  if (state === "automatic") return detail === "connected" ? "Connected (by itself)" : "Connects by itself";
  if (nothing && state === "not connected") return "Off";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

/** The Agents section of the settings screen: one row per supported agent, where it stands. */
export function agentRows(): SettingRow[] {
  return SETUPS.map((s) => {
    const status = statusOf(s);
    const row: SettingRow = {
      key: `agent:${s.id}`,
      label: labelOf(s),
      raw: JSON.stringify({
        state: status.state,
        detail: status.detail,
        file: s.file(),
        ...(status.unreadable ? { unreadable: true } : {}),
        ...(status.partial ? { partial: status.partial } : {}),
        ...(s.linkWords ? { link: s.linkWords } : {}),
        ...(s.connect ? {} : { nothing: true }),
      }),
      value: `${agentValue(status.state, status.detail, !s.connect)}${signedInWords(s)}`,
      restart: false,
    };
    // Its pane: the file its hooks go in (none for one reached through its own server, or with nothing to set up).
    const file = s.file();
    if (file) row.facts = [{ label: "Hooks in", value: file }];
    if (status.state === "needs repair") row.note = capital(status.detail);
    return row;
  });
}

/**
 * Connect (or repair) and Disconnect, from an agent's row; Leave it does nothing. One with nothing to
 * set up (T3 Code): Turn on forgets your "no" and connects to it now; Turn off remembers "no" and
 * stops: nothing of its own changes either way.
 */
export function agentAction(id: string, value: string) {
  const setup = SETUPS.find((s) => s.id === id);
  if (!setup || value === "keep") return;
  if (!setup.connect && (value === "connect" || value === "disconnect")) {
    const on = value === "connect";
    rememberAgents({ [id]: on ? "yes" : "no" });
    switchAgent(id, on);
    ui.info(on ? `(${setup.name} is on: ${NAME} connects to it while it's running.)` : `(${setup.name} is off: ${NAME} leaves it alone; nothing of its own changed.)`);
  } else if (value === "connect") {
    const o = connectOne(setup);
    logOutcome(o, "settings");
    if (o.did === "failed") ui.error("agents", o.error);
    else {
      rememberAgents({ [id]: null });
      ui.info(`(${outcomeMessage(o)})`);
    }
  } else if (value === "disconnect" && setup.disconnect) {
    try {
      const changed = setup.disconnect();
      log("agent_disconnected", { agent: id, by: "settings", ...changedFields(changed) });
      // Not offered again by the card: you took it out.
      rememberAgents({ [id]: "no" });
      ui.info(
        setup.linkWords
          ? `(Disconnected ${setup.name}: ${NAME} no longer listens to it; nothing of its own changed.)`
          : changed.events.length
            ? `(Disconnected ${setup.name}: ${NAME}'s hooks are out of ${shortPath(changed.file)}${changed.backup ? " (the old one is backed up next to it)" : ""}; yours are as they were.)`
            : `(${setup.name} had none of ${NAME}'s hooks.)`,
      );
    } catch (err) {
      log("agent_failed", { agent: id, by: "settings", error: err instanceof Error ? err.message : String(err) });
      ui.error("agents", err);
    }
  }
  refreshSettings();
}
