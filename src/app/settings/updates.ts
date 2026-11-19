// Settings → Updates: the updater for this copy (core/updates/), what it found, what the section
// was asked, and restarting into a new version (or to apply a setting) once nothing is in the way.
import { NAME, COMMAND } from "../../core/name.ts";
import { ui, type SettingRow } from "../../core/ui-store.ts";
import { RESTART_EXIT, UPDATE_EXIT } from "../../core/running.ts";
import { compareVersions } from "../../core/updates/feed.ts";
import { thisCopy } from "../../core/updates/layout.ts";
import { loadState, saveState, Updater, type UpdateView, updateWords } from "../../core/updates/updater.ts";
import { loadSettings } from "../../core/settings.ts";
import { version } from "../../cli-args.ts";
import { log } from "../../core/log.ts";
import { audio, floor, hooks, state } from "../state.ts";
import { refreshSettings } from "../settings-screen.ts";

// This copy (core/updates/): an installed one looks at the release feed once a day and, with
// automatic updates on, installs a newer version in the background for the next start; a
// development checkout doesn't (KIKO_UPDATES=force: it looks, and only says).
const updateCopy = thisCopy(version());
let autoUpdate = loadSettings().autoUpdate !== false;
export const updater = new Updater({ copy: updateCopy, auto: () => autoUpdate, changed: updateChanged, log });
let updateView: UpdateView = { running: updateCopy.version, installed: updateCopy.installed, auto: autoUpdate };

/**
 * What the updater found: the header's words, Settings → Updates, and, the first time a newer
 * version is ready, one line saying so and what's new (never said out loud).
 */
export function updateChanged(view: UpdateView) {
  updateView = view;
  ui.set({ update: updateWords(view) });
  refreshSettings();
  const ready = view.ready && compareVersions(view.ready.version, view.running) > 0 ? view.ready : null;
  if (!ready) return;
  const state = loadState(updateCopy.layout);
  if (state.announced === ready.version) return;
  try {
    saveState(updateCopy.layout, { ...state, announced: ready.version });
  } catch {
    // Not kept: said again next start, nothing worse.
  }
  log("update_ready", { version: ready.version, running: view.running });
  ui.info(
    `${NAME} ${ready.version} is ready${ready.notes ? `: ${ready.notes}` : "."} It starts the next time ${NAME} does: Settings → Updates → Restart now, or quit and run ${COMMAND}. Your sessions keep running.`,
  );
}

/** Automatic updates turned on or off. Turned on with a newer one out: it's installed now, as it would have been. */
export function setAutoUpdate(on: boolean) {
  autoUpdate = on;
  if (autoUpdate && updateView.available && updateView.installed) void updater.check();
  updateChanged(updater.view());
}

/** Settings → Updates: the version running, what's newer, and whether new ones install by themselves. */
export function updateRows(): SettingRow[] {
  const v = updateView;
  const newer = v.ready && compareVersions(v.ready.version, v.running) > 0;
  const status = v.ready
    ? newer
      ? `${v.ready.version} ready, restart to use it`
      : `${v.ready.version} starts next time`
    : v.available
      ? `${v.available.version} available${v.available.skipped ? " (you went back from it)" : ""}`
      : !v.installed
        ? "a development copy"
        : v.checkedAt
          ? "the newest"
          : "";
  const what = v.ready ?? v.available;
  const note = v.failed && v.available ? `${v.available.version} couldn't be installed: ${v.failed}` : what?.notes ? `What's new in ${what.version}: ${what.notes}` : undefined;
  return [
    { key: "updates", label: "Version", raw: JSON.stringify(v), value: `${v.running}${status ? ` · ${status}` : ""}`, restart: false, ...(note ? { note } : {}) },
    { key: "autoUpdate", label: "Automatic updates", raw: autoUpdate, value: autoUpdate ? "On" : "Off", restart: false },
  ];
}

/** What Settings → Updates was asked: restart into the version installed, install the newer one now, or look again. */
export function updateAction(value: string) {
  if (value === "restart") {
    if (!updateView.ready) return ui.info("(nothing new to restart into)");
    log("update_restart", { version: updateView.ready.version, running: updateView.running });
    return void restartWhenHeard(UPDATE_EXIT);
  }
  if (value !== "check" && value !== "install") return;
  const install = value === "install";
  ui.info(install ? `Downloading ${NAME} ${updateView.available?.version ?? ""}…`.replace(" …", "…") : "Looking for a new version…");
  void updater.check(install).then((outcome) => {
    const v = updater.view();
    if (outcome === "offline") ui.info("Couldn't reach the release feed: offline? It looks again in an hour.");
    else if (outcome === "busy") ui.info(`Another update is going on (${COMMAND} update?): it says here when it's done.`);
    else if (outcome === "failed") ui.info(`${NAME} ${v.available?.version ?? ""} couldn't be installed${v.failed ? `: ${v.failed}` : ""}.`.replace("  ", " "));
    else if (outcome === "newest") ui.info(`${NAME} ${v.running} is the newest.`);
    else if (outcome === "available" && !v.installed) ui.info(`${NAME} ${v.available?.version} is out; this development copy updates with git pull.`);
    else if (outcome === "available") ui.info(`${NAME} ${v.available?.version} is out: Install it now, here, or ${COMMAND} update.`);
  });
}

/**
 * Restarts to apply a setting (start.ts starts it again), once nothing is still to be read out to
 * you and you aren't talking: a restart lets every held session go, and would drop those.
 */
let restarting = false;
export async function restartWhenHeard(code = RESTART_EXIT) {
  if (restarting) return;
  restarting = true;
  const why = code === UPDATE_EXIT ? `to start ${NAME} ${updateView.ready?.version ?? "again"}` : "to apply your changes";
  ui.info(floor.owesReading() ? `Restarting ${why} once what's waiting has been read out…` : `Restarting ${why}…`);
  while (floor.owesReading() || floor.pressed || floor.replying || state.voiceHolds || state.phoneHolds || floor.speaking || audio.busy()) {
    await new Promise((r) => setTimeout(r, 200));
  }
  setTimeout(() => hooks.shutdown(code), 400);
}
