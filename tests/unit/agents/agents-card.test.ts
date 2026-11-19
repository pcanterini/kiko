// Connecting your agents (src/agents/setup.ts, src/ui/agents-card.ts): which agents are found and
// where each stands, which the first-run card offers, the card as its popup draws it (a checklist in
// src/ui/menu-view.ts), its answer carried out and remembered (agentAnswers, in this test's own
// settings file), and an agent found later offered once. Fake setups for most of it; the real ones'
// detection with a PATH and folders of this test's own.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { agents } from "../../../src/agents/index.ts";
import { claudeCodeSetup } from "../../../src/agents/claude-code/setup.ts";
import { codexSetup } from "../../../src/agents/codex/setup.ts";
import { t3 } from "../../../src/agents/t3code/index.ts";
import { t3codeSetup, t3Running } from "../../../src/agents/t3code/setup.ts";
import {
  agentNamed,
  agentWords,
  answerCard,
  answersOf,
  cardMessage,
  cardRows,
  cardSaid,
  foundRows,
  labelOf,
  notInstalledLine,
  SETUPS,
  startWarning,
  statusOf,
  type CardRow,
} from "../../../src/agents/setup.ts";
import type { AgentSetup, SetupState } from "../../../src/agents/types.ts";
import { agentChoices } from "../../../src/core/settings-options.ts";
import { loadSettings, rememberAgents, SETTINGS_FILE } from "../../../src/core/settings.ts";
import { agentsCard, cardAnswer } from "../../../src/ui/agents-card.ts";
import { menuSize, MenuView } from "../../../src/ui/menu-view.ts";

/** A made-up agent: where it stands (changed by connect), and what connecting it did. */
type Fake = AgentSetup & { now: SetupState; connected: number };
function fake(id: string, name: string, state: SetupState, extra: Partial<AgentSetup> = {}): Fake {
  const s: Fake = {
    id,
    name,
    about: "",
    now: state,
    connected: 0,
    file: () => `~/.${id}/hooks.json`,
    installed: () => s.now !== "not installed",
    status: () => ({ state: s.now, detail: s.now === "not connected" ? `adds hooks to ~/.${id}/hooks.json` : s.now === "automatic" ? "connects by itself when it's running" : s.now }),
    connect: () => {
      s.connected++;
      s.now = "connected";
      return { file: `/home/${id}/hooks.json`, events: ["Stop"], backup: `/home/${id}/hooks.json.bak` };
    },
    disconnect: () => ({ file: "", events: [], backup: null }),
    ...extra,
  };
  return s;
}

describe("setup's line for the agents it works with that aren't on this Mac (notInstalledLine)", () => {
  test("the ones not installed, by name, in the card's order; null when every one is found", () => {
    const all = [
      fake("claude-code", "Claude Code", "connected"),
      fake("codex", "Codex", "not installed", { label: "Codex CLI" }),
      fake("opencode", "OpenCode", "not installed"),
      fake("t3code", "T3 Code", "automatic"),
    ];
    assert.equal(notInstalledLine(all), "Also works with: Codex CLI, OpenCode (not installed here).");
    assert.equal(notInstalledLine(all.slice(0, 1)), null);
  });
});

