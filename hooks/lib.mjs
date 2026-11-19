// What the hook scripts beside it share (claude-code-hook.mjs, codex-hook.mjs, quick-permission.mjs; the
// safety gate's rules are guard.mjs):
// which Kiko they belong to (the release or Kiko Dev, by where they are), finding that app's
// socket, sending it a line, and cutting long fields. Each script imports
// it by a relative path, which resolves from the script's own folder however it's run (`node
// <path>` from a checkout, `kiko hook <path>` from an installed copy: src/main.ts). Imports
// nothing of src/: the scripts run on their own.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which Kiko these scripts belong to (src/core/name.ts FLAVOUR), by where they are: beside a
 * checkout's src/, Kiko Dev; in an installed copy (no src/), the release. Never the environment's
 * KIKO_FLAVOUR: the release's entries and Kiko Dev's both run on every event, and each must
 * reach only its own app, whatever the session's environment says.
 */
export const FLAVOUR = existsSync(new URL("../src/core/name.ts", import.meta.url)) ? "dev" : "release";
/**
 * The app's name and slug (src/core/name.ts NAME and SLUG), the only names these scripts repeat:
 * everything else is made from them, as name.ts makes it. tests/unit/core/name.test.ts checks they match.
 */
export const NAME = "Kiko";
export const SLUG = "kiko";
/** This flavour's slug (src/core/name.ts flavourNames): the release's, or Kiko Dev's, with "-dev". */
const OWN_SLUG = FLAVOUR === "dev" ? `${SLUG}-dev` : SLUG;
/** The release's socket, and Kiko Dev's (src/core/name.ts flavourNames). */
const SOCKETS = { release: [`/tmp/${SLUG}.sock`], dev: [`/tmp/${SLUG}-dev.sock`] };
/** This flavour's config folder, ~/.config/<this>/ (src/core/name.ts flavourNames). */
export const CONFIG_DIR = join(homedir(), ".config", OWN_SLUG);

/**
 * Whether the safety gate is on in these saved settings (src/core/config.ts `guard`): off unless
 * turned on, since 2026-11-02 (it was on by default the day it was built). `guard` saved, true or
 * false, is the answer; not saved, it's on only for someone who had turned one of its kinds off
 * while it was on by default (`guardOff`), so a gate set up by hand stays as it was.
 */
export function guardOn(saved) {
  if (!saved || typeof saved !== "object") return false;
  if (typeof saved.guard === "boolean") return saved.guard;
  return Array.isArray(saved.guardOff) && saved.guardOff.length > 0;
}

/**
 * The safety gate as this flavour's settings file has it (src/core/settings.ts SETTINGS_FILE:
 * KIKO_SETTINGS, else ~/.config/<this>/settings.json), read by a hook before anything else it does
 * for the gate: off (the default), the hook passes there and then, without loading the rules or
 * reaching the app (a small file read, well under a millisecond). No file: off, as the app reads it.
 * A file that isn't JSON (caught being written): on, so the app, which has the setting in hand, decides.
 */
export function guardSaved() {
  let text;
  try {
    text = readFileSync(appEnv("SETTINGS") || join(CONFIG_DIR, "settings.json"), "utf8");
  } catch {
    return false;
  }
  try {
    return guardOn(JSON.parse(text));
  } catch {
    return true;
  }
}

/** The longest a string field goes to the app; longer ones are cut (clipInput). */
export const MAX_STRING = 2000;
/** The prompt told with UserPromptSubmit, at most: enough to tell the app's own words apart. */
export const MAX_PROMPT = 8000;
/**
 * A told event (one not waited for) never waits on the app longer than this. Nor does
 * UserPromptSubmit, which since 2026-11-14 reads one line back (whether the prompt is your dictated
 * words): no answer by then, and the prompt goes in without the note.
 */
export const TELL_MS = 1000;

/**
 * How an agent is told your words were spoken, worded here only (2026-11-14), so the two lines can't
 * drift apart: VOICE_REPLY goes before a reply given through a held Stop hook, VOICE_PROMPT is the
 * hook context beside a prompt the app typed into the session for you (UserPromptSubmit: the app
 * says which prompts those are, src/core/dictated.ts). Typed words used to arrive with nothing, so
 * "high term" was read as it stood, not as iTerm. src/core/history.ts and
 * src/agents/codex/rollouts.ts take VOICE_REPLY off again when they read a session's record back.
 */
const SPOKEN = "speech-to-text, so expect small transcription errors";
export const VOICE_REPLY = `The user replied by voice (${SPOKEN}): `;
export const VOICE_PROMPT = `The user dictated this message by voice (${SPOKEN}).`;

/** KIKO_<key> (src/core/name.ts envVar). */
export const appEnv = (key) => process.env[`${SLUG.toUpperCase().replace(/-/g, "_")}_${key}`];

