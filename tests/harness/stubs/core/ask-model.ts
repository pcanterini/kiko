// The model's read of your answer to one of Claude's questions, without a model: T.askModel(question, text) is
// its line ("2", "OTHER", "MAC", …; UNCLEAR when unset), checked by the real fromModel. T.askModelCalls counts them.
import { fromModel } from "../../../../src/core/ask.ts";
export async function matchByModel(q: any, text: string) {
  const T = (globalThis as any).T;
  T.askModelCalls = (T.askModelCalls ?? 0) + 1;
  const answer: string = T.askModel ? T.askModel(q, text) : "UNCLEAR";
  return { match: fromModel(q, answer, text), answer, costUsd: 0, ms: 0 };
}
