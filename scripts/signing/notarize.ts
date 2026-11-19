// Notarizes a release's executables with Apple, then waits for this Mac's Gatekeeper to accept a
// downloaded copy of each (RELEASING.md, "Signing and notarization"). Two ways in:
//   node scripts/signing/notarize.ts --version <v> [--status <file>] [--log-out <file>] <root>
//       <root> holds <arch>/kiko-<v>/ for each chip: scripts/release.sh on the full path, before packing
//   node scripts/signing/notarize.ts --dist <dist/<version>> [--notify]
//       a release already packed (and, from `pnpm ship`, already published): its tarballs, named in its
//       latest.json, unpacked and notarized. The fast path runs this in the background after publishing
//       (scripts/ship/ship.ts); `pnpm release:notarize <version>` runs it again by hand
// Either way the steps are the same: one zip of every chip's folder to Apple's notary service
// (notarytool submit --wait, the keychain profile KIKO_NOTARY_PROFILE, kiko-notary); anything but
// Accepted saves Apple's log and stops; then Apple's log must list every executable and Apple must
// serve a ticket for each (scripts/signing/notarized.ts), and Gatekeeper must accept a quarantined
// copy of each (scripts/signing/gatekeeper.ts, which waits for Apple's ticket to reach it).
// Each step is written to the status file (scripts/ship/status.ts; --dist: dist/<version>/notary.json),
// so the next `pnpm ship` or `pnpm release:status` says how it ended. --notify: a macOS notification at
// the end. Exit 0 when accepted; 1 otherwise. Nothing here prints Apple's account details.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NAME, SLUG } from "../../src/core/name.ts";
import { type NotaryState, type NotaryStatus, STATUS_FILE, writeStatus } from "../ship/status.ts";

const HERE = import.meta.dirname;

export type SubmitResult = { status: string; id: string };

/** What notarizing does to the world: Apple, codesign, spctl, the status file. The tests' stand-ins replace them. */
export type NotarizeDeps = {
  zip(root: string, zip: string): void;
  submit(zip: string): SubmitResult;
  /** Apple's log of a submission saved to `out`; false when it couldn't be fetched. */
  fetchLog(id: string, out: string): boolean;
  /** notarized.ts: the log lists every file and Apple serves a ticket for each. */
  tickets(log: string, files: string[]): boolean;
  /** gatekeeper.ts: a quarantined copy of each accepted (it waits). */
  gatekeeper(files: string[]): boolean;
  status(s: NotaryStatus): void;
  notify(title: string, message: string): void;
  say(line: string): void;
  now(): Date;
};

export type NotarizeOptions = {
  version: string;
  mode: NotaryStatus["mode"];
  /** Holds <arch>/kiko-<version>/. */
  root: string;
  /** Where the zip and Apple's log go while it works. */
  work: string;
  /** Where Apple's log of a rejected submission is kept. */
  logOut: string;
  /** The background job's own output, named in the status. */
  output?: string;
  notify?: boolean;
};

/** Every signed file in a root: each chip's kiko, its helpers, tmux and its app bundles (the helper app, checked as a whole). */
export function signedFiles(root: string, version: string): string[] {
  const files: string[] = [];
  for (const arch of readdirSync(root).sort()) {
    const dir = join(root, arch, `${SLUG}-${version}`);
    files.push(join(dir, SLUG));
    for (const helper of readdirSync(join(dir, "native")).sort()) files.push(join(dir, "native", helper));
    files.push(join(dir, "bin", "tmux"));
    for (const app of readdirSync(dir).sort()) if (app.endsWith(".app")) files.push(join(dir, app));
  }
  return files;
}

/** Notarizes, checks the tickets, waits for Gatekeeper; the status file follows each step. */
export async function notarize(o: NotarizeOptions, files: string[], d: NotarizeDeps): Promise<NotaryStatus> {
  const started = d.now().toISOString();
  let current: NotaryStatus = { version: o.version, mode: o.mode, state: "notarizing", pid: process.pid, started, updated: started, ...(o.output ? { log: o.output } : {}) };
  const set = (state: NotaryState, extra: Partial<NotaryStatus> = {}) => {
    current = { ...current, ...extra, state, updated: d.now().toISOString() };
    if (state === "ok" || state === "rejected" || state === "failed") delete current.pid;
    d.status(current);
    return current;
  };
  const end = (state: "ok" | "rejected" | "failed", message?: string, extra: Partial<NotaryStatus> = {}) => {
    const s = set(state, { ...extra, ...(message ? { message } : {}) });
    if (o.notify) d.notify(`${NAME} ${o.version}`, state === "ok" ? "Notarized; Gatekeeper accepts it." : `Notarization ${state === "rejected" ? "REJECTED" : "failed"}: ${message ?? ""}`);
    return s;
  };

  set("notarizing", { message: `submitting ${files.length} executables to Apple` });
  const zip = join(o.work, `${SLUG}-${o.version}.zip`);
  try {
    d.zip(o.root, zip);
  } catch (e) {
    return end("failed", `couldn't zip the release: ${e instanceof Error ? e.message : String(e)}`);
  }
  d.say(`Notarizing ${o.version} (${files.length} executables), waiting for Apple (usually a minute or two)…`);
  const { status, id } = d.submit(zip);
  // No answer at all (offline, the profile missing): nothing was judged, so it can be tried again.
  if (!status) return end("failed", `couldn't submit to Apple's notary service (offline, or the keychain profile?)`, id ? { submission: id } : {});
  if (status !== "Accepted") {
    const saved = id ? d.fetchLog(id, o.logOut) : false;
    return end("rejected", `Apple's notary service said: ${status}`, { ...(id ? { submission: id } : {}), ...(saved ? { log: o.logOut } : {}) });
  }
  d.say("Notarized: Accepted.");
  set("checking", { submission: id, message: "Apple's log and ticket service" });
  const log = join(o.work, "notary-log.json");
  if (!d.fetchLog(id, log)) return end("failed", "couldn't fetch Apple's log of the notarization, to check what it covers");
  if (!d.tickets(log, files)) return end("failed", "Apple's ticket doesn't cover every executable, or isn't served (scripts/signing/notarized.ts said which)");
  set("gatekeeper", { message: "waiting for this Mac's Gatekeeper to accept a downloaded copy of each" });
  if (!d.gatekeeper(files)) return end("failed", "Gatekeeper still refuses a downloaded copy (scripts/signing/gatekeeper.ts said which)");
  return end("ok", undefined, { message: undefined });
}