describe("which agents the card shows, and which it asks about", () => {
  test("found and not connected: asked, ticked; connected: shown (setup lists it ticked); automatic (T3 Code): asked, ticked; not installed: left out", () => {
    const rows = cardRows({}, [
      fake("claude-code", "Claude Code", "not connected"),
      fake("codex", "Codex", "connected", { label: "Codex CLI" }),
      fake("t3code", "T3 Code", "automatic", { connect: undefined }),
      fake("pi", "Pi", "not installed"),
    ]);
    assert.deepEqual(rows, [
      { id: "claude-code", name: "Claude Code", state: "not connected", detail: "adds hooks to ~/.claude-code/hooks.json", ask: true, ticked: true, hint: "adds hooks to ~/.claude-code/hooks.json" },
      { id: "codex", name: "Codex CLI", state: "connected", detail: "connected", ask: false, ticked: true, hint: "connected" },
      { id: "t3code", name: "T3 Code", state: "automatic", detail: "connects by itself when it's running", ask: true, ticked: true, hint: "connects by itself when it's running" },
    ]);
  });
  test("listed by label where there's one: Codex CLI (not the desktop app); the others by name; Codex still Codex where it's said", () => {
    assert.deepEqual(SETUPS.map(labelOf), ["Claude Code", "Codex CLI", "OpenCode", "T3 Code"]);
    assert.equal(codexSetup.name, "Codex");
  });
  test("nothing to offer (all connected, or answered before): no card", () => {
    assert.equal(cardRows({ t: "yes" }, [fake("a", "A", "connected"), fake("t", "T", "automatic", { connect: undefined })]), null);
    assert.equal(cardRows({ t: "no" }, [fake("t", "T", "not connected", { connect: undefined })]), null);
    assert.equal(cardRows({ a: "later", b: "no" }, [fake("a", "A", "not connected"), fake("b", "B", "needs repair")]), null);
  });
  test("setup's list (foundRows): every one found, card or not; answered ones unticked, with where they stand", () => {
    const rows = foundRows({ a: "no", b: "no", t: "no" }, [
      fake("a", "A", "not connected"),
      fake("b", "B", "needs repair", { status: () => ({ state: "needs repair", detail: "its hooks never fired (B 1.0)" }) }),
      fake("c", "C", "connected"),
      fake("t", "T3 Code", "not connected", { connect: undefined, status: () => ({ state: "not connected", detail: "off: Kiko leaves it alone" }) }),
    ]);
    assert.deepEqual(
      rows.map((r) => [r.id, r.ask, r.ticked, r.hint]),
      [
        ["a", false, false, "adds hooks to ~/.a/hooks.json"],
        ["b", false, false, "needs repair: its hooks never fired (B 1.0)"],
        ["c", false, true, "connected"],
        ["t", false, false, "off: Kiko leaves it alone"],
      ],
    );
  });
  test("an agent answered before is shown as skipped, not asked; needs repair is asked (Enter fixes it)", () => {
    const rows = cardRows({ a: "no" }, [fake("a", "A", "not connected"), fake("b", "B", "needs repair")])!;
    assert.deepEqual(
      rows.map((r) => [r.id, r.ask, r.detail]),
      [
        ["a", false, "skipped: settings → Agents connects it"],
        ["b", true, "needs repair: Enter fixes it"],
      ],
    );
  });
  test("a file that isn't JSON isn't offered (Kiko leaves it alone)", () => {
    const broken = fake("a", "A", "needs repair", { status: () => ({ state: "needs repair", detail: "isn't valid JSON", unreadable: true }) });
    assert.equal(cardRows({}, [broken]), null);
  });
  test("a hook-health check makes a connected agent need repair, and the card offers it", () => {
    const quiet = fake("codex", "Codex", "connected", { health: () => "its hooks never fired (Codex 0.166.0)" });
    assert.deepEqual(statusOf(quiet), { state: "needs repair", detail: "its hooks never fired (Codex 0.166.0)" });
    assert.equal(cardRows({}, [quiet])![0].ask, true);
    assert.equal(statusOf(fake("c", "C", "connected", { health: () => null })).state, "connected");
  });
  test("signed in, when an agent can tell, is said beside it", () => {
    const rows = cardRows({}, [fake("a", "A", "not connected", { signedIn: () => true })])!;
    assert.match(rows[0].detail, / · signed in$/);
  });
});

