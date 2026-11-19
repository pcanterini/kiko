// The folders Claude Code has run in, read back from a fake ~/.claude/projects in a temporary folder
// (src/agents/claude-code/projects.ts): never the real one.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { decodeFolder, encodeFolder, historyFolders, throwaway } from "../../../../src/agents/claude-code/projects.ts";

// realpath: on macOS the temporary folder is /var/… but really /private/var/….
const base = realpathSync(mkdtempSync(join(tmpdir(), "kiko-history-")));
const claudeProjects = join(base, "claude", "projects");
const code = join(base, "code");
mkdirSync(claudeProjects, { recursive: true });

/** A folder on disk, and a transcript of a session in it under the fake ~/.claude/projects. */
function ran(cwd: string, transcripts: Array<{ id: string; lines: object[]; at?: number }>, opts: { make?: boolean; recordCwd?: boolean } = {}) {
  if (opts.make !== false) mkdirSync(cwd, { recursive: true });
  const project = join(claudeProjects, encodeFolder(cwd));
  mkdirSync(project, { recursive: true });
  for (const t of transcripts) {
    const file = join(project, `${t.id}.jsonl`);
    const lines = opts.recordCwd === false ? t.lines : [{ type: "user", cwd, sessionId: t.id, message: { content: "hi" } }, ...t.lines];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    if (t.at) utimesSync(file, t.at / 1000, t.at / 1000);
  }
  return project;
}

const keepAll = () => false;

describe("historyFolders: the folders in Claude Code's history", () => {
  // A "-" in a folder's name and a "/" both encode to "-": lacy-platform, and clipkit/apps/desktop.
  ran(join(code, "lacy-platform"), [{ id: "t1", lines: [{ type: "custom-title", customTitle: "Lacy" }], at: 2_000_000 }]);
  ran(join(code, "clipkit", "apps", "desktop"), [{ id: "s1", lines: [], at: 1_000_000 }]);
  // Its transcripts don't say where it ran: found by walking the disk.
  ran(join(code, "no-cwd.here"), [{ id: "n1", lines: [{ type: "summary", summary: "x" }] }], { recordCwd: false });
  // Gone since.
  ran(join(code, "deleted-project"), [{ id: "d1", lines: [] }], { make: false });
  // Renamed by the app (renames.json): the name counts though the transcript doesn't say it.
  ran(join(code, "pixie"), [{ id: "r1", lines: [] }]);

  const found = historyFolders(claudeProjects, { r1: { name: "Mountains", at: 1 } }, keepAll);
  const byCwd = new Map(found.map((f) => [f.cwd, f]));

  test("each folder from the cwd its transcripts recorded, dashes in names and all", () => {
    assert.ok(byCwd.has(join(code, "lacy-platform")));
    assert.ok(byCwd.has(join(code, "clipkit", "apps", "desktop")));
  });
  test("a folder its transcripts don't name: found on disk by its encoded name", () => {
    assert.ok(byCwd.has(join(code, "no-cwd.here")), [...byCwd.keys()].join(", "));
  });
  test("a folder that's gone is left out", () => {
    assert.ok(!byCwd.has(join(code, "deleted-project")));
    assert.equal(found.length, 4);
  });
  test("the names its sessions were given: /rename in the transcript, and the app's renames", () => {
    assert.deepEqual(byCwd.get(join(code, "lacy-platform"))!.names, ["Lacy"]);
    assert.deepEqual(byCwd.get(join(code, "pixie"))!.names, ["Mountains"]);
    assert.deepEqual(byCwd.get(join(code, "clipkit", "apps", "desktop"))!.names, []);
  });
  test("when it was last used: its newest transcript", () => {
    assert.equal(Math.round(byCwd.get(join(code, "lacy-platform"))!.lastUsed), 2_000_000);
  });
  test("no history folder: none", () => {
    assert.deepEqual(historyFolders(join(base, "nowhere"), {}, keepAll), []);
  });
});

describe("decodeFolder: an encoded name back to a folder on disk", () => {
  const root = join(base, "decode");
  mkdirSync(join(root, "one", "a-b", "c"), { recursive: true });
  mkdirSync(join(root, "two", "a", "b-c"), { recursive: true });
  mkdirSync(join(root, "two", "a-b"), { recursive: true }); // a dead end on the way: a-b has no c here
  mkdirSync(join(root, "x.y"), { recursive: true });
  // From "/": the full path, encoded.
  test("each part as the folder whose own name encodes to it", () => {
    assert.equal(decodeFolder(encodeFolder(join(root, "x.y"))), join(root, "x.y"));
    assert.equal(decodeFolder(encodeFolder(join(root, "one", "a-b", "c"))), join(root, "one", "a-b", "c"));
    assert.equal(decodeFolder(encodeFolder(join(root, "two", "a", "b-c"))), join(root, "two", "a", "b-c"));
  });
  test("nothing there: null", () => {
    assert.equal(decodeFolder(encodeFolder(join(root, "nope"))), null);
    assert.equal(decodeFolder("not-encoded"), null);
  });
});

describe("throwaway folders", () => {
  test("temporary folders, a worktree, the desktop app's scratch workspaces", () => {
    assert.ok(throwaway("/private/tmp/claude-501/x"));
    assert.ok(throwaway("/var/folders/qz/abc/T"));
    assert.ok(throwaway("/Users/me/git/lacy/.claude/worktrees/agent-ab9c"));
    assert.ok(throwaway("/Users/me/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026-10-26-16dc10"));
  });
  test("not a project, nor a folder inside a worktree", () => {
    assert.ok(!throwaway("/Users/me/git/lacy-platform"));
    assert.ok(!throwaway("/Users/me/git/app/.claude/worktrees/agent-1/tests/out"));
  });
});

test("a symlinked folder is listed by the path its transcripts recorded", () => {
  const real = join(base, "real", "kiko");
  mkdirSync(real, { recursive: true });
  const link = join(base, "real", "claude-code-speech");
  symlinkSync(real, link);
  ran(link, [{ id: "l1", lines: [] }], { make: false });
  const found = historyFolders(claudeProjects, {}, keepAll).map((f) => f.cwd);
  assert.ok(found.includes(link));
});
