// Opus 5.5 on the user's Claude plan, for the relay eval's judge and reference (--judge plan, the
// default): headless Claude Code, `claude -p`, on the login `claude` already has, never an API key.
// The same question as the API path (opus.ts): a system prompt, the case on stdin, a JSON schema
// for the answer (--json-schema), an effort (--effort); Claude Code's own thinking (adaptive). Not
// a coding session: no tools, no MCP servers, no settings files, hooks, plugins, skills or CLAUDE.md
// (--safe-mode), nothing saved, run in an empty folder of its own. No fallback model: an answer
// from any model but Opus 5.5 is an error.
//
// $0 a verdict on the plan; Claude Code still reports what the call would have cost at list price
// (`listUsd`), shown beside it. The child's environment and command line are never printed.
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Effort, OpusResult } from "./opus.ts";

export const PLAN_MODEL = "claude-opus-5-5";
/** A call that hasn't answered in this long is killed and fails. */
const TIMEOUT_MS = 5 * 60_000;

export type Spawn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcess;

/** What stops the plan backend for the whole run: no `claude`, not logged in, the plan's limit. Never retried. */
export class PlanUnavailable extends Error {}

// API billing and its settings (ANTHROPIC_API_KEY, _AUTH_TOKEN, _BASE_URL, _MODEL…), the other
// providers Claude Code can use, the eval's own keys, and the markers of a Claude Code session the
// eval may be started from. CLAUDE_CODE_OAUTH_TOKEN stays: it is a plan login.
const STRIP =
  /^(ANTHROPIC_\w+|CLAUDE_CODE_USE_\w+|AWS_BEARER_TOKEN_BEDROCK|OPENROUTER_API_KEY|DEEPGRAM_API_KEY|CARTESIA_API_KEY|ELEVENLABS_API_KEY|OPENAI_API_KEY|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(?!OAUTH_TOKEN$)\w+)$/;

/** The child's environment: the eval's, minus every API key and Claude Code session marker. */
export function planEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !STRIP.test(k)));
}

/** The `claude` arguments for one question; the question itself goes in on stdin. */
export function planArgs(o: { system: string; schema: Record<string, unknown>; effort: Effort }): string[] {
  return [
    "-p",
    "--model",
    PLAN_MODEL,
    "--effort",
    o.effort,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(o.schema),
    "--system-prompt",
    o.system,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--safe-mode",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
}

/** The checks a JSON schema of the eval's kind makes (type, enum, required, properties, additionalProperties, items): the first problem, or null. */
export function schemaError(value: unknown, schema: Record<string, unknown>, at = "answer"): string | null {
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (types.length && !types.some((t) => t === kind || (t === "number" && kind === "integer"))) return `${at}: ${kind}, not ${types.join(" or ")}`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${at}: ${JSON.stringify(value)} isn't one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  if (kind === "object") {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in obj)) return `${at}: no "${key}"`;
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) {
        const err = schemaError(v, props[key], `${at}.${key}`);
        if (err) return err;
      } else if (schema.additionalProperties === false) return `${at}: "${key}" isn't in the schema`;
    }
  }
  if (kind === "array" && schema.items) {
    for (const [i, v] of (value as unknown[]).entries()) {
      const err = schemaError(v, schema.items as Record<string, unknown>, `${at}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}

/** The answer in an answer's text: the JSON itself, or in a ```json fence. */
function jsonIn(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse((fenced ? fenced[1] : text).trim());
}

type Ran = { code: number | null; stdout: string; stderr: string; ms: number; missing: boolean; timedOut: boolean };

function run(spawn: Spawn, args: string[], input: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let missing = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Math.round(performance.now() - start), missing, timedOut });
    };
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") missing = true;
      stderr += err.message;
      finish(null);
    });
    child.on("close", finish);
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

const NOT_FOUND = "claude not found on the PATH: install Claude Code (https://claude.com/claude-code) and log in, or judge on the API with --judge api.";
const NOT_LOGGED_IN = "claude isn't logged in to a Claude plan: run `claude auth login`, or judge on the API with --judge api.";
const LIMIT = /usage limit|rate limit|limit reached|out of extra usage|429/i;

/**
 * Asks Opus 5.5 on the plan. One backend per process: `check()` first (no claude, not logged in,
 * or logged in some other way than a Claude plan all fail it), then `ask()` per question. Once the
 * plan's limit is hit, every later question fails at once rather than starting more runs.
 */
