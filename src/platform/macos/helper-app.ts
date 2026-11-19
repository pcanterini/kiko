// The helper app (ARCHITECTURE.md, "The helper app"): the helpers that need a macOS permission
// (BROKERED: the mic, the talk key, Apple's speech-to-text and the permissions check) run as
// children of "<NAME>.app" ("<NAME> Dev.app" in a checkout), started through Launch Services, so
// macOS asks for and keeps the microphone and Input Monitoring for that app, by its name, instead
// of for whichever terminal `kiko` runs in. native/macos/app/host.swift is the app: a spawn broker
// on a Unix socket. Here is `kiko`'s side:
//   - spawnHelper(name, args, stdio): a ChildProcess-like HelperProcess, at once (its streams are
//     there to listen to); behind it the app's child (one socket per stdio stream, which the app
//     makes the child's own stdin/stdout/stderr: nothing copied in between) or, when the app can't
//     be used, the helper spawned directly as before (BrokerUse says which, logged once a process
//     as `helper_app`). A spawn the app refuses falls back to a direct one too.
//   - runHelper: one run, its output collected (`permissions status`, `mic --list`).
//   - relaunchHelperApp: after Input Monitoring is turned on, so the talk key's tap is let in
//     (macOS reads it when an app starts): nobody has to click "Quit & Reopen".
//   - the app gone mid-run (macOS's own "Quit & Reopen" kills it when a permission is turned on):
//     the helpers' callers start theirs again (startAgain), which starts the app again (or finds
//     the one macOS reopened), logged as helper_app_restarted; only one that doesn't come back is said.
//   - helperAppHolder: the app's name while the permissions are its own (the setup's words).
// The app is found (and in a checkout built, then rebuilt only when its sources change: buildApp)
// at helperAppSpec's path, started with `open -g -j` unless it answers on its socket already, and
// asked its build (Info.plist BrokerBuild) in its hello: one that isn't the bundle's on disk (an
// update, a rebuild) is quit and started again, unless another `kiko` is using it (direct then).
// KIKO_HELPER_APP=off: always direct (the tests: tests/setup.ts). Anything that isn't macOS: direct.
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { constants, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { APP_ROOT, INSTALLED, installedHelper } from "../../core/app-root.ts";
import { log } from "../../core/log.ts";
import { envVar, FLAVOUR, OWN } from "../../core/name.ts";
import { BROKERED, buildNative, NATIVE_BUILD, signer } from "./native.ts";

export { BROKERED };

/** Where the app is and how it's reached. */
type HelperAppSpec = { name: string; id: string; path: string; socket: string };

/** The app's socket: in its own folder in ~/Library/Caches (the home from the user database, as the app finds it, not $HOME). */
export const brokerSocket = (id: string, home = userInfo().homedir) => join(home, "Library", "Caches", id, "broker.sock");

/** This flavour's app: beside the executable in an installed copy, in native/macos/.build/ in a checkout. */
function helperAppSpec(): HelperAppSpec {
  const dir = INSTALLED ? APP_ROOT : NATIVE_BUILD;
  return { name: OWN.helperApp, id: OWN.helperAppId, path: join(dir, `${OWN.helperApp}.app`), socket: brokerSocket(OWN.helperAppId) };
}

/**
 * Whether the app is to be used: on macOS, unless KIKO_HELPER_APP=off; never under the test runner
 * (NODE_TEST_CONTEXT, which a test's own `kiko` inherits) unless KIKO_HELPER_APP=on: a test must
 * never start the real app (its grants are the user's).
 */
export function helperAppWanted(env = envVar("HELPER_APP"), platform = process.platform, underTest = !!process.env.NODE_TEST_CONTEXT): boolean {
  const said = (env ?? "").trim().toLowerCase();
  return platform === "darwin" && said !== "off" && (said === "on" || !underTest);
}

/** A bundle's build, as `kiko` compares it (Info.plist BrokerBuild); null when it can't be read. */
export function bundleBuild(path: string): string | null {
  try {
    const plist = readFileSync(join(path, "Contents", "Info.plist"), "utf8");
    return /<key>BrokerBuild<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

// ── A checkout's build ──────────────────────────────────────────────────────

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
/** What a checkout's app is built from: a change to any of these (or the identity) rebuilds it. */
const SOURCES = [
  "native/macos/app/host.swift",
  "native/macos/app/icon.swift",
  "native/macos/mic.swift",
  "native/macos/hotkey.swift",
  "native/macos/speech.swift",
  "native/macos/permissions.swift",
  "scripts/build-helper-app.sh",
  "scripts/signing/audio-input.entitlements",
  "scripts/signing/helper-app.entitlements",
];

/** The checkout's build of `spec`: a hash of its sources, names and signing identity. */
function sourceBuild(spec: HelperAppSpec, identity: string, root = REPO): string {
  const h = createHash("sha256");
  for (const file of SOURCES)
    h.update(`${file}\0`)
      .update(readFileSync(join(root, file)))
      .update("\0");
  h.update(`${spec.name}\0${spec.id}\0${OWN.command}\0${identity}`);
  return `dev-${h.digest("hex").slice(0, 16)}`;
}

/**
 * A checkout's app, built (scripts/build-helper-app.sh, signed with your developer identity when
 * there is one: ad hoc, macOS would tie its permissions to the binary's hash and ask again after
 * every rebuild) unless the one there was built from these sources. Null when it's ready, else why not.
 */
async function buildApp(spec: HelperAppSpec, say: (line: string) => void = (l) => console.log(l)): Promise<string | null> {
  if (INSTALLED) return existsSync(spec.path) ? null : `${spec.path} is missing`;
  const identity = signer();
  let build: string;
  try {
    build = sourceBuild(spec, identity);
  } catch (err) {
    return `its sources: ${(err as Error).message}`;
  }
  if (bundleBuild(spec.path) === build) return null;
  say(`Building ${spec.name}.app (the helper app that holds the microphone and talk key permissions)…`);
  const version = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }).version;
  const out = join(spec.path, "..");
  const started = Date.now();
  const built = await new Promise<{ code: number | null; output: string }>((resolve) => {
    const p = spawn(
      "sh",
      [
        join(REPO, "scripts/build-helper-app.sh"),
        "--out",
        out,
        "--flavour",
        FLAVOUR,
        "--name",
        spec.name,
        "--id",
        spec.id,
        "--command",
        OWN.command,
        "--app-socket",
        OWN.socket,
        "--identity",
        identity,
        "--version",
        version,
        "--build",
        build,
      ],
      {
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    p.stdout.on("data", (d) => (output += d));
    p.stderr.on("data", (d) => (output += d));
    p.on("error", (err) => resolve({ code: 1, output: err.message }));
    p.on("close", (code) => resolve({ code, output }));
  });
  log("helper_app_built", { ok: built.code === 0, ms: Date.now() - started, signed: identity === "-" ? "ad hoc" : "identity" });
  if (built.code !== 0) return `its build failed: ${built.output.trim().split("\n").slice(-3).join(" ")}`;
  return null;
}

// ── The app's control channel ───────────────────────────────────────────────

/** What the app says in its hello (`told`: how many times it said it works from the terminal, opened by hand; `quiet`: brought to the front with a `kiko` about, said nothing). */
export type Hello = { pid: number; bundleId: string; bundlePath: string; build: string; version: string; responsible: { pid: number; self: boolean }; clients: number; told?: number; quiet?: number };

type Message = Record<string, any> & { op: string };

/** One control connection to the app: one JSON object per line each way. */
export class BrokerConn extends EventEmitter {
  private buf = "";
  private live = new Map<string, (m: Message) => void>();
  closed = false;
  hello: Hello | null = null;

  readonly socket: Socket;
  readonly path: string;

  constructor(socket: Socket, path: string) {
    super();
    this.socket = socket;
    this.path = path;
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      this.buf += d;
      for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        let m: Message;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof m.token === "string" && this.live.has(m.token)) this.live.get(m.token)!(m);
        // The app's own log lines (the overlay's): never an answer to anything.
        else if (m.op === "log") this.emit("log", m);
        else this.emit("message", m);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.closed = true;
      for (const [token, on] of [...this.live]) {
        this.live.delete(token);
        on({ op: "gone", token });
      }
      this.emit("close");
    });
    this.unref();
  }

  send(m: Message) {
    if (!this.closed) this.socket.write(`${JSON.stringify(m)}\n`);
  }

  /** The next message that isn't a child's. */
  next(timeoutMs: number): Promise<Message | null> {
    return new Promise((resolve) => {
      const done = (m: Message | null) => {
        clearTimeout(timer);
        this.off("message", done);
        this.off("close", gone);
        resolve(m);
      };
      const gone = () => done(null);
      const timer = setTimeout(() => done(null), timeoutMs);
      this.on("message", done);
      this.once("close", gone);
    });
  }

  async sayHello(build: string | null, timeoutMs = 5000): Promise<Hello | null> {
    this.send({ op: "hello", build });
    const m = await this.next(timeoutMs);
    this.hello = m?.op === "hello" ? (m as unknown as Hello) : null;
    return this.hello;
  }

  /** A child's messages, until it's gone. */
  track(token: string, on: (m: Message) => void) {
    this.live.set(token, (m) => {
      if (m.op === "exit" || m.op === "gone" || m.op === "error") this.live.delete(token);
      on(m);
      this.refIfBusy();
    });
    this.refIfBusy();
  }

  /** No more messages for `token` (one given up on: an AppleScript past its time). */
  untrack(token: string) {
    this.live.delete(token);
    this.refIfBusy();
  }

  /** Keeps `kiko` running only while a child does (a direct child's pipes do the same). */
  private refIfBusy() {
    if (this.live.size) this.socket.ref();
    else this.unref();
  }

  private unref() {
    this.socket.unref();
  }

  close() {
    this.socket.destroy();
  }
}

