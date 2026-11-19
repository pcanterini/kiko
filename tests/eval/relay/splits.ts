// Each relay case's split, for tuning against the suite without fitting to it: about 60% train,
// 20% validation, 20% held-out test, within each category. Stored in cases.ts (SPLITS), so a case
// keeps its split for good; a new case gets one with `pnpm eval:relay --assign-splits`, which fills
// the category's split furthest under its share (the order set by a hash of the id, not by hand).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const SPLIT_NAMES = ["train", "validation", "test"] as const;
export type Split = (typeof SPLIT_NAMES)[number];
export const SHARE: Record<Split, number> = { train: 0.6, validation: 0.2, test: 0.2 };

const hash = (id: string) => createHash("sha256").update(id).digest("hex");

/** `existing` with a split for every case that has none, stratified by category. */
export function assignSplits(cases: Array<{ id: string; category: string }>, existing: Record<string, Split>): Record<string, Split> {
  const out: Record<string, Split> = {};
  for (const c of cases) if (existing[c.id]) out[c.id] = existing[c.id];
  const categories = [...new Set(cases.map((c) => c.category))];
  for (const category of categories) {
    const all = cases.filter((c) => c.category === category);
    const count: Record<Split, number> = { train: 0, validation: 0, test: 0 };
    for (const c of all) if (out[c.id]) count[out[c.id]]++;
    const fresh = all.filter((c) => !out[c.id]).sort((a, b) => hash(a.id).localeCompare(hash(b.id)));
    for (const c of fresh) {
      const n = SPLIT_NAMES.reduce((a, s) => a + count[s], 0) + 1;
      // The split furthest under its share once this case counts; train first on a tie.
      const pick = SPLIT_NAMES.reduce((best, s) => (SHARE[s] * n - count[s] > SHARE[best] * n - count[best] ? s : best), SPLIT_NAMES[0]);
      out[c.id] = pick;
      count[pick]++;
    }
  }
  return out;
}

const START = "export const SPLITS: Record<string, Split> = {";
const END = "};";

/** cases.ts with its SPLITS block written as `splits`, in the cases' order. */
export function writeSplits(file: string, splits: Record<string, Split>, order: string[]) {
  const text = readFileSync(file, "utf8");
  const at = text.indexOf(START);
  if (at < 0) throw new Error(`${file}: no SPLITS block`);
  const end = text.indexOf(END, at);
  const body = order
    .filter((id) => splits[id])
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(splits[id])},`)
    .join("\n");
  writeFileSync(file, `${text.slice(0, at)}${START}\n${body}\n${text.slice(end)}`);
}
