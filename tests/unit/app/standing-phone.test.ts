// A prompt standing after its voice window (src/app/standing.ts), through the app's own entry (the
// floor's `stands`) and answered from the phone through the app's own hub (src/app/phone.ts
// phoneHub): it stands with you at the Mac (presence isn't read); a late Allow reaches it through
// its held hook, by its id, and takes it down; answered in its terminal (its session listed blocked,
// then not), in its window or after, it's taken down; once it's gone the phone gets prompt_gone; at
// its hold limit (shortened here) it's let go and the phone gets the note with nothing to press. The
// prompts here are stand-ins (no socket). The status line's file is this test's own, never the
// running app's.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { Held, ToolUse } from "../../../src/agents/types.ts";

process.env.KIKO_STATE = join(process.cwd(), "state.json");
// The hold limit, from when its hook came in: short, for the note it ends in.
process.env.KIKO_TEST_STAND_LIMIT_MS = "300";
const { config } = await import("../../../src/core/config.ts");
const { phoneHub, promptId } = await import("../../../src/app/phone.ts");
const { closedStanding, noteHeld, sessionsListed, standing, standingCard, stands, turnEnded, watchHeld } = await import("../../../src/app/standing.ts");
const { LOG_FILE } = await import("../../../src/core/log.ts");
const { floor, hooks, state } = await import("../../../src/app/state.ts");
const { platform } = await import("../../../src/platform/index.ts");
const { makeSession } = await import("../../support/fixtures.ts");
const { writeState } = await import("../../../src/app/status.ts");
const { sessionStatus, ui } = await import("../../../src/core/ui-store.ts");
const { waitingOn } = await import("../../../src/ui/bar.ts");
config.sounds = false;

class Prompt implements Held {
  readonly isPermission = true;
  readonly text = "";
  readonly continued = false;
  readonly canAllowAlways = false;
  readonly questions = null;
  readonly tool: ToolUse = { name: "Bash", input: { command: "npm test" } };
  readonly sessionId: string;
  readonly cwd = "/x/lacy";
  readonly desktop: boolean;
  decision: string | null = null;
  closed = false;
  onClosed: () => void = () => {};
  constructor(id: string, desktop = false) {
    this.sessionId = id;
    this.desktop = desktop;
  }
  get open() {
    return this.decision === null && !this.closed;
  }
  allow(always: boolean) {
    if (!this.open) return false;
    this.decision = always ? "always" : "allow";
    return true;
  }
  deny() {
    if (!this.open) return false;
    this.decision = "deny";
    return true;
  }
  release() {
    if (!this.open) return false;
    this.decision = "released";
    return true;
  }
  answer() {
    return false;
  }
  answerQuestions() {
    return false;
  }
  lastAsked() {
    return "";
  }
  saidThisTurn() {
    return null;
  }
  watchTyped() {}
}

/** Its hook came in now, and its voice window ran out: the floor asks the app (stands). */
function stand(p: Prompt) {
  noteHeld(p);
  assert.equal(stands(p), true);
}

/** The lines shown on the Mac while `run` runs. */
function linesDuring(run: () => void) {
  const lines: string[] = [];
  const take = (l: { text: string }) => void lines.push(l.text);
  ui.on("line", take);
  try {
    run();
  } finally {
    ui.off("line", take);
  }
  return lines;
}

const listing = (id: string, status: string) => [{ ...makeSession({ name: "lacy" }), sessionId: id, status }];

