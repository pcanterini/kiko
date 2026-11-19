// The relay eval's plan backend (tests/eval/relay/plan.ts) against a fake `claude` on a PATH of its
// own, in a temp folder: never the real CLI, no network, no login.
import "../../setup.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { JUDGE_SCHEMA, type Verdict } from "../../eval/relay/judge.ts";
import { PLAN_MODEL, PlanUnavailable, planArgs, planBackend, planEnv, schemaError } from "../../eval/relay/plan.ts";

// The fake: `auth status --json` and `-p`, as the mode in FAKE_CLAUDE_MODE says. Each -p call is
// numbered and recorded (its arguments, its stdin, which keys it saw) in FAKE_CLAUDE_DIR.
const FAKE = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_CLAUDE_DIR;
const mode = process.env.FAKE_CLAUDE_MODE;
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o));
if (args[0] === "auth") {
  if (mode === "logged-out") { out({ loggedIn: false, authMethod: "none" }); process.exit(1); }
  if (mode === "api-key") { out({ loggedIn: true, authMethod: "api_key" }); process.exit(0); }
  out({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
  process.exit(0);
}
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const countFile = path.join(dir, "count");
  const n = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0) + 1;
  fs.writeFileSync(countFile, String(n));
  fs.writeFileSync(path.join(dir, "call-" + n + ".json"), JSON.stringify({
    args, input, cwd: process.cwd(),
    keys: Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDECODE$|CLAUDE_CODE_|OPENROUTER_)/.test(k)),
  }));
  const verdict = { pass: true, aspect: "none", reason: "carries it" };
  const result = (extra) => ({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.012, usage: { output_tokens: 40 }, modelUsage: { "${PLAN_MODEL}": {} }, ...extra });
  if (mode === "logged-out") { out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }); process.exit(1); }
  if (mode === "limit") { out({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "Claude usage limit reached" }); process.exit(1); }
  if (mode === "other-model") { out(result({ structured_output: verdict, modelUsage: { "claude-sonnet-5": {} } })); process.exit(0); }
  if (mode === "text-json") { out(result({ result: "\`\`\`json\\n" + JSON.stringify(verdict) + "\\n\`\`\`" })); process.exit(0); }
  if (mode === "bad-always" || (mode === "bad-then-good" && n === 1)) { out(result({ result: "I think it passes." })); process.exit(0); }
  if (mode === "wrong-shape" && n === 1) { out(result({ structured_output: { pass: "yes", aspect: "none", reason: "" } })); process.exit(0); }
  out(result({ structured_output: verdict }));
});
`;

/** A folder with only the fake claude in it, and the environment to run it in (a stray API key and a session marker included, to be stripped). */
function fake(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  writeFileSync(join(dir, "claude"), FAKE);
  chmodSync(join(dir, "claude"), 0o755);
  const env = {
    PATH: dir,
    HOME: dir,
    FAKE_CLAUDE_DIR: dir,
    FAKE_CLAUDE_MODE: mode,
    ANTHROPIC_API_KEY: "test-not-a-key",
    ANTHROPIC_BASE_URL: "http://localhost:1",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
  };
  const calls = () => (existsSync(join(dir, "count")) ? Number(readFileSync(join(dir, "count"), "utf8")) : 0);
  const call = (n: number) => JSON.parse(readFileSync(join(dir, `call-${n}.json`), "utf8")) as { args: string[]; input: string; cwd: string; keys: string[] };
  return { backend: planBackend({ env }), calls, call };
}

const QUESTION = { system: "You judge.", user: "<user_said>hi</user_said>", schema: JUDGE_SCHEMA as unknown as Record<string, unknown>, effort: "medium" as const };

describe("relay eval: the plan backend (claude -p)", () => {
  test("good JSON: the verdict, $0 paid, the list price kept; no API key or session marker reaches claude", async () => {
    const f = fake("good");
    assert.deepEqual(await f.backend.check(), { authMethod: "claude.ai", subscription: "max" });
    const r = await f.backend.ask<Verdict>(QUESTION);
    assert.deepEqual(r.data, { pass: true, aspect: "none", reason: "carries it" });
    assert.equal(r.costUsd, 0);
    assert.equal(r.listUsd, 0.012);
    assert.equal(r.outputTokens, 40);
    assert.equal(r.retried, undefined);
    assert.equal(f.calls(), 1);
    const c = f.call(1);
    assert.deepEqual(c.keys, []);
    assert.equal(c.input, QUESTION.user);
    assert.deepEqual(c.args, planArgs(QUESTION));
    assert.equal(c.args[c.args.indexOf("--model") + 1], "claude-opus-5-5");
    assert.equal(c.args[c.args.indexOf("--effort") + 1], "medium");
    assert.deepEqual(JSON.parse(c.args[c.args.indexOf("--json-schema") + 1]), JUDGE_SCHEMA);
    for (const flag of ["-p", "--no-session-persistence", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(c.args.includes(flag), flag);
    assert.equal(c.args[c.args.indexOf("--tools") + 1], "");
    assert.equal(c.args[c.args.indexOf("--setting-sources") + 1], "");
    assert.ok(c.cwd.includes("kiko-judge-"), "an empty folder of its own");
  });

  test("bad JSON, then good: asked once more, saying what was wrong", async () => {
    const f = fake("bad-then-good");
    const r = await f.backend.ask<Verdict>(QUESTION);
    assert.equal(r.data.pass, true);
    assert.equal(r.retried, true);
    assert.equal(f.calls(), 2);
    assert.match(f.call(2).input, /wasn't JSON matching the schema: no JSON in the answer/);
  });

  test("JSON of the wrong shape counts as bad: checked against the schema, then retried", async () => {
    const f = fake("wrong-shape");
    const r = await f.backend.ask<Verdict>(QUESTION);
    assert.equal(r.retried, true);
    assert.match(f.call(2).input, /answer\.pass: string, not boolean/);
  });

  test("JSON in the text (no structured output) is read; bad twice is an error, after two calls only", async () => {
    assert.equal((await fake("text-json").backend.ask<Verdict>(QUESTION)).data.reason, "carries it");
    const f = fake("bad-always");
    await assert.rejects(f.backend.ask(QUESTION), /answered twice with no JSON/);
    assert.equal(f.calls(), 2);
  });

  test("not logged in: check() says how to log in; a call says the same and stops the backend", async () => {
    const f = fake("logged-out");
    await assert.rejects(f.backend.check(), (err: Error) => err instanceof PlanUnavailable && /isn't logged in.*claude auth login.*--judge api/.test(err.message));
    await assert.rejects(f.backend.ask(QUESTION), PlanUnavailable);
    await assert.rejects(f.backend.ask(QUESTION), PlanUnavailable);
    assert.equal(f.calls(), 1, "no second run once it's known");
  });

  test("logged in with an API key, not a plan: refused", async () => {
    await assert.rejects(fake("api-key").backend.check(), /logged in with api_key, not a Claude plan/);
  });

  test("no claude on the PATH: a clear line, no fallback", async () => {
    const empty = mkdtempSync(join(tmpdir(), "no-claude-"));
    const backend = planBackend({ env: { PATH: empty, HOME: empty } });
    await assert.rejects(backend.check(), (err: Error) => err instanceof PlanUnavailable && /claude not found on the PATH.*--judge api/.test(err.message));
    await assert.rejects(backend.ask(QUESTION), /claude not found/);
  });

  test("the plan's limit stops every later call without starting claude; another model is an error", async () => {
    const f = fake("limit");
    await assert.rejects(f.backend.ask(QUESTION), /the Claude plan's limit/);
    await assert.rejects(f.backend.ask(QUESTION), /the Claude plan's limit/);
    assert.equal(f.calls(), 1);
    await assert.rejects(fake("other-model").backend.ask(QUESTION), /answered with claude-sonnet-5, not claude-opus-5-5/);
  });

  test("planEnv strips API keys, other providers and session markers; keeps a plan token and the rest", () => {
    const env = planEnv({
      PATH: "/bin",
      HOME: "/h",
      ANTHROPIC_API_KEY: "x",
      ANTHROPIC_AUTH_TOKEN: "x",
      ANTHROPIC_MODEL: "x",
      CLAUDE_CODE_USE_BEDROCK: "1",
      OPENROUTER_API_KEY: "x",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "x",
      CLAUDE_CODE_OAUTH_TOKEN: "plan",
      CLAUDE_CONFIG_DIR: "/c",
    });
    assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
  });

  test("schemaError: types, enums, required, extra keys, arrays of objects", () => {
    const s = JUDGE_SCHEMA as unknown as Record<string, unknown>;
    assert.equal(schemaError({ pass: false, aspect: "detail-lost", reason: "lost the path" }, s), null);
    assert.match(schemaError({ pass: false, aspect: "made-up", reason: "" }, s)!, /isn't one of/);
    assert.match(schemaError({ pass: false, aspect: "none" }, s)!, /no "reason"/);
    assert.match(schemaError({ pass: false, aspect: "none", reason: "", extra: 1 }, s)!, /"extra" isn't in the schema/);
    const list = { type: "array", items: { type: "object", required: ["to"], properties: { to: { type: "string" } } } };
    assert.equal(schemaError([{ to: "atlas" }], list), null);
    assert.match(schemaError([{ to: "atlas" }, { to: 3 }], list)!, /answer\[1\]\.to: integer, not string/);
  });
});
