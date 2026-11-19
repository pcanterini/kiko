import { randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { online } from "./online.ts";
import { modelCalls } from "./model-route.ts";
import { shadow, shadowModelFor } from "./shadow.ts";

// The classifier: fast models on OpenRouter that answer typed questions about a state with
// probabilities instead of prose, in about 0.3s (OpenRouter calls the endpoint "decisions"). Several
// questions go in one request and are answered independently. Alpha endpoint; see
// openrouter.ai/docs/guides/community/jev-tutorial. TypeSafe's Jev (config.classifierModel) answers
// most; your words go to d1-ultra (config.utteranceModel). The "classify" log lines (called "jev"
// before 2026-11-01) record whichever model answered. Your own OpenRouter key, else the Kiko
// account's trial proxy (model-route.ts).

export type Question = { type: "choice"; instructions: string; criteria: Record<string, string> } | { type: "noul"; instructions: string; criteria: { true: string; false: string } };

export type Answer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> } | { type: "noul"; noul: number }; // probability of yes

export const classifierEnabled = () => config.classifier;

/**
 * Asks the classifier model (or `model`) several questions about one state in a single request. With `shadow`, the
 * shadow model for this kind of decision (shadow.ts) is asked the same at the same time, for the
 * log only; its fields go on that log line.
 */
export async function decide<K extends string>(
  what: string,
  state: unknown,
  questions: Record<K, Question>,
  opts: { model?: string; shadow?: Record<string, unknown> } = {},
): Promise<{ answers: Record<K, Answer>; costUsd: number; ms: number; model: string }> {
  const model = opts.model ?? config.classifierModel;
  // Pairs this "classify" log line with its "shadow" line.
  const id = randomUUID().slice(0, 8);
  const start = performance.now();
  const deadline = AbortSignal.timeout(4000);
  const post = () => modelCalls.post("decisions", { model, state, questions }, { call: "classify", what, signal: deadline });
  // A connection that drops before an answer ("fetch failed", often a pooled connection the server
  // had already closed) is tried once more on a fresh one, within the same 4s. Timeouts aren't.
  const request = post().catch((err) => {
    // Out of time: with the relay down too, a sign the Mac is offline (core/online.ts).
    if (deadline.aborted) online.callTimedOut("classifier");
    if (deadline.aborted || !(err instanceof TypeError)) throw err;
    log("classify_retry", { what, id, cause: causeOf(err) });
    return post().catch((again) => {
      throw new Error(`${again instanceof Error ? again.message : String(again)} (${causeOf(again)})`);
    });
  });
  const shadowModel = opts.shadow ? shadowModelFor(what, model) : "";
  if (shadowModel) {
    try {
      void shadow({ id, what, model: shadowModel, state, questions, note: opts.shadow });
    } catch {}
  }
  // Errors name the model: "Jev 503", "liquid/d1-ultra 503".
  const name = /^typesafe\/jev-/.test(model) ? "Jev" : model;
  const res = await request;
  if (!res.ok) throw new Error(`${name} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body: any = await res.json();
  for (const key of Object.keys(questions)) {
    if (!body.answers?.[key]) throw new Error(`${name} didn't answer "${key}": ${JSON.stringify(body).slice(0, 300)}`);
  }
  const served = String(body.model ?? model);
  const result = { answers: body.answers as Record<K, Answer>, costUsd: Number(body.usage?.cost ?? 0), ms: Math.round(performance.now() - start), model: served };
  // `model` as asked for, `served` as the answer names it (dated), like the "shadow" line.
  log("classify", { what, id, model, served, state, answers: result.answers, costUsd: result.costUsd, ms: result.ms });
  return result;
}

/** What's behind a "fetch failed": the network error's code or message, e.g. ECONNRESET. */
function causeOf(err: unknown) {
  const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  return cause?.code ?? cause?.message ?? "no cause";
}

export const yes = (answer: Answer) => (answer.type === "noul" ? answer.noul : 0);
export const picked = (answer: Answer) => (answer.type === "choice" ? { choice: answer.choice, confidence: answer.confidence } : { choice: "", confidence: 0 });
