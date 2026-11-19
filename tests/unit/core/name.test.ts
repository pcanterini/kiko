// The app's name (src/core/name.ts, 2026-10-28) and what carries it: the environment variables, the
// hook and the status line finding the app (its socket and state file), and the name in the
// dictionary and in what names a session.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { applyDictionary, builtInEntries } from "../../../src/core/dictionary.ts";
import { MINE } from "../../support/dictionary.ts";
import { ENV_PREFIX, envVar, flavourNames, NAME, RELEASES_URL, SLUG, SOCKET_PATH, STATE_PATH, STATUS_LINE_SCRIPT } from "../../../src/core/name.ts";
import { aboutVoiceApp } from "../../../src/core/routing-rules.ts";
import { addressedTo, APP_FOLDER, sessionName } from "../../../src/core/sessions.ts";
import { leadingName } from "../../../src/core/wake.ts";
import { makeWorld } from "../../support/fixtures.ts";
import { SLOW } from "../../support/until.ts";

const ROOT = new URL("../../../", import.meta.url);
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `kiko-${prefix}-`));
/** The environment without any of the app's own variables. */
const cleanEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^KIKO_/.test(k)) env[k] = v;
  return { ...env, ...extra };
};
/** Runs a script with `input` on stdin; what it printed. (Node can take many seconds to start on a busy machine.) */
function run(script: string, input: string, env: Record<string, string>, args: string[] = []) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, [script, ...args], { env, timeout: 30_000 * SLOW }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin!.end(input);
  });
}

describe("environment variables", () => {
  const keep = process.env.KIKO_NAME_TEST;
  after(() => {
    if (keep === undefined) delete process.env.KIKO_NAME_TEST;
    else process.env.KIKO_NAME_TEST = keep;
  });
  test("KIKO_<key>, else nothing", () => {
    delete process.env.KIKO_NAME_TEST;
    assert.equal(envVar("NAME_TEST"), undefined);
    process.env.KIKO_NAME_TEST = "set";
    assert.equal(envVar("NAME_TEST"), "set");
  });

  test("the paths carry the name (each flavour's), and the hook and status line know them", () => {
    // A checkout: Kiko Dev's (flavour.test.ts has the rest).
    assert.deepEqual([SOCKET_PATH, STATE_PATH], ["/tmp/kiko-dev.sock", "/tmp/kiko-dev.state.json"]);
    const [release, dev] = [flavourNames("release"), flavourNames("dev")];
    assert.deepEqual([release.socket, release.state], ["/tmp/kiko.sock", "/tmp/kiko.state.json"]);
    // The hook scripts' (hooks/claude-code-hook.mjs and the others) shared lib, and the status line: made as name.ts makes them.
    const hook = readFileSync(new URL("hooks/lib.mjs", ROOT), "utf8");
    assert.ok(hook.includes("{ release: [`/tmp/${SLUG}.sock`], dev: [`/tmp/${SLUG}-dev.sock`] }"));
    assert.deepEqual([release.socket, dev.socket], [`/tmp/${SLUG}.sock`, `/tmp/${SLUG}-dev.sock`]);
    const status = readFileSync(new URL(`statusline/${STATUS_LINE_SCRIPT}`, ROOT), "utf8");
    assert.ok(status.includes("[`/tmp/${OWN_SLUG}.state.json`]"));
    assert.deepEqual([release.state, dev.state], [`/tmp/${SLUG}.state.json`, `/tmp/${SLUG}-dev.state.json`]);
  });
});

