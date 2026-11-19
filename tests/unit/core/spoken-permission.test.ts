// What a permission prompt is said as with no model's words (src/core/spoken-permission.ts): never a
// command read out unless it's a few plain words. Kiko's quick check once read
// a whole shell pipeline aloud ("…wants to run cd /Users/me/git/kiko/logs; ls | wc -l; …").
// The screen (the card, the timeline, the phone) still shows the command.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeTool } from "../../../src/core/decisions.ts";
import { quickAskLine, quickWhat } from "../../../src/core/quick-ask.ts";
import { codeLike, plainPermissionLine, sayableCommand, spokenDescription, spokenWhat } from "../../../src/core/spoken-permission.ts";

// That quick check's request, as the hook had it.
const INCIDENT = {
  name: "Bash",
  input: {
    command:
      'cd /Users/me/git/kiko/logs; ls | wc -l; ls | sed -E \'s/T.*//\' | sort | uniq -c; echo ---; f=$(ls | tail -1); echo $f; head -c 1500 "$f"; echo; echo ---; grep -h -o \'"kind":"[a-z_-]*"\' * 2>/dev/null | sort | uniq -c | sort -rn | head -30',
    description: "Summarize log files by date and entry kinds",
  },
};
const bash = (command: string, description?: string) => ({ name: "Bash", input: { command, ...(description === undefined ? {} : { description }) } });

describe("the quick check's question", () => {
  test("the incident: what it's for, said; never the command", () => {
    assert.equal(quickAskLine(spokenWhat(INCIDENT)), "Kiko's quick check wants to summarize log files by date and entry kinds. Allow?");
  });

  test("no description: a long command is a command", () => {
    const { command } = INCIDENT.input;
    assert.equal(quickAskLine(spokenWhat(bash(command))), "Kiko's quick check wants to run a command. Allow?");
  });

  test("a few plain words are said as they are", () => {
    assert.equal(quickAskLine(spokenWhat(bash("whois  pebble.com"))), "Kiko's quick check wants to run whois pebble.com. Allow?");
  });

  test("the screen still shows the whole command", () => {
    const shown = quickWhat(INCIDENT, describeTool(INCIDENT.name, INCIDENT.input));
    assert.ok(shown.startsWith("run cd /Users/me/git/kiko/logs; ls | wc -l;"), shown);
    assert.match(describeTool(INCIDENT.name, INCIDENT.input), /^run: cd \/Users\/me\/git\/kiko\/logs; ls \| wc -l/);
  });
});

describe("a session's question when the model's wording failed", () => {
  test("its name and what it's for", () => {
    assert.equal(plainPermissionLine("Lacy", INCIDENT), "Lacy wants to summarize log files by date and entry kinds. Allow?");
    assert.equal(plainPermissionLine("It", bash("cd /x/y && rm -rf build | tee log")), "It wants to run a command. Allow?");
    assert.equal(plainPermissionLine("The 2 plus 2 session", bash("pnpm test")), "The 2 plus 2 session wants to run pnpm test. Allow?");
  });

  test("a file by its name, without its folders", () => {
    assert.equal(plainPermissionLine("Lacy", { name: "Edit", input: { file_path: "/Users/me/git/kiko/src/app.ts" } }), "Lacy wants to edit app.ts. Allow?");
    assert.equal(spokenWhat({ name: "MultiEdit", input: { file_path: "/a/b/c/wrangler.toml" } }), "edit wrangler.toml");
    assert.equal(spokenWhat({ name: "Write", input: { file_path: "/a/b/notes.md" } }), "write notes.md");
    assert.equal(spokenWhat({ name: "Read", input: { file_path: "/a/b/c/d/config.json" } }), "read config.json");
    assert.equal(spokenWhat({ name: "Edit", input: {} }), "edit a file");
  });

  test("a web page by its site, an MCP tool by its name in words", () => {
    assert.equal(spokenWhat({ name: "WebFetch", input: { url: "https://www.example.com/a/b?c=d" } }), "open a web page on example.com");
    assert.equal(spokenWhat({ name: "WebFetch", input: { url: "not a url" } }), "open a web page");
    assert.equal(spokenWhat({ name: "mcp__cloudflare__dns_update", input: {} }), "use dns update from cloudflare");
    assert.equal(spokenWhat({ name: "Task", input: { description: "Explore the hooks code" } }), "start a subagent to explore the hooks code");
    assert.equal(spokenWhat({ name: "Glob", input: { pattern: "**/*.ts" } }), "use Glob");
    assert.equal(spokenWhat(null), "use a tool");
  });
});

describe("what's said plainly", () => {
  test("a description: lower-cased unless it starts with a name, no closing period", () => {
    assert.equal(spokenDescription({ description: "Run the unit tests." }), "run the unit tests");
    assert.equal(spokenDescription({ description: "GitHub: list open PRs" }), "GitHub: list open PRs");
    assert.equal(spokenDescription({ description: "README check" }), "README check");
    assert.equal(spokenDescription({ description: "" }), null);
    assert.equal(spokenDescription({ description: "List files in /Users/me/git/kiko/logs" }), null, "a path: not said");
    assert.equal(spokenWhat(bash("ls /Users/me/git/kiko/logs", "List files in /Users/me/git/kiko/logs")), "run a command");
  });

  test("a command is said only when it's a few plain words", () => {
    for (const ok of ["pnpm test", "wrangler deploy --env production", "git status", "npm run test:unit"]) assert.equal(sayableCommand(ok), ok);
    for (const no of [
      "ls | wc -l",
      "cd x; ls",
      "cat /etc/hosts",
      "echo 'hi'",
      "rm -r -f -v",
      "pnpm test --filter a b",
      "FOO=1 pnpm test",
      "echo $HOME",
      "ls *.ts",
      "./run.sh",
      `npx ${"x".repeat(40)}`,
      "",
    ])
      assert.equal(sayableCommand(no), null, no);
  });

  test("the last guard: anything still code-like or long is the plain phrase", () => {
    for (const code of ["a | b", "a; b", "a && b", "$(ls)", "`ls`", "x > y", "/a/b/c", "a".repeat(31)]) assert.ok(codeLike(code), code);
    for (const words of ["summarize log files by date", "edit app.ts", "open a web page on example.com", "run wrangler deploy --env production"]) assert.ok(!codeLike(words), words);
    // A description that slipped through anything else, or an odd tool's name: never read out.
    assert.equal(spokenWhat({ name: "Write", input: { file_path: `/a/${"x".repeat(60)}.ts` } }), "write a file");
    assert.equal(spokenWhat({ name: "cat /etc/hosts | grep x", input: {} }), "use a tool");
    assert.equal(spokenWhat({ name: "WebSearch", input: { query: "jq | sort $(date)" } }), "search the web");
    assert.equal(spokenWhat({ name: "WebSearch", input: { query: "cloudflare dns api" } }), "search the web for cloudflare dns api");
  });
});
