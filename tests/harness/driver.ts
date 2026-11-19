// The faked-app harness's driver (test-app.ts runs the cases; cases/ has them, by area): the run's own files,
// the sessions it fakes (DESK, TERM) and T (what the stubs heard, said, typed and played, and what a case sets
// for them), the real app started on them, and what the cases share: begin() and what this case said, showed,
// played and logged, talk(), until, the fake phone (Phone). Importing it starts the app.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { checkWaits } from "../support/until.ts";

rmSync("settings-test.json", { force: true }); // "Voice can" and friends start at their defaults
rmSync("dictionary.json", { force: true }); // a new install has none: only the built-in words
rmSync("phones.json", { force: true }); // no paired phones
rmSync("missed.json", { force: true }); // nor what they missed
rmSync("pronunciation.json", { force: true }); // only the built-in respellings
rmSync("claude.json", { force: true }); // Claude Code's config (run.sh: KIKO_CLAUDE_CONFIG): none, until a case writes it
// Where new sessions open (run.sh points the app here): a projects root with pixie and tideline, a fake
// ~/.claude/projects whose one folder is clip-tool, where a session was named Clipkit, and an empty
// scratch folder.
export const PROJECTS_ROOT = `${process.cwd()}/projects-root`;
export const SCRATCH = `${process.cwd()}/scratch`;
export const HISTORY_FOLDER = `${process.cwd()}/elsewhere/clip-tool`;
for (const dir of [PROJECTS_ROOT, SCRATCH, "claude-projects", "elsewhere", "codex-home", "codex-sessions"]) rmSync(dir, { recursive: true, force: true });
for (const dir of [`${PROJECTS_ROOT}/pixie`, `${PROJECTS_ROOT}/tideline`, HISTORY_FOLDER]) mkdirSync(dir, { recursive: true });
{
  const project = `claude-projects/${HISTORY_FOLDER.replace(/[^a-zA-Z0-9]/g, "-")}`;
  mkdirSync(project, { recursive: true });
  const lines = [
    { type: "user", cwd: HISTORY_FOLDER, sessionId: "h1", message: { content: "hi" } },
    { type: "custom-title", customTitle: "Clipkit", sessionId: "h1" },
  ];
  writeFileSync(`${project}/h1.jsonl`, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

export const T: any = ((globalThis as any).T = {
  classifier: true,
  needs: [] as number[],
  said: [] as { at: number; text: string; start?: number; end?: number }[],
  cues: [] as Buffer[],
  played: [] as { pcm: Buffer; at: number; end: number }[],
  typed: [] as any[],
  keys: [] as any[],
  opened: [] as any[],
  ran: [] as { program: string; clipboard: boolean }[],
  speakMs: 50,
  heard: "",
  sessions: [] as any[],
  utterance: (_: any) => ({ audience: "app", audienceConfidence: 0, intent: "other", intentConfidence: 0 }),
  route: (_: any) => [] as any[],
});
// A session's place in Ghostty, as the terminal adapters would find it (src/terminals/ghostty/).
export function ghostty(id: string) {
  return { via: "ghostty", id, keys: true };
}
// A session in the Claude desktop app: no adapter reaches it (nothing types into the desktop app),
// so words for it outside its reply window aren't sent, and it's said so.
export const DESK = {
  sessionId: "desk-1",
  name: "desk",
  title: "2 plus 2",
  kind: "interactive",
  status: "idle",
  lastActiveAt: 0,
  cwd: "/Users/example/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-x",
  place: null,
  mapping: "none",
  desktop: true,
};
export const TERM = {
  sessionId: "term-1",
  name: "atlas",
  title: "",
  kind: "interactive",
  status: "idle",
  lastActiveAt: 0,
  cwd: "/nonexistent/atlas-agents",
  place: ghostty("ghostty-1"),
  mapping: "title",
  desktop: false,
};
T.sessions = [DESK, TERM];
// Every program the app runs (node:child_process), by name, run as it would be: nothing may touch the
// clipboard (pbcopy, pbpaste, or a script that pastes), for a desktop session or any other. Whether a
// command did is worked out here and kept; its arguments aren't.
{
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const cp = createRequire(import.meta.url)("node:child_process");
  const CLIPBOARD = /\b(pbcopy|pbpaste|NSPasteboard)\b|the clipboard|keystroke "v"/;
  for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
    const real = cp[fn];
    const wrapped = function (this: unknown, cmd: string, ...rest: any[]) {
      const args = Array.isArray(rest[0]) ? rest[0].map(String) : [];
      const program = String(cmd).trim().split(/\s+/)[0].split("/").at(-1) ?? "";
      T.ran.push({ program, clipboard: CLIPBOARD.test([cmd, ...args].join(" ")) });
      return real.call(this, cmd, ...rest);
    };
    for (const key of Object.getOwnPropertySymbols(real)) Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(real, key)!);
    cp[fn] = wrapped;
  }
  syncBuiltinESMExports();
}
// A session Kiko opens starts in the "Permission mode" setting's mode: Accept edits by default
// (core/permission-mode.ts), so its command line carries the flags (each word quoted, as the terminals put it).
export const CLAUDE = "claude '--permission-mode' 'acceptEdits'";
export const clipboardRuns = () => T.ran.filter((r: any) => r.clipboard || r.program === "pbcopy" || r.program === "pbpaste");
/** Words for a session nothing types into (the desktop app's), from the app's log: refused, with what wasn't sent. */
export const notSent = (sessionId: string) => logEntries().filter((l) => l.event === "type_failed" && l.sessionId === sessionId);