/** A connection to `path`, or null when nothing answers there. */
export function connectTo(path: string, timeoutMs = 3000): Promise<Socket | null> {
  return new Promise((resolve) => {
    const s = connect(path);
    const timer = setTimeout(() => {
      s.destroy();
      resolve(null);
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", () => {
      clearTimeout(timer);
      s.destroy();
      resolve(null);
    });
  });
}

const samePath = (a: string, b: string) => {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(a) === real(b);
};

// ── Finding (or starting) the app ───────────────────────────────────────────

/** Which way this process's helpers run: through the app, or `kiko`'s own children (why). */
export type BrokerUse = { conn: BrokerConn } | { why: string };

/** What a Broker needs from the world: the tests' fakes replace them. */
export type BrokerDeps = {
  wanted(): boolean;
  spec(): HelperAppSpec;
  /** Built (a checkout), or there (an installed copy): null, else why not. */
  prepare(spec: HelperAppSpec): Promise<string | null>;
  /** Started through Launch Services (`open -g -j`): resolves once `open` returns, throws when it fails. */
  launch(path: string): Promise<void>;
  log(event: string, fields: Record<string, unknown>): void;
  /** How long to wait for a started app's socket. */
  startMs?: number;
  /** A helper's executable when it runs directly (directPath; the tests' own scripts). */
  directPath?(name: string): string;
};

