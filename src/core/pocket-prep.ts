// Pocket, the free voice, set up in the background: started by install.sh as soon as Kiko's files
// are in place (`kiko _run pocket`: ../pocket-start.ts), and by first-run setup as it opens
// (../onboard.ts; nothing more when it's running already): pocket/setup.sh (pocket-tts.ts
// pocketSetup: into POCKET_VENV), then one start of its server so the model is downloaded (about
// 1 GB in all) and the app's first Pocket start is quick. Detached: it goes on after setup ends.
// Setup's voice step waits for it, showing how far along it is (prepWatcher); Esc there, and the app
// runs with the macOS voice until it's ready, then switches by itself (app/pocket-switch.ts).
//
// It needs nothing installed first: setup.sh uses a uv on the PATH or a Python 3.10+ when there is
// one, else fetches a uv of its own (pinned, its checksum checked) into pocket-uv/ beside the venv,
// which fetches its own Python. A failed download or a wrong checksum fails it, and the log says why.
// The model goes in pocket-hf/ beside the venv (pocket-tts.ts pocketHfEnv), not the shared
// ~/.cache/huggingface, so `kiko uninstall` takes it too. One another install has already (the shared
// cache, the other flavour's: pocket-tts.ts adoptSharedModel) is cloned in first, before anything
// downloads; the server's start then fetches only what's missing.
//
// It keeps beside the venv (pocket-tts.ts prepFile): pocket-prep.preparing (its pid, while it runs:
// pocketInstalled waits for it), pocket-prep.status (running while setup.sh installs, voice while
// the model downloads, then ready or failed) and pocket-prep.log.
//
// KIKO_POCKET_SETUP: a script run in place of pocket/setup.sh (the install test's stand-in: no
// real 1 GB download in a test).
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { envVar, NAME } from "./name.ts";
import { POCKET_VENV } from "./app-root.ts";
import { adoptSharedModel, pocketHfEnv, pocketHfHome, pocketInstalled, pocketModelSources, pocketPreparing, pocketSetup, pocketUvHome, prepFile } from "./pocket-tts.ts";

export type PrepState = "ready" | "running" | "failed" | "none";

/** The warm-up's own port, out of the app's way (pocket-tts.ts: 8737). */
const PREP_PORT = 8738;

// $1: setup.sh; $2: serve.py; $3: the venv; $4: the port; $5, $6: its pid and status files. The model
// is fetched by the server's first start: up to 30 minutes for it to answer, on a slow line.
const SCRIPT = `
setup="$1"; serve="$2"; venv="$3"; port="$4"; pidfile="$5"; status="$6"
echo $$ > "$pidfile"
trap 'rm -f "$pidfile"' EXIT
echo running > "$status"
POCKET_VENV="$venv" sh "$setup" || { echo failed > "$status"; exit 1; }
echo voice > "$status"
cd "$(dirname "$serve")" || exit 1
POCKET_TTS_WATCH_STDIN=0 "$venv/bin/python" "$serve" --host 127.0.0.1 --port "$port" </dev/null & server=$!
n=0
until curl -sf -o /dev/null "http://127.0.0.1:$port/openapi.json"; do
  kill -0 $server 2>/dev/null || { echo failed > "$status"; exit 1; }
  n=$((n + 1))
  [ $n -gt 900 ] && { kill $server; echo failed > "$status"; exit 1; }
  sleep 2
done
kill $server
wait $server 2>/dev/null
echo ready > "$status"
`;

/**
 * Where it stands: running (its process alive), ready (it finished, or Pocket was installed some
 * other way), failed (it stopped short, or its process went), none (never started, not installed).
 */
export function pocketPrepState(venv = POCKET_VENV): PrepState {
  if (pocketPreparing(venv)) return "running";
  const status = readStatus(venv);
  if (status === "ready" || (!status && pocketInstalled(venv))) return "ready";
  if (status === "running" || status === "voice" || status === "failed") return "failed";
  return "none";
}