describe("the phone and a standing prompt", () => {
  // Nothing left standing for the next test's cards (or its hold limit firing in it).
  afterEach(() => standing.releaseAll());

  test("the status line's file is this test's own", () => {
    writeState();
    assert.ok(JSON.parse(readFileSync(join(process.cwd(), "state.json"), "utf8")).pid);
  });

  test("a terminal session's stands with you at the Mac: presence isn't asked; the line says where it can be answered", () => {
    const presence = platform.presence;
    let reads = 0;
    platform.presence = {
      atComputer: async () => {
        reads++;
        return { idleMs: 200, locked: false, asleep: false };
      },
    };
    try {
      const p = new Prompt("lacy-at-mac");
      const lines = linesDuring(() => stand(p));
      assert.ok(standing.has(p), "stands though you're at the Mac");
      assert.equal(p.decision, null, "its hook still held");
      assert.equal(reads, 0, "presence not read");
      assert.deepEqual(lines, ["(no answer yet; still on its card and its terminal)"]);
      writeState();
      assert.equal(ui.state.permission?.id, promptId(p), "the Mac's card");
    } finally {
      platform.presence = presence;
    }
  });

  test("on the Mac's card and in the phone's queued cards; a late Allow goes through its held hook, and it's gone everywhere", () => {
    const p = new Prompt("lacy-1");
    stand(p);
    assert.ok(standing.has(p));
    const id = promptId(p);
    writeState();
    assert.equal(standingCard(), p, "the Mac's card");
    assert.equal(ui.state.permission?.id, id);
    assert.equal(ui.state.waiting, null, "no window: it stays up");
    assert.equal(phoneHub.promptUp?.(id), true, "up, for what the phone missed of it");
    assert.equal(phoneHub.permission(id, "allow", "phone-1"), null);
    assert.equal(p.decision, "allow", "answered through its hook");
    assert.ok(!standing.has(p));
    assert.equal(ui.state.permission, null, "the card is gone");
    assert.equal(phoneHub.promptUp?.(id), false);
    // Again, from another phone: gone.
    assert.equal(phoneHub.permission(id, "deny", "phone-2"), "prompt_gone");
    assert.equal(p.decision, "allow");
  });

  test("exact by id: two standing, a Deny answers the one it names, the other stays up (oldest first on the card)", () => {
    const older = new Prompt("lacy-2");
    const newer = new Prompt("lacy-2");
    stand(older);
    stand(newer);
    writeState();
    assert.equal(ui.state.permission?.id, promptId(older), "oldest first on the Mac's card");
    assert.deepEqual(
      ui.state.queuedPermissions?.map((q) => q.id),
      [promptId(newer)],
      "the other one queued on the phone",
    );
    assert.equal(phoneHub.permission(promptId(newer), "deny", "phone-1"), null);
    assert.deepEqual([older.decision, newer.decision], [null, "deny"]);
    assert.equal(ui.state.permission?.id, promptId(older));
    assert.equal(phoneHub.permission(promptId(older), "always", "phone-1"), null);
    assert.equal(older.decision, "allow", "Always where it can't be for good: once");
    assert.equal(ui.state.permission, null);
  });

  test("answered in its own window while its hook is held: its session listed blocked, then not: taken down everywhere, its hook let go", () => {
    const p = new Prompt("lacy-4");
    stand(p);
    const id = promptId(p);
    const session = (status: string) => [{ ...makeSession({ name: "lacy" }), sessionId: "lacy-4", status }];
    sessionsListed(session("blocked"));
    assert.ok(standing.has(p), "its dialog up beside it: still standing");
    sessionsListed(session("busy"));
    assert.ok(!standing.has(p), "the dialog answered there");
    assert.equal(p.decision, "released", "nothing more comes through its hook");
    assert.equal(ui.state.permission, null);
    assert.equal(phoneHub.permission(id, "allow", "phone-1"), "prompt_gone");
  });

  test("answered in its terminal during its voice window (listed blocked while asked, then not): nothing stands, its hook let go, nothing said", () => {
    const p = new Prompt("lacy-7");
    noteHeld(p);
    floor.queue.push(p); // held on the floor meanwhile (being asked, or in line)
    try {
      sessionsListed(listing("lacy-7", "blocked"));
      sessionsListed(listing("lacy-7", "busy"));
      const lines = linesDuring(() => assert.equal(stands(p), true, "taken off the floor"));
      assert.ok(!standing.has(p), "not standing: it was answered there");
      assert.equal(p.decision, "released");
      assert.deepEqual(lines, []);
    } finally {
      floor.queue.splice(floor.queue.indexOf(p), 1);
    }
  });

  test("its hold limit: let go, its card gone, and the phone gets the note with nothing to press", async () => {
    const notes: string[][] = [];
    const phone = state.phone;
    state.phone = { promptLetGo: (...a: string[]) => void notes.push(a) } as unknown as typeof state.phone;
    try {
      const p = new Prompt("lacy-8");
      stand(p);
      const id = promptId(p);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(standing.has(p), "not yet");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(!standing.has(p));
      assert.equal(p.decision, "released", "its hook let go: Claude Code's own dialog has it");
      assert.deepEqual(notes, [[id, "lacy-8", "lacy", "lacy asked to run: npm test — waiting in its terminal"]]);
      writeState();
      assert.equal(ui.state.permission, null);
      assert.equal(phoneHub.permission(id, "allow", "phone-1"), "prompt_gone");
    } finally {
      state.phone = phone;
    }
  });

  test("two prompts of one session: answered in its terminal, both come down; the session's next prompt stands on its own", () => {
    const a = new Prompt("lacy-9");
    const b = new Prompt("lacy-9");
    stand(a);
    stand(b);
    sessionsListed(listing("lacy-9", "blocked"));
    writeState();
    assert.equal(ui.state.permission?.id, promptId(a));
    assert.deepEqual(
      ui.state.queuedPermissions?.map((q) => q.id),
      [promptId(b)],
    );
    sessionsListed(listing("lacy-9", "busy"));
    assert.deepEqual([standing.has(a), standing.has(b)], [false, false], "its dialogs answered there");
    const c = new Prompt("lacy-9");
    stand(c);
    sessionsListed(listing("lacy-9", "busy"));
    assert.ok(standing.has(c), "a new one isn't taken down by what was seen before it");
  });

  test("never listed blocked: a listing alone doesn't take it down; its session's next Stop does", () => {
    const p = new Prompt("lacy-5");
    stand(p);
    sessionsListed([{ ...makeSession({ name: "lacy" }), sessionId: "lacy-5", status: "busy" }]);
    assert.ok(standing.has(p));
    turnEnded("lacy-5");
    assert.ok(!standing.has(p));
    assert.equal(p.decision, "released");
  });

  test("its session listed blocked, then gone from the list (its process ended, its hook left running): after two listings without it, taken down everywhere, no needs-you", () => {
    const p = new Prompt("live-check-tmp");
    stand(p);
    const id = promptId(p);
    const live = { ...makeSession({ name: "live-check-tmp" }), sessionId: "live-check-tmp", status: "blocked" };
    const lacy = { ...makeSession({ name: "lacy" }), sessionId: "lacy-6", status: "idle" };
    ui.set({ sessions: [live, lacy] });
    sessionsListed(ui.state.sessions);
    writeState();
    assert.equal(sessionStatus(live, ui.state), "needs_you");
    assert.equal(ui.state.permission?.id, id, "on the Mac's card while it runs");
    ui.set({ sessions: [lacy] });
    sessionsListed(ui.state.sessions);
    assert.ok(standing.has(p), "one listing without it may be a listing that failed");
    ui.set({ sessions: [lacy] });
    sessionsListed(ui.state.sessions);
    assert.ok(!standing.has(p), "gone from two listings: ended");
    assert.equal(p.decision, "released", "its orphaned hook let go");
    writeState();
    assert.equal(ui.state.permission, null, "the Mac's card is gone");
    assert.deepEqual(ui.state.queuedPermissions, [], "nothing queued for the phone");
    assert.equal(standingCard(), null);
    assert.deepEqual(waitingOn(ui.state), [], "no needs-you on the bottom line");
    assert.equal(phoneHub.permission(id, "allow", "phone-1"), "prompt_gone");
    ui.set({ sessions: [] });
  });

  test("its hook closed while it stood (answered in its terminal): taken down, and an Allow after gets prompt_gone", () => {
    const p = new Prompt("lacy-3");
    stand(p);
    const id = promptId(p);
    p.closed = true;
    assert.equal(standing.gone(p), true);
    writeState();
    assert.equal(ui.state.permission, null);
    assert.equal(phoneHub.permission(id, "allow", "phone-1"), "prompt_gone");
    assert.equal(p.decision, null, "nothing sent to a hook that's gone");
  });
});

