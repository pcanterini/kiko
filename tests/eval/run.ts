// Routing eval: runs each case in tests/eval/cases.ts through decide() (src/core/decide.ts), the same
// function the app's deliver() calls (shortcuts → decision model → router + code guards), with the
// real decision models (d1-ultra on your words, Jev on permission answers), router and trim models. It never types into sessions, presses keys, speaks or opens windows:
// only deciding runs; tests/support/outcomes.ts describes what the app would then do.
//
//   pnpm eval:routing --list                     cases, no network
//   pnpm eval:routing --case clipkit-correction-resends --repeat 1
//   pnpm eval:routing --tag incident,stop        any of these tags
//   pnpm eval:routing --grep "2 plus 2"          id, words or why
//   pnpm eval:routing --model deepseek           router + trim on DeepSeek V4.1 Flash (OpenRouter)
//   pnpm eval:routing --model haiku              the default
//   pnpm eval:routing --utterance-model jev      your words decided by Jev instead of d1-ultra (or any
//                                                decision model's OpenRouter id)
//   pnpm eval:routing --repeat 5 --concurrency 6 --no-trim --verbose
//   pnpm eval:routing --tag app-words --clean   also clean up the words sent (cleanup.ts), as the app does
//   pnpm eval:routing --dictionary               fix every case's words with the dictionary first (tests/support/dictionary.ts)
//                                                (cases with `dictionary: true` always are), as the app does
//
// Costs money (decision model + router + trim per run) and isn't deterministic: each case runs --repeat
// times (default 3). Results go to tests/eval/results/, the src/core/log.ts logs of the calls to
// tests/eval/logs/ (both git-ignored); logs/ and logs/latest.jsonl are left alone.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { DecideDeps, Decision } from "../../src/core/decide.ts";
import type { Action as RouterAction } from "../../src/core/router.ts";
import type { Outcome } from "../support/outcomes.ts";
import type { Case, Match } from "./cases.ts";
import { setEvalEnv } from "./env.ts";

const here = dirname(fileURLToPath(import.meta.url));

