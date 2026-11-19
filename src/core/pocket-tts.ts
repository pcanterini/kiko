import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { appFile, INSTALLED, POCKET_LOG, POCKET_VENV } from "./app-root.ts";
import { appEnv } from "./env.ts";
import { log } from "./log.ts";
import { envVar, flavourNames, SLUG } from "./name.ts";
import { customVoice, customVoiceName, isCustomVoiceId, voiceGain, voiceSidecar, VOICES_DIR } from "./pocket-voices.ts";
import { gainStream } from "./voice-gain.ts";
import type { VoiceTimings } from "./voice-marks.ts";

// marks: told each sentence as its audio starts and ends (the phone's read-along, voice-marks.ts).
type Handlers = { onAudio: (pcm: Buffer) => void; onDone: () => void; marks?: VoiceTimings };

/** What the app's speaker plays: 24 kHz mono s16le. Pocket TTS (Mimi codec) outputs exactly this. */
const OUT_RATE = 24000;
// Its scripts (serve.py, setup.sh) ship with the app; its Python is POCKET_VENV (pocket/.venv in a
// checkout, ~/.local/share/kiko/pocket-venv for an installed copy, so an update keeps it). Beside
// the venv: pocket-uv/ (the uv setup.sh fetched when there was none, with its Python and cache) and
// pocket-hf/ (the model: pocketHfHome), so all of it is Kiko's and `kiko uninstall` takes it.
const POCKET_DIR = appFile("pocket");
const LOG_PATH = POCKET_LOG;
const PYTHON = join(POCKET_VENV, "bin", "python");

/**
 * How to install it: `sh <script>` with `env` added to the environment (setup.sh puts it in
 * POCKET_VENV). A few minutes and about 1 GB with the model; run in the background.
 */
export const pocketSetup = { script: join(POCKET_DIR, "setup.sh"), serve: join(POCKET_DIR, "serve.py"), env: { POCKET_VENV } };

/** Built-in English voices (precomputed embeddings, ~6 MB each, downloaded on first use). */
export const POCKET_VOICES = [
  { id: "alba", label: "Alba (female, casual)" },
  { id: "marius", label: "Marius (male)" },
  { id: "javert", label: "Javert (male)" },
  { id: "jean", label: "Jean (male)" },
  { id: "cosette", label: "Cosette (female)" },
  { id: "fantine", label: "Fantine (female)" },
  { id: "eponine", label: "Eponine (female)" },
  { id: "azelma", label: "Azelma (female)" },
  { id: "anna", label: "Anna (female)" },
  { id: "vera", label: "Vera (female)" },
  { id: "mary", label: "Mary (female)" },
  { id: "jane", label: "Jane (female)" },
  { id: "eve", label: "Eve (female)" },
  { id: "caro_davy", label: "Caro Davy (female)" },
  { id: "charles", label: "Charles (male)" },
  { id: "george", label: "George (male; the default)" },
  { id: "michael", label: "Michael (male)" },
  { id: "paul", label: "Paul (male)" },
  { id: "bill_boerst", label: "Bill Boerst (male)" },
  { id: "peter_yearsley", label: "Peter Yearsley (male)" },
  { id: "stuart_bell", label: "Stuart Bell (male)" },
] as const;
export const DEFAULT_POCKET_VOICE = "george";

/**
 * Whether pocket/setup.sh has installed it (and finished: it leaves .installing in the venv until
 * then): without it Pocket can't start, so a missing Cartesia key means the macOS voice (keys.ts
 * pickEngines). Not while first-run setup's download (pocket-prep.ts) is still fetching the model.
 */
export const pocketInstalled = (venv = POCKET_VENV) => existsSync(join(venv, "bin", "python")) && !existsSync(join(venv, ".installing")) && !pocketPreparing(venv);

/** Where first-run setup's download keeps its pid, status and log: beside the venv (pocket-prep.ts). */
export const prepFile = (venv: string, name: "preparing" | "status" | "log") => join(dirname(venv), `pocket-prep.${name === "log" ? "log" : name}`);

/**
 * Pocket's own Hugging Face folder (HF_HOME for its server: here and pocket-prep.ts), beside the
 * venv: its model (about 1 GB) goes there, not in the ~/.cache/huggingface other apps share.
 */