/** A prompt whose agent watches for an answer in its own window (Claude Code's: agents/claude-code/answered-there.ts): `answer` is it seen. */
class Watched extends Prompt {
  seen: ((sign: string) => void) | null = null;
  watchAnswered(answered: (sign: string) => void) {
    this.seen = answered;
  }
}

/** The lines logged as `event` since `from` (the log file's length then). */
function loggedSince(from: number, event: string) {
  return readFileSync(join(process.env.KIKO_LOG_DIR!, LOG_FILE), "utf8")
    .slice(from)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === event);
}
const logLength = () => {
  try {
    return readFileSync(join(process.env.KIKO_LOG_DIR!, LOG_FILE), "utf8").length;
  } catch {
    return 0;
  }
};

describe("answered in its agent's own window, as its agent sees it (no listing)", () => {
  afterEach(() => standing.releaseAll());

  test("standing: taken down at once, its hook let go, logged; an Allow after gets prompt_gone", () => {
    const p = new Watched("lacy-w1");
    watchHeld(p);
    stand(p);
    const id = promptId(p);
    const from = logLength();
    p.seen!("tool_result");
    assert.ok(!standing.has(p));
    assert.equal(p.decision, "released");
    assert.deepEqual(
      loggedSince(from, "permission_answered_there").map((l) => [l.sessionId, l.sign]),
      [["lacy-w1", "tool_result"]],
    );
    assert.deepEqual(
      loggedSince(from, "permission_stand_gone").map((l) => l.how),
      ["terminal"],
    );
    writeState();
    assert.equal(ui.state.permission, null);
    assert.equal(phoneHub.permission(id, "allow", "phone-1"), "prompt_gone");
  });

  test("on the floor in its voice window (being asked out loud): dropped as a hook that closed, nothing more asked, nothing stands", () => {
    const p = new Watched("lacy-w2");
    noteHeld(p);
    watchHeld(p);
    floor.current = p;
    const from = logLength();
    const stopped: string[] = [];
    const { stopTalking, writeState: written } = hooks;
    hooks.stopTalking = ((why: string) => void stopped.push(why)) as typeof hooks.stopTalking;
    hooks.writeState = writeState;
    let lines: string[];
    try {
      lines = linesDuring(() => p.seen!("dialog_closed"));
    } finally {
      Object.assign(hooks, { stopTalking, writeState: written });
    }
    assert.equal(floor.current, null, "off the floor");
    assert.deepEqual(stopped, ["hook_closed"], "no longer asked out loud");
    assert.equal(p.decision, "released", "its hook let go");
    assert.ok(!standing.has(p));
    assert.deepEqual(lines, ["(lacy stopped waiting)"], "shown, never said");
    assert.deepEqual(
      loggedSince(from, "permission_answered_there").map((l) => l.sign),
      ["dialog_closed"],
    );
    assert.equal(stands(p), false, "its window can't make it stand after");
  });

  test("still in line: taken out of it; answered from Kiko first, nothing happens", () => {
    const p = new Watched("lacy-w3");
    noteHeld(p);
    watchHeld(p);
    floor.queue.push(p);
    p.seen!("tool_result");
    assert.ok(!floor.queue.includes(p), "out of line");
    assert.equal(p.decision, "released");
    const q = new Watched("lacy-w4");
    watchHeld(q);
    stand(q);
    q.allow(false);
    const from = logLength();
    q.seen!("tool_result");
    assert.equal(q.decision, "allow", "its answer stands");
    assert.deepEqual(loggedSince(from, "permission_answered_there"), []);
  });

  test("a hook that closed as answered in its own window (OpenCode's permission.replied): gone as `terminal`, else `hook_closed`", () => {
    const a = new Prompt("lacy-w5");
    stand(a);
    Object.assign(a, { closedHow: "terminal" as const, closed: true });
    const from = logLength();
    assert.equal(closedStanding(a), true);
    const b = new Prompt("lacy-w6");
    stand(b);
    b.closed = true;
    assert.equal(closedStanding(b), true);
    assert.deepEqual(
      loggedSince(from, "permission_stand_gone").map((l) => [l.sessionId, l.how]),
      [
        ["lacy-w5", "terminal"],
        ["lacy-w6", "hook_closed"],
      ],
    );
  });

  test("a Codex prompt (no prompt of Codex's while its hook is held): standing, said to be only on its card", () => {
    const p = new Prompt("codex-w7");
    Object.assign(p, { onlyHere: true });
    const lines = linesDuring(() => stand(p));
    assert.deepEqual(lines, ["(no answer yet; still on its card)"]);
    const q = new Prompt("lacy-w8");
    assert.deepEqual(
      linesDuring(() => stand(q)),
      ["(no answer yet; still on its card and its terminal)"],
      "Claude Code's: its dialog is beside it",
    );
  });
});
