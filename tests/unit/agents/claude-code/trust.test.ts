// Whether Claude Code trusts a folder (src/agents/claude-code/trust.ts): read from a fixture of its
// config file, never the real ~/.claude.json; only `projects[<folder>].hasTrustDialogAccepted`.
// And "trust the scratch folder" said to the app (routing-rules.ts asksTrustScratch, decide.ts).
import "../../../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { claudeConfigFile, folderTrusted } from "../../../../src/agents/claude-code/trust.ts";
import { decide, type DecideDeps, type DecideState } from "../../../../src/core/decide.ts";
import { asksTrustScratch } from "../../../../src/core/routing-rules.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "kiko-trust-")));
after(() => rmSync(dir, { recursive: true, force: true }));

const ROOT = "/Users/me/Kiko/scratch";
function config(projects: unknown, name = "claude.json") {
  const file = join(dir, name);
  // Other fields, as the real file has them: never looked at.
  writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: "not-read@example.com" }, primaryApiKey: "sk-not-read", projects }));
  return file;
}

describe("folderTrusted", () => {
  test("its own answer: trusted, not trusted, never asked", () => {
    const file = config({ [ROOT]: { hasTrustDialogAccepted: true }, "/Users/me/git/pixie": { hasTrustDialogAccepted: false } });
    assert.equal(folderTrusted(ROOT, file), true);
    assert.equal(folderTrusted(`${ROOT}/`, file), true, "a trailing slash is the same folder");
    assert.equal(folderTrusted("/Users/me/git/pixie", file), false);
    assert.equal(folderTrusted("/Users/me/elsewhere", file), false);
  });

  test("only the folder itself: a subfolder's answer isn't the scratch folder's", () => {
    const file = config({ [`${ROOT}/2026-10-29-dozer`]: { hasTrustDialogAccepted: true } });
    assert.equal(folderTrusted(ROOT, file), false);
  });

  // Zebra started in a new scratch subfolder without
  // asking, its own entry false, since the scratch folder was trusted; Kiko said it wasn't.
  test("a trusted folder above it covers it, outside a git repo, whatever its own entry says", () => {
    const file = config({ [ROOT]: { hasTrustDialogAccepted: true }, [`${ROOT}/2026-10-14-zebra`]: { hasTrustDialogAccepted: false } }, "parent.json");
    assert.equal(folderTrusted(`${ROOT}/2026-10-14-zebra`, file), true, "its own false doesn't stop the walk up");
    assert.equal(folderTrusted(`${ROOT}/2026-10-30-new`, file), true, "not made yet, not in the file: its parent's");
    assert.equal(folderTrusted(`${ROOT}/a/b/c`, file), true, "any folder above it");
    assert.equal(folderTrusted("/Users/me/Kiko", file), false, "not the folder above it");
    assert.equal(folderTrusted("/Users/me/Kiko/scratch-other", file), false, "a name that only starts the same");
    assert.equal(folderTrusted("/x", config({ "/": { hasTrustDialogAccepted: true } }, "root.json")), true, "up to /");
  });

  test("inside a git repo, only up to its root: a trusted folder above the repo doesn't count", () => {
    const outer = join(dir, "outer");
    const repo = join(outer, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    const above = config({ [outer]: { hasTrustDialogAccepted: true } }, "above-repo.json");
    assert.equal(folderTrusted(join(repo, "src", "deep"), above), false);
    assert.equal(folderTrusted(repo, above), false);
    assert.equal(folderTrusted(join(outer, "loose"), above), true, "beside the repo, not in it: covered");
    const atRoot = config({ [repo]: { hasTrustDialogAccepted: true } }, "repo-root.json");
    assert.equal(folderTrusted(join(repo, "src", "deep"), atRoot), true, "the repo's root covers it");
    const inside = config({ [join(repo, "src")]: { hasTrustDialogAccepted: true } }, "repo-inside.json");
    assert.equal(folderTrusted(join(repo, "src", "deep"), inside), true, "a folder between it and the root too");
  });

  test("a git worktree: its main checkout's answer counts (Claude Code's project for it), as does the walk up to the worktree's root", () => {
    const main = join(dir, "main-repo");
    const tree = join(main, ".claude", "worktrees", "agent-1");
    mkdirSync(join(main, ".git", "worktrees", "agent-1"), { recursive: true });
    writeFileSync(join(main, ".git", "worktrees", "agent-1", "commondir"), "../..\n");
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "agent-1")}\n`);
    assert.equal(folderTrusted(join(tree, "src"), config({ [main]: { hasTrustDialogAccepted: true } }, "main.json")), true);
    assert.equal(folderTrusted(join(tree, "src"), config({ [join(main, ".claude")]: { hasTrustDialogAccepted: true } }, "between.json")), false, "the walk up stops at the worktree's root");
    assert.equal(folderTrusted(join(tree, "src"), config({ [tree]: { hasTrustDialogAccepted: true } }, "tree.json")), true);
  });

  test("the folder as it really is, when it's reached through a link", () => {
    const real = join(dir, "real-scratch");
    const link = join(dir, "linked-scratch");
    mkdirSync(real);
    symlinkSync(real, link);
    const file = config({ [real]: { hasTrustDialogAccepted: true } }, "linked.json");
    assert.equal(folderTrusted(link, file), true);
  });

  test("can't tell: no file, or not JSON", () => {
    assert.equal(folderTrusted(ROOT, join(dir, "missing.json")), null);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    assert.equal(folderTrusted(ROOT, bad), null);
    assert.equal(folderTrusted(ROOT, config(undefined, "none.json")), false, "no projects at all: not trusted");
  });

  test("the file: KIKO_CLAUDE_CONFIG, else $CLAUDE_CONFIG_DIR/.claude.json, else ~/.claude.json", () => {
    const saved = { kiko: process.env.KIKO_CLAUDE_CONFIG, dir: process.env.CLAUDE_CONFIG_DIR };
    try {
      process.env.KIKO_CLAUDE_CONFIG = "/fixture/claude.json";
      assert.equal(claudeConfigFile(), "/fixture/claude.json");
      delete process.env.KIKO_CLAUDE_CONFIG;
      process.env.CLAUDE_CONFIG_DIR = "/elsewhere/claude";
      assert.equal(claudeConfigFile(), "/elsewhere/claude/.claude.json");
      delete process.env.CLAUDE_CONFIG_DIR;
      assert.match(claudeConfigFile(), /\/\.claude\.json$/);
    } finally {
      if (saved.kiko === undefined) delete process.env.KIKO_CLAUDE_CONFIG;
      else process.env.KIKO_CLAUDE_CONFIG = saved.kiko;
      if (saved.dir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved.dir;
    }
  });
});

describe('"trust the scratch folder"', () => {
  test("the request itself, as said", () => {
    for (const said of ["Trust the scratch folder.", "trust the scratch folder", "Okay, trust the scratch folder once.", "Yes, trust Kiko's scratch area", "please trust my scratch folder now"]) {
      assert.ok(asksTrustScratch(said), said);
    }
  });
  test("not words for a session, nor about something else", () => {
    for (const said of ["tell pixie to trust the scratch folder", "why does it ask me to trust the scratch folder?", "trust me", "trust the process"]) {
      assert.ok(!asksTrustScratch(said), said);
    }
  });

  async function run(text: string, voiceCan: DecideState["voiceCan"]) {
    const deps: DecideDeps = {
      utterance: null,
      approval: null,
      route: async () => {
        throw new Error("the router isn't asked");
      },
      trim: null,
    };
    return decide(
      { text, sessions: [], notes: new Map(), recent: [], waiting: null, justSpoke: null, lastId: null, appAsked: false, lastSent: null, lastRepeat: false, voiceCan, classifierMinConfidence: 0.75 },
      deps,
    );
  }
  test("decided in code: the trust step, where starting sessions is allowed; else refused", async () => {
    const d = await run("Kiko, trust the scratch folder.", "everything");
    assert.deepEqual([d.step, d.actions], ["trust-scratch", [{ type: "trust_scratch" }]]);
    const off = await run("trust the scratch folder", "messages");
    // Refused with the trust step kept: a yes to "turn it on" does it then.
    assert.deepEqual(off.actions, [{ type: "refused", what: "start", then: { type: "trust_scratch" } }]);
  });
});