export const pocketHfHome = (venv = POCKET_VENV) => join(dirname(venv), "pocket-hf");

/** The uv setup.sh fetches when there's no uv or Python here, with the Python and cache any uv it runs keeps for Pocket: beside the venv. */
export const pocketUvHome = (venv = POCKET_VENV) => join(dirname(venv), "pocket-uv");

/** What its server's environment gets so all of Hugging Face's caches go in pocketHfHome, whatever HF_* you've set for other apps. */
export const pocketHfEnv = (venv = POCKET_VENV) => {
  const home = pocketHfHome(venv);
  return { HF_HOME: home, HF_HUB_CACHE: join(home, "hub"), HF_XET_CACHE: join(home, "xet") };
};

/**
 * The Hugging Face caches other apps share, where Pocket's model may be already (an older install of
 * Kiko's put it there, or another app did): where Hugging Face itself looks, by your settings, then
 * its default. HF_HUB_CACHE (or the older HUGGINGFACE_HUB_CACHE), HF_HOME/hub,
 * $XDG_CACHE_HOME/huggingface/hub, ~/.cache/huggingface/hub: each one set, once. Exact paths, never
 * a search. KIKO_POCKET_MODEL_FROM (folders, `:` between; empty: none) in place of these and the
 * other flavour's (pocketModelSources): the tests', so they never look at the real ones.
 */
export function sharedHfHubs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const from = envVar("POCKET_MODEL_FROM", env);
  if (from !== undefined) return from.split(":").filter(Boolean);
  const under = (dir: string | undefined, ...rest: string[]) => (dir ? join(dir, ...rest) : undefined);
  return uniquePaths([env.HF_HUB_CACHE, env.HUGGINGFACE_HUB_CACHE, under(env.HF_HOME, "hub"), under(env.XDG_CACHE_HOME, "huggingface", "hub"), join(home, ".cache", "huggingface", "hub")], home);
}

/**
 * The other flavour's own Pocket model folder (its pocketHfHome's hub), where it always is: for a
 * checkout (Kiko Dev), the release's in ~/.local/share/kiko; for the release, the checkout
 * ~/.local/bin/kiko-dev links to (`pnpm link:dev`). Undefined when there's no such link.
 */
export function otherFlavourHub(home = homedir(), installed = INSTALLED): string | undefined {
  if (!installed) return join(home, ".local", "share", SLUG, "pocket-hf", "hub");
  const command = flavourNames("dev").command;
  try {
    const link = join(home, ".local", "bin", command);
    const target = resolve(dirname(link), readlinkSync(link));
    if (basename(target) !== command || basename(dirname(target)) !== "bin") return undefined;
    return join(dirname(dirname(target)), "pocket", "pocket-hf", "hub");
  } catch {
    return undefined;
  }
}

/** Where Pocket's model may be already, in the order they're tried (adoptSharedModel): the shared caches (sharedHfHubs), then the other flavour's. */
export function pocketModelSources(env: NodeJS.ProcessEnv = process.env, home = homedir(), installed = INSTALLED): string[] {
  if (envVar("POCKET_MODEL_FROM", env) !== undefined) return sharedHfHubs(env, home);
  return uniquePaths([...sharedHfHubs(env, home), otherFlavourHub(home, installed)], home);
}

/** Each path once, absolute (~/ for the home), in order; unset and relative ones left out. */
function uniquePaths(paths: (string | undefined)[], home: string): string[] {
  const out = paths.filter((p): p is string => Boolean(p)).map((p) => (p === "~" || p.startsWith("~/") ? join(home, p.slice(1)) : p));
  return [...new Set(out.filter(isAbsolute).map((p) => resolve(p)))];
}

/** Pocket's model folders in a Hugging Face cache (`hub`): kyutai/pocket-tts and its without-voice-cloning twin. */
export function pocketModelDirs(hub: string): string[] {
  try {
    return readdirSync(hub).filter((name) => name.startsWith("models--kyutai--pocket-tts") && !name.endsWith(".copying"));
  } catch {
    return [];
  }
}