export function planBackend(opts: { spawn?: Spawn; env?: NodeJS.ProcessEnv } = {}) {
  const spawn = opts.spawn ?? (nodeSpawn as Spawn);
  const env = planEnv(opts.env ?? process.env);
  let cwd: string | null = null;
  let stopped: PlanUnavailable | null = null;
  const folder = () => (cwd ??= mkdtempSync(join(tmpdir(), "kiko-judge-")));

  /** Throws PlanUnavailable unless `claude` is there and logged in to a Claude plan. */
  async function check(): Promise<{ authMethod: string; subscription?: string }> {
    const r = await run(spawn, ["auth", "status", "--json"], "", folder(), env);
    if (r.missing) throw new PlanUnavailable(NOT_FOUND);
    let status: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    try {
      status = JSON.parse(r.stdout);
    } catch {
      throw new PlanUnavailable(`claude auth status gave no answer (exit ${r.code}): is the installed claude current? Or judge on the API with --judge api.`);
    }
    if (!status.loggedIn) throw new PlanUnavailable(NOT_LOGGED_IN);
    // A plan login: claude.ai (the keychain's) or a long-lived plan token (claude setup-token).
    if (status.authMethod !== "claude.ai" && status.authMethod !== "oauth_token")
      throw new PlanUnavailable(`claude is logged in with ${status.authMethod ?? "an unknown method"}, not a Claude plan: log in with \`claude auth login\`, or judge on the API with --judge api.`);
    return { authMethod: status.authMethod, ...(status.subscriptionType ? { subscription: status.subscriptionType } : {}) };
  }

  /** One call: the answer, or why there's none (`bad` for an answer that isn't the schema's JSON, which is retried). */
  async function once<T>(o: { system: string; user: string; schema: Record<string, unknown>; effort: Effort }): Promise<{ ok: true; result: OpusResult<T> } | { ok: false; bad: string }> {
    const r = await run(spawn, planArgs(o), o.user, folder(), env);
    if (r.missing) throw (stopped = new PlanUnavailable(NOT_FOUND));
    if (r.timedOut) throw new Error(`claude -p gave no answer in ${TIMEOUT_MS / 1000}s`);
    let out: {
      is_error?: boolean;
      subtype?: string;
      result?: string;
      stop_reason?: string;
      structured_output?: unknown;
      total_cost_usd?: number;
      usage?: { output_tokens?: number };
      modelUsage?: Record<string, unknown>;
      api_error_status?: number | null;
    };
    try {
      out = JSON.parse(r.stdout);
    } catch {
      const said = (r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 160) ?? "";
      if (/not logged in|\/login/i.test(said)) throw (stopped = new PlanUnavailable(NOT_LOGGED_IN));
      throw new Error(`claude -p exited ${r.code} with no JSON${said ? `: ${said}` : ""}`);
    }
    const said = (out.result ?? "").slice(0, 160);
    if (out.is_error && /not logged in|\/login|invalid api key|authentication/i.test(said)) throw (stopped = new PlanUnavailable(NOT_LOGGED_IN));
    if (out.is_error && (out.api_error_status === 429 || LIMIT.test(said))) throw (stopped = new PlanUnavailable(`the Claude plan's limit: ${said}`));
    if (out.stop_reason === "refusal") throw new Error("Opus refused (on the plan)");
    const models = Object.keys(out.modelUsage ?? {});
    const others = models.filter((m) => m !== PLAN_MODEL);
    if (others.length) throw new Error(`claude -p answered with ${others.join(", ")}, not ${PLAN_MODEL}`);
    if (out.is_error && !/structured|json|schema/i.test(`${out.subtype} ${said}`)) throw new Error(`claude -p failed (${out.subtype ?? "error"}): ${said}`);
    let data: unknown = out.structured_output;
    if (data === undefined) {
      try {
        data = jsonIn(out.result ?? "");
      } catch {
        return { ok: false, bad: `no JSON in the answer: ${said.slice(0, 120)}` };
      }
    }
    const wrong = schemaError(data, o.schema);
    if (wrong) return { ok: false, bad: wrong };
    return { ok: true, result: { data: data as T, costUsd: 0, listUsd: out.total_cost_usd ?? 0, ms: r.ms, outputTokens: out.usage?.output_tokens ?? 0 } };
  }

  /** Opus 5.5 answers `user` under `system`, as JSON matching `schema`; an answer that isn't is asked once more. */
  async function ask<T>(o: { system: string; user: string; schema: Record<string, unknown>; effort: Effort }): Promise<OpusResult<T>> {
    if (stopped) throw stopped;
    const first = await once<T>(o);
    if (first.ok) return first.result;
    const second = await once<T>({ ...o, user: `${o.user}\n\n(Your last answer wasn't JSON matching the schema: ${first.bad}. Answer again with only that JSON.)` });
    if (second.ok) return { ...second.result, retried: true };
    throw new Error(`Opus on the plan answered twice with no JSON matching the schema: ${second.bad}`);
  }

  return { check, ask };
}
