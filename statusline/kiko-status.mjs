#!/usr/bin/env node
// Claude Code status line wrapper: prints the user's own status line unchanged,
// then appends a short voice segment when Kiko (src/core/name.ts) is running.
//
//   statusLine.command = "node /path/to/kiko-status.mjs -- npx -y ccstatusline@latest"
//
// Rules:
// - The wrapped command gets the exact stdin Claude Code sent us; its stdout is printed byte for byte.
// - Our segment only appears when the app is on (fresh state file + live pid).
// - Any failure on our side falls back to printing just their output.
// - Their output is cached per session and reused while Claude Code's input is unchanged,
//   so a 1s refreshInterval (needed for the countdown) doesn't re-run `npx` every second.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Which Kiko this is (src/core/name.ts FLAVOUR), by where it is, as hooks/lib.mjs tells it: beside a
// checkout's src/, Kiko Dev; in an installed copy, the release. Each one's status line follows its own app.
const DEV = existsSync(new URL("../src/core/name.ts", import.meta.url));
// The app's name and slug (src/core/name.ts NAME and SLUG), the only names this script repeats: it
// imports nothing. tests/unit/core/name.test.ts checks they match.
const NAME = "Kiko";
const SLUG = "kiko";
// This flavour's slug (src/core/name.ts flavourNames): Kiko Dev's ends in "-dev".
const OWN_SLUG = DEV ? `${SLUG}-dev` : SLUG;
// The app's state file: KIKO_STATE when set, otherwise /tmp/kiko.state.json (Kiko Dev's: /tmp/kiko-dev.state.json).
const SET = process.env[`${SLUG.toUpperCase().replace(/-/g, "_")}_STATE`];
const STATE_PATHS = SET ? [SET] : [`/tmp/${OWN_SLUG}.state.json`];
const STALE_MS = 10_000; // app counts as off if its heartbeat is older than this
const CACHE_MAX_AGE_MS = 15_000; // re-run their command at least this often even if input is unchanged
const CHILD_TIMEOUT_MS = 10_000;
const SHOW_AFTER_MS = 500; // "deciding…" / "checking…" only once it's taken this long: quick ones don't flicker
const SENT_MS = 2_000; // how long "✓ sent to …" stays
// Each flavour's own: the two scripts may cache in different shapes.
const CACHE_DIR = join(tmpdir(), `${OWN_SLUG}-statusline`);

const sep = process.argv.indexOf("--");
const wrapped = sep === -1 ? [] : process.argv.slice(sep + 1);

// If Claude Code cancels us mid-run, finish quietly so the cache still gets written.
let cancelled = false;
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"])
  process.on(sig, () => {
    cancelled = true;
  });
process.stdout.on("error", () => {});

main().catch(() => {});

async function main() {
  const input = await readStdin();
  let info = {};
  try {
    info = JSON.parse(input.toString("utf8")) || {};
  } catch {}

  const theirs = await theirOutput(input, info);

  let segment = "";
  try {
    segment = voiceSegment(info.session_id);
  } catch {}

  let out = theirs;
  if (segment) {
    try {
      out = appendSegment(theirs, segment);
    } catch {}
  }
  if (!cancelled && out) process.stdout.write(out);
}

// ---------- their status line ----------