// What runs on its own (imports nothing of src/) repeats the name, once each; renaming the app
// edits these with name.ts, and these tests fail until each says the same.
describe("the names repeated outside src/ are name.ts's", () => {
  const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

  test("the hook scripts' lib and the status line", () => {
    for (const path of ["hooks/lib.mjs", `statusline/${STATUS_LINE_SCRIPT}`]) {
      const source = read(path);
      assert.match(source, new RegExp(`^(?:export )?const NAME = "${NAME}";$`, "m"), path);
      assert.match(source, new RegExp(`^(?:export )?const SLUG = "${SLUG}";$`, "m"), path);
    }
    assert.equal(`${SLUG.toUpperCase().replace(/-/g, "_")}_`, ENV_PREFIX, "the prefix both make of the slug");
  });

  test("install.sh: the name, the slug and where the releases are", () => {
    const script = read("install.sh");
    assert.ok(script.includes(`\nNAME=${NAME}\nSLUG=${SLUG}\n`));
    assert.ok(script.includes(`\nRELEASES=\${${ENV_PREFIX}RELEASES_URL:-${RELEASES_URL}}\n`));
  });

  test("the player helper's environment variables, tmux.conf's title, package.json, the files named after it", () => {
    assert.ok(read("native/macos/player.swift").includes(`\nlet envPrefix = "${ENV_PREFIX}"\n`));
    assert.ok(read("src/terminals/tmux/tmux.conf").includes(`\nset -g set-titles-string "${NAME} · #{pane_title}"\n`));
    const pkg = JSON.parse(read("package.json"));
    assert.equal(pkg.name, SLUG);
    assert.deepEqual(Object.keys(pkg.bin), [SLUG, `${SLUG}-dev`]);
    for (const path of [`bin/${SLUG}`, `bin/${SLUG}-dev`, `statusline/${STATUS_LINE_SCRIPT}`, `scripts/signing/${SLUG}.entitlements`]) assert.ok(existsSync(new URL(path, ROOT)), path);
  });
});

// The scripts Claude Code runs, as copies (with what they import, `beside` them) whose fixed paths
// (each as its source writes it, a template literal) point into a temporary folder.
function copyWithPaths(file: string, paths: Record<string, string>, beside: string[] = []) {
  const dir = tmp("script");
  const files = [file, ...beside];
  const sources = files.map((f) => readFileSync(new URL(f, ROOT), "utf8"));
  for (const from of Object.keys(paths))
    assert.ok(
      sources.some((source) => source.includes(from)),
      `${files.join(" or ")} names ${from}`,
    );
  files.forEach((f, i) => {
    let source = sources[i]!;
    for (const [from, to] of Object.entries(paths)) source = source.replaceAll(from, JSON.stringify(to));
    writeFileSync(join(dir, f.split("/").pop()!), source);
  });
  return join(dir, file.split("/").pop()!);
}

describe("the hook reaches the app (hooks/claude-code-hook.mjs)", () => {
  const dir = tmp("sock");
  const SOCKET = join(dir, "app.sock");
  const hook = copyWithPaths("hooks/claude-code-hook.mjs", { "`/tmp/${SLUG}.sock`": SOCKET }, ["hooks/lib.mjs"]);
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));
  /** An app listening at `path`, answering each Stop with a reply naming it. */
  function app(path: string, reply: string) {
    const got: unknown[] = [];
    const server = createServer((conn) => {
      conn.once("data", (line) => {
        got.push(JSON.parse(String(line)));
        conn.end(`${JSON.stringify({ reply })}\n`);
      });
    });
    servers.push(server);
    return new Promise<{ got: unknown[]; close: () => Promise<void> }>((resolve) => server.listen(path, () => resolve({ got, close: () => new Promise((r) => server.close(() => r())) })));
  }
  const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "s-1", cwd: "/x", last_assistant_message: "done" });
  const replyIn = (out: string) => (out ? JSON.parse(out).hookSpecificOutput.additionalContext.split(": ").pop() : null);
  const env = cleanEnv({ CLAUDE_CODE_ENTRYPOINT: "cli" });

  test("the app's socket", async () => {
    const running = await app(SOCKET, "the app");
    assert.equal(replyIn(await run(hook, stop, env)), "the app");
    assert.equal(running.got.length, 1);
    await running.close();
  });

  test("not running: nothing, at once", async () => {
    assert.equal(await run(hook, stop, env), "");
  });

  test("a socket set in the environment is the only one tried", async () => {
    const set = join(dir, "set.sock");
    const running = await app(SOCKET, "the app");
    const there = await app(set, "set app");
    assert.equal(replyIn(await run(hook, stop, { ...env, KIKO_SOCKET: set })), "set app");
    assert.equal(running.got.length, 0);
    await there.close();
    assert.equal(await run(hook, stop, { ...env, KIKO_SOCKET: join(dir, "missing.sock") }), "");
    assert.equal(running.got.length, 0);
    await running.close();
  });
});

