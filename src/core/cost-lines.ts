// The window's own lines that carry a dollar amount (the timing line, the routing model's info line,
// the quick check's line), each with it while dollars are shown and without it on the subscription
// (core/dollars.ts decides; nothing here does).
import { usdShown } from "./dollars.ts";

type Tokens = { input_tokens: number; output_tokens: number };
const tokens = (u: Tokens) => `${u.input_tokens}→${u.output_tokens} tok`;

/** The routing model's line: "Haiku: $0.0012 (1200→40 tok)"; without dollars, "Haiku: 1200→40 tok". */
export function routeCostLine(model: string, costUsd: number, u: Tokens): string {
  const spent = usdShown(costUsd);
  return `${model}: ${spent ? `${spent} (${tokens(u)})` : tokens(u)}`;
}

/** A press's timing, after `head` ("key up → done 1.20s"): " · $0.0010 · total $0.0123"; without dollars, nothing more. */
export function pressDoneLine(head: string, sttCost: number, total: number): string {
  const spent = usdShown(sttCost);
  return spent ? `${head} · ${spent} · total ${usdShown(total)}` : head;
}

/**
 * A reply's timing, after `head` ("first token 0.40s · first sound 0.90s"):
 * " · $0.0021 (Haiku 1200→40 tok) · total $0.0123"; without dollars, " · (Haiku 1200→40 tok)".
 */
export function replyTimingLine(head: string, spentUsd: number, model: string, u: Tokens, total: number): string {
  const spent = usdShown(spentUsd);
  const what = `${model} ${tokens(u)}`;
  return spent ? `${head} · ${spent} (${what}) · total ${usdShown(total)}` : `${head} · (${what})`;
}

/** What the quick check's run reported it cost: " · $0.0312"; "" with none reported, or without dollars. */
export function quickCostNote(costUsd: number | null): string {
  const spent = costUsd === null ? null : usdShown(costUsd);
  return spent ? ` · ${spent}` : "";
}