/** A Rex block's id (REX_BLOCK): "block:" and a UUID, nothing else (src/terminals/rex/rex.ts BLOCK_ID). */
const REX_BLOCK = /^block:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The terminal the session runs in, as the hook's environment says (the app works out which:
 * src/core/terminal-apps.ts sessionTerminal): TERM_PROGRAM, macOS's __CFBundleIdentifier (the app
 * that started the shell), `kiko` when it's in Kiko's own tmux (KIKO_KEPT_TMUX, set there:
 * src/terminals/tmux/tmux.ts LEAVE_TMUX), and `rex`, the Rex block it runs in (REX_BLOCK, only
 * when it's one: the app looks there first, and takes it only while the session's process is in it).
 * Only those, and short; an empty object says none is known, so the app never scripts Ghostty for it.
 */
export function terminalEnv(env = process.env) {
  const t = {};
  if (env.TERM_PROGRAM) t.program = env.TERM_PROGRAM.slice(0, 100);
  if (env.__CFBundleIdentifier) t.bundle = env.__CFBundleIdentifier.slice(0, 200);
  if (env[`${SLUG.toUpperCase().replace(/-/g, "_")}_KEPT_TMUX`] !== undefined) t.kiko = true;
  const block = env.REX_BLOCK?.slice(0, 64);
  if (block && REX_BLOCK.test(block)) t.rex = block;
  return t;
}

/**
 * Where the running app listens: KIKO_SOCKET when set, otherwise this flavour's socket,
 * /tmp/kiko.sock or /tmp/kiko-dev.sock (src/core/name.ts SOCKET_PATH). Its app not running:
 * nothing there, and the script is gone at once.
 */
export function socketPaths() {
  const set = appEnv("SOCKET");
  return (set ? [set] : SOCKETS[FLAVOUR]).filter(notSomeoneElses);
}

/**
 * Not a socket another user put there: /tmp is anyone's, and one listening at the app's path while
 * it's off would get every session's messages and could answer its prompts. A path with nothing there is kept (the caller looks again); one that isn't a socket, or isn't
 * this user's, is passed over, as if the app weren't running.
 */
function notSomeoneElses(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return true;
  }
  return st.isSocket() && st.uid === process.getuid();
}

/**
 * A told event: one line, and the process gone once it's written; no answer is read, and nothing is
 * printed. A socket nobody listens on (left over from a crash) is passed over for the next one.
 */
export function tell(event, sockets) {
  let connected = false;
  const socket = connect(sockets[0], () => {
    connected = true;
    socket.end(`${JSON.stringify(event)}\n`, () => process.exit(0));
  });
  socket.on("error", () => {
    if (connected || sockets.length === 1) process.exit(0);
    socket.destroy();
    tell(event, sockets.slice(1));
  });
}

/**
 * A held event: the app answers with one line, or just closes; `finish` gets what came (it may be
 * called again on close, so it exits or guards). No socket that takes it: exit 0, nothing printed.
 */
export function send(event, sockets, finish) {
  let answer = "";
  let connected = false;
  const socket = connect(sockets[0], () => {
    connected = true;
    socket.write(`${JSON.stringify(event)}\n`);
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    answer += chunk;
    if (answer.includes("\n")) finish(answer);
  });
  socket.on("close", () => {
    if (connected) finish(answer);
  });
  socket.on("error", () => {
    if (connected || sockets.length === 1) process.exit(0);
    socket.destroy();
    send(event, sockets.slice(1), finish);
  });
}

/** A tool's input with its long fields (file contents, big edits, a patch) cut; what the tool would do stays readable. */
export function clipInput(value) {
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] = typeof field === "string" && field.length > MAX_STRING ? `${field.slice(0, MAX_STRING)}…` : field;
  }
  return out;
}

/**
 * A held event whose app answers in lines, more than one maybe (the safety gate's: its verdict, then
 * for Codex the decision): `onLine` gets each line as it comes, `onClose` once the app closes
 * (`answered`: whether any line came), `onConnect` once it's taken. No socket that takes it: exit 0,
 * nothing printed, as `send`.
 */
export function converse(event, sockets, { onConnect = () => {}, onLine, onClose }) {
  let buffer = "";
  let connected = false;
  let answered = false;
  const socket = connect(sockets[0], () => {
    connected = true;
    socket.write(`${JSON.stringify(event)}\n`);
    onConnect();
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      answered = true;
      onLine(line);
      at = buffer.indexOf("\n");
    }
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose(answered);
  };
  socket.on("close", () => {
    if (connected) close();
  });
  socket.on("error", () => {
    // Gone after it was taken: as a close (the caller decides what no answer means).
    if (connected) return close();
    if (sockets.length === 1) process.exit(0);
    socket.destroy();
    converse(event, sockets.slice(1), { onConnect, onLine, onClose });
  });
  return socket;
}