/**
 * Pocket's model, where another install has it already (pocketModelSources, in order): copied into
 * Pocket's own folder (pocketHfHome) before its server's first start, so it doesn't fetch 1 GB again.
 * Called by first-run setup's download (pocket-prep.ts startPocketPrep) before it starts, and by the
 * app's start of Pocket. Each model folder not in Pocket's own yet comes from the first source that
 * has it whole (every file its snapshots name, each checked), else from the first that has some of
 * it; the server fetches whatever's missing. Never fails: anything wrong, and it downloads as before.
 *
 * Nothing in a source is ever written, moved, deleted or locked: it's only read (cpSync, realpath,
 * lstat, readlink) and cloned. Pocket's copy is its own, whatever happens to the source after:
 *   - every file a clone (APFS: copy-on-write, no extra space; Bun's cpSync and copyFileSync clone,
 *     Node's copy; a volume without clones, or another volume, gets a real copy, never an error);
 *   - links kept as they are (verbatimSymlinks: Hugging Face's are relative, snapshots/<rev>/<file>
 *     -> ../../blobs/<hash>, so they point into the copy); a blob that's a link to Hugging Face's
 *     cache-wide store (hub/blobs/<xx>/<hash>, huggingface_hub 2.3 and later) replaced by a clone of
 *     the file it points to; a snapshot link that leads anywhere but the copy's own blobs/, dropped;
 *   - each blob checked against its name (an LFS file's SHA-256, a small file's git hash: about a
 *     quarter of a second per GB): one that doesn't match, and that source's whole copy is discarded;
 *     half-downloaded files (*.incomplete) and anything Hugging Face doesn't keep there, left out.
 * Copied under a temporary name of this process's own, then renamed, so a half copy is never used
 * (one left by a process that died is cleared next time). What it copied.
 */
export function adoptSharedModel(venv = POCKET_VENV, from: string | string[] = pocketModelSources()): string[] {
  const to = pocketHfEnv(venv).HF_HUB_CACHE;
  const own = realOr(to);
  const hubs = (typeof from === "string" ? [from] : from).filter((hub) => realOr(hub) !== own);
  const copied: string[] = [];
  for (const name of new Set(hubs.flatMap(pocketModelDirs))) {
    const dest = join(to, name);
    try {
      if (lexists(dest)) continue;
      clearLeftovers(to, name);
      mkdirSync(to, { recursive: true });
      if (adoptFolder(hubs, name, dest)) copied.push(name);
    } catch {
      // It downloads instead.
    }
  }
  return copied;
}

/** `name` into `dest`, from the first of `hubs` that has it whole, else the first that has some of it: whether it did. */
function adoptFolder(hubs: string[], name: string, dest: string): boolean {
  const temps = hubs.map((_, i) => `${dest}.${process.pid}.${i}.copying`);
  try {
    let some: string | undefined;
    for (const [i, hub] of hubs.entries()) {
      const got = cloneChecked(join(hub, name), realOr(hub), temps[i]);
      if (got === "whole") {
        renameSync(temps[i], dest);
        return true;
      }
      if (got === "some" && !some) some = temps[i];
      else rmSync(temps[i], { recursive: true, force: true });
    }
    if (!some) return false;
    renameSync(some, dest);
    return true;
  } finally {
    for (const temp of temps) rmSync(temp, { recursive: true, force: true });
  }
}

