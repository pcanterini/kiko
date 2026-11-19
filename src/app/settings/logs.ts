// Settings → Logs (core/log-retention.ts): how long the app's logs are kept, pruned to it, and
// their folder opened in Finder.
import { execFile } from "node:child_process";
import { LOG_DIR } from "../../core/app-root.ts";
import { keepLogsOf, keepLogsWords, logsSize, sizeWords, startLogPruning } from "../../core/log-retention.ts";
import { loadSettings, type Settings } from "../../core/settings.ts";
import { ui, type SettingRow } from "../../core/ui-store.ts";
import { log, LOG_FILE } from "../../core/log.ts";

let logPruner: ReturnType<typeof startLogPruning> | null = null;

/**
 * The app's logs pruned to Settings → Logs → Keep logs: at start, then once a day, never this
 * run's file nor latest.jsonl's. `logs_pruned` says how many went and their bytes, nothing else.
 */
export function startPruningLogs() {
  logPruner ??= startLogPruning({
    dir: LOG_DIR,
    days: () => keepLogsOf(loadSettings().keepLogs),
    keep: () => [LOG_FILE],
    logPruned: ({ count, bytes }) => log("logs_pruned", { count, bytes }),
  });
}

/** Keep logs changed: a shorter window applies at once, not at the next daily prune. */
export const pruneLogsNow = () => logPruner?.now();

/** Not a setting: the logs' folder opened in Finder. */
export function openLogs() {
  execFile("open", [LOG_DIR], (err) => err && ui.error("logs", err));
}

/** Settings → Logs: how long they're kept, and how much the folder holds now. */
export function logsRow(saved: Settings): SettingRow {
  const days = keepLogsOf(saved.keepLogs);
  return { key: "keepLogs", label: "Keep logs", raw: days, value: `${keepLogsWords(days)} · ${sizeWords(logsSize(LOG_DIR).bytes)}`, restart: false };
}