const readStatus = (venv: string) => {
  try {
    return readFileSync(prepFile(venv, "status"), "utf8").trim();
  } catch {
    return ""; // never run here
  }
};

/** What it's doing while it runs: installing Pocket (setup.sh), or downloading its voice model (the server's first start). */
type PrepPhase = "install" | "voice";

export const prepPhase = (venv = POCKET_VENV): PrepPhase => (readStatus(venv) === "voice" ? "voice" : "install");

/**
 * Starts it, detached, unless it's running or Pocket is installed already: what it did. "no-setup":
 * there's no setup.sh to run. `setup`: the scripts (pocket-tts.ts pocketSetup; KIKO_POCKET_SETUP
 * in place of setup.sh). `from`: where the model may be already (pocket-tts.ts pocketModelSources).
 */
export function startPocketPrep(venv = POCKET_VENV, setup: { script: string; serve: string } = prepScripts(), port = PREP_PORT, from?: string[]): "started" | "running" | "ready" | "no-setup" {
  const state = pocketPrepState(venv);
  if (state === "running") return "running";
  if (state === "ready" && pocketInstalled(venv)) return "ready";
  if (!existsSync(setup.script)) return "no-setup";
  mkdirSync(dirname(venv), { recursive: true });
  // The model, where another install has it already, cloned into Pocket's own folder before
  // anything downloads (APFS: a fraction of a second; it never fails the start, nor writes there).
  try {
    adoptSharedModel(venv, from ?? pocketModelSources());
  } catch {
    // It downloads, as before.
  }
  const log = openSync(prepFile(venv, "log"), "w");
  const args = [setup.script, setup.serve, venv, String(port), prepFile(venv, "preparing"), prepFile(venv, "status")];
  // The model into Pocket's own Hugging Face folder, as the app's own start of it does.
  const env = { ...process.env, ...pocketHfEnv(venv) };
  const child = spawn("sh", ["-c", SCRIPT, "sh", ...args], { detached: true, stdio: ["ignore", log, log], env });
  closeSync(log);
  child.unref();
  // Its pid and state written here too (the script writes the same as it starts), so a start right
  // after this one (install.sh's, then setup's) finds it running.
  if (child.pid) {
    writeFileSync(prepFile(venv, "preparing"), `${child.pid}\n`);
    writeFileSync(prepFile(venv, "status"), "running\n");
  }
  return "started";
}

/** setup.sh (KIKO_POCKET_SETUP in its place: a test's stand-in) and serve.py. */
const prepScripts = () => ({ script: envVar("POCKET_SETUP") || pocketSetup.script, serve: pocketSetup.serve });