async function theirOutput(input, info) {
  if (!wrapped.length) return "";
  const cmd = wrapped.join("\0");
  let cachePath = null,
    fp = null,
    cached = null;
  try {
    const sid = String(info.session_id || "nosession").replace(/[^A-Za-z0-9_-]/g, "_");
    cachePath = join(CACHE_DIR, `${sid}.json`);
    fp = fingerprint(info, input);
    const c = JSON.parse(readFileSync(cachePath, "utf8"));
    if (c && c.cmd === cmd && typeof c.out === "string") cached = c;
    if (cached && cached.fp === fp && Date.now() - cached.at < CACHE_MAX_AGE_MS) return cached.out;
  } catch {}

  const res = await runWrapped(input);
  if (res.ok) {
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      const tmp = `${cachePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ cmd, fp, at: Date.now(), out: res.out }));
      renameSync(tmp, cachePath);
    } catch {}
    return res.out;
  }
  // Their command failed: show what it printed, else the last good output we had.
  return res.out || cached?.out || "";
}

// Input minus the wall-clock field that changes on every tick.
function fingerprint(info, raw) {
  let basis;
  try {
    const copy = structuredClone(info);
    if (copy.cost) delete copy.cost.total_duration_ms;
    basis = JSON.stringify(copy);
  } catch {
    basis = raw.toString("utf8");
  }
  return createHash("sha1").update(basis).digest("hex");
}

function runWrapped(input) {
  return new Promise((resolve) => {
    let child;
    try {
      // One argument after `--` is a shell snippet; several are an argv we run as-is.
      child = wrapped.length === 1 ? spawn(wrapped[0], { shell: true, stdio: ["pipe", "pipe", "ignore"] }) : spawn(wrapped[0], wrapped.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve({ ok: false, out: "" });
    }

    const chunks = [];
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, out: Buffer.concat(chunks).toString("utf8") });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(false);
    }, CHILD_TIMEOUT_MS);
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// ---------- voice segment ----------

function voiceSegment(sessionId) {
  const s = runningState();
  if (!s) return "";
  const now = Date.now();

  const C = { red: "\x1b[31m", magenta: "\x1b[35m", yellow: "\x1b[33m", green: "\x1b[32m", dim: "\x1b[90m", reset: "\x1b[0m" };
  // Listening while the push-to-talk key is held, speaking while the app talks, otherwise "voice on".
  if (s.listening) return `${C.red}🎙 listening…${C.reset}`;
  // A send the app wasn't sure of, held a moment before it goes (while it says where, too).
  const clean = (name) =>
    typeof name === "string"
      ? name
          .replace(/[\x00-\x1f\x7f]/g, "")
          .trim()
          .slice(0, 40)
      : "";
  if (s.holding && clean(s.holding.name)) return `${C.yellow}⏳ to ${clean(s.holding.name)}…${C.reset}`;
  if (s.speaking) return `${C.magenta}🔊 speaking…${C.reset}`;
  // Working out where your words go, then where they went, and a quick check running. Older
  // versions of the app don't write these fields.
  const since = (at) => (typeof at === "number" && Number.isFinite(at) ? now - at : -1);
  if (s.deciding && since(s.deciding.startedAt) > SHOW_AFTER_MS) return `${C.yellow}⏳ deciding…${C.reset}`;
  const sent = s.sent;
  if (sent && typeof sent.name === "string" && since(sent.at) >= 0 && since(sent.at) < SENT_MS) {
    const name = sent.name
      .replace(/[\x00-\x1f\x7f]/g, "")
      .trim()
      .slice(0, 40);
    if (name) return `${C.green}✓ sent to ${name}${C.reset}`;
  }
  if (s.checking && since(s.checking.startedAt) > SHOW_AFTER_MS) return `${C.yellow}⏳ checking…${C.reset}`;
  // Hands-free on: during a session's reply window, words without the name answer it, counting
  // down; otherwise it's waiting for its name. Older versions of the app don't write this.
  const w = s.waiting;
  // Someone else was talking around the app's words: this time a reply needs the name.
  if (s.handsFree?.needsName && w && typeof w.until === "number" && w.until > now) {
    const to = clean(w.name);
    return `${C.green}◎ reply${to ? ` to ${to}` : ""}: say "${clean(s.handsFree.name) || NAME}" first this time · ${Math.ceil((w.until - now) / 1000)}s${C.reset}`;
  }
  if (s.handsFree?.replyWindow && w && typeof w.until === "number" && w.until > now) {
    const to = clean(w.name);
    return `${C.green}◎ reply${to ? ` to ${to}` : ""}, no "${clean(s.handsFree.name) || NAME}" needed · ${Math.ceil((w.until - now) / 1000)}s${C.reset}`;
  }
  if (s.handsFree) return `${C.green}◎ listening for "${clean(s.handsFree.name) || NAME}"${C.reset}`;
  return `${C.dim}🎙 voice on${C.reset}`;
}

// The first state file of an app that's on: fresh, and its pid alive.
function runningState() {
  for (const path of STATE_PATHS) {
    let s;
    try {
      // Yours only: /tmp is anyone's, and another user's file there isn't your app's state.
      if (statSync(path).uid !== process.getuid()) continue;
      s = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!s || typeof s !== "object") continue;
    if (typeof s.updatedAt !== "number" || Date.now() - s.updatedAt > STALE_MS) continue;
    if (pidAlive(s.pid)) return s;
  }
  return null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Same line as their last line (matching ccstatusline's " | " separator) unless that
// would overflow the terminal width, in which case it gets its own line.
function appendSegment(theirs, segment) {
  const body = theirs.replace(/\n+$/, "");
  if (!body) return segment + "\n";
  const lastLine = body.slice(body.lastIndexOf("\n") + 1);
  const cols = Number(process.env.COLUMNS) || 0;
  const joined = `${lastLine} | ${segment}`;
  if (cols && visibleWidth(joined) > cols) return `${body}\n${segment}\n`;
  return `${body} | ${segment}\n`;
}

function visibleWidth(str) {
  const plain = str
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "") // OSC (links)
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, ""); // CSI (colors)
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f || (cp >= 0x300 && cp < 0x370) || cp === 0x200d) continue;
    w += cp >= 0x1100 && (cp >= 0x1f000 || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60)) ? 2 : 1;
  }
  return w;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(Buffer.alloc(0));
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks)));
  });
}