/** The real thing: xcrun notarytool, the two check scripts, osascript. */
export function realDeps(profile: string, statusFile: string | undefined): NotarizeDeps {
  const node = (script: string, args: string[]) => spawnSync(process.execPath, [join(HERE, script), ...args], { stdio: "inherit" }).status === 0;
  return {
    zip(root, zip) {
      const r = spawnSync("ditto", ["-c", "-k", "--keepParent", root, zip], { encoding: "utf8" });
      if (r.status !== 0) throw new Error((r.stderr || "ditto failed").trim());
    },
    submit(zip) {
      const r = spawnSync("xcrun", ["notarytool", "submit", zip, "--keychain-profile", profile, "--wait", "--timeout", "30m", "--output-format", "json"], { encoding: "utf8" });
      try {
        const j = JSON.parse(r.stdout) as { status?: string; id?: string };
        return { status: j.status ?? "", id: j.id ?? "" };
      } catch {
        // Only the last lines of what it said, never its arguments: no account details.
        console.error((r.stderr ?? "").trim().split("\n").slice(-5).join("\n"));
        return { status: "", id: "" };
      }
    },
    fetchLog(id, out) {
      return spawnSync("xcrun", ["notarytool", "log", id, "--keychain-profile", profile, out], { stdio: "ignore" }).status === 0;
    },
    tickets: (log, files) => node("notarized.ts", ["--log", log, ...files]),
    gatekeeper: (files) => node("gatekeeper.ts", files),
    status: (s) => {
      if (statusFile) writeStatus(statusFile, s);
    },
    notify(title, message) {
      const quote = (t: string) => JSON.stringify(t.slice(0, 200));
      spawnSync("osascript", ["-e", `display notification ${quote(message)} with title ${quote(title)}`], { stdio: "ignore", timeout: 10_000 });
    },
    say: (line) => console.log(line),
    now: () => new Date(),
  };
}

/** A packed release's tarballs, from its latest.json, unpacked into root/<arch>/. */
export function unpackDist(dist: string, root: string): { version: string } {
  const feed = JSON.parse(readFileSync(join(dist, "latest.json"), "utf8")) as { version: string; assets: Record<string, { url: string }> };
  for (const [key, asset] of Object.entries(feed.assets)) {
    const arch = key.replace(/^darwin-/, "");
    const into = join(root, arch);
    spawnSync("mkdir", ["-p", into]);
    const r = spawnSync("tar", ["-xzf", join(dist, basename(asset.url)), "-C", into], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`couldn't unpack ${basename(asset.url)}: ${(r.stderr ?? "").trim()}`);
  }
  return { version: feed.version };
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: string[]): Promise<number> {
  const profile = process.env.KIKO_NOTARY_PROFILE || "kiko-notary";
  const dist = arg(args, "--dist");
  const work = mkdtempSync(join(tmpdir(), `${SLUG}-notarize-`));
  try {
    let root: string;
    let version: string;
    let statusFile = arg(args, "--status");
    let logOut = arg(args, "--log-out");
    let mode: NotaryStatus["mode"] = (arg(args, "--mode") as NotaryStatus["mode"]) ?? "build";
    if (dist) {
      root = join(work, "release");
      statusFile ??= join(dist, STATUS_FILE);
      try {
        version = unpackDist(dist, root).version;
      } catch (e) {
        const now = new Date().toISOString();
        const message = e instanceof Error ? e.message : String(e);
        writeStatus(statusFile, { version: basename(dist), mode: "fast", state: "failed", started: now, updated: now, message });
        console.error(`notarize: ${message}`);
        return 1;
      }
      logOut ??= join(dist, "notary-log.json");
      if (!arg(args, "--mode")) mode = "fast";
    } else {
      root = args.at(-1) ?? "";
      version = arg(args, "--version") ?? "";
      if (!root || !version || root.startsWith("--")) {
        console.error("usage: node scripts/signing/notarize.ts --version <v> [--status <file>] [--log-out <file>] <root>  |  --dist <dist/<version>> [--notify]");
        return 2;
      }
      logOut ??= join(work, "notary-log.json");
    }
    const files = signedFiles(root, version);
    const s = await notarize({ version, mode, root, work, logOut, output: arg(args, "--output"), notify: args.includes("--notify") }, files, realDeps(profile, statusFile));
    if (s.state !== "ok") console.error(`notarize: ${s.state}: ${s.message ?? ""}${s.log ? ` (${s.log})` : ""}`);
    else console.log(`Notarized ${version}: Apple's ticket covers all ${files.length} executables, and Gatekeeper accepts a downloaded copy of each.`);
    return s.state === "ok" ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