/** The last line of its log that says something: why it failed, for Kiko's own log. */
export function prepWhy(venv = POCKET_VENV): string {
  try {
    const lines = readFileSync(prepFile(venv, "log"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return (lines.at(-1) ?? "").slice(0, 300);
  } catch {
    return "";
  }
}

// ── How far along ────────────────────────────────────────────────────────
//
// Measured on disk as it lands: the install first (pocket-tts with torch: a venv of about 800 MB;
// with uv, its download cache in pocket-uv/ fills first and the venv is cloned from it, so the
// larger of the two), then the model in pocket-hf/ (about 225 MB). Approximate (pip's own download
// isn't seen until it installs), so the share shown never goes back, and stays under 100% until it's
// ready.

/** About how much lands, in bytes: the install (the venv, or uv's cache with its Python) and the model. */
export const PREP_BYTES = { install: 850e6, model: 230e6 };

/** What's on disk now: the install's bytes, the model's, and the phase. */
type PrepBytes = { install: number; model: number; phase: PrepPhase };

/** How far along, 0 to 1 (1 only with the install and the model all there). */
export function prepFraction(b: PrepBytes): number {
  const install = b.phase === "voice" ? PREP_BYTES.install : Math.min(Math.max(b.install, 0), PREP_BYTES.install);
  const model = Math.min(Math.max(b.model, 0), PREP_BYTES.model);
  return (install + model) / (PREP_BYTES.install + PREP_BYTES.model);
}

/** The share shown, looked at again and again: never back, under 1 while it runs, 1 once it's ready. */
export class PrepProgress {
  private shown = 0;
  next(state: PrepState, bytes: PrepBytes | null): number {
    if (state === "ready") return (this.shown = 1);
    if (state === "running" && bytes) this.shown = Math.max(this.shown, Math.min(0.99, prepFraction(bytes)));
    return this.shown;
  }
}

/** The kilobytes `du` counts in each of `paths` (0 for one that isn't there). */
function du(paths: string[]): Promise<number[]> {
  const there = paths.filter((p) => existsSync(p));
  if (!there.length) return Promise.resolve(paths.map(() => 0));
  return new Promise((resolve) => {
    execFile("du", ["-sk", ...there], { encoding: "utf8" }, (_err, stdout) => {
      // A file gone while it counted: an error, and the rest still counted.
      const kb = new Map<string, number>();
      for (const line of String(stdout ?? "").split("\n")) {
        const m = /^(\d+)\t(.+)$/.exec(line);
        if (m) kb.set(m[2], Number(m[1]));
      }
      resolve(paths.map((p) => kb.get(p) ?? 0));
    });
  });
}

/** What it has put on disk so far. */
export async function prepBytes(venv = POCKET_VENV): Promise<PrepBytes> {
  const [env, uv, hf] = await du([venv, pocketUvHome(venv), pocketHfHome(venv)]);
  return { install: Math.max(env, uv) * 1024, model: hf * 1024, phase: prepPhase(venv) };
}

/** Where it stands: its state, the share done (0 to 1, never back), what it's doing, and why it failed. */
export type PrepNow = { state: PrepState; fraction: number; phase: PrepPhase; why?: string };

/** A look at it each time it's called (one for each screen that shows it: the share never goes back). */
export function prepWatcher(venv = POCKET_VENV): () => Promise<PrepNow> {
  const progress = new PrepProgress();
  return async () => {
    const state = pocketPrepState(venv);
    const bytes = state === "running" ? await prepBytes(venv) : null;
    return { state, fraction: progress.next(state, bytes), phase: bytes?.phase ?? "install", ...(state === "failed" ? { why: prepWhy(venv) } : {}) };
  };
}

/**
 * The line said once at the app's start about the download setup started (`flag`: the settings'
 * pocketSetup): it's ready and speaking, or it failed and the macOS voice goes on. Null when
 * there's nothing to say yet (still running: the app switches when it's ready) or it was said.
 */
export function pocketNote(flag: unknown, tts: string, state: PrepState, venv = POCKET_VENV): string | null {
  if (flag !== "started") return null;
  if (tts === "pocket") return `Pocket, the free voice, finished downloading: ${NAME} speaks with it now. Settings → Voice changes it.`;
  if (state === "failed") return `Pocket, the free voice, couldn't be set up (what happened: ${prepFile(venv, "log")}). The macOS voice speaks meanwhile.`;
  return null;
}

/**
 * The line said at the app's start when Pocket is the voice but isn't installed in this copy (a new
 * clone or install: the settings are shared, the venv is the copy's own), and its download was just
 * started (`before`: where it stood; "failed": it was tried before here, and `why` is the last line
 * its log had). The macOS voice speaks until it's ready, then the app switches (app/pocket-switch.ts).
 */
export function pocketMissingLine(before: PrepState, why = ""): string {
  const again = before === "failed" ? ` It didn't finish last time${why ? ` (${why})` : ""}, so it's trying again.` : "";
  return `Setting up Pocket, the free voice, for this copy of ${NAME}: the macOS voice speaks until it's ready.${again} Settings → Voice changes it.`;
}
