// The trim without a model: T.trim(input) is the parts to drop (none: as said), cut by the real removeParts.
// T.trimDelayMs: it takes that long; T.trimming counts the trims started.
import { removeParts } from "../../../../src/core/trim.ts";
export async function trimForClaude(input: any) {
  const T = (globalThis as any).T;
  T.trimming = (T.trimming ?? 0) + 1;
  if (T.trimDelayMs) await new Promise((r) => setTimeout(r, T.trimDelayMs));
  const parts: string[] = T.trim ? T.trim(input) : [];
  const cut = parts.length ? removeParts(input.text, parts) : null;
  return cut ? { ...cut, costUsd: 0, ms: T.trimDelayMs ?? 0 } : { text: input.text, dropped: [], costUsd: 0, ms: 0 };
}
