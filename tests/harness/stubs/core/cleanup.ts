// The clean-up without a model: T.clean(text) is the cleaned text (none: as said).
export { checkCleanup, cutFromCleaned, leftOut } from "../../../../src/core/cleanup.ts";
export async function cleanUp(text: string) {
  const T = (globalThis as any).T;
  T.cleanCalls = (T.cleanCalls ?? 0) + 1;
  const out = T.clean ? T.clean(text) : text;
  return { text: out, cleaned: out !== text, costUsd: 0, ms: 3 };
}
