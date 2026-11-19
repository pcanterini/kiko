// A quick task's permission prompts in the app (src/core/quick-ask.ts): what's denied without asking,
// what "always" keeps and where, the prompt as the floor holds it (allow, always, deny, let go, gone),
// and the offer of a session after a quick task that couldn't check something (decide.ts handOff).
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { HookHeld, type HookEvent } from "../../../src/agents/claude-code/hooks.ts";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import {
  alwaysRuleOf,
  deniedOutright,
  HAND_OFF_LINE,
  isQuickCheck,
  loadQuickAlways,
  offersHandOff,
  QUICK_ALWAYS_FILE,
  QUICK_CHECK_NAME,
  QuickAsk,
  quickAskLine,
  quickVerdict,
  quickWhat,
  rememberQuickAlways,
} from "../../../src/core/quick-ask.ts";
import { SETTINGS_FILE } from "../../../src/core/settings.ts";
import { makeWorld, type VoiceCan } from "../../support/fixtures.ts";

const bash = (command: string) => ({ name: "Bash", input: { command } });

describe("denied without asking: what would change things", () => {
  for (const tool of ["Edit", "MultiEdit", "Write", "NotebookEdit"]) {
    test(tool, () => assert.match(deniedOutright({ name: tool, input: { file_path: "/a" } })!, /can't change files/));
  }
  test("any MCP tool", () => assert.ok(deniedOutright({ name: "mcp__kiko__permission", input: {} })));
  for (const command of [
    "git commit -m x",
    "git push",
    "git -C ~/x reset --hard",
    "git checkout main",
    "git branch new-thing",
    "git branch -D old",
    "git stash",
    "git stash pop",
    "git tag v1",
    "git config user.name x",
    "git diff --output=/tmp/x",
    "cd ~/x && git add .",
    "git status; git commit -am wip",
    "FOO=1 git clean -fd",
    "/usr/bin/git rm a",
    "echo $(git rev-parse HEAD) && git push",
  ]) {
    test(`Bash: ${command}`, () => assert.match(deniedOutright(bash(command))!, /can't change a git repository/));
  }
  for (const command of [
    "git status",
    "git -C ~/x log --oneline -5",
    "git --no-pager diff",
    "git branch",
    "git branch --show-current",
    "git branch -a",
    "git remote -v",
    "git stash list",
    "git tag",
    "git config --get user.email",
    "git log | head -3",
    "whois pebble.com",
    "curl -sI https://pebble.com",
    "python3 -c 'print(1)'",
    "docker system df",
  ]) {
    test(`asked, not denied: ${command}`, () => assert.equal(deniedOutright(bash(command)), null));
  }
  // Since 2026-11-05 (quick checks in auto mode): every change the guard hook reads, not only git's.
  for (const command of ["rm -rf ~/x", "echo hi > notes.txt", "docker rm web", "docker system prune -af", "curl -d a=b https://example.com", "kill 123", "brew install jq", "ssh box uptime"]) {
    test(`Bash: ${command}`, () => assert.match(deniedOutright(bash(command))!, /only looks, and this would change something/));
  }
  test("the web is asked", () => {
    assert.equal(deniedOutright({ name: "WebFetch", input: { url: "https://x.dev" } }), null);
    assert.equal(deniedOutright({ name: "WebSearch", input: { query: "pebble" } }), null);
  });
});

describe('"always": that exact command, in quick checks, kept with the settings', () => {
  test("next to the settings file, never Claude Code's", () => {
    assert.equal(QUICK_ALWAYS_FILE, join(join(SETTINGS_FILE, ".."), "quick-always.json"));
    assert.ok(!QUICK_ALWAYS_FILE.includes(".claude"));
  });
  test("a command, exactly; nothing for the web or other tools", () => {
    assert.equal(alwaysRuleOf(bash("  whois pebble.com ")), "whois pebble.com");
    assert.equal(alwaysRuleOf({ name: "WebFetch", input: { url: "https://x" } }), null);
    assert.equal(alwaysRuleOf({ name: "WebSearch", input: { query: "x" } }), null);
    assert.equal(alwaysRuleOf({ name: "Read", input: { file_path: "/x" } }), null);
    assert.equal(alwaysRuleOf(null), null);
  });
  test("kept, read back, once each", () => {
    const file = join(mkdtempSync(join(tmpdir(), "qa-")), "sub", "quick-always.json");
    assert.deepEqual(loadQuickAlways(file), []);
    assert.ok(rememberQuickAlways("whois pebble.com", file));
    assert.ok(rememberQuickAlways("whois pebble.com", file));
    assert.ok(rememberQuickAlways("dig pebble.dev", file));
    assert.deepEqual(loadQuickAlways(file), ["whois pebble.com", "dig pebble.dev"]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { commands: ["whois pebble.com", "dig pebble.dev"] });
  });
  test("the verdict: denied first, then always, else asked", () => {
    const always = ["whois pebble.com", "git commit -m x"];
    assert.deepEqual(quickVerdict(bash("whois pebble.com"), always), { verdict: "allow", why: "always" });
    assert.deepEqual(quickVerdict(bash("whois pebble.dev"), always), { verdict: "ask" });
    assert.equal(quickVerdict(bash("git commit -m x"), always).verdict, "deny", "a writing command kept by hand still isn't run");
    assert.deepEqual(quickVerdict({ name: "WebFetch", input: { url: "https://x" } }, always), { verdict: "ask" });
  });
});

describe("how it's named and asked", () => {
  test("Kiko's quick check, not a session", () => {
    assert.equal(QUICK_CHECK_NAME, "Kiko's quick check");
    assert.ok(isQuickCheck("kiko"));
    assert.ok(!isQuickCheck("term-1"));
    assert.ok(!isQuickCheck(null));
  });
  test("the question", () => {
    const what = quickWhat(bash("whois  pebble.com"), "run: whois pebble.com");
    assert.equal(what, "run whois pebble.com");
    assert.equal(quickAskLine(what), "Kiko's quick check wants to run whois pebble.com. Allow?");
    assert.equal(quickWhat({ name: "WebFetch", input: { url: "https://x.dev" } }, "fetch https://x.dev"), "fetch https://x.dev");
  });
});

/** The hook's held prompt, keeping what it would send the permission server. */
class Kept extends HookHeld {
  sent: Record<string, unknown> | null = null;
  get open() {
    return this.sent === null;
  }
  protected send(payload: Record<string, unknown>) {
    if (this.sent) return false;
    this.sent = payload;
    return true;
  }
}
const event = (tool_name: string, tool_input: Record<string, unknown>): HookEvent => ({ hook_event_name: "PermissionRequest", session_id: "kiko", cwd: homedir(), tool_name, tool_input });
function held(tool_name = "Bash", tool_input: Record<string, unknown> = { command: "whois pebble.com" }) {
  const inner = new Kept(event(tool_name, tool_input));
  const remembered: string[] = [];
  let done = 0;
  const ask = new QuickAsk(inner, { remember: (c) => remembered.push(c), done: () => done++ });
  return { inner, ask, remembered, done: () => done };
}

describe("the prompt as the floor holds it", () => {
  test("a permission, from the quick check, with its tool", () => {
    const { ask } = held();
    assert.equal(ask.isPermission, true);
    assert.equal(ask.sessionId, "kiko");
    assert.deepEqual(ask.tool, bash("whois pebble.com"));
    assert.equal(ask.questions, null);
    assert.equal(ask.open, true);
  });
  test("allow: allowed, nothing kept, done once", () => {
    const h = held();
    assert.ok(h.ask.allow(false));
    assert.deepEqual(h.inner.sent, { decision: { behavior: "allow" } });
    assert.deepEqual(h.remembered, []);
    assert.equal(h.done(), 1);
    assert.equal(h.ask.open, false);
    assert.equal(h.ask.allow(false), false);
    assert.equal(h.done(), 1);
  });
  test("always: the command kept by Kiko; Claude Code is told a plain allow", () => {
    const h = held();
    assert.ok(h.ask.canAllowAlways);
    h.ask.allow(true);
    assert.deepEqual(h.remembered, ["whois pebble.com"]);
    assert.deepEqual(h.inner.sent, { decision: { behavior: "allow" } });
  });
  test("the web: never always", () => {
    const h = held("WebFetch", { url: "https://pebble.com" });
    assert.equal(h.ask.canAllowAlways, false);
    h.ask.allow(true);
    assert.deepEqual(h.remembered, []);
  });
  test("deny: denied with why", () => {
    const h = held();
    h.ask.deny('The user said no by voice: "no"');
    assert.deepEqual(h.inner.sent, { decision: { behavior: "deny", message: 'The user said no by voice: "no"' } });
    assert.equal(h.done(), 1);
  });
  test("let go (its window ran out): a no, never left for a terminal", () => {
    const h = held();
    h.ask.release();
    assert.deepEqual(h.inner.sent, { decision: { behavior: "deny", message: "Nobody answered in time." } });
    assert.equal(h.done(), 1);
  });
  test("gone first (the quick check ended): done, and the floor told", () => {
    const h = held();
    let closed = 0;
    h.ask.onClosed = () => closed++;
    h.inner.onClosed();
    assert.equal(closed, 1);
    assert.equal(h.done(), 1);
  });
});

describe("the offer of a session after a quick task", () => {
  const r = (outcome: string, denied: string[] = []) => ({ outcome, denied });
  test("when it couldn't check something, or needs changes", () => {
    assert.ok(offersHandOff(r("answered", ["Bash: whois pebble.com"])));
    assert.ok(offersHandOff(r("failed", ["WebFetch: https://x"])));
    assert.ok(offersHandOff(r("needs_changes")));
    assert.ok(!offersHandOff(r("answered")));
    assert.ok(!offersHandOff(r("failed")));
    assert.ok(!offersHandOff(r("cancelled", ["Bash: x"])));
    assert.ok(!offersHandOff(r("timeout", ["Bash: x"])));
    assert.equal(HAND_OFF_LINE, "I couldn't check that quickly. Want me to open a session for it?");
  });

  const world = makeWorld([]);
  const TASK = "Check whether pebble.com, .dev and .io are available.";
  async function decideAfterOffer(text: string, handOff: DecideState["handOff"], voiceCan: VoiceCan = "everything") {
    let routed = 0;
    const deps: DecideDeps = {
      utterance: null,
      approval: null,
      route: async () => {
        routed++;
        return { text: "", actions: [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
      },
      trim: null,
    };
    const state: DecideState = {
      text,
      sessions: world.sessions,
      notes: world.notes,
      recent: [`app said: ${HAND_OFF_LINE}`],
      waiting: null,
      justSpoke: null,
      lastId: null,
      appAsked: true,
      lastSent: null,
      lastRepeat: false,
      voiceCan,
      handOff,
      classifierMinConfidence: 0.75,
    };
    return { ...(await decide(state, deps)), routed };
  }
  test("yes: a session in its folder, with the task as its prompt; no router", async () => {
    // From the home folder (no project's): a scratch folder, not ~.
    const d = await decideAfterOffer("Yes, please.", { task: TASK, cwd: homedir() });
    assert.equal(d.step, "hand-off");
    assert.deepEqual(d.actions, [{ type: "start", where: { kind: "scratch", said: null }, name: "", prompt: TASK }]);
    assert.equal(d.routed, 0);
    const volume = await decideAfterOffer("Sure.", { task: "Set the computer volume to 10%.", cwd: homedir() });
    assert.deepEqual(volume.actions, [{ type: "start", where: { kind: "scratch", said: null }, name: "", prompt: "Set the computer volume to 10%." }]);
    // ~ when you say so.
    const home = await decideAfterOffer("Yes, but in my home folder.", { task: TASK, cwd: homedir() });
    assert.deepEqual(home.actions, [{ type: "start", where: { kind: "home", cwd: homedir() }, name: "", prompt: TASK }]);
    const there = await decideAfterOffer("Sure.", { task: TASK, cwd: "/Users/x/code/pixie" });
    assert.deepEqual(there.actions, [{ type: "start", where: { kind: "project", cwd: "/Users/x/code/pixie", how: "exact", name: "pixie", said: "pixie" }, name: "", prompt: TASK }]);
  });
  test("no: left, said so", async () => {
    const d = await decideAfterOffer("No, leave it.", { task: TASK, cwd: homedir() });
    assert.deepEqual(d.actions, [{ type: "say", text: "Okay, I'll leave it.", why: "hand_off_declined" }]);
  });
  test("starting sessions not allowed by voice: refused", async () => {
    const d = await decideAfterOffer("Yes.", { task: TASK, cwd: homedir() }, "messages");
    assert.deepEqual(
      d.actions.map((a) => [a.type, (a as any).what, (a as any).then?.type, (a as any).then?.prompt]),
      [["refused", "start", "start", TASK]],
    );
  });
  test("anything else: the router, as for any question the app asked", async () => {
    const d = await decideAfterOffer("What would it need?", { task: TASK, cwd: homedir() });
    assert.equal(d.step, "app-question");
    assert.equal(d.routed, 1);
  });
});
