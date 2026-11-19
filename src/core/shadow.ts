import { config } from "./config.ts";
import { log } from "./log.ts";
import type { Answer, Question } from "./classifier.ts";

// Shadow testing: another classifier model gets the exact request the deciding one gets (Jev, or
// d1-ultra for your words), sent at the same moment, and its answers are only logged, never acted
// on, so the two can be compared on real use (`pnpm shadow:report`). Each "shadow" log line carries
// the id of the "classify" line it pairs with ("jev" in logs before 2026-11-01). Nothing waits on it: it adds no latency, and its errors and timeouts only reach the log.
// A developer's tool: off unless KIKO_DEV_SHADOW=1 (config.ts), and nothing a user sees turns it on.
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
// Longer than the deciding model's 4s: nothing waits, and a slow answer still tells us about its latency.
const TIMEOUT_MS = 8000;

/**
 * The model shadowing `what` decisions made by `primary`: on your words ("utterance")
 * config.utteranceShadowModel, on the rest config.shadowModel. "" for none: off, or the same model.
 */
export function shadowModelFor(what: string, primary: string) {
  const model = what === "utterance" ? config.utteranceShadowModel : config.shadowModel;
  return model && model !== primary ? model : "";
}

/**
 * Sends the deciding model's request to the shadow `model` and logs what comes back. Fire and
 * forget: returns at once, never throws, and its promise (for tests) never rejects.
 */
export function shadow(input: {
  id: string;
  what: string;
  model: string;
  state: unknown;
  questions: Record<string, Question>;
  /** More for the log line, such as which session each handle stood for. */
  note?: Record<string, unknown>;
}): Promise<void> {
  const { id, what, model, state, questions, note } = input;
  if (!model) return Promise.resolve();
  const start = performance.now();
  const ms = () => Math.round(performance.now() - start);
  return ask(model, state, questions)
    .then(
      (r) => quietLog({ what, id, model, served: r.model, answers: r.answers, costUsd: r.costUsd, ms: ms(), ...note }),
      (err) => quietLog({ what, id, model, error: err instanceof Error ? err.message : String(err), ms: ms(), ...note }),
    )
    .catch(() => {});
}

async function ask(model: string, state: unknown, questions: Record<string, Question>) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openrouterKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, state, questions }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body: any = await res.json();
  for (const key of Object.keys(questions)) {
    if (!body.answers?.[key]) throw new Error(`didn't answer "${key}": ${JSON.stringify(body).slice(0, 300)}`);
  }
  return { model: String(body.model ?? model), answers: body.answers as Record<string, Answer>, costUsd: Number(body.usage?.cost ?? 0) };
}

// A full disk mustn't turn a logged answer into an unhandled rejection.
function quietLog(data: Record<string, unknown>) {
  try {
    log("shadow", data);
  } catch {}
}