// A run that crashed while you talked left the volume down (stubs/platform/macos/duck.ts: a fake one): 80 → 16. Put back on start.
T.mac = { volume: 16 };
writeFileSync("state.json", JSON.stringify({ pid: spawnSync("true").pid, updatedAt: Date.now(), ducked: { from: 80, to: 16 } }));

// T3 Code: a fake server (tests/support/fake-t3.ts), never the real one, with one project and no
// threads until its cases (t3Cases) add one; and a fake `t3` CLI in its home (run.sh: out/t3home)
// that mints the token it takes. The app finds it on this port as it starts.
const { FakeT3 } = await import("../support/fake-t3.ts");
export const fakeT3 = new FakeT3();
fakeT3.project("t3p", "/nonexistent/t3-pixie", "t3-pixie");
fakeT3.writeCli(process.env.KIKO_T3_HOME!);
process.env.KIKO_T3_PORT = String(await fakeT3.listen());

// This run's log: log.ts only repoints logs/latest.jsonl for the real app, so take the newest file.
export const LOGS = process.env.KIKO_LOG_DIR ?? "logs";
export const logFile = () =>
  `${LOGS}/${readdirSync(LOGS)
    .filter((f) => /^\d.*\.jsonl$/.test(f))
    .sort()
    .at(-1)}`;
export const { ui, sessionStatus } = await import("../../src/core/ui-store.ts");
export const { findSession } = await import("../../src/core/sessions.ts");
export const { SOUNDS } = await import("../../src/core/sounds.ts");
export const lines: { at: number; kind: string; text: string }[] = [];
ui.on("line", (l: any) => lines.push({ at: Date.now(), kind: l.kind, text: l.text }));
await import("../../src/app.ts");
export const { HookRequest } = await import("./stubs/agents/claude-code/hooks.ts");
export const { forgetPending } = await import("../../src/core/guard.ts");
export const { config } = await import("../../src/core/config.ts");

// A fake phone on the app's phone server (src/remote/server.ts), at the port it listens on now (phoneServer.port).
const { LocalPhone } = await import("../support/local-phone.ts");
const { invalid } = await import("../../src/remote/schema.ts");
export const { parsePairUrl } = await import("../../src/remote/pair-link.ts");
// CommonJS: its function is module.exports.default.
const jsQR = (await import("jsqr")).default.default;
export const phoneServer = { port: 0 };
/** A phone: what it got (each checked against the schema), and whether the hub closed it. */

