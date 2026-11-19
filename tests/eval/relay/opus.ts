// Claude Opus 5.5 for the relay eval's reference and judge: one structured-output call (a JSON
// schema), adaptive thinking. Two backends, one per run (setBackend; a summary never mixes them):
// "plan" (the default) is headless Claude Code on the user's Claude plan (plan.ts), $0 a call;
// "api" is the app's own Anthropic client (src/core/anthropic.ts: the key as the app finds it),
// paid per token. No fallback model: a judge that quietly became another model would make runs
// incomparable, so a refusal is an error the report shows. Loads src/: import it dynamically, after
// the eval has set its environment.
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, requestInfo } from "../../../src/core/anthropic.ts";
import { planBackend } from "./plan.ts";

export const OPUS = "claude-opus-5-5";
// USD per million tokens (Claude Opus 5.5).
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Backend = "plan" | "api";
/**
 * `costUsd`: what was paid (0 on the plan). `listUsd`: on the plan, what Claude Code says the call
 * would have cost at list price. `retried`: on the plan, the first answer wasn't the schema's JSON.
 */
export type OpusResult<T> = { data: T; costUsd: number; listUsd?: number; ms: number; requestId?: string; outputTokens: number; retried?: boolean };

let client: Anthropic | null = null;
let backend: Backend = "plan";
let plan: ReturnType<typeof planBackend> | null = null;

/** The backend askOpus uses, for the whole run. "plan" first checks that claude is there and logged in to a plan (PlanUnavailable if not). */
export async function setBackend(b: Backend): Promise<{ authMethod: string; subscription?: string } | null> {
  backend = b;
  if (b === "api") return null;
  plan = planBackend();
  return plan.check();
}

/** Opus 5.5 answers `user` under `system`, as JSON matching `schema`. Throws on a refusal, a cut-off answer or bad JSON. */
export async function askOpus<T>(opts: { system: string; user: string; schema: Record<string, unknown>; effort: Effort; maxTokens?: number }): Promise<OpusResult<T>> {
  if (backend === "plan") {
    if (!plan) throw new Error("askOpus: setBackend first");
    return plan.ask<T>(opts);
  }
  // The SDK retries rate limits and overloads itself, with backoff.
  client ??= anthropic({ maxRetries: 6 });
  const start = performance.now();
  const { data: message, response } = await client.messages
    .create({
      model: OPUS,
      max_tokens: opts.maxTokens ?? 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: opts.effort, format: { type: "json_schema", schema: opts.schema } },
      // The instructions are the same for every case: cached after the first call.
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: opts.user }],
    })
    .withResponse();
  const ms = Math.round(performance.now() - start);
  const u = message.usage;
  const costUsd = (u.input_tokens * PRICE.input + u.output_tokens * PRICE.output + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite) / 1e6;
  const { requestId } = requestInfo(response);
  if (message.stop_reason === "refusal") throw new Error(`Opus refused (${message.stop_details?.category ?? "no category"})${requestId ? `, request ${requestId}` : ""}`);
  if (message.stop_reason === "max_tokens") throw new Error(`Opus ran out of tokens${requestId ? `, request ${requestId}` : ""}`);
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`Opus answered with no JSON: ${text.slice(0, 120)}`);
  }
  return { data, costUsd, ms, outputTokens: u.output_tokens, ...(requestId ? { requestId } : {}) };
}

/** A case's sessions and moment, as the reference and the judge read them. */
export function describeMoment(c: {
  sessions: Array<{ name: string; given?: string; title?: string; status?: string; said?: string; codex?: boolean }>;
  waiting?: string;
  recent?: string[];
  say: string;
}): string {
  const sessions = c.sessions.map((s) => {
    const bits = [s.title && `title "${s.title}"`, s.status, s.codex && "a Codex session", s.said && `last said: "${s.said}"`].filter(Boolean);
    return `- ${s.name}${bits.length ? ` (${bits.join("; ")})` : ""}`;
  });
  return [
    `<sessions>\n${sessions.join("\n")}\n</sessions>`,
    c.recent?.length ? `<recent>\n${c.recent.join("\n")}\n</recent>` : "<recent>(nothing yet)</recent>",
    c.waiting ? `<waiting_for_reply>${c.waiting}: Kiko just read out what it said, and its reply window is open.</waiting_for_reply>` : "<waiting_for_reply>none</waiting_for_reply>",
    `<user_said>${c.say}</user_said>`,
  ].join("\n");
}