/** A Hugging Face blob's name: a small file's git hash (SHA-1) or an LFS file's SHA-256. */
const BLOB_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The model folder `src` (in the cache `store`, as its real path) cloned into `temp` and made Pocket's
 * own (adoptSharedModel): "whole" (every file its snapshots name is there), "some", or "none" (no
 * blob at all, a blob that doesn't match its name, or anything failed: `temp` is then thrown away).
 */
function cloneChecked(src: string, store: string, temp: string): "whole" | "some" | "none" {
  try {
    // A link to a folder elsewhere would be copied as the link: not Pocket's own.
    if (!lstatSync(src).isDirectory()) return "none";
    cpSync(src, temp, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    for (const entry of readdirSync(temp)) if (!["blobs", "snapshots", "refs"].includes(entry)) rmSync(join(temp, entry), { recursive: true, force: true });
    const blobs = join(temp, "blobs");
    let kept = 0;
    for (const blob of listDir(blobs)) {
      const path = join(blobs, blob);
      const stat = lstatSync(path);
      if (!BLOB_NAME.test(blob) || !(stat.isFile() || stat.isSymbolicLink())) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (stat.isSymbolicLink()) {
        // Hugging Face's cache-wide store: the file it leads to, cloned in the link's place.
        unlinkSync(path);
        let real: string;
        try {
          real = realpathSync(join(src, "blobs", blob));
        } catch {
          continue; // leads nowhere: missing, fetched by the server
        }
        if (!within(real, store) || !statSync(real).isFile()) continue;
        copyFileSync(real, path, constants.COPYFILE_FICLONE);
      }
      if (contentHash(path, blob) !== blob) return "none";
      kept++;
    }
    let named = 0;
    let missing = 0;
    walk(join(temp, "snapshots"), (path, stat) => {
      if (stat.isDirectory()) return;
      if (stat.isSymbolicLink() && dirname(resolve(dirname(path), readlinkSync(path))) === blobs) {
        named++;
        if (!existsSync(path)) missing++;
        return;
      }
      rmSync(path, { force: true });
    });
    walk(join(temp, "refs"), (path, stat) => {
      if (!stat.isDirectory() && !stat.isFile()) rmSync(path, { force: true });
    });
    if (!kept) return "none";
    return named && !missing ? "whole" : "some";
  } catch {
    return "none";
  }
}

/** A blob's hash, as its name has it: SHA-256 of its bytes (64 hex digits), or git's SHA-1 of them (40). */
function contentHash(path: string, name: string): string {
  const git = name.length === 40;
  const hash = createHash(git ? "sha1" : "sha256");
  const fd = openSync(path, "r");
  try {
    if (git) hash.update(`blob ${fstatSync(fd).size}\0`);
    const buf = Buffer.allocUnsafe(8 << 20);
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Half copies of `name` in `to` left by a process that's gone (or by an older Kiko's, named <name>.copying): deleted. A live process's own, left. */
function clearLeftovers(to: string, name: string) {
  for (const entry of listDir(to)) {
    if (!entry.startsWith(`${name}.`) || !entry.endsWith(".copying")) continue;
    const pid = Number(entry.slice(name.length + 1).split(".")[0]);
    if (pid && pid !== process.pid && alive(pid)) continue;
    rmSync(join(to, entry), { recursive: true, force: true });
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
};

const listDir = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Each entry under `dir`, its contents before it, never following a link. */
function walk(dir: string, visit: (path: string, stat: Stats) => void) {
  for (const name of listDir(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) walk(path, visit);
    visit(path, stat);
  }
}

const lexists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const realOr = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** First-run setup's download (pocket-prep.ts) is running: its process is alive. */
export function pocketPreparing(venv = POCKET_VENV): boolean {
  try {
    const pid = Number(readFileSync(prepFile(venv, "preparing"), "utf8").trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type Options = { port?: number; voice?: string; startupTimeoutMs?: number; voicesDir?: string };

/**
 * What a sentence is said with: a built-in voice (or a voice file's URL), sent by name; or one of
 * your voice files (pocket-voices.ts), uploaded, and played at its volume (its sidecar's gainDb).
 */
type SpokenVoice = { url: string } | { name: string; path: string; file: Buffer; key: string; gainDb: number };

/** The /tts request failed with this status (the server answered: not a dropped connection). */
class TtsStatusError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`/tts ${status}: ${detail}`);
    this.status = status;
  }
}

/** Your voice files the server couldn't load (by path, size and time: one replaced is tried again): the default voice speaks instead. */
const brokenVoices = new Set<string>();
/** Each problem with a voice of yours, told once (one line in the log), not at every sentence. */
const toldVoices = new Set<string>();
const tellOnce = (key: string, message: string) => {
  if (toldVoices.has(key)) return;
  toldVoices.add(key);
  console.error("[pocket-tts]", message);
};

/**
 * Kyutai Pocket TTS, run locally on the CPU. Same shape as Cartesia.
 *
 * connect() reuses a Pocket TTS server already listening on the port, otherwise
 * starts the official `pocket-tts serve` from pocket/.venv (see pocket/setup.sh)
 * and waits for it to load the model. Each reply is cut into sentences as text
 * streams in; sentences are synthesized one at a time, in order, each as a
 * streamed POST /tts. close() stops a server this instance started (it also
 * exits on its own when this process dies: it watches its stdin).
 */
export class PocketTts {
  private port: number;
  private voice: string;
  private startupTimeoutMs: number;
  private voicesDir: string;
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private replies = new Set<() => void>();

  constructor(opts: Options = {}) {
    this.port = opts.port ?? Number(appEnv("POCKET_TTS_PORT") ?? 8737);
    this.voice = opts.voice ?? appEnv("POCKET_VOICE") ?? DEFAULT_POCKET_VOICE;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? Number(appEnv("POCKET_TTS_STARTUP_TIMEOUT_MS") ?? 300_000);
    this.voicesDir = opts.voicesDir ?? VOICES_DIR;
  }

  /** The server's own voice (its --default-voice), and what speaks when a voice of yours can't: always a built-in one. */
  private get builtInVoice() {
    return isVoice(this.voice) ? this.voice : DEFAULT_POCKET_VOICE;
  }

  /**
   * What a reply is said with: `voiceId` when it's a voice (built in, a URL, or one of your files),
   * else this instance's. One of yours whose file is missing, unreadable or didn't load before: the
   * built-in voice, told once.
   */
  private pick(voiceId?: string): SpokenVoice {
    const id = voiceId && (isVoice(voiceId) || isCustomVoiceId(voiceId)) ? voiceId : this.voice;
    if (!isCustomVoiceId(id)) return { url: id };
    const fallback = { url: this.builtInVoice };
    const name = customVoiceName(id)!;
    const custom = customVoice(id, this.voicesDir);
    if (!custom) {
      tellOnce(`missing:${this.voicesDir}:${name}`, `voice "${name}": no ${name}.safetensors or ${name}.wav in ${this.voicesDir}; using ${fallback.url} instead`);
      return fallback;
    }
    let file: Buffer;
    let key: string;
    try {
      const stat = statSync(custom.path);
      key = `${custom.path}:${stat.size}:${stat.mtimeMs}`;
      file = readFileSync(custom.path);
    } catch (err: any) {
      tellOnce(`unreadable:${custom.path}`, `voice "${name}": can't read ${custom.path} (${err?.code ?? err?.message ?? err}); using ${fallback.url} instead`);
      return fallback;
    }
    if (brokenVoices.has(key)) return fallback;
    // Its volume: read each reply, so one changed in Settings is heard from the next.
    const gain = voiceGain(custom.name, this.voicesDir);
    if (gain.problem) tellOnce(`gain:${gain.problem}:${sidecarStamp(custom.name, this.voicesDir)}`, `voice "${name}": ${gain.problem}; playing it at 0 dB`);
    return { name: custom.name, path: custom.path, file, key, gainDb: gain.gainDb };
  }

  private get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  connect(): Promise<void> {
    this.ready ??= this.start().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  /** Start a spoken reply. Returns functions to push text, end it, or cancel it. */
  async open(handlers: Handlers, voiceId?: string) {
    await this.connect();
    let voice = this.pick(voiceId);
    const queue: string[] = [];
    let buffer = "";
    let chars = 0;
    let ended = false;
    let cancelled = false;
    let running = false;
    let abort: AbortController | null = null;

    const finish = () => {
      this.replies.delete(cancel);
      handlers.onDone();
    };
    const run = async () => {
      running = true;
      while (!cancelled) {
        const text = queue.shift();
        if (text === undefined) break;
        abort = new AbortController();
        const onPcm = (pcm: Buffer) => {
          if (!cancelled) handlers.onAudio(pcm);
        };
        try {
          try {
            mark(() => handlers.marks?.sentence(text));
            await this.synthesize(text, voice, abort.signal, onPcm);
          } catch (err) {
            // A voice file of yours the server can't load: this sentence and the rest in the built-in voice.
            if (cancelled || !("file" in voice) || !(err instanceof TtsStatusError)) throw err;
            brokenVoices.add(voice.key);
            tellOnce(`broken:${voice.key}`, `voice "${voice.name}": the server couldn't load ${voice.path} (${err.message.slice(0, 200)}); using ${this.builtInVoice} instead`);
            voice = { url: this.builtInVoice };
            mark(() => handlers.marks?.sentence(text));
            await this.synthesize(text, voice, abort.signal, onPcm);
          }
        } catch (err: any) {
          if (!cancelled) {
            // That sentence isn't said; the rest of the line goes on.
            console.error("[pocket-tts]", err?.message ?? err);
            log("pocket_sentence_failed", {
              message: String(err?.message ?? err).slice(0, 300),
              ...(err instanceof TtsStatusError ? { status: err.status } : {}),
              chars: text.length,
              customVoice: "file" in voice,
            });
          }
        }
        if (!cancelled) mark(() => handlers.marks?.sentenceDone());
        abort = null;
      }
      running = false;
      if (!cancelled && ended) finish();
    };
    const kick = () => {
      if (!running && queue.length) void run();
    };
    // The read-along's marks never get in the way of the voice.
    const mark = (f: () => void) => {
      try {
        f();
      } catch (err) {
        console.error("[pocket-tts] marks:", (err as Error).message);
      }
    };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      queue.length = 0;
      buffer = "";
      abort?.abort();
      this.replies.delete(cancel);
    };
    this.replies.add(cancel);

    return {
      push: (text: string) => {
        if (cancelled || ended || !text) return;
        chars += text.length;
        buffer += text;
        let cut;
        while ((cut = nextCut(buffer)) > 0) {
          addSegment(queue, buffer.slice(0, cut));
          buffer = buffer.slice(cut);
        }
        kick();
      },
      /** Characters received so far (local synthesis, nothing is billed). */
      chars: () => chars,
      end: () => {
        if (cancelled || ended) return;
        ended = true;
        addSegment(queue, buffer);
        buffer = "";
        if (running) return;
        if (queue.length) kick();
        else finish();
      },
      cancel,
    };
  }

  close() {
    for (const cancel of [...this.replies]) cancel();
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    if (proc && proc.exitCode === null) {
      proc.stdin?.end();
      proc.kill("SIGTERM");
    }
  }

  private async start() {
    if (await this.isPocketServer()) return;
    if (!pocketInstalled()) {
      throw new Error(`Pocket TTS is not installed. Run: POCKET_VENV=${POCKET_VENV} sh ${pocketSetup.script}`);
    }
    // Its model in its own folder (pocketHfHome); one another install has already, copied over first.
    adoptSharedModel();
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const log = openSync(LOG_PATH, "w");
    // A built-in voice: yours are sent with each sentence, so one that doesn't load never stops the server.
    const args = ["serve.py", "--host", "127.0.0.1", "--port", String(this.port), "--default-voice", this.builtInVoice];
    const proc = spawn(PYTHON, args, { cwd: POCKET_DIR, stdio: ["pipe", log, log], env: { ...process.env, ...pocketHfEnv() } });
    closeSync(log);
    this.proc = proc;
    proc.stdin!.on("error", () => {});
    let exited = false;
    proc.on("exit", () => {
      exited = true;
      // Died after starting: the next connect()/open() starts a new one.
      if (this.proc === proc) {
        this.proc = null;
        this.ready = null;
      }
    });

    const deadline = Date.now() + this.startupTimeoutMs;
    while (!(await this.isPocketServer())) {
      if (exited) throw new Error(`Pocket TTS server exited during startup: ${logTail()}`);
      if (Date.now() > deadline) {
        this.close();
        throw new Error(`Pocket TTS server not ready after ${this.startupTimeoutMs} ms: ${logTail()}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** True when a Pocket TTS server (ours or someone else's) is answering on the port. */
  private async isPocketServer() {
    try {
      const res = await fetch(`${this.base}/openapi.json`, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) return false;
      const spec: any = await res.json();
      return String(spec?.info?.title ?? "").includes("Pocket TTS");
    } catch {
      return false;
    }
  }

  /**
   * One POST /tts: streams a WAV back; forwards its PCM as it arrives. A voice file of yours goes up
   * with it (voice_wav, its name keeping the extension the server reads it by), and its audio comes
   * back at its volume (voice-gain.ts): for the speaker, a phone and the preview alike.
   */
  private async synthesize(text: string, voice: SpokenVoice, signal: AbortSignal, onPcm: (pcm: Buffer) => void) {
    const form = new FormData();
    form.set("text", text);
    if ("file" in voice) form.set("voice_wav", new Blob([new Uint8Array(voice.file)]), basename(voice.path));
    else form.set("voice_url", voice.url);
    const res = await fetch(`${this.base}/tts`, { method: "POST", body: form, signal });
    if (!res.ok || !res.body) throw new TtsStatusError(res.status, await res.text().catch(() => ""));

    let head: Buffer | null = Buffer.alloc(0);
    let resample: ((pcm: Buffer) => Buffer) | null = null;
    let odd: Buffer | null = null;
    const gain = "file" in voice && voice.gainDb ? gainStream(voice.gainDb) : null;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      let data: Buffer = Buffer.from(chunk);
      if (head) {
        head = Buffer.concat([head, data]);
        const parsed = parseWavHeader(head);
        if (!parsed) continue;
        resample = parsed.rate === OUT_RATE ? null : linearResampler(parsed.rate, OUT_RATE);
        data = head.subarray(parsed.dataStart);
        head = null;
      }
      if (odd) {
        data = Buffer.concat([odd, data]);
        odd = null;
      }
      if (data.length % 2) {
        odd = Buffer.from(data.subarray(data.length - 1));
        data = data.subarray(0, data.length - 1);
      }
      if (!data.length) continue;
      const pcm = resample ? resample(data) : Buffer.from(data);
      onPcm(gain ? gain(pcm) : pcm);
    }
  }
}

/** A sidecar's size and time (or "none"): a problem with it is told again once it's changed. */
function sidecarStamp(name: string, dir: string) {
  try {
    const stat = statSync(voiceSidecar(name, dir));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "none";
  }
}

function isVoice(id: string) {
  // Built-in names, or a voice file URL the server can clone (http(s):// or hf://).
  return POCKET_VOICES.some((v) => v.id === id) || /^(https?|hf):\/\//.test(id);
}

/**
 * Where to cut the streamed text, or 0 to wait for more. Cuts after a sentence
 * (once the next character shows it really ended), after a clause once the
 * piece is long, or at a space if it runs on without punctuation.
 */
export function nextCut(buf: string): number {
  const sentence = /[.!?…]+["')\]]*(?=\s)|\n/g;
  let m;
  while ((m = sentence.exec(buf))) {
    const end = m.index + m[0].length;
    if (buf.slice(0, end).trim().length >= 12) return end;
  }
  if (buf.length >= 90) {
    const clause = buf.slice(40).search(/[,;:—–](?=\s)/);
    if (clause >= 0) return 40 + clause + 1;
  }
  if (buf.length >= 220) {
    const space = buf.lastIndexOf(" ");
    if (space > 40) return space;
  }
  return 0;
}

export function addSegment(queue: string[], raw: string) {
  const text = raw
    .replace(/[*`]+/g, "")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/[\p{L}\p{N}]/u.test(text)) queue.push(text);
}

function parseWavHeader(buf: Buffer): { rate: number; dataStart: number } | null {
  if (buf.length < 12) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("unexpected /tts response (not a WAV stream)");
  }
  let rate = OUT_RATE;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") return { rate, dataStart: offset + 8 };
    if (offset + 8 + size > buf.length) return null;
    if (id === "fmt ") rate = buf.readUInt32LE(offset + 12);
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** Streaming linear-interpolation resampler for s16le mono (only used if the model isn't 24 kHz). */
function linearResampler(from: number, to: number) {
  const step = from / to;
  let pos = 0; // position of the next output sample, relative to `prev`
  let prev = 0;
  return (pcm: Buffer) => {
    const n = pcm.length / 2;
    const at = (i: number) => (i < 0 ? prev : pcm.readInt16LE(i * 2));
    const out: number[] = [];
    while (pos < n) {
      const i = Math.floor(pos);
      const frac = pos - i;
      out.push(Math.round(at(i - 1) * (1 - frac) + at(i) * frac));
      pos += step;
    }
    pos -= n;
    if (n) prev = pcm.readInt16LE((n - 1) * 2);
    const buf = Buffer.alloc(out.length * 2);
    out.forEach((s, k) => buf.writeInt16LE(s, k * 2));
    return buf;
  };
}

function logTail() {
  try {
    return readFileSync(LOG_PATH, "utf8").trim().split("\n").slice(-5).join(" | ");
  } catch {
    return "(no log)";
  }
}