describe("the card's answer, carried out and remembered", () => {
  beforeEach(() => rmSync(SETTINGS_FILE, { force: true }));

  test("Enter: the ticked ones connected (their answer forgotten), the unticked remembered as no", () => {
    const a = fake("a", "Claude Code", "not connected");
    const b = fake("b", "Codex", "not connected", { afterConnect: "Codex asks you to trust them once, at its next start." });
    const answer = { offered: ["a", "b"], connect: ["b"], later: false };
    const { outcomes, answers } = answerCard(answer, [a, b]);
    assert.equal(a.connected, 0);
    assert.equal(b.connected, 1);
    assert.deepEqual(answers, { a: "no", b: null });
    assert.deepEqual(
      outcomes.map((o) => [o.id, o.did]),
      [["b", "connected"]],
    );
    assert.equal(cardMessage(answer, outcomes, [a, b]), "Connected Codex. Skipped Claude Code: settings → Agents connects it any time.");
  });
  test("said short: what's connected in a line (by label), then what's left to do, only for the ones connected now", () => {
    const claude = fake("claude-code", "Claude Code", "not connected", { restartOpen: true });
    const codex = fake("codex", "Codex", "not connected", { label: "Codex CLI", restartOpen: true, nextStart: "Codex asks once to trust its hooks" });
    const opencode = fake("opencode", "OpenCode", "not connected", { linkWords: "Kiko listens to OpenCode's background service" });
    const t3code = fake("t3code", "T3 Code", "automatic", { connect: undefined, disconnect: undefined });
    const setups = [claude, codex, opencode, t3code];
    const all = { offered: setups.map((s) => s.id), connect: setups.map((s) => s.id), later: false };
    assert.deepEqual(cardSaid(all, answerCard(all, setups).outcomes, setups), {
      said: "Connected Claude Code, Codex CLI, OpenCode and T3 Code.",
      todo: "Restart Claude Code or Codex sessions that are already open; Codex asks once to trust its hooks.",
    });
    // Codex connected before (no outcome): nothing about it to do.
    const fresh = [
      fake("claude-code", "Claude Code", "not connected", { restartOpen: true }),
      fake("codex", "Codex", "connected", { label: "Codex CLI", restartOpen: true, nextStart: "Codex asks once to trust its hooks" }),
    ];
    const one = { offered: ["claude-code", "codex"], connect: ["claude-code", "codex"], later: false };
    assert.deepEqual(cardSaid(one, answerCard(one, fresh).outcomes, fresh), { said: "Connected Claude Code.", todo: "Restart Claude Code sessions that are already open." });
    // Nothing to restart (OpenCode): no second line.
    const quiet = [fake("opencode", "OpenCode", "not connected")];
    const oc = { offered: ["opencode"], connect: ["opencode"], later: false };
    assert.deepEqual(cardSaid(oc, answerCard(oc, quiet).outcomes, quiet), { said: "Connected OpenCode.", todo: "" });
    assert.doesNotMatch(cardMessage(all, [], setups), /hooks in|backed up|~\//);
  });
  test("one that needed repair is repaired; one that fails isn't remembered (offered again)", () => {
    const broken = fake("a", "A", "needs repair");
    const failing = fake("b", "B", "not connected", {
      connect: () => {
        throw new Error("EACCES");
      },
    });
    const { outcomes, answers } = answerCard({ offered: ["a", "b"], connect: ["a", "b"], later: false }, [broken, failing]);
    assert.deepEqual(
      outcomes.map((o) => o.did),
      ["repaired", "failed"],
    );
    assert.deepEqual(answers, { a: null, b: null });
  });
  test("Esc (later): every one offered remembered as later, nothing connected", () => {
    const a = fake("a", "A", "not connected");
    const answer = { offered: ["a"], connect: [], later: true };
    const { outcomes, answers } = answerCard(answer, [a]);
    assert.deepEqual([outcomes, answers, a.connected], [[], { a: "later" }, 0]);
    assert.equal(cardMessage(answer, outcomes, [a]), "Not now, then: settings → Agents connects it any time.");
  });
  test("remembered in the settings: the card doesn't come back; an agent found later is offered once", () => {
    const claude = fake("claude-code", "Claude Code", "not connected");
    const codex = fake("codex", "Codex", "not installed");
    const setups = [claude, codex];
    rememberAgents(answerCard({ offered: ["claude-code"], connect: [], later: true }, setups).answers);
    assert.deepEqual(loadSettings().agentAnswers, { "claude-code": "later" });
    assert.equal(cardRows(answersOf(loadSettings().agentAnswers), setups), null, "not asked again at the next start");
    // Next month, Codex is installed: offered once, the same card; Claude Code still skipped.
    codex.now = "not connected";
    const rows = cardRows(answersOf(loadSettings().agentAnswers), setups)!;
    assert.deepEqual(
      rows.filter((r) => r.ask).map((r) => r.id),
      ["codex"],
    );
    rememberAgents(answerCard({ offered: ["codex"], connect: [], later: false }, setups).answers);
    assert.deepEqual(loadSettings().agentAnswers, { "claude-code": "later", codex: "no" });
    assert.equal(cardRows(answersOf(loadSettings().agentAnswers), setups), null);
  });
  test("connecting one forgets its answer; the rest of the settings stay as they were", () => {
    rememberAgents({ a: "no", b: "later" });
    const saved = loadSettings();
    rememberAgents({ a: null });
    assert.deepEqual(loadSettings().agentAnswers, { b: "later" });
    rememberAgents({ b: null });
    assert.equal(loadSettings().agentAnswers, undefined);
    assert.deepEqual(
      Object.keys(saved).filter((k) => k !== "agentAnswers"),
      [],
    );
    assert.deepEqual(answersOf({ a: "no", b: "yes", c: 1, d: "maybe" }), { a: "no", b: "yes" });
    assert.deepEqual(answersOf(null), {});
  });
  test("T3 Code (nothing to set up): ticked, nothing written, a yes kept; unticked, a no; neither connects anything", () => {
    const claude = fake("claude-code", "Claude Code", "not connected");
    const t3code = fake("t3code", "T3 Code", "automatic", { connect: undefined, disconnect: undefined });
    const setups = [claude, t3code];
    const on = { offered: ["claude-code", "t3code"], connect: ["claude-code", "t3code"], later: false };
    const yes = answerCard(on, setups);
    assert.deepEqual(yes.answers, { "claude-code": null, t3code: "yes" });
    assert.deepEqual(
      yes.outcomes.map((o) => [o.id, o.did]),
      [["claude-code", "connected"]],
      "no outcome for T3: nothing done",
    );
    assert.equal(cardMessage(on, yes.outcomes, setups), "Connected Claude Code and T3 Code.");
    rememberAgents(yes.answers);
    assert.equal(cardRows(answersOf(loadSettings().agentAnswers), setups), null, "not asked again");
    const off = { offered: ["t3code"], connect: [], later: false };
    const no = answerCard(off, [t3code]);
    assert.deepEqual([no.answers, no.outcomes], [{ t3code: "no" }, []]);
    assert.equal(cardMessage(off, no.outcomes, [t3code]), "Left T3 Code off: settings → Agents turns it on any time.");
    rememberAgents(no.answers);
    assert.deepEqual(loadSettings().agentAnswers, { t3code: "no" });
  });
  test("setup's list: a connected one left ticked stays as it is; unticked, it's disconnected (a no kept); one that can't be, said", () => {
    let disconnected = 0;
    const kept = fake("a", "Claude Code", "connected");
    const out = fake("b", "Codex", "connected", {
      disconnect: () => {
        disconnected++;
        return { file: "/home/b/hooks.json", events: ["Stop"], backup: "/home/b/hooks.json.bak" };
      },
    });
    const stuck = fake("c", "OpenCode", "connected", {
      disconnect: () => {
        throw new Error("EACCES");
      },
    });
    const answer = { offered: ["a", "b", "c"], connect: ["a"], later: false };
    const { outcomes, answers } = answerCard(answer, [kept, out, stuck]);
    assert.equal(kept.connected, 0, "not connected again");
    assert.equal(disconnected, 1);
    assert.deepEqual(answers, { a: null, b: "no", c: null });
    assert.deepEqual(
      outcomes.map((o) => [o.id, o.did]),
      [
        ["b", "disconnected"],
        ["c", "failed"],
      ],
    );
    assert.equal(cardMessage(answer, outcomes, [kept, out, stuck]), "Disconnected Codex. OpenCode wasn't disconnected: EACCES.");
  });
  test("at start without a card: a word when hooks need repair, or nothing is connected", () => {
    assert.match(startWarning([fake("a", "Claude Code", "needs repair")])!, /^Claude Code's hooks need repair \(needs repair\): settings → Agents fixes it\.$/);
    assert.match(startWarning([fake("a", "A", "not connected")])!, /^No agent is connected/);
    assert.equal(startWarning([fake("a", "A", "connected"), fake("b", "B", "not connected")]), null);
    assert.equal(startWarning([fake("t", "T3 Code", "automatic", { connect: undefined })]), null);
  });
});

describe("the card, as the popup draws it", () => {
  const rows: CardRow[] = [
    { id: "claude-code", name: "Claude Code", state: "not connected", detail: "adds hooks to ~/.claude/settings.json", ask: true },
    { id: "codex", name: "Codex", state: "not connected", detail: "adds hooks to ~/.codex/hooks.json", ask: true },
    { id: "t3code", name: "T3 Code", state: "automatic", detail: "not running", ask: false },
  ];
  const ask = (verb: string, arg: string) => [verb, arg];
  const card = () => new MenuView(agentsCard(rows, ask));
  const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

  test("everything found ticked, T3 Code shown but not a box; the hints at the bottom; fits the popup", () => {
    const menu = agentsCard(rows, ask);
    const size = menuSize(menu);
    assert.ok(size.width <= 60);
    assert.deepEqual(plain(new MenuView(menu).frame(size.width, size.height)).slice(0, 4), [
      " Which coding agents should Kiko talk to?",
      " [x] Claude Code   adds hooks to ~/.claude/settings.json",
      " [x] Codex         adds hooks to ~/.codex/hooks.json",
      "  ·  T3 Code       not running",
    ]);
    assert.match(plain(new MenuView(menu).frame(size.width, size.height)).at(-1)!, /Space ticks · Enter goes on · Esc later/);
  });
  test("Space unticks the one chosen, ↓ moves (never onto T3 Code), Enter connects the ticked ones", () => {
    const v = card();
    assert.deepEqual(v.key(" "), { kind: "none" });
    assert.match(plain(v.frame(60, 7))[1], /^ \[ \] Claude Code/);
    assert.deepEqual(v.key("\x1b[B"), { kind: "none" });
    assert.deepEqual(v.key("\x1b[B"), { kind: "none" }, "round the ends, over the boxes only");
    const picked = v.key("\r");
    assert.deepEqual(picked, {
      kind: "run",
      commands: [
        ["agentOn", "codex"],
        ["agents", "connect"],
      ],
    });
    const asks = (picked as { commands: string[][] }).commands.map(([verb, arg]) => ({ verb, arg }));
    assert.deepEqual(cardAnswer(asks, rows), { offered: ["claude-code", "codex"], connect: ["codex"], later: false });
  });
  test("Enter at once connects all of them; nothing ticked connects none (the rest remembered as no)", () => {
    const all = card().key("\r") as { commands: string[][] };
    assert.deepEqual(
      cardAnswer(
        all.commands.map(([verb, arg]) => ({ verb, arg })),
        rows,
      ).connect,
      ["claude-code", "codex"],
    );
    const v = card();
    v.key(" ");
    v.key("\x1b[B");
    v.key(" ");
    const none = v.key("\r") as { commands: string[][] };
    assert.deepEqual(
      cardAnswer(
        none.commands.map(([verb, arg]) => ({ verb, arg })),
        rows,
      ),
      { offered: ["claude-code", "codex"], connect: [], later: false },
    );
  });
  test("Escape (or Ctrl+C) is later; a click ticks a line", () => {
    assert.deepEqual(card().key("\x1b"), { kind: "run", commands: [["agents", "later"]] });
    assert.deepEqual(card().key("\x03"), { kind: "run", commands: [["agents", "later"]] });
    assert.deepEqual(cardAnswer([{ verb: "agents", arg: "later" }], rows), { offered: ["claude-code", "codex"], connect: [], later: true });
    const v = card();
    assert.deepEqual(v.click(1, 3), { kind: "none" });
    assert.match(plain(v.frame(60, 7))[2], /^ \[ \] Codex/);
    assert.deepEqual(v.click(1, 4), { kind: "none" }, "T3 Code: nothing");
  });
  test("an ask naming an agent the card didn't offer is ignored", () => {
    assert.deepEqual(
      cardAnswer(
        [
          { verb: "agentOn", arg: "t3code" },
          { verb: "agentOn", arg: "evil" },
          { verb: "agents", arg: "connect" },
        ],
        rows,
      ).connect,
      [],
    );
  });
});

describe("the real setups: found by PATH and folders of this test's own", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiko-detect-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const withEnv = (env: Record<string, string | undefined>, run: () => void) => {
    const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    try {
      run();
    } finally {
      for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  };

  test("Claude Code: claude on PATH, or its folder; neither: not installed", () => {
    withEnv({ PATH: bin, KIKO_CLAUDE_SETTINGS: join(dir, "no-claude", "settings.json") }, () => {
      assert.equal(claudeCodeSetup.installed(), false);
      assert.equal(claudeCodeSetup.status().state, "not installed");
      writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
      assert.equal(claudeCodeSetup.installed(), true);
      assert.deepEqual(claudeCodeSetup.status(), { state: "not connected", detail: `adds hooks to ${join(dir, "no-claude", "settings.json")}` });
      rmSync(join(bin, "claude"));
      mkdirSync(join(dir, "no-claude"));
      assert.equal(claudeCodeSetup.installed(), true, "its folder is there");
    });
  });
  test("Codex: codex on PATH, or its home", () => {
    withEnv({ PATH: bin, CODEX_HOME: join(dir, "no-codex") }, () => {
      assert.equal(codexSetup.status().state, "not installed");
      writeFileSync(join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
      assert.equal(codexSetup.status().state, "not connected");
      rmSync(join(bin, "codex"));
      mkdirSync(join(dir, "no-codex"));
      assert.equal(codexSetup.installed(), true);
    });
  });
  test("T3 Code: its CLI in its home; nothing to connect; in the app, Kiko's connection to it said", () => {
    withEnv({ KIKO_T3_HOME: join(dir, "t3") }, () => {
      assert.equal(t3codeSetup.status().state, "not installed");
      mkdirSync(join(dir, "t3", "bin"), { recursive: true });
      writeFileSync(join(dir, "t3", "bin", "t3"), "");
      const was = t3codeSetup.running;
      try {
        t3codeSetup.running = () => false;
        assert.deepEqual(t3codeSetup.status(), { state: "automatic", detail: "not running" });
        t3codeSetup.running = () => true;
        assert.equal(t3codeSetup.status().detail, "connected");
        // Said no to (setup, the card, settings → Agents' Turn off): off, connected or not.
        rememberAgents({ t3code: "no" });
        assert.deepEqual(t3codeSetup.status(), { state: "not connected", detail: "off: Kiko leaves it alone" });
        rememberAgents({ t3code: "yes" });
        assert.equal(t3codeSetup.status().state, "automatic");
      } finally {
        t3codeSetup.running = was;
        rmSync(SETTINGS_FILE, { force: true });
      }
      assert.equal(t3codeSetup.connect, undefined);
    });
  });
  test("T3 Code before Kiko connects (setup, the CLI): whether T3 itself runs, by its server's pid", () => {
    const home = join(dir, "t3-own");
    const runtime = join(home, "userdata", "server-runtime.json");
    mkdirSync(join(home, "bin"), { recursive: true });
    mkdirSync(join(home, "userdata"), { recursive: true });
    writeFileSync(join(home, "bin", "t3"), "");
    // A process that's surely gone: one that ran and was waited for.
    const gone = spawnSync("/usr/bin/true").pid!;
    withEnv({ KIKO_T3_HOME: home }, () => {
      const was = t3codeSetup.running;
      try {
        for (const unset of [null, () => null]) {
          t3codeSetup.running = unset;
          rmSync(runtime, { force: true });
          assert.equal(t3Running(home), false, "no runtime file: not running");
          assert.deepEqual(t3codeSetup.status(), { state: "automatic", detail: "nothing to add: Kiko connects while it's running" });
          writeFileSync(runtime, JSON.stringify({ pid: process.pid, port: 3773 }));
          assert.equal(t3Running(home), true);
          assert.deepEqual(t3codeSetup.status(), { state: "automatic", detail: "running: Kiko connects when it starts" });
          writeFileSync(runtime, JSON.stringify({ pid: gone, port: 3773 }));
          assert.equal(t3Running(home), false, "its server gone");
          assert.equal(t3codeSetup.status().detail, "nothing to add: Kiko connects while it's running");
          writeFileSync(runtime, "not json");
          assert.equal(t3Running(home), null, "can't tell");
          assert.equal(t3codeSetup.status().detail, "nothing to add: Kiko connects while it's running");
        }
        writeFileSync(runtime, JSON.stringify({ port: 3773 }));
        assert.equal(
          t3Running(home, () => true),
          null,
          "no pid in it",
        );
        writeFileSync(runtime, JSON.stringify({ pid: 4242 }));
        assert.equal(
          t3Running(home, (pid) => pid === 4242),
          true,
        );
      } finally {
        t3codeSetup.running = was;
      }
    });
  });
  test("T3 Code said no to: the app doesn't start its connection, nor lists its threads; once on again, it does", async () => {
    rmSync(SETTINGS_FILE, { force: true });
    const t3code = agents.find((a) => a.id === "t3code")!;
    try {
      rememberAgents({ t3code: "no" });
      await t3code.start();
      assert.equal(t3.keeping, false, "not started after a no");
      assert.deepEqual(await t3code.list(), []);
      rememberAgents({ t3code: "yes" });
      await t3code.start();
      assert.equal(t3.keeping, true, "started once it's on");
    } finally {
      t3code.stop();
      rmSync(SETTINGS_FILE, { force: true });
    }
    assert.equal(t3.keeping, false);
  });
  test("T3 Code, the app's own: before its connection starts, its setup looks for T3 itself", () => {
    // agents/index.ts (imported above) set it to the app's connection, not started in a test.
    assert.equal(t3codeSetup.running?.(), null);
  });
  test("the registry: every agent's setup is its adapter's, in the same order", () => {
    assert.deepEqual(
      agents.map((a) => a.setup),
      SETUPS,
    );
    assert.deepEqual(
      SETUPS.map((s) => s.id),
      agents.map((a) => a.id),
    );
  });
  test("command-line words come from the registry", () => {
    assert.equal(agentWords(), "claude, codex or opencode");
    assert.equal(agentNamed("claude"), claudeCodeSetup);
    assert.equal(agentNamed("Claude-Code"), claudeCodeSetup);
    assert.equal(agentNamed("codex"), codexSetup);
    assert.equal(agentNamed("OpenCode"), SETUPS[2]);
    assert.equal(agentNamed("t3code"), t3codeSetup);
    assert.equal(agentNamed("vim"), undefined);
  });
});

describe("an agent's row in settings → Agents: what can be done", () => {
  const values = (row: Parameters<typeof agentChoices>[0]) => agentChoices(row).map((c) => c.value);
  test("by where it stands", () => {
    assert.deepEqual(values({ state: "not connected", detail: "", file: "~/.claude/settings.json" }), ["connect", "keep"]);
    assert.deepEqual(values({ state: "connected", detail: "", file: "x" }), ["disconnect", "keep"]);
    assert.deepEqual(values({ state: "connected", detail: "", file: "x", partial: "SessionEnd not on (optional)" }), ["connect", "disconnect", "keep"]);
    assert.deepEqual(values({ state: "needs repair", detail: "Stop isn't on", file: "x" }), ["connect", "disconnect", "keep"]);
    assert.equal(agentChoices({ state: "needs repair", detail: "", file: "x" })[0].label, "Repair");
    assert.deepEqual(values({ state: "needs repair", detail: "", file: "x", unreadable: true }), ["keep"]);
    assert.deepEqual(values({ state: "not installed", detail: "", file: "x" }), ["connect", "keep"]);
    assert.deepEqual(values({ state: "automatic", detail: "connected", file: "", nothing: true }), ["keep", "disconnect"]);
    assert.equal(agentChoices({ state: "automatic", detail: "connected", file: "", nothing: true })[1].label, "Turn off");
    // Off (said no to): turned on again from here.
    assert.deepEqual(values({ state: "not connected", detail: "off: Kiko leaves it alone", file: "", nothing: true }), ["connect", "keep"]);
    assert.equal(agentChoices({ state: "not connected", detail: "", file: "", nothing: true })[0].label, "Turn on");
  });
});