const { values: flags } = parseArgs({
  options: {
    list: { type: "boolean", default: false },
    case: { type: "string" },
    tag: { type: "string" },
    grep: { type: "string" },
    model: { type: "string", default: "haiku" },
    "utterance-model": { type: "string" },
    repeat: { type: "string", default: "3" },
    concurrency: { type: "string", default: "4" },
    "no-trim": { type: "boolean", default: false },
    clean: { type: "boolean", default: false },
    dictionary: { type: "boolean", default: false },
    "classifier-min": { type: "string" },
    "jev-min": { type: "string" }, // its name before 2026-11-01
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (flags.help) {
  console.log(`pnpm eval:routing [--list] [--case id,id] [--tag t,t] [--grep text] [--model haiku|deepseek|<openrouter id>]
                  [--utterance-model d1-ultra|jev|<openrouter id>] [--repeat 3] [--concurrency 4] [--no-trim] [--clean] [--dictionary] [--classifier-min 0.75] [--verbose]`);
  process.exit(0);
}

// ── Environment, before any src/ module loads ──────────────────────────────────────────────
// The user's keys from .env, or already in the environment (a git worktree has no .env of its own:
// `node --env-file=<main checkout>/.env tests/eval/run.ts`); none of their saved settings (each case
// sets its own "Voice can").
// (tests/eval/env.ts)
const model = setEvalEnv({ model: flags.model!, utteranceModel: flags["utterance-model"], keys: !flags.list });

// The cases as recorded, said to the app by the name it has (name.ts spokenName: with no saved
// settings, KIKO_SPOKEN_NAME or the default, as config.ts sets it too): recorded-name.ts.
const { setSpokenName } = await import("../../src/core/name.ts");
const { inSpokenName } = await import("./recorded-name.ts");
const spokenName = setSpokenName(process.env.KIKO_SPOKEN_NAME);
const CASES = (await import("./cases.ts")).CASES.map((c) => inSpokenName(c, spokenName));
const { decide } = await import("../../src/core/decide.ts");
const { describeOutcome, outcomesOf } = await import("../support/outcomes.ts");
const { sessionName } = await import("../../src/core/sessions.ts");
// The state decide() sees, as the app builds it (a fixed dictionary of the user's, tests/support/dictionary.ts).
const { buildState } = await import("./world.ts");

// ── Which cases ────────────────────────────────────────────────────────────────────────────
const list = (s?: string) =>
  s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
const ids = list(flags.case);
const tags = list(flags.tag);
const grep = flags.grep?.toLowerCase();
const unknown = ids.filter((id) => !CASES.some((c) => c.id === id));
if (unknown.length) throw new Error(`No such case: ${unknown.join(", ")}`);
const cases = CASES.filter((c) => (!ids.length || ids.includes(c.id)) && (!tags.length || c.tags.some((t) => tags.includes(t))) && (!grep || `${c.id} ${c.say} ${c.why}`.toLowerCase().includes(grep)));
const dupes = CASES.map((c) => c.id).filter((id, i, all) => all.indexOf(id) !== i);
if (dupes.length) throw new Error(`Duplicate case ids: ${dupes.join(", ")}`);

if (flags.list) {
  for (const c of cases) console.log(`${c.id.padEnd(44)} ${c.tags.join(",").padEnd(36)} ${JSON.stringify(c.say).slice(0, 90)}`);
  const byTag = new Map<string, number>();
  for (const c of cases) for (const t of c.tags) byTag.set(t, (byTag.get(t) ?? 0) + 1);
  console.log(
    `\n${cases.length} cases. Tags: ${[...byTag]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t} ${n}`)
      .join(", ")}`,
  );
  process.exit(0);
}
if (!cases.length) throw new Error("No cases match.");

// ── The real decision functions ────────────────────────────────────────────────────────────
const { config } = await import("../../src/core/config.ts");
const { decideUtterance, decideApproval } = await import("../../src/core/decisions.ts");
const { Router } = await import("../../src/core/router.ts");
const { trimForClaude } = await import("../../src/core/trim.ts");
const { cleanUp } = await import("../../src/core/cleanup.ts");
config.llm = model;
config.classifier = true;
if (flags["classifier-min"] ?? flags["jev-min"]) config.classifierMinConfidence = Number(flags["classifier-min"] ?? flags["jev-min"]);

const deps: DecideDeps = {
  utterance: decideUtterance,
  approval: decideApproval,
  route: (input) => new Router().route(input, () => {}),
  trim: flags["no-trim"] ? null : trimForClaude,
  // Off by default: the cases' expected words are as said. Routing never sees the cleaned words.
  clean: flags.clean ? cleanUp : null,
};

// ── One run of one case ────────────────────────────────────────────────────────────────────
/** A decision, short: for the report and the results file. */
type Summary = {
  layer: string;
  classifier?: { audience: string; audienceConfidence: number; intent: string; intentConfidence: number; appParts: number };
  approval?: { answer: string; confidence: number };
  router?: { calls: string[]; said: string };
  errors: string[];
  costUsd: number;
};
type Run = { pass: boolean; why: string; decision: Summary; outcomes: Outcome[]; ms: number };

function summarize(d: Decision): Summary {
  return {
    layer: d.step,
    ...(d.utterance && {
      classifier: {
        audience: d.utterance.audience === "app" ? "app" : sessionName(d.utterance.audience),
        audienceConfidence: d.utterance.audienceConfidence,
        intent: d.utterance.intent,
        intentConfidence: d.utterance.intentConfidence,
        appParts: d.utterance.appParts,
      },
    }),
    ...(d.approval && { approval: { answer: d.approval.answer, confidence: d.approval.confidence } }),
    ...(d.router && { router: { calls: d.router.actions.map(describeCall), said: d.router.text } }),
    errors: d.errors.map((e) => `${e.where}: ${e.message}`),
    costUsd: d.classifierCostUsd + d.llmCostUsd,
  };
}

function describeCall(a: RouterAction): string {
  switch (a.name) {
    case "start_session":
      return `start_session(${a.newProject ? "new project " : ""}${a.project ?? "-"}${a.sessionName ? `, named ${a.sessionName}` : ""}${a.prompt ? `, "${a.prompt.slice(0, 40)}"` : ""}${a.agent ? `, in ${a.agent}` : ""})`;
    case "rename_session":
      return `rename_session(${sessionName(a.session)} → ${a.newName})`;
    case "quick_task":
      return `quick_task(${a.cwd.split("/").pop()})`;
    case "add_to_dictionary":
      return `add_to_dictionary(${a.heard} → ${a.write})`;
    case "remove_from_dictionary":
      return `remove_from_dictionary(${a.heard})`;
    default:
      return `${a.name}(${sessionName(a.session)})`;
  }
}

const build = (c: Case) => buildState(c, { dictionary: flags.dictionary!, classifierMinConfidence: config.classifierMinConfidence });

function matches(o: Outcome, m: Match): boolean {
  const rec = o as Record<string, unknown>;
  for (const [key, want] of Object.entries(m)) {
    if (want === undefined) continue;
    // A new session's agent: "" for none named (Claude Code, the default).
    const got = key === "text" ? (rec.text ?? rec.message) : key === "agent" ? (rec.agent ?? "") : rec[key];
    if (want instanceof RegExp) {
      if (typeof got !== "string" || !want.test(got)) return false;
    } else if (typeof want === "boolean") {
      if (Boolean(got) !== want) return false;
    } else if (typeof want === "string") {
      if (typeof got !== "string" || got.toLowerCase() !== want.toLowerCase()) return false;
    } else if (got !== want) return false;
  }
  return true;
}

async function runOnce(c: Case): Promise<Run> {
  const { state, nameOf } = build(c);
  const start = performance.now();
  const decision = await decide(state, deps);
  const ms = Math.round(performance.now() - start);
  // Name sessions as the case does (two sessions in one folder share a spoken name).
  const outcomes = outcomesOf(decision, state).map((o) => (o.sessionId && "to" in o ? { ...o, to: nameOf.get(o.sessionId) ?? o.to } : o)) as Outcome[];
  const first = outcomes[0];
  const bad = outcomes.find((o) => (c.mustNot ?? []).some((m) => matches(o, m)));
  const why = !first ? "no action" : bad ? `must not: ${describeOutcome(bad)}` : !c.expect.some((m) => matches(first, m)) ? `unexpected: ${describeOutcome(first)}` : "";
  return { pass: !why, why, decision: summarize(decision), outcomes, ms };
}

// ── Run all, a few at a time ───────────────────────────────────────────────────────────────
const repeat = Math.max(1, Number(flags.repeat));
const concurrency = Math.max(1, Number(flags.concurrency));
const jobs = cases.flatMap((c) => Array.from({ length: repeat }, () => c));
const results = new Map<string, Run[]>(cases.map((c) => [c.id, []]));
const started = performance.now();
let next = 0;
let done = 0;
const tty = process.stdout.isTTY;
await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const c = jobs[next++];
      let run: Run;
      try {
        run = await runOnce(c);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        run = { pass: false, why: `crashed: ${message}`, decision: { layer: "crashed", errors: [message], costUsd: 0 }, outcomes: [], ms: 0 };
      }
      results.get(c.id)!.push(run);
      done++;
      if (tty) process.stdout.write(`\r${done}/${jobs.length} runs…`);
    }
  }),
);
const wallMs = performance.now() - started;
if (tty) process.stdout.write("\r\x1b[K");

// ── Report ─────────────────────────────────────────────────────────────────────────────────
const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 5 : 3)}`;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const tally = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([x, n]) => (n > 1 ? `${x} ×${n}` : x));
};

let passes = 0;
let total = 0;
let cost = 0;
const tagStats = new Map<string, { pass: number; runs: number }>();
const failing: string[] = [];
console.log(`Routing eval · router ${model} · your words ${config.utteranceModel} (min ${config.classifierMinConfidence}) · Jev ${config.classifierModel} · ${cases.length} cases × ${repeat}\n`);
for (const c of cases) {
  const runs = results.get(c.id)!;
  const ok = runs.filter((r) => r.pass).length;
  const caseCost = runs.reduce((a, r) => a + r.decision.costUsd, 0);
  const avgMs = runs.reduce((a, r) => a + r.ms, 0) / runs.length;
  passes += ok;
  total += runs.length;
  cost += caseCost;
  for (const t of c.tags) {
    const s = tagStats.get(t) ?? { pass: 0, runs: 0 };
    s.pass += ok;
    s.runs += runs.length;
    tagStats.set(t, s);
  }
  const mark = ok === runs.length ? "✔" : ok === 0 ? "✖" : "◐";
  const seen = tally(runs.map((r) => `[${r.decision.layer}] ${r.outcomes.map(describeOutcome).join(" + ") || "nothing"}`));
  console.log(`${mark} ${`${ok}/${runs.length}`.padEnd(5)} ${c.id.padEnd(44)} ${(avgMs / 1000).toFixed(1)}s ${usd(caseCost / runs.length)}/run  ${seen.join(" | ")}`);
  if (ok < runs.length || flags.verbose) {
    for (const r of runs) {
      if (r.pass && !flags.verbose) continue;
      const j = r.decision.classifier;
      const detail = [
        r.why || "pass",
        j && `${config.utteranceModel.split("/").pop()} ${j.audience} ${j.audienceConfidence.toFixed(2)} · ${j.intent} ${j.intentConfidence.toFixed(2)} · parts ${j.appParts.toFixed(2)}`,
        r.decision.router && `router ${r.decision.router.calls.join(", ") || "-"}${r.decision.router.said ? ` said "${r.decision.router.said.slice(0, 90)}"` : ""}`,
        r.decision.errors.length && `errors: ${r.decision.errors.join("; ")}`,
      ].filter(Boolean);
      console.log(`      ${detail.join("\n      ")}`);
    }
    if (ok < runs.length) {
      console.log(`      said: ${JSON.stringify(c.say).slice(0, 160)}`);
      console.log(`      want: ${c.expect.map((m) => JSON.stringify(m, (_k, v) => (v instanceof RegExp ? String(v) : v))).join(" or ")}`);
      console.log(`      why:  ${c.why}`);
      failing.push(c.id);
    }
  }
}
console.log(`\nPer tag:`);
for (const [t, s] of [...tagStats].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${t.padEnd(32)} ${pct(s.pass, s.runs).padStart(4)}  (${s.pass}/${s.runs})`);
}
console.log(
  `\nTotal: ${pct(passes, total)} of runs passed (${passes}/${total}); ${cases.length - failing.length}/${cases.length} cases passed every run.` +
    `\nCost ${usd(cost)} (${usd(cost / total)}/run) · wall time ${(wallMs / 1000).toFixed(1)}s at concurrency ${concurrency}.`,
);
if (failing.length) console.log(`Failing: ${failing.join(", ")}`);

const resultsDir = join(here, "results");
mkdirSync(resultsDir, { recursive: true });
const file = join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${flags.model!.replace(/[^a-z0-9.-]+/gi, "_")}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      model,
      classifierModel: config.classifierModel,
      utteranceModel: config.utteranceModel,
      classifierMinConfidence: config.classifierMinConfidence,
      repeat,
      passes,
      total,
      costUsd: cost,
      wallMs: Math.round(wallMs),
      cases: cases.map((c) => ({
        id: c.id,
        tags: c.tags,
        runs: results.get(c.id)!.map((r) => ({
          pass: r.pass,
          why: r.why,
          layer: r.decision.layer,
          outcomes: r.outcomes,
          classifier: r.decision.classifier,
          router: r.decision.router,
          approval: r.decision.approval,
          errors: r.decision.errors,
          ms: r.ms,
          costUsd: r.decision.costUsd,
        })),
      })),
    },
    (_k, v) => (v instanceof RegExp ? String(v) : v),
    2,
  ),
);
console.log(`Results: ${file}`);
process.exit(failing.length ? 1 : 0);