export class Broker {
  private pending: Promise<BrokerUse> | null = null;
  private conn: BrokerConn | null = null;
  /** The last way decided, for what's said (helperAppHolder). */
  last: BrokerUse | null = null;
  /** The app went away unasked (killed: macOS's "Quit & Reopen"), when and which: helper_app_restarted once it's back. */
  private lost: { at: number; pid: number | null } | null = null;
  /** Its going away is ours (relaunch, quit): not a loss. */
  private leaving = false;

  readonly d: BrokerDeps;

  constructor(d: BrokerDeps) {
    this.d = d;
  }

  /**
   * The app's connection, ready; or why the helpers run directly. Decided once a process (again
   * after the app goes away): direct stays direct, so a Mac with no GUI session isn't asked again at each spawn.
   */
  use(): Promise<BrokerUse> {
    if (this.conn && !this.conn.closed) return Promise.resolve({ conn: this.conn });
    if (this.last && "why" in this.last) return Promise.resolve(this.last);
    if (!this.pending)
      this.pending = this.establish().then((use) => {
        this.pending = null;
        this.last = use;
        if (this.lost) {
          const ok = "conn" in use;
          this.d.log("helper_app_restarted", {
            why: "gone",
            ms: Date.now() - this.lost.at,
            ok,
            wasPid: this.lost.pid,
            ...(ok ? { pid: use.conn.hello?.pid ?? null } : { direct: use.why }),
          });
          this.lost = null;
        }
        if ("conn" in use) {
          this.conn = use.conn;
          use.conn.once("close", () => {
            if (this.conn !== use.conn) return;
            this.conn = null;
            if (!this.leaving) this.lost = { at: Date.now(), pid: use.conn.hello?.pid ?? null };
          });
        }
        return use;
      });
    return this.pending;
  }