export class Phone {
  ws: any;
  got: any[] = [];
  closed = false;
  open: Promise<void>;
  /**
   * As the app does, it says where it is right after welcome: `back` (in front), `away` (in the
   * background or locked as it connected), or nothing (an app from before presence-on-connect).
   */
  constructor(says: "back" | "away" | null = "back", qr?: { secret: Buffer }) {
    this.ws = new LocalPhone(`ws://127.0.0.1:${phoneServer.port}`, qr ? { qr } : {});
    this.ws.on("message", (data: any) => {
      const m = JSON.parse(String(data));
      const why = invalid(m, "hub");
      assert.equal(why, null, `the hub sent an invalid ${m.type}: ${why}`);
      this.got.push(m);
      if (m.type === "welcome" && says) this.ws.send(JSON.stringify({ v: 1, type: "presence", state: says }));
    });
    this.ws.on("close", () => (this.closed = true));
    this.open = new Promise((resolve) => this.ws.once("open", resolve));
  }
  async send(m: object) {
    await this.open;
    this.ws.send(JSON.stringify({ v: 1, ...m }));
  }
  /** The next message of `type` (matching `ok`) from `from` on: waits for it. */
  async next(type: string, ok: (m: any) => boolean = () => true, from = 0, ms = 2000) {
    await until(() => this.got.slice(from).some((m) => m.type === type && ok(m)), ms);
    return this.got.slice(from).find((m) => m.type === type && ok(m));
  }
  of(type: string) {
    return this.got.filter((m) => m.type === type);
  }
  close() {
    this.ws.close();
  }
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What a phone's camera reads off a QR code's modules ([y][x]), with a light quiet zone round them. */
export function scanQr(modules: boolean[][]): string | null {
  const quiet = 4;
  const scale = 4;
  const n = modules.length + quiet * 2;
  const data = new Uint8ClampedArray(n * scale * n * scale * 4);
  for (let y = 0; y < n * scale; y++) {
    for (let x = 0; x < n * scale; x++) {
      const v = modules[Math.floor(y / scale) - quiet]?.[Math.floor(x / scale) - quiet] ? 0 : 255;
      data.set([v, v, v, 255], (y * n * scale + x) * 4);
    }
  }
  return jsQR(data, n * scale, n * scale)?.data ?? null;
}
/**
 * Waits for `cond`, checked every 5ms. `ms` is only a backstop: a wait is for an event or a message,
 * so running out means it never came; `what` says which, in the failure.
 */
export const until = checkWaits(3000, 5);
/** The starting sessions the app has opened (its session_open log) and not seen start or end yet. */
function stillStarting() {
  const log = logEntries();
  const done = new Set(log.filter((l) => l.event === "session_ready" || l.event === "session_never_started").map((l) => l.startingId));
  return log.filter((l) => l.event === "session_open" && l.startingId && !done.has(l.startingId));
}
/**
 * The sessions the app opened in a case, which nothing here ever lists (so they'd stay "starting",
 * core/starting.ts): started now, as Claude Code does once their folder is trusted, then gone, so
 * later cases don't find them in the list. Which ones, from the app's log (session_open, not yet
 * session_ready or session_never_started), not from the list shown, which may not have them yet.
 */
export async function startOpened() {
  const left = stillStarting();
  if (!left.length) return;
  const before = T.sessions;
  const at = Date.now();
  const folderOf = (cwd: string) => cwd.split("/").at(-1);
  // Each one its agent's (a Codex session the app opened is only a Codex session in its folder).
  T.sessions = [
    ...before,
    ...left.map((l: any, i: number) => ({
      ...TERM,
      sessionId: `started-${at}-${i}`,
      name: l.name ?? folderOf(l.folder),
      givenName: l.name ?? "",
      cwd: l.folder,
      place: null,
      mapping: "none",
      ...(l.agent ? { agent: l.agent } : {}),
    })),
  ];
  T.hooks.onSessionsChanged();
  const ids = new Set(left.map((l: any) => l.startingId));
  await until(() => !stillStarting().some((l) => ids.has(l.startingId)), 5000, `the sessions opened in this case to start (${[...ids].join(", ")})`);
  T.sessions = before;
  T.hooks.onSessionsChanged();
  await until(() => !ui.state.sessions.some((s: any) => String(s.sessionId).startsWith(`started-${at}-`)), 5000, "the started sessions to leave the list");
}
export const stop = (s: any, entrypoint: string) => new HookRequest({ hook_event_name: "Stop", session_id: s.sessionId, cwd: s.cwd, entrypoint, last_assistant_message: `reply from ${s.sessionId}` });
export const logEntries = () =>
  readFileSync(logFile(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
// When this case began (for timings), and where it starts in what was said, shown, played and logged.
// By position, not time: the last case's line or beep can land in the same millisecond this one begins,
// and `at >= mark` took it for this case's.
export let mark = 0;
let from = { said: 0, lines: 0, played: 0, log: 0 };
export const markHere = () => {
  mark = Date.now();
  from = { said: T.said.length, lines: lines.length, played: T.played.length, log: logEntries().length };
};
export const begin = (name: string) => {
  markHere();
  console.log(`\n# ${name}`);
};
/** This case's: what was said (T.said), shown (lines), played (T.played) and logged, since begin() or markHere(). */
export const caseSaid = (): any[] => T.said.slice(from.said);
export const caseLines = () => lines.slice(from.lines);
export const casePlayed = (): any[] => T.played.slice(from.played);
export const caseLog = () => logEntries().slice(from.log);
export const saidFor = (s: any) => caseSaid().find((x: any) => x.text === `summary for ${s === DESK ? "2 plus 2" : "atlas-agents"}`);
export async function talk(text: string) {
  T.heard = text;
  T.hotkey.onDown();
  await wait(20);
  await T.hotkey.onUp();
}
// The hook went away (its session was interrupted): what clears `current` outside the app.
export const gone = (r: any) => {
  r.settled = true;
  r.settledAt ||= Date.now();
  r.onClosed();
};
export const windowStart = (s: any) => saidFor(s)!.at + T.speakMs; // speech "ends" speakMs after it starts
/** Its reading is over and its reply window counts: what a fixed speakMs + 50 waited for before. */
export const windowOpen = (s: any) => until(() => ui.state.waiting?.sessionId === s.sessionId && ui.state.waiting?.until != null);
/**
 * "At once" (released when the next came in, cut by a press, let go once the answer was heard): within this.
 * It was 30ms, and a loaded machine went past it (34ms) with nothing wrong: the app looks every 20ms
 * (deliver.ts waitFor) and timers run late under load. Still under the shortest wait any of these could
 * fall into instead (KIKO_TEST_UNHEARD_MS 150, the give-way 200, the fyi window 600; run.sh), so a
 * release that waits for one of them still fails.
 */
export const AT_ONCE_MS = 100;
export const near = (actual: number, expected: number, slack = 80) => assert.ok(Math.abs(actual - expected) <= slack, `expected ~${expected}ms, got ${actual}ms`);
await until(() => T.hotkey);

// What a case heard and saw: the "sent" beep, a line shown, a line spoken; and what Voice can says off.
export const cue = () => T.cues.filter((c: Buffer) => c === SOUNDS.sent).length;
export const info = (text: string) => caseLines().some((l) => l.text === text);
export const spoke = (text: string) => caseLines().some((l) => l.kind === "voice" && l.text === text);
export const { VOICE_CAN_SAID, voiceOffLine } = await import("../../src/core/voice-off.ts");
/** Words for a session that isn't waiting, at Replies only: whose (when another one waits), where it's turned on, "say turn it on". */
export const NOT_WAITING = (name?: string) => voiceOffLine("message", { name });
/** What Voice can stopping something says (core/voice-off.ts): what's off, where it's turned on, and the offer. */
export const OFF_LINE = (doing: string) => `${doing} by voice is off. ${VOICE_CAN_SAID} Say turn it on, and I'll do it now.`;
// Held finished turns: the transcript a held Stop names (announce.ts writes its first lines), a prompt queued in it, a held Stop.
export const TRANSCRIPT = `${process.cwd()}/fake-transcript.jsonl`;
export const enqueue = (content: string) => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId: TERM.sessionId, content }) + "\n";
export const held = (s: any, extra: any = {}) => new HookRequest({ ...stop(s, s === DESK ? "claude-desktop" : "cli").event, transcript_path: TRANSCRIPT, stop_hook_active: true, ...extra });
export const announced = (s: any) => Boolean(saidFor(s));
