// Where the summary eval (summary.ts) reads its cases and verdicts. Real cases are the user's own
// replies, taken from logs/, so they're never in the repo: they're kept in a folder of their own
// (private-evals/ in the checkout is git-ignored for them), passed as --data. Without it the eval
// runs on sample/, a small made-up set of the same shape, so it works from a fresh clone.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The made-up cases, used when no folder is given. */
export const SAMPLE_DIR = join(here, "sample");

/** One reply, as the summary was given it then, and its must-keep items once judged. */
export type SummaryCase = {
  id: string;
  at: string;
  name: string;
  titled: boolean;
  nameSession: boolean;
  tag: string; // who spoke, as the prompt tagged it: claude, codex, agent
  context: string[];
  asked: string[];
  reply: string;
  needsUser: number | null;
  /** What was said then (the summarizer of that day). */
  spokenThen: string;
  firstTokenMsThen: number | null;
  /** Judged: what the reply is, and what a summary must say (empty: nothing beyond its outcome). */
  kinds?: string[];
  mustKeep?: string[];
  /** For "more about": a topic the reply covers, and one it doesn't (said "It didn't say anything about …"). */
  topic?: string;
  offTopic?: string;
};

export type SummaryData = {
  dir: string;
  /** The cases (summary-cases.json): written by --extract, read by everything else. */
  casesFile: string;
  /** The judges' verdicts (summary-verdicts.json), when there are any. */
  verdictsFile: string;
  /** The made-up set: no folder was given. */
  sample: boolean;
};

/** The files for `dir` (relative to where it's run, as typed), or the sample's with none. */
export function summaryData(dir?: string): SummaryData {
  const at = dir ? resolve(dir) : SAMPLE_DIR;
  return { dir: at, casesFile: join(at, "summary-cases.json"), verdictsFile: join(at, "summary-verdicts.json"), sample: !dir };
}

/**
 * The cases in `data`. A folder given without them is a mistake (a typo in the path), not zero
 * cases: it says so. Each case must have the fields every step reads.
 */
export function readCases(data: SummaryData): SummaryCase[] {
  if (!existsSync(data.casesFile)) throw new Error(`No summary-cases.json in ${data.dir}: pass --data the folder that has it, or leave it out for the sample.`);
  const cases = JSON.parse(readFileSync(data.casesFile, "utf8")) as SummaryCase[];
  if (!Array.isArray(cases)) throw new Error(`${data.casesFile}: not a list of cases.`);
  for (const [i, c] of cases.entries()) {
    const missing = (["id", "name", "tag", "reply", "spokenThen"] as const).filter((k) => typeof c[k] !== "string");
    if (missing.length || !Array.isArray(c.context) || !Array.isArray(c.asked)) {
      throw new Error(`${data.casesFile}: case ${c.id ?? i} lacks ${[...missing, ...(Array.isArray(c.context) ? [] : ["context"]), ...(Array.isArray(c.asked) ? [] : ["asked"])].join(", ")}.`);
    }
  }
  return cases;
}