  private async establish(): Promise<BrokerUse> {
    const started = Date.now();
    const direct = (why: string): BrokerUse => {
      this.d.log("helper_app", { path: "direct", why, ms: Date.now() - started });
      return { why };
    };
    if (!this.d.wanted()) return direct("off");
    const spec = this.d.spec();
    const notReady = await this.d.prepare(spec);
    if (notReady) return direct(notReady);
    if (!existsSync(spec.path)) return direct(`${spec.name}.app isn't there`);
    const build = bundleBuild(spec.path);
    const running = await this.open(spec.socket);
    if (running) {
      const hello = await running.sayHello(build);
      if (hello && hello.build === build && samePath(hello.bundlePath, spec.path)) return this.ready(running, hello, started, false);
      if (hello && hello.clients > 1) {
        running.close();
        return direct(`another ${OWN.command} uses ${spec.name} build ${hello.build}, not ${build}`);
      }
      // Another build (an update, a rebuild): quit, and this one started instead.
      running.send({ op: "quit" });
      await running.next(3000);
      running.close();
      for (const until = Date.now() + 5000; Date.now() < until && (await connectTo(spec.socket, 500).then((s) => (s?.destroy(), !!s))); ) await sleep(100);
    }
    try {
      await this.d.launch(spec.path);
    } catch (err) {
      return direct(`Launch Services couldn't start it (${(err as Error).message})`);
    }
    const waitMs = this.d.startMs ?? 15_000;
    let conn: BrokerConn | null = null;
    for (const until = Date.now() + waitMs; !conn; await sleep(150)) {
      conn = await this.open(spec.socket);
      if (!conn && Date.now() > until) return direct(`it didn't answer within ${Math.round(waitMs / 1000)} s of starting`);
    }
    const hello = await conn.sayHello(build);
    if (!hello) return direct("it didn't say hello");
    if (hello.build !== build) {
      conn.close();
      return direct(`it's build ${hello.build}, not ${build}`);
    }
    return this.ready(conn, hello, started, true);
  }

  private async open(socket: string): Promise<BrokerConn | null> {
    const s = await connectTo(socket);
    return s ? new BrokerConn(s, socket) : null;
  }

  private ready(conn: BrokerConn, hello: Hello, started: number, launched: boolean): BrokerUse {
    conn.on("log", (m: Message) => {
      const { op: _op, event, ...fields } = m;
      this.d.log(String(event), fields);
    });
    this.d.log("helper_app", {
      path: "app",
      build: hello.build,
      pid: hello.pid,
      launched,
      ownResponsible: hello.responsible?.self === true,
      told: hello.told ?? 0,
      quiet: hello.quiet ?? 0,
      ms: Date.now() - started,
    });
    // Who uses it, beside its socket: the app brought to the front (macOS's "Reopen") says nothing while this pid is alive.
    try {
      writeFileSync(join(dirname(conn.path), "client.pid"), `${process.pid}\n`, { mode: 0o600 });
    } catch {
      // its folder gone meanwhile: it only keeps the app quiet
    }
    return { conn };
  }