describe("the status line finds the app (statusline/kiko-status.mjs)", () => {
  const dir = tmp("state");
  const STATE = join(dir, "app.state.json");
  const status = copyWithPaths(`statusline/${STATUS_LINE_SCRIPT}`, { "`/tmp/${OWN_SLUG}.state.json`": STATE });
  // The app keeps its state file fresh, a heartbeat a second (the status line takes one older than 10 s for an app
  // that's gone): so does this, so a status line slow to start on a busy machine still finds it fresh. Written whole
  // (renamed into place), as a status line may read it any moment.
  let fields: Record<string, unknown> = {};
  const write = () => {
    writeFileSync(`${STATE}.new`, JSON.stringify({ pid: process.pid, updatedAt: Date.now(), ...fields }));
    renameSync(`${STATE}.new`, STATE);
  };
  const heartbeat = setInterval(write, 1000);
  after(() => clearInterval(heartbeat));
  const state = (now: Record<string, unknown>) => {
    fields = now;
    write();
  };
  const segment = async () => (await run(status, "{}", cleanEnv())).replace(/\x1b\[[0-9;]*m/g, "").trim();
  /**
   * A reply window's countdown (`until`), as the status line says it: `words` and its seconds left, which are those
   * at some moment while it ran, however long it took to start (it rounds up: 61 just as it's started, for 60.5 s).
   */
  const countdown = async (until: number, words: string) => {
    const from = Date.now();
    const out = await segment();
    const to = Date.now();
    const said = out.match(/^(.*) · (\d+)s$/);
    assert.equal(said?.[1], words, out);
    const left = Number(said![2]);
    assert.ok(left >= Math.ceil((until - to) / 1000) && left <= Math.ceil((until - from) / 1000), `${left}s left, run from ${until - from} to ${until - to} ms before the end`);
  };

  test("its state file", async () => {
    state({ listening: true });
    assert.equal(await segment(), "🎙 listening…");
    state({ speaking: true });
    assert.equal(await segment(), "🔊 speaking…");
  });

  test("hands-free on: listening for the name; taking your words after it: listening", async () => {
    state({ handsFree: { by: null, name: "Kiko" } });
    assert.equal(await segment(), '◎ listening for "Kiko"');
    state({ listening: true, handsFree: { by: "name", name: "Kiko" } });
    assert.equal(await segment(), "🎙 listening…");
    state({});
    assert.equal(await segment(), "🎙 voice on");
  });

  test("hands-free, a session's reply window counting down: reply without the name", async () => {
    // A window long enough to be open still however slow the status line is to start.
    const waiting = { sessionId: "s1", name: "Lacy", kind: "reply", phase: "waiting", until: Date.now() + 60_500 };
    state({ waiting, handsFree: { by: null, name: "Kiko", replyWindow: true } });
    await countdown(waiting.until, '◎ reply to Lacy, no "Kiko" needed');
    // "Reply without saying Kiko" off: the name is still needed.
    state({ waiting, handsFree: { by: null, name: "Kiko", replyWindow: false } });
    assert.equal(await segment(), '◎ listening for "Kiko"');
  });

  test("hands-free, someone else was talking around the app's words: the name is needed this time", async () => {
    const waiting = { sessionId: "s1", name: "Lacy", kind: "reply", phase: "waiting", until: Date.now() + 60_500 };
    state({ waiting, handsFree: { by: null, name: "Kiko", replyWindow: false, needsName: true } });
    await countdown(waiting.until, '◎ reply to Lacy: say "Kiko" first this time');
  });
});

describe("the name in what you say", () => {
  test("speech-to-text's spellings of it are built in, and fixed anywhere", () => {
    const fix = (text: string) => applyDictionary(text, MINE).text;
    assert.equal(fix("Ask kiku to run the tests."), "Ask Kiko to run the tests.");
    assert.equal(fix("the Giko app"), "the Kiko app");
    assert.equal(fix("gico's status bar"), "Kiko's status bar");
    assert.equal(fix("Kiku, what's everyone doing?"), "Kiko, what's everyone doing?");
    for (const heard of ["kiku", "giko", "gico"])
      assert.ok(
        builtInEntries().some((e) => e.heard === heard && e.write === "Kiko"),
        heard,
      );
  });

  test("the spellings from the wake tests (2026-11-02, 11-03): Kiko, kiko.sh and Kiko Dev; 'Keiko', 'Chico' and 'keto' alone stay words", () => {
    const fix = (text: string) => applyDictionary(text, MINE).text;
    for (const heard of ["Chiko", "kico", "Keeko", "Giko", "Gico"]) assert.equal(fix(`Ask ${heard} what's next.`), "Ask Kiko what's next.", heard);
    assert.equal(fix("The site is kiko.sa."), "The site is kiko.sh.");
    assert.equal(fix("Open Kiko Dodge in the browser."), "Open kiko.sh in the browser.");
    assert.equal(fix("We need to have a kiko dev and production, chiko. And a devkiko."), "We need to have a Kiko Dev and production, Kiko. And a Kiko Dev.");
    assert.equal(fix("Run it in kiku dev, then chiko dev."), "Run it in Kiko Dev, then Kiko Dev.");
    for (const said of ["Hey Keiko, how are you?", "Chico is a town in California.", "I'm on a keto diet.", "Pico, the board, is tiny."]) assert.equal(fix(said), said, said);
    for (const said of ["Hey Keiko, how are you?", "Chico, come here."]) assert.equal(leadingName(said).addressed, false, said);
  });

  test("the domain said as words is written kiko.sh, before 'kiku' alone becomes Kiko", () => {
    const fix = (text: string) => applyDictionary(text, MINE).text;
    for (const said of ["kiko dot sh", "Kiko dot S H", "kiku dot sh", "Kiku dot s h", "kiko.sa", "Kikode.sa", "Kiko dotch", "Kiko dot ESH", "keto dot SH"])
      assert.equal(fix(`Open ${said} in the browser.`), "Open kiko.sh in the browser.", said);
    assert.equal(fix("Kiku, is kiku dot sh up?"), "Kiko, is kiko.sh up?");
    // A dictionary of your own without them: the same, built in.
    assert.equal(applyDictionary("Open kiku dot sh.", [{ heard: "clip kit", write: "clipkit" }]).text, "Open kiko.sh.");
  });

  test("the session on the app's own code answers to it, whatever its folder", () => {
    const w = makeWorld([{ name: APP_FOLDER }, { name: "clipkit" }]);
    const own = w.byName.get(APP_FOLDER)!;
    const a = addressedTo(w.sessions, `${NAME}, run the tests.`);
    assert.deepEqual(a?.sessions.map(sessionName), [sessionName(own)]);
    assert.equal(a?.rest, "Run the tests.");
    assert.equal(addressedTo(makeWorld([{ name: "clipkit" }, { name: "pixie" }]).sessions, `${NAME}, run the tests.`), null);
  });

  test("'the Kiko app' is about this app, like 'the voice app'", () => {
    assert.ok(aboutVoiceApp("The Kiko app's status bar never says speaking."));
    assert.ok(aboutVoiceApp("the kiku screen"));
    assert.ok(aboutVoiceApp("this voice app"));
  });
});
