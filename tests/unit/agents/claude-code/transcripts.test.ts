// Claude Code's transcripts (src/agents/claude-code/transcripts.ts): where a session's is.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptPath } from "../../../../src/agents/claude-code/transcripts.ts";

describe("transcriptPath", () => {
  // A session resumed after its folder moved (~/git/claude-code-speech → ~/git/kiko, 2026-10-28)
  // keeps writing to the old folder's project, so it's found there by its ID.
  test("a session whose folder moved is found in the old folder's project", () => {
    const home = mkdtempSync(join(tmpdir(), "kiko-home-"));
    const before = process.env.HOME;
    // Its projects under this home, as Claude Code's are (tests/setup.ts points them elsewhere).
    const projectsSet = process.env.KIKO_CLAUDE_PROJECTS;
    delete process.env.KIKO_CLAUDE_PROJECTS;
    process.env.HOME = home;
    try {
      const projects = join(home, ".claude", "projects");
      const old = join(projects, "-Users-me-git-claude-code-speech");
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, "moved-id.jsonl"), "{}\n");
      assert.equal(transcriptPath("/Users/me/git/kiko", "moved-id"), join(old, "moved-id.jsonl"));
      // One where the folder says is used as is, and one found nowhere stays where the folder says.
      const here = join(projects, "-Users-me-git-kiko");
      mkdirSync(here, { recursive: true });
      writeFileSync(join(here, "home-id.jsonl"), "{}\n");
      assert.equal(transcriptPath("/Users/me/git/kiko", "home-id"), join(here, "home-id.jsonl"));
      assert.equal(transcriptPath("/Users/me/git/kiko", "nowhere-id"), join(here, "nowhere-id.jsonl"));
    } finally {
      process.env.HOME = before;
      process.env.KIKO_CLAUDE_PROJECTS = projectsSet;
    }
  });
});