  /** The app relaunched (a permission turned on since it started takes effect); false when the helpers don't run in it. */
  async relaunch(): Promise<boolean> {
    const use = await this.use();
    if (!("conn" in use)) return false;
    const spec = this.d.spec();
    this.leaving = true;
    use.conn.send({ op: "relaunch" });
    await new Promise<void>((resolve) => (use.conn.closed ? resolve() : use.conn.once("close", () => resolve())));
    this.conn = null;
    this.leaving = false;
    // The new instance starts itself (`open -n`): waited for, so it isn't started twice.
    for (const until = Date.now() + 10_000; Date.now() < until; await sleep(150)) {
      const s = await connectTo(spec.socket, 500);
      if (s) {
        s.destroy();
        break;
      }
    }
    this.d.log("helper_app_relaunched", {});
    return "conn" in (await this.use());
  }

  /** Quits the app if it's running (uninstall). */
  async quit(): Promise<boolean> {
    const s = await connectTo(this.d.spec().socket, 1000);
    if (!s) return false;
    this.leaving = true;
    const conn = new BrokerConn(s, this.d.spec().socket);
    conn.send({ op: "quit" });
    await conn.next(3000);
    conn.close();
    return true;
  }
}

// ── A helper's process ──────────────────────────────────────────────────────

export type Stdio = { stdin?: "pipe" | "ignore"; stdout?: "pipe" | "ignore"; stderr?: "pipe" | "inherit" | "ignore" };

/** What callers use of a ChildProcess: the streams asked for, exit and close (code, signal), kill. */
export interface HelperProcess extends EventEmitter {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  /** "app" or "direct", once it's started. */
  via: "app" | "direct" | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

const SIGNAL_NAMES = new Map(Object.entries(constants.signals).map(([name, n]) => [n as number, name as NodeJS.Signals]));
const signalNumber = (s: NodeJS.Signals | number | undefined) => (typeof s === "number" ? s : ((constants.signals as Record<string, number>)[s ?? "SIGTERM"] ?? 15));

class Helper extends EventEmitter implements HelperProcess {
  readonly stdin: PassThrough | null;
  readonly stdout: PassThrough | null;
  readonly stderr: PassThrough | null;
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  via: "app" | "direct" | null = null;
  private killWith: number | null = null;
  private onKill: ((signal: number) => void) | null = null;
  private ended = false;

  readonly name: string;
  readonly stdio: Required<Stdio>;

  constructor(name: string, stdio: Required<Stdio>) {
    super();
    this.name = name;
    this.stdio = stdio;
    this.stdin = stdio.stdin === "pipe" ? new PassThrough() : null;
    this.stdout = stdio.stdout === "pipe" ? new PassThrough() : null;
    this.stderr = stdio.stderr === "pipe" ? new PassThrough() : null;
    // Writes after the helper's gone go nowhere, as a dead child's stdin "error"s are ignored by callers.
    this.stdin?.on("error", () => {});
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.ended) return false;
    const n = signalNumber(signal);
    if (this.onKill) this.onKill(n);
    else this.killWith = n;
    return true;
  }

  /** Started: `kill` reaches it from now on (one asked before is sent now). */
  started(via: "app" | "direct", pid: number | undefined, onKill: (signal: number) => void) {
    this.via = via;
    this.pid = pid;
    this.onKill = onKill;
    if (this.killWith !== null) onKill(this.killWith);
  }

  finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout?.end();
    this.stderr?.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

/** The helper's executable for a direct spawn: a checkout's own build, or the installed one (in the app, else native/). */
export function directPath(name: string): string {
  if (!INSTALLED) return buildNative(name);
  const inApp = join(helperAppSpec().path, "Contents", "Helpers", name);
  return BROKERED.has(name) && existsSync(inApp) ? inApp : installedHelper(name);
}

/** As before the app: `kiko`'s own child, its streams joined to the HelperProcess's. */
function startDirect(h: Helper, args: string[], path: () => string, note: BrokerDeps["log"]) {
  let child: ChildProcess;
  try {
    child = spawn(path(), args, { stdio: [h.stdio.stdin, h.stdio.stdout, h.stdio.stderr] });
  } catch (err) {
    h.stderr?.write(`${(err as Error).message}\n`);
    note("helper_spawn_failed", { helper: h.name, via: "direct", why: (err as Error).message });
    setImmediate(() => h.finish(127, null));
    return;
  }
  child.on("error", (err) => {
    note("helper_spawn_failed", { helper: h.name, via: "direct", why: err.message });
    h.finish(127, null);
  });
  if (h.stdin && child.stdin) {
    child.stdin.on("error", () => {});
    h.stdin.pipe(child.stdin);
  }
  if (h.stdout && child.stdout) child.stdout.pipe(h.stdout, { end: false });
  if (h.stderr && child.stderr) child.stderr.pipe(h.stderr, { end: false });
  let exit: [number | null, NodeJS.Signals | null] | null = null;
  child.on("exit", (code, signal) => (exit = [code, signal]));
  child.on("close", (code, signal) => h.finish(exit?.[0] ?? code, exit?.[1] ?? signal));
  h.started("direct", child.pid, (signal) => child.kill(signal));
}

/** Through the app: a socket per stream, then the spawn; a refusal falls back to `fallback`. */
function startInApp(h: Helper, conn: BrokerConn, args: string[], fallback: () => void, note: BrokerDeps["log"]) {
  const token = randomBytes(12).toString("hex");
  const fds: number[] = [];
  const socks: Record<number, Socket> = {};
  const wants: Array<[number, boolean]> = [
    [0, h.stdio.stdin === "pipe"],
    [1, h.stdio.stdout === "pipe"],
    [2, h.stdio.stderr !== "ignore"],
  ];
  for (const [fd, want] of wants) {
    if (!want) continue;
    fds.push(fd);
    const s = connect(conn.path);
    s.on("error", () => {});
    s.write(`${JSON.stringify({ op: "stdio", token, fd })}\n`);
    socks[fd] = s;
  }
  const out = socks[1];
  const err = socks[2];
  if (out && h.stdout) out.pipe(h.stdout, { end: false });
  if (err) {
    if (h.stderr) err.pipe(h.stderr, { end: false });
    else err.on("data", (d) => process.stderr.write(d)); // "inherit"
  }
  // Its streams' ends, so 'exit' comes after the last of its output (as 'close' does for a child).
  const readEnds = [out, err].filter(Boolean).map((s) => new Promise<void>((r) => (s!.destroyed ? r() : s!.once("close", () => r()))));
  let exited = false;
  conn.track(token, (m) => {
    if (m.op === "spawned") {
      if (h.stdin && socks[0]) h.stdin.pipe(socks[0]);
      h.started("app", typeof m.pid === "number" ? m.pid : undefined, (signal) => conn.send({ op: "kill", token, signal }));
    } else if (m.op === "error") {
      for (const s of Object.values(socks)) s.destroy();
      note("helper_spawn_failed", { helper: h.name, via: "app", why: String(m.message ?? "") });
      fallback();
    } else if (m.op === "exit" || m.op === "gone") {
      if (exited) return;
      exited = true;
      const code = m.op === "exit" && typeof m.code === "number" ? m.code : null;
      const signal = m.op === "exit" ? (typeof m.signal === "number" ? (SIGNAL_NAMES.get(m.signal) ?? null) : null) : "SIGKILL";
      // The app gone: its children went with it.
      if (m.op === "gone") for (const s of Object.values(socks)) s.destroy();
      const timeout = sleep(2000);
      void Promise.race([Promise.all(readEnds), timeout]).then(() => {
        socks[0]?.destroy();
        h.finish(code, signal);
      });
    }
  });
  conn.send({ op: "spawn", token, helper: h.name, args, fds });
}

/** How long after a helper died each try to start it again waits: a little over 7 s in all, beside any wait for the app to start. */
const AGAIN_MS = [300, 1000, 2000, 4000];

/**
 * A helper that died after it was ready, started again by `start` (which starts the app again
 * through the Broker when it's gone: macOS's "Quit & Reopen" kills it): tried after each of
 * `delays`, until it works or `stopped()`. Nothing's said here: the caller logs the result and
 * tells the user only when it failed ({ ok: false, why }: the last try's error).
 */
export async function startAgain(
  start: () => Promise<void>,
  o: { stopped: () => boolean; delays?: number[] },
): Promise<{ ok: true; ms: number; tries: number } | { ok: false; why: string; ms: number; tries: number } | null> {
  const began = Date.now();
  let why = "";
  let tries = 0;
  for (const wait of o.delays ?? AGAIN_MS) {
    await sleep(wait);
    if (o.stopped()) return null;
    tries++;
    try {
      await start();
      return { ok: true, ms: Date.now() - began, tries };
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, why, ms: Date.now() - began, tries };
}

/** The real app: this flavour's, started with `open -g -j`. */
/**
 * A control connection to this flavour's app as it runs now (`kiko-dev _overlay-test`): the running
 * one as it is, even another build (never quit for this one, as use() would), else started as
 * `kiko` starts it. `diskBuild`: the bundle's on disk, to say when the running one is older.
 */
export async function helperAppConn(via: Broker = broker): Promise<{ conn: BrokerConn; hello: Hello | null; diskBuild: string | null } | { why: string }> {
  const spec = via.d.spec();
  const diskBuild = bundleBuild(spec.path);
  const s = via.d.wanted() ? await connectTo(spec.socket, 1000) : null;
  if (s) {
    const conn = new BrokerConn(s, spec.socket);
    return { conn, hello: await conn.sayHello(diskBuild), diskBuild };
  }
  const use = await via.use();
  return "conn" in use ? { conn: use.conn, hello: use.conn.hello, diskBuild: bundleBuild(spec.path) } : use;
}

export const broker = new Broker({
  wanted: () => helperAppWanted(),
  spec: helperAppSpec,
  prepare: (spec) => buildApp(spec),
  launch: (path) =>
    new Promise((resolve, reject) => {
      const p = spawn("/usr/bin/open", ["-g", "-j", path], { stdio: ["ignore", "ignore", "pipe"] });
      let said = "";
      p.stderr.on("data", (d) => (said += d));
      const timer = setTimeout(() => p.kill(), 15_000);
      p.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(said.trim().split("\n").pop() || `open exited ${code}`));
      });
    }),
  log,
});

