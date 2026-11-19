// A release's notarization status, kept beside its files: dist/<version>/notary.json (RELEASING.md,
// "The fast path"). Written by scripts/signing/notarize.ts as it goes (in the background after
// `pnpm ship` has published, or before packing on the full path), read by the next `pnpm ship` and
// by `pnpm release:status`, which print a rejection loudly. A rejection never undoes a publish.
//   node scripts/ship/status.ts [dist folder]     (pnpm release:status) exit 1 if any needs a look
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SLUG } from "../../src/core/name.ts";

/** Where a notarization is: still going (notarizing, checking, gatekeeper), done (ok), or not (rejected by Apple, failed after). */
export type NotaryState = "notarizing" | "checking" | "gatekeeper" | "ok" | "rejected" | "failed";

export type NotaryStatus = {
  version: string;
  /** fast: after publishing, in the background; full: before packing (blocking); build: release.sh run by hand. */
  mode: "fast" | "full" | "build";
  state: NotaryState;
  /** The process doing it, while it's going: a dead one that never finished is shown as stopped. */
  pid?: number;
  /** Apple's submission id. */
  submission?: string;
  started: string;
  updated: string;
  /** What went wrong, or what it's waiting for. */
  message?: string;
  /** Apple's log of a submission that wasn't Accepted, or the background job's own output. */
  log?: string;
};

export const STATUS_FILE = "notary.json";

const PENDING: NotaryState[] = ["notarizing", "checking", "gatekeeper"];

/** Written whole, then renamed over the old one, so a reader never sees half of it. */
export function writeStatus(file: string, status: NotaryStatus): void {
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, `${JSON.stringify(status, null, 2)}\n`);
  renameSync(part, file);
}

export function readStatus(file: string): NotaryStatus | undefined {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as NotaryStatus;
    return typeof s.version === "string" && typeof s.state === "string" ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a process is still running (signal 0 only asks). */
export function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type Verdict = { level: "ok" | "pending" | "problem"; line: string };

/** One line about one release's notarization: fine, still going, or something to look at (and what to do). */
export function describeStatus(s: NotaryStatus, running: (pid: number | undefined) => boolean = alive): Verdict {
  const v = s.version;
  switch (s.state) {
    case "ok":
      return { level: "ok", line: `${v}: notarized, and Gatekeeper accepts a downloaded copy (${s.updated})` };
    case "rejected":
      return {
        level: "problem",
        line: `${v}: Apple REJECTED the notarization (${s.message ?? "not Accepted"}). It stays published (curl | sh and ${SLUG} update don't check it), but a browser download would be blocked: fix the signing and ship a new version.${s.log ? ` Apple's log: ${s.log}` : ""}`,
      };
    case "failed":
      return {
        level: "problem",
        line: `${v}: notarization FAILED (${s.message ?? "unknown"}). It stays published. Try again: pnpm release:notarize ${v}${s.log ? ` (output: ${s.log})` : ""}`,
      };
    default:
      if (PENDING.includes(s.state) && running(s.pid)) return { level: "pending", line: `${v}: notarizing in the background since ${s.started} (${s.state}${s.message ? `: ${s.message}` : ""})` };
      return {
        level: "problem",
        line: `${v}: the background notarization STOPPED before it finished (last: ${s.state}, ${s.updated}). Run it again: pnpm release:notarize ${v}${s.log ? ` (output: ${s.log})` : ""}`,
      };
  }
}

/** Each version's status under a dist folder (dist/<version>/notary.json), newest version first. */
export function scanStatuses(dist: string): NotaryStatus[] {
  if (!existsSync(dist)) return [];
  const found: NotaryStatus[] = [];
  for (const name of readdirSync(dist)) {
    const s = readStatus(join(dist, name, STATUS_FILE));
    if (s) found.push(s);
  }
  return found.sort((a, b) => compareVersions(b.version, a.version));
}

/** -1, 0 or 1, by x.y.z (anything after a "-" ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split("-")[0]
      .split(".")
      .map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The problems, as a block that can't be missed (red on a terminal); nothing when there are none. */
export function loud(problems: string[], tty = Boolean(process.stdout.isTTY)): string {
  if (!problems.length) return "";
  const bar = "!".repeat(78);
  const text = [bar, "!!! NOTARIZATION NEEDS A LOOK", ...problems.map((p) => `!!! ${p}`), bar].join("\n");
  return tty ? `\x1b[1;31m${text}\x1b[0m` : text;
}

/** What `pnpm release:status` prints: every release's line, the problems loudly. */
export function report(statuses: NotaryStatus[], running: (pid: number | undefined) => boolean = alive): { text: string; problems: number } {
  if (!statuses.length) return { text: "No notarization status found (dist/<version>/notary.json): nothing shipped from here yet.", problems: 0 };
  const verdicts = statuses.map((s) => describeStatus(s, running));
  const problems = verdicts.filter((v) => v.level === "problem").map((v) => v.line);
  const lines = verdicts.filter((v) => v.level !== "problem").map((v) => v.line);
  return { text: [loud(problems), ...lines].filter(Boolean).join("\n"), problems: problems.length };
}

if (import.meta.main) {
  const dist = process.argv[2] ?? join(import.meta.dirname, "..", "..", "dist");
  const { text, problems } = report(scanStatuses(dist));
  console.log(text);
  process.exit(problems ? 1 : 0);
}