/**
 * Starts helper `name` (native/macos/<name>.swift) with `args`: through the app when it's one of
 * BROKERED and the app can be used, else `kiko`'s own child. Returns at once. `via`: another Broker (the tests').
 */
export function spawnHelper(name: string, args: string[] = [], stdio: Stdio = {}, via: Broker = broker): HelperProcess {
  const h = new Helper(name, { stdin: stdio.stdin ?? "pipe", stdout: stdio.stdout ?? "pipe", stderr: stdio.stderr ?? "pipe" });
  const path = via.d.directPath ?? directPath;
  const direct = () => startDirect(h, args, () => path(name), via.d.log);
  if (!BROKERED.has(name)) {
    direct();
    return h;
  }
  void via.use().then(
    (use) => ("conn" in use ? startInApp(h, use.conn, args, direct, via.d.log) : direct()),
    () => direct(),
  );
  return h;
}

/** One run of a helper: its output, and how it ended; killed after `timeoutMs` (0: never). */
export function runHelper(name: string, args: string[], timeoutMs = 0, via: Broker = broker): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawnHelper(name, args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }, via);
    let stdout = "";
    let stderr = "";
    p.stdout!.on("data", (d) => (stdout += d));
    p.stderr!.on("data", (d) => (stderr += d));
    const timer = timeoutMs ? setTimeout(() => p.kill(), timeoutMs) : null;
    p.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** The app relaunched after a permission was turned on (Input Monitoring); false when the helpers aren't the app's (the terminal must be reopened instead). */
export const relaunchHelperApp = () => broker.relaunch();

/** The app's name while the helpers run in it (whose permissions they are); null when they're the terminal's. */
export async function helperAppHolder(via: Broker = broker): Promise<string | null> {
  const use = await via.use();
  return "conn" in use ? helperAppSpec().name : null;
}

/** The app quit if it's running (the uninstall): whether it was. */
export const quitHelperApp = () => broker.quit();

/** lsregister, to forget a bundle Launch Services knows (the uninstall). */
export function unregisterApp(path: string): boolean {
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  return spawnSync(lsregister, ["-u", path], { stdio: "ignore", timeout: 20_000 }).status === 0;
}
