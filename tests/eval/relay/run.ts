// Relay eval: what arrives in a session when the user names it, relays through Kiko ("tell Bobby
// to …"), mixes in words for Kiko, or replies to the one waiting. Each case (cases.ts) runs through
// decide() (src/core/decide.ts), the path the app's deliver() takes: the decision model, the router,
// the trim and, with --clean, the clean-up; tests/support/outcomes.ts says what the app would then do
// and type. Nothing is typed, pressed, spoken or opened. Then it's judged twice: hard checks in code
// against the committed reference (checks.ts, reference.json) and Claude Opus 5.5 (judge.ts).
//
//   pnpm eval:relay --list                           cases, splits and reference status, no network
//   pnpm eval:relay --assign-splits                  give new cases a split (train/validation/test), no network
//   pnpm eval:relay --build-reference [--force]      Opus 5.5 reads each case → reference.json (missing or stale ones;
//                                                    --force also rebuilds unreviewed ones)
//   pnpm eval:relay --calibrate [--repeat 3]         the judge on hand-labelled outcomes (calibration.ts): agreement
//   pnpm eval:relay                                  every case, once, judged
//   pnpm eval:relay --split train --tag opening,aside --grep mintbox --case a,b
//   pnpm eval:relay --repeat 3 --concurrency 8 --no-judge --judge-effort high
//   pnpm eval:relay --judge plan|api                 where Opus 5.5 runs, for the judge and the reference (below)
//   pnpm eval:relay --rejudge <results>.json         judge an earlier run's outcomes again (this backend and effort),
//                                                    case by case against its verdicts; no engine calls
//   pnpm eval:relay --variant baseline               today's engine (the default), or a strategy module:
//   pnpm eval:relay --variant ./my-strategy.ts       any file whose default export is a Variant (variant.ts)
//   pnpm eval:relay --model deepseek --utterance-model jev --clean --no-trim --dictionary   as eval:routing
//
// The judge and the reference (Opus 5.5): --judge plan (the default; KIKO_EVAL_JUDGE=plan|api) runs
// headless Claude Code (`claude -p`, plan.ts) on your Claude plan's login, $0 a verdict, concurrency 4
// by default to go easy on the plan's limits; it needs `claude` on the PATH, logged in, and stops with
// a line saying so otherwise (never falls back to the API). --judge api calls the Anthropic API with
// ANTHROPIC_API_KEY, paid per token, concurrency 6 by default. The summary records which (judge.backend).
// The engine under test (Haiku router and trim, Jev or d1-ultra on OpenRouter) always runs on the API:
// it's what's measured.
//
// Costs money (the engine's models per run, and Opus 5.5 per judged run on --judge api) and isn't
// deterministic. Results go to tests/eval/results/ (git-ignored): relay-<time>-<variant>.json (every
// run), .summary.json (one machine-readable summary per run, for comparing iterations), .md (the
// report); the engine's call logs to tests/eval/logs/. Keys from .env or the environment (a worktree:
// node --env-file=<main checkout>/.env); --calibrate, --rejudge and --build-reference on the plan need none.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { DecideDeps } from "../../../src/core/decide.ts";
import type { Outcome } from "../../support/outcomes.ts";
import { setEvalEnv } from "../env.ts";
import { CALIBRATION } from "./calibration.ts";
import { asRoutingCase, CATEGORIES, categoryOf, PRIVATE_RELAY_FILE, PRIVATE_RELAY_IDS, RELAY_CASES, type RelayCase, SPLITS } from "./cases.ts";
import { type Check, hardChecks, type Reference, type Sent } from "./checks.ts";
import type { Did, Verdict } from "./judge.ts";
import type { Backend, Effort } from "./opus.ts";
import { inputHash, readReferences, REFERENCE_FILE, REFERENCE_SCHEMA, REFERENCE_SYSTEM, type ReferenceEntry, referenceFor, settle, writeReferences } from "./reference.ts";
import { assignSplits, SPLIT_NAMES, type Split, writeSplits } from "./splits.ts";
import { BUILT_IN, type Variant } from "./variant.ts";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, "..", "results");

const { values: flags } = parseArgs({
  options: {
    list: { type: "boolean", default: false },
    "assign-splits": { type: "boolean", default: false },
    "build-reference": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    calibrate: { type: "boolean", default: false },
    case: { type: "string" },
    tag: { type: "string" },
    grep: { type: "string" },
    split: { type: "string" },
    repeat: { type: "string", default: "1" },
    concurrency: { type: "string" },
    judge: { type: "string" },
    rejudge: { type: "string" },
    model: { type: "string", default: "haiku" },
    "utterance-model": { type: "string" },
    variant: { type: "string", default: "baseline" },
    label: { type: "string" },
    "no-judge": { type: "boolean", default: false },
    "judge-effort": { type: "string", default: "medium" },
    "reference-effort": { type: "string", default: "high" },
    "no-trim": { type: "boolean", default: false },
    clean: { type: "boolean", default: false },
    dictionary: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (flags.help) {
  console.log(`pnpm eval:relay [--list] [--assign-splits] [--build-reference [--force]] [--calibrate] [--rejudge <results>.json]
                [--case id,id] [--tag t,t] [--grep text] [--split train|validation|test] [--repeat 1] [--concurrency 4 (plan) | 6 (api)]
                [--judge plan|api] [--variant baseline|<module path>] [--label name] [--no-judge] [--judge-effort medium] [--reference-effort high]
                [--model haiku|deepseek|<openrouter id>] [--utterance-model d1-ultra|jev|<openrouter id>] [--no-trim] [--clean] [--dictionary] [--verbose]`);
  process.exit(0);
}

// ── Which cases ────────────────────────────────────────────────────────────────────────────
const list = (s?: string) =>
  s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
const dupes = RELAY_CASES.map((c) => c.id).filter((id, i, all) => all.indexOf(id) !== i);
if (dupes.length) throw new Error(`Duplicate case ids: ${dupes.join(", ")}`);
for (const c of RELAY_CASES) {
  const names = new Set(c.sessions.map((s) => s.name.toLowerCase()));
  for (const t of [c.to, ...(c.alsoOk ?? [])].flatMap((t) => (t === null ? [] : Array.isArray(t) ? t : [t]))) {
    if (!names.has(t.toLowerCase())) throw new Error(`${c.id}: no session "${t}"`);
  }
  if (c.waiting && !names.has(c.waiting.toLowerCase())) throw new Error(`${c.id}: no session "${c.waiting}" to wait`);
}

if (flags["assign-splits"]) {
  const splits = assignSplits(
    RELAY_CASES.map((c) => ({ id: c.id, category: categoryOf(c) })),
    SPLITS,
  );
  const fresh = RELAY_CASES.filter((c) => !SPLITS[c.id]).length;
  // Each case's split goes back to the file it's in: the private cases' to tests/eval/private/.
  const order = RELAY_CASES.map((c) => c.id);
  writeSplits(
    join(here, "cases.ts"),
    splits,
    order.filter((id) => !PRIVATE_RELAY_IDS.has(id)),
  );
  if (PRIVATE_RELAY_IDS.size)
    writeSplits(
      PRIVATE_RELAY_FILE,
      splits,
      order.filter((id) => PRIVATE_RELAY_IDS.has(id)),
    );
  console.log(`${fresh} new case${fresh === 1 ? "" : "s"} given a split; ${RELAY_CASES.length} in all. Run pnpm format if the file needs it.`);
  process.exit(0);
}
const unsplit = RELAY_CASES.filter((c) => !SPLITS[c.id]).map((c) => c.id);
if (unsplit.length) throw new Error(`No split for ${unsplit.join(", ")}: run pnpm eval:relay --assign-splits.`);

const ids = list(flags.case);
const tags = list(flags.tag);
const grep = flags.grep?.toLowerCase();
const split = flags.split as Split | undefined;
if (split && !SPLIT_NAMES.includes(split)) throw new Error(`--split: one of ${SPLIT_NAMES.join(", ")}`);
const unknown = ids.filter((id) => !RELAY_CASES.some((c) => c.id === id));
if (unknown.length) throw new Error(`No such case: ${unknown.join(", ")}`);
const cases = RELAY_CASES.filter(
  (c) =>
    (!ids.length || ids.includes(c.id)) &&
    (!tags.length || c.tags.some((t) => tags.includes(t))) &&
    (!grep || `${c.id} ${c.say} ${c.note}`.toLowerCase().includes(grep)) &&
    (!split || SPLITS[c.id] === split),
);
const references = readReferences();

if (flags.list) {
  const status = (c: RelayCase) => (referenceFor(references, c) ? (references.cases[c.id].review === "auto" ? "ref" : "ref✓") : references.cases[c.id] ? "stale" : "-");
  const shown = (t: RelayCase["to"]) => (t === null ? "(not sent)" : Array.isArray(t) ? t.join("+") : t);
  for (const c of cases)
    console.log(`${c.id.padEnd(32)} ${categoryOf(c).padEnd(21)} ${SPLITS[c.id].padEnd(10)} ${status(c).padEnd(5)} ${shown(c.to).padEnd(16)} ${JSON.stringify(c.say).slice(0, 80)}`);
  console.log(`\n${cases.length} cases.`);
  console.log(`${"category".padEnd(21)} ${"cases".padStart(5)} ${SPLIT_NAMES.map((s) => s.padStart(10)).join(" ")} ${"log".padStart(5)} ${"ref".padStart(5)}`);
  for (const cat of CATEGORIES) {
    const of = cases.filter((c) => categoryOf(c) === cat);
    if (!of.length) continue;
    const bySplit = SPLIT_NAMES.map((s) => String(of.filter((c) => SPLITS[c.id] === s).length).padStart(10)).join(" ");
    console.log(
      `${cat.padEnd(21)} ${String(of.length).padStart(5)} ${bySplit} ${String(of.filter((c) => c.tags.includes("log")).length).padStart(5)} ${String(of.filter((c) => referenceFor(references, c)).length).padStart(5)}`,
    );
  }
  process.exit(0);
}
if (!cases.length && !flags.calibrate) throw new Error("No cases match.");

// ── Environment, before any src/ module loads (tests/eval/env.ts) ────────────────────────────
const opusOnly = flags["build-reference"] || flags.calibrate || Boolean(flags.rejudge);
const BACKENDS: readonly Backend[] = ["plan", "api"];
const backend = (flags.judge ?? process.env.KIKO_EVAL_JUDGE ?? "plan") as Backend;
if (!BACKENDS.includes(backend)) throw new Error(`--judge (or KIKO_EVAL_JUDGE): one of ${BACKENDS.join(", ")}, not "${backend}"`);
const onApi = backend === "api";
const model = setEvalEnv({
  model: flags.model!,
  utteranceModel: flags["utterance-model"],
  keys: opusOnly ? (onApi ? ["ANTHROPIC_API_KEY"] : false) : true,
  alsoAnthropic: !flags["no-judge"] && onApi,
  why: opusOnly ? "Opus 5.5 on --judge api needs ANTHROPIC_API_KEY" : `the eval needs OPENROUTER_API_KEY (the decision model) and ANTHROPIC_API_KEY (Haiku${onApi ? " and the Opus judge" : ""})`,
});
// The cases and the reference say the app's name as recorded: Kiko.
(await import("../../../src/core/name.ts")).setSpokenName("Kiko");
const { askOpus, describeMoment, setBackend } = await import("./opus.ts");
const { judge } = await import("./judge.ts");
const { PlanUnavailable } = await import("./plan.ts");

// One backend for the whole run, checked before any case: no claude, or not logged in, stops here.
if (opusOnly || !flags["no-judge"]) {
  try {
    const login = await setBackend(backend);
    if (login) console.log(`Opus 5.5 on your Claude plan (claude -p, ${login.authMethod}${login.subscription ? `, ${login.subscription}` : ""}): $0 a call.`);
  } catch (err) {
    if (!(err instanceof PlanUnavailable)) throw err;
    console.error(`--judge plan: ${err.message}`);
    process.exit(1);
  }
}

const repeat = Math.max(1, Number(flags.repeat));
const concurrency = Math.max(1, Number(flags.concurrency ?? (onApi ? 6 : 4)));
const judgeEffort = flags["judge-effort"] as Effort;
/** The judge as the reports name it: "Opus 5.5 (medium, plan)". */
const judgeName = (effort: string) => `Opus 5.5 (${effort}, ${onApi ? "api" : "plan"})`;
const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 5 : n < 1 ? 4 : 2)}`;
/** What Opus cost: paid on the API; on the plan, $0 and the list price it would have been. */
const opusCost = (paid: number, list: number, n: number) =>
  onApi ? `${usd(paid)} (${usd(paid / Math.max(1, n))}/call)` : `$0 on the plan (list price ${usd(list)}, ${usd(list / Math.max(1, n))}/call)`;
/** A plan limit reached mid-run fails every later call: say so once, plainly. */
const planStopped = (errors: Array<string | null>) => {
  const stop = errors.find((e) => e && /^the Claude plan's limit|^claude (isn't|not found)/.test(e));
  if (stop) console.error(`\nThe plan backend stopped: ${stop}`);
};
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const percentile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
};

/** Runs `work` on each item, `concurrency` at a time, showing progress. */
async function pool<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const tty = process.stdout.isTTY;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]);
        done++;
        if (tty) process.stdout.write(`\r${done}/${items.length}…`);
      }
    }),
  );
  if (tty) process.stdout.write("\r\x1b[K");
  return out;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── --build-reference ────────────────────────────────────────────────────────────────────────
if (flags["build-reference"]) {
  const effort = flags["reference-effort"] as Effort;
  const todo = cases.filter((c) => !referenceFor(references, c) || (flags.force && references.cases[c.id].review === "auto"));
  console.log(`Building the reference with ${judgeName(effort)} for ${todo.length} of ${cases.length} cases…`);
  const started = performance.now();
  let cost = 0;
  let list = 0;
  const failed: string[] = [];
  const order = RELAY_CASES.map((c) => c.id);
  await pool(todo, async (c) => {
    try {
      const r = await askOpus<Reference>({ system: REFERENCE_SYSTEM, user: describeMoment(c), schema: REFERENCE_SCHEMA as unknown as Record<string, unknown>, effort });
      const { reference, flags: found } = settle(c, r.data);
      const before = references.cases[c.id];
      if (before && before.review !== "auto") found.push(`was ${before.review} by hand before the case changed: review again`);
      const entry: ReferenceEntry = {
        inputHash: inputHash(c),
        model: "claude-opus-5-5",
        effort,
        backend,
        builtAt: new Date().toISOString(),
        costUsd: r.costUsd,
        ms: r.ms,
        reference,
        review: "auto",
        flags: found,
      };
      references.cases[c.id] = entry;
      cost += r.costUsd;
      list += r.listUsd ?? 0;
      writeReferences(references, order);
      if (found.length || flags.verbose) console.log(`${c.id}: ${found.join("; ") || "ok"}`);
    } catch (err) {
      failed.push(`${c.id}: ${message(err)}`);
    }
  });
  const s = (performance.now() - started) / 1000;
  console.log(`\nBuilt ${todo.length - failed.length}; cost ${opusCost(cost, list, todo.length - failed.length)} in ${s.toFixed(0)}s at concurrency ${concurrency}.`);
  if (failed.length) console.log(`Failed:\n  ${failed.join("\n  ")}`);
  planStopped(failed.map((f) => f.slice(f.indexOf(": ") + 2)));
  console.log(`Reference: ${REFERENCE_FILE}`);
  process.exit(failed.length ? 1 : 0);
}

// ── --calibrate ──────────────────────────────────────────────────────────────────────────────
if (flags.calibrate) {
  const jobs = CALIBRATION.flatMap((item) => Array.from({ length: repeat }, () => item));
  console.log(`Calibrating the judge, ${judgeName(judgeEffort)}, on ${CALIBRATION.length} hand-labelled outcomes × ${repeat} at concurrency ${concurrency}…`);
  const started = performance.now();
  const runs = await pool(jobs, async (item) => {
    try {
      const r = await judge({ moment: item.moment, reference: item.reference, did: item.did }, judgeEffort);
      return { id: item.id, label: item.label, aspect: item.aspect, verdict: r.data, costUsd: r.costUsd, listUsd: r.listUsd ?? 0, ms: r.ms, retried: r.retried ?? false, error: null as string | null };
    } catch (err) {
      return { id: item.id, label: item.label, aspect: item.aspect, verdict: null, costUsd: 0, listUsd: 0, ms: 0, retried: false, error: message(err) };
    }
  });
  planStopped(runs.map((r) => r.error));
  const judged = runs.filter((r) => r.verdict);
  const agree = judged.filter((r) => (r.verdict!.pass ? "pass" : "fail") === r.label);
  const failsCaught = judged.filter((r) => r.label === "fail" && !r.verdict!.pass);
  const aspectAgree = failsCaught.filter((r) => r.verdict!.aspect === r.aspect);
  const falsePass = judged.filter((r) => r.label === "fail" && r.verdict!.pass);
  const falseFail = judged.filter((r) => r.label === "pass" && !r.verdict!.pass);
  const cost = runs.reduce((a, r) => a + r.costUsd, 0);
  const list = runs.reduce((a, r) => a + r.listUsd, 0);
  for (const r of runs) {
    const got = r.verdict ? `${r.verdict.pass ? "pass" : "fail"} (${r.verdict.aspect})` : `error: ${r.error}`;
    const ok = r.verdict && (r.verdict.pass ? "pass" : "fail") === r.label;
    console.log(`${ok ? "✔" : "✖"} ${r.id.padEnd(30)} label ${r.label} (${r.aspect}) · judge ${got}${ok && !flags.verbose ? "" : `\n      ${r.verdict?.reason ?? ""}`}`);
  }
  const summary = {
    kind: "relay-calibration",
    at: new Date().toISOString(),
    backend,
    judgeEffort,
    concurrency,
    items: CALIBRATION.length,
    repeat,
    judged: judged.length,
    errors: runs.length - judged.length,
    agreement: judged.length ? agree.length / judged.length : 0,
    falsePass: falsePass.length,
    falseFail: falseFail.length,
    aspectAgreementOnCaughtFails: failsCaught.length ? aspectAgree.length / failsCaught.length : 0,
    costUsd: cost,
    ...(onApi ? {} : { listUsd: list, retriedForJson: runs.filter((r) => r.retried).length }),
    p50Ms: percentile(
      judged.map((r) => r.ms),
      0.5,
    ),
    p95Ms: percentile(
      judged.map((r) => r.ms),
      0.95,
    ),
    wallMs: Math.round(performance.now() - started),
    runs,
  };
  console.log(
    `\nAgreement ${pct(agree.length, judged.length)} (${agree.length}/${judged.length}); passed what a person failed: ${falsePass.length}; failed what a person passed: ${falseFail.length}; same aspect on caught fails ${pct(aspectAgree.length, failsCaught.length)}.` +
      `\nCost ${opusCost(cost, list, judged.length)} · p50 ${(summary.p50Ms / 1000).toFixed(1)}s, p95 ${(summary.p95Ms / 1000).toFixed(1)}s · wall ${(summary.wallMs / 1000).toFixed(0)}s at concurrency ${concurrency}.`,
  );
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `relay-calibration-${stamp()}-${backend}-${judgeEffort}.json`);
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Results: ${file}`);
  process.exit(0);
}

// ── --rejudge ────────────────────────────────────────────────────────────────────────────────
// An earlier run's outcomes (its .json: every run's `did`), judged again by this run's backend and
// effort against today's reference, then set beside that run's verdicts. The engine isn't called,
// so a difference is the judges', not the engine's.
if (flags.rejudge) {
  type Stored = { summary: { label?: string; judge?: { model: string; effort: string; backend?: Backend } | null }; cases: Array<{ id: string; runs: Array<{ did: Did; verdict: Verdict | null }> }> };
  const from = JSON.parse(readFileSync(resolve(process.cwd(), flags.rejudge), "utf8")) as Stored;
  const was = from.summary.judge;
  const wasName = was ? `Opus 5.5 (${was.effort}, ${was.backend ?? "api"})` : "no judge";
  const jobs = from.cases.flatMap((s) => {
    const c = RELAY_CASES.find((x) => x.id === s.id);
    return c ? s.runs.map((r, run) => ({ c, run, did: r.did, before: r.verdict })) : [];
  });
  const gone = from.cases.filter((s) => !RELAY_CASES.some((x) => x.id === s.id)).map((s) => s.id);
  console.log(`Judging ${jobs.length} runs of ${from.summary.label ?? flags.rejudge} again with ${judgeName(judgeEffort)} (they were judged by ${wasName}) at concurrency ${concurrency}…`);
  if (gone.length) console.log(`No longer cases, skipped: ${gone.join(", ")}`);
  const started = performance.now();
  const runs = await pool(jobs, async (j) => {
    try {
      const r = await judge({ moment: j.c, reference: referenceFor(references, j.c)?.reference ?? null, did: j.did }, judgeEffort);
      return { id: j.c.id, run: j.run, before: j.before, verdict: r.data as Verdict | null, costUsd: r.costUsd, listUsd: r.listUsd ?? 0, ms: r.ms, error: null as string | null };
    } catch (err) {
      return { id: j.c.id, run: j.run, before: j.before, verdict: null, costUsd: 0, listUsd: 0, ms: 0, error: message(err) };
    }
  });
  planStopped(runs.map((r) => r.error));
  const both = runs.filter((r) => r.verdict && r.before);
  const same = both.filter((r) => r.verdict!.pass === r.before!.pass);
  const differ = both.filter((r) => r.verdict!.pass !== r.before!.pass);
  for (const r of differ)
    console.log(
      `✖ ${r.id} #${r.run}: before ${r.before!.pass ? "pass" : `fail (${r.before!.aspect})`} · now ${r.verdict!.pass ? "pass" : `fail (${r.verdict!.aspect})`}\n      before: ${r.before!.reason}\n      now: ${r.verdict!.reason}`,
    );
  for (const r of runs.filter((r) => r.error)) console.log(`error ${r.id} #${r.run}: ${r.error}`);
  const cost = runs.reduce((a, r) => a + r.costUsd, 0);
  const list = runs.reduce((a, r) => a + r.listUsd, 0);
  const passNow = both.filter((r) => r.verdict!.pass).length;
  const passBefore = both.filter((r) => r.before!.pass).length;
  const wallMs = Math.round(performance.now() - started);
  const judgedMs = runs.filter((r) => r.verdict).map((r) => r.ms);
  console.log(
    `\nSame verdict on ${pct(same.length, both.length)} (${same.length}/${both.length}); pass rate ${pct(passBefore, both.length)} before, ${pct(passNow, both.length)} now; ${runs.filter((r) => r.error).length} errors.` +
      `\nCost ${opusCost(cost, list, judgedMs.length)} · p50 ${(percentile(judgedMs, 0.5) / 1000).toFixed(1)}s, p95 ${(percentile(judgedMs, 0.95) / 1000).toFixed(1)}s · wall ${(wallMs / 1000).toFixed(0)}s at concurrency ${concurrency}.`,
  );
  const summary = {
    kind: "relay-rejudge",
    at: new Date().toISOString(),
    from: flags.rejudge,
    before: was ?? null,
    judge: { model: "claude-opus-5-5", effort: judgeEffort, backend },
    concurrency,
    runs: runs.length,
    compared: both.length,
    agreement: both.length ? same.length / both.length : 0,
    passBefore,
    passNow,
    errors: runs.filter((r) => r.error).length,
    costUsd: cost,
    ...(onApi ? {} : { listUsd: list }),
    p50Ms: percentile(judgedMs, 0.5),
    p95Ms: percentile(judgedMs, 0.95),
    wallMs,
    differ: differ.map((r) => ({ id: r.id, run: r.run, before: r.before, now: r.verdict })),
    verdicts: runs,
  };
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `relay-rejudge-${stamp()}-${backend}-${judgeEffort}.json`);
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Results: ${file}`);
  process.exit(0);
}

// ── The engine, as the app runs it ───────────────────────────────────────────────────────────
const { config } = await import("../../../src/core/config.ts");
const { decide } = await import("../../../src/core/decide.ts");
const { decideUtterance, decideApproval } = await import("../../../src/core/decisions.ts");
const { Router } = await import("../../../src/core/router.ts");
const { trimForClaude } = await import("../../../src/core/trim.ts");
const { cleanUp } = await import("../../../src/core/cleanup.ts");
const { describeOutcome, outcomesOf } = await import("../../support/outcomes.ts");
const { buildState } = await import("../world.ts");
config.llm = model;
config.classifier = true;

const base: DecideDeps = {
  utterance: decideUtterance,
  approval: decideApproval,
  route: (input) => new Router().route(input, () => {}),
  trim: flags["no-trim"] ? null : trimForClaude,
  clean: flags.clean ? cleanUp : null,
};

/** --variant: a built-in strategy by name, or a module whose default export is a Variant. */
async function loadVariant(spec: string): Promise<Variant> {
  if (BUILT_IN[spec]) return BUILT_IN[spec];
  const path = resolve(process.cwd(), spec);
  if (!existsSync(path)) throw new Error(`--variant: no built-in "${spec}" (${Object.keys(BUILT_IN).join(", ")}) and no file ${path}`);
  const mod = (await import(pathToFileURL(path).href)) as { default?: Variant; variant?: Variant };
  const v = mod.default ?? mod.variant;
  if (!v || typeof v.name !== "string") throw new Error(`--variant ${spec}: its default export isn't a Variant (tests/eval/relay/variant.ts)`);
  return v;
}
const variant = await loadVariant(flags.variant!);
const deps = variant.deps ? variant.deps(base) : base;
const judging = !flags["no-judge"];

// ── One run of one case ──────────────────────────────────────────────────────────────────────
type Run = {
  sent: Sent[];
  did: Did;
  outcomes: string[];
  step: string;
  checks: Check[];
  hardPass: boolean;
  verdict: Verdict | null;
  judgeError: string | null;
  engineMs: number;
  relayMs: number;
  judgeMs: number;
  engineCostUsd: number;
  relayCostUsd: number;
  judgeCostUsd: number;
  /** On the plan: what the verdict would have cost at list price (judgeCostUsd is 0). */
  judgeListUsd: number;
  errors: string[];
};

const MESSAGES = new Set(["send", "ask", "resend"]);
const textOf = (o: Outcome) => ("text" in o ? o.text : "message" in o ? o.message : undefined);

/** The names a reply may drop up front: the waiting session's, as said ("Bobby", "kiko dev", "Kikodev"). */
function replyNames(c: RelayCase): string[] {
  const spec = c.sessions.find((s) => s.name.toLowerCase() === c.waiting?.toLowerCase());
  if (!spec) return [];
  return [spec.name, spec.given ?? "", spec.name.replace(/[-_\s]+/g, "")].filter(Boolean);
}

async function runOnce(c: RelayCase): Promise<Run> {
  const { state, nameOf } = buildState(asRoutingCase(c), { dictionary: flags.dictionary!, classifierMinConfidence: config.classifierMinConfidence });
  const t0 = performance.now();
  const decision = await decide(state, deps);
  const engineMs = Math.round(performance.now() - t0);
  const outcomes = outcomesOf(decision, state).map((o) => (o.sessionId && "to" in o ? { ...o, to: nameOf.get(o.sessionId) ?? o.to } : o)) as Outcome[];
  const messages = outcomes.filter((o) => MESSAGES.has(o.action)) as Array<Outcome & { to: string; via: string; sessionId?: string }>;
  const allTo = messages.map((o) => o.to);
  const sent: Sent[] = [];
  const did: Did = [];
  let relayMs = 0;
  let relayCostUsd = 0;
  for (const o of outcomes) {
    if (!MESSAGES.has(o.action)) {
      const text = textOf(o);
      did.push({ action: o.action, ...("to" in o && o.to ? { to: o.to } : {}), ...(text !== undefined ? { text } : {}) });
      continue;
    }
    const m = o as Outcome & { to: string; via: string; sessionId?: string };
    let text = textOf(m) ?? "";
    const reply = m.via === "reply";
    if (variant.relay && (!reply || variant.rewritesReplies)) {
      const t = performance.now();
      const r = await variant.relay({
        said: state.text,
        engineText: text,
        action: m.action,
        to: m.to,
        session: state.sessions.find((s) => s.sessionId === m.sessionId) ?? null,
        sessions: state.sessions,
        recent: state.recent,
        allTo,
        reply,
      });
      relayMs += performance.now() - t;
      relayCostUsd += r.costUsd ?? 0;
      text = r.text;
    }
    sent.push({ to: m.to, text, via: m.via, action: m.action });
    did.push({ action: m.action, to: m.to, text, via: m.via });
  }
  const ref = referenceFor(references, c)?.reference ?? null;
  const checks = hardChecks({ said: c.say, sent, want: c.to, alsoOk: c.alsoOk, reference: ref, reply: categoryOf(c) === "reply-exact" ? { names: replyNames(c) } : null });
  let verdict: Verdict | null = null;
  let judgeError: string | null = null;
  let judgeMs = 0;
  let judgeCostUsd = 0;
  let judgeListUsd = 0;
  if (judging) {
    try {
      const j = await judge({ moment: c, reference: ref, did }, judgeEffort);
      verdict = j.data;
      judgeMs = j.ms;
      judgeCostUsd = j.costUsd;
      judgeListUsd = j.listUsd ?? 0;
    } catch (err) {
      judgeError = message(err);
    }
  }
  return {
    sent,
    did,
    outcomes: outcomes.map(describeOutcome),
    step: decision.step,
    checks,
    hardPass: checks.every((x) => x.pass),
    verdict,
    judgeError,
    engineMs,
    relayMs: Math.round(relayMs),
    judgeMs,
    engineCostUsd: decision.classifierCostUsd + decision.llmCostUsd,
    relayCostUsd,
    judgeCostUsd,
    judgeListUsd,
    errors: decision.errors.map((e) => `${e.where}: ${e.message}`),
  };
}

// ── Run all ──────────────────────────────────────────────────────────────────────────────────
const label = flags.label ?? variant.name;
const noRef = cases.filter((c) => !referenceFor(references, c)).map((c) => c.id);
console.log(
  `Relay eval · variant ${variant.name} · router ${model} · your words ${config.utteranceModel} · judge ${judging ? judgeName(judgeEffort) : "off"}${split ? ` · ${split} split` : ""} · ${cases.length} cases × ${repeat} at concurrency ${concurrency}`,
);
if (noRef.length) console.log(`No current reference for ${noRef.length} (hard checks: target and replies only): ${noRef.slice(0, 12).join(", ")}${noRef.length > 12 ? "…" : ""}`);
const started = performance.now();
const jobs = cases.flatMap((c) => Array.from({ length: repeat }, () => c));
const finished = await pool(jobs, async (c) => {
  try {
    return { c, run: await runOnce(c) };
  } catch (err) {
    const why = message(err);
    const run: Run = {
      sent: [],
      did: [],
      outcomes: [],
      step: "crashed",
      checks: [{ name: "target", pass: false, why: `crashed: ${why}` }],
      hardPass: false,
      verdict: null,
      judgeError: null,
      engineMs: 0,
      relayMs: 0,
      judgeMs: 0,
      engineCostUsd: 0,
      relayCostUsd: 0,
      judgeCostUsd: 0,
      judgeListUsd: 0,
      errors: [why],
    };
    return { c, run };
  }
});
const wallMs = Math.round(performance.now() - started);
const runsOf = new Map<string, Run[]>(cases.map((c) => [c.id, []]));
for (const { c, run } of finished) runsOf.get(c.id)!.push(run);

// ── Scores ───────────────────────────────────────────────────────────────────────────────────
type Score = { runs: number; hard: number; judge: number; judged: number; both: number };
const blank = (): Score => ({ runs: 0, hard: 0, judge: 0, judged: 0, both: 0 });
const add = (s: Score, r: Run) => {
  s.runs++;
  if (r.hardPass) s.hard++;
  if (r.verdict) {
    s.judged++;
    if (r.verdict.pass) s.judge++;
    if (r.verdict.pass && r.hardPass) s.both++;
  }
};
const rate = (s: Score) => ({ runs: s.runs, hard: s.runs ? s.hard / s.runs : 0, judge: s.judged ? s.judge / s.judged : null, both: s.judged ? s.both / s.judged : null });
const total = blank();
const byCategory = new Map<string, Score>();
const byTag = new Map<string, Score>();
const checkFails = new Map<string, number>();
const aspects = new Map<string, number>();
let disagree = 0;
for (const c of cases) {
  for (const r of runsOf.get(c.id)!) {
    add(total, r);
    const cat = categoryOf(c);
    byCategory.set(cat, byCategory.get(cat) ?? blank());
    add(byCategory.get(cat)!, r);
    for (const t of c.tags) {
      byTag.set(t, byTag.get(t) ?? blank());
      add(byTag.get(t)!, r);
    }
    for (const x of r.checks) if (!x.pass) checkFails.set(x.name, (checkFails.get(x.name) ?? 0) + 1);
    if (r.verdict && !r.verdict.pass) aspects.set(r.verdict.aspect, (aspects.get(r.verdict.aspect) ?? 0) + 1);
    if (r.verdict && r.verdict.pass !== r.hardPass) disagree++;
  }
}
const all = [...runsOf.values()].flat();
const cost = {
  engine: all.reduce((a, r) => a + r.engineCostUsd, 0),
  relay: all.reduce((a, r) => a + r.relayCostUsd, 0),
  judge: all.reduce((a, r) => a + r.judgeCostUsd, 0),
};
const judgeList = all.reduce((a, r) => a + r.judgeListUsd, 0);
planStopped(all.map((r) => r.judgeError));
const relayLatency = all.map((r) => r.engineMs + r.relayMs);
const judgeLatency = all.filter((r) => r.verdict).map((r) => r.judgeMs);

// ── Report ───────────────────────────────────────────────────────────────────────────────────
const lines: string[] = [];
const say = (s = "") => {
  console.log(s);
  lines.push(s);
};
const short = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n)}…` : s);
const typed = (r: Run) =>
  r.sent.length ? r.sent.map((s) => `→ ${s.to}${s.via === "reply" ? " (reply)" : ""}: ${JSON.stringify(s.text)}`).join("  ") : `(nothing sent: ${r.outcomes.join(" + ") || "no action"})`;

say(`# Relay eval: ${label}`);
say();
say(`Variant ${variant.name} (${variant.about}) · router ${model} · your words ${config.utteranceModel} · judge ${judging ? judgeName(judgeEffort) : "off"}${split ? ` · ${split} split` : ""}`);
say(`${cases.length} cases × ${repeat} = ${all.length} runs · ${new Date().toISOString()}`);
say();
say("## Per case");
say();
for (const c of cases) {
  const runs = runsOf.get(c.id)!;
  const hard = runs.filter((r) => r.hardPass).length;
  const judged = runs.filter((r) => r.verdict);
  const jp = judged.filter((r) => r.verdict!.pass).length;
  const ok = hard === runs.length && jp === judged.length;
  say(`${ok ? "✔" : "✖"} ${c.id.padEnd(32)} ${categoryOf(c).padEnd(21)} hard ${hard}/${runs.length} judge ${judging ? `${jp}/${judged.length}` : "-"}  ${short(typed(runs[0]), 120)}`);
}
say();
say("## Per category");
say();
say(`${"category".padEnd(22)} ${"runs".padStart(5)} ${"hard".padStart(6)} ${"judge".padStart(6)} ${"both".padStart(6)}`);
for (const cat of CATEGORIES) {
  const s = byCategory.get(cat);
  if (!s) continue;
  say(`${cat.padEnd(22)} ${String(s.runs).padStart(5)} ${pct(s.hard, s.runs).padStart(6)} ${pct(s.judge, s.judged).padStart(6)} ${pct(s.both, s.judged).padStart(6)}`);
}
say(`${"all".padEnd(22)} ${String(total.runs).padStart(5)} ${pct(total.hard, total.runs).padStart(6)} ${pct(total.judge, total.judged).padStart(6)} ${pct(total.both, total.judged).padStart(6)}`);
say();
say(`Hard-check failures: ${[...checkFails].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
if (judging) say(`Judge failures by aspect: ${[...aspects].map(([k, n]) => `${k} ${n}`).join(", ") || "none"} · hard checks and judge disagree on ${disagree} of ${total.judged} runs`);
say();
say("## Failures");
say();
for (const c of cases) {
  const runs = runsOf.get(c.id)!;
  const bad = runs.filter((r) => !r.hardPass || (r.verdict && !r.verdict.pass) || r.judgeError);
  if (!bad.length) continue;
  say(`### ${c.id} (${categoryOf(c)}, ${SPLITS[c.id]})`);
  say(`- said: ${JSON.stringify(c.say)}`);
  say(
    `- want: ${c.to === null ? "not sent" : Array.isArray(c.to) ? c.to.join(" + ") : c.to}${
      referenceFor(references, c)
        ? ` · ideal: ${
            referenceFor(references, c)!
              .reference.messages.map((m) => `${m.to}: ${JSON.stringify(m.text)}`)
              .join(" | ") || "not sent"
          }`
        : ""
    }`,
  );
  for (const r of bad) {
    say(`- typed: ${typed(r)}`);
    const failed = r.checks.filter((x) => !x.pass);
    if (failed.length) say(`  - hard: ${failed.map((x) => `${x.name}${x.to && r.sent.length > 1 ? ` (${x.to})` : ""}: ${x.why}`).join("; ")}`);
    if (r.verdict && !r.verdict.pass) say(`  - judge: ${r.verdict.aspect}: ${r.verdict.reason}`);
    if (r.judgeError) say(`  - judge error: ${r.judgeError}`);
    if (r.errors.length) say(`  - engine errors: ${r.errors.join("; ")}`);
  }
  say();
}
say("## Latency and cost");
say();
say(
  `Relay (engine${variant.relay ? " + variant" : ""}) p50 ${(percentile(relayLatency, 0.5) / 1000).toFixed(2)}s · p95 ${(percentile(relayLatency, 0.95) / 1000).toFixed(2)}s` +
    (judging ? ` · judge p50 ${(percentile(judgeLatency, 0.5) / 1000).toFixed(1)}s, p95 ${(percentile(judgeLatency, 0.95) / 1000).toFixed(1)}s` : ""),
);
say(
  `Cost: engine ${usd(cost.engine)} (${usd(cost.engine / all.length)}/run)${variant.relay ? ` · variant ${usd(cost.relay)}` : ""}${judging ? ` · judge ${opusCost(cost.judge, judgeList, total.judged)}` : ""} · total ${usd(cost.engine + cost.relay + cost.judge)} · wall ${(wallMs / 1000).toFixed(0)}s at concurrency ${concurrency}`,
);

// ── Results ──────────────────────────────────────────────────────────────────────────────────
const summary = {
  kind: "relay-run",
  at: new Date().toISOString(),
  label,
  variant: variant.name,
  router: model,
  utteranceModel: config.utteranceModel,
  judge: judging ? { model: "claude-opus-5-5", effort: judgeEffort, backend } : null,
  concurrency,
  options: { split: split ?? null, tags, grep: grep ?? null, cases: ids, repeat, clean: flags.clean, trim: !flags["no-trim"], dictionary: flags.dictionary },
  cases: cases.length,
  runs: all.length,
  withoutReference: noRef,
  score: rate(total),
  perCategory: Object.fromEntries(CATEGORIES.filter((c) => byCategory.has(c)).map((c) => [c, rate(byCategory.get(c)!)])),
  perTag: Object.fromEntries([...byTag].sort((a, b) => a[0].localeCompare(b[0])).map(([t, s]) => [t, rate(s)])),
  hardCheckFailures: Object.fromEntries(checkFails),
  judgeAspects: Object.fromEntries(aspects),
  judgeErrors: all.filter((r) => r.judgeError).length,
  hardJudgeDisagree: disagree,
  latencyMs: {
    relayP50: percentile(relayLatency, 0.5),
    relayP95: percentile(relayLatency, 0.95),
    judgeP50: percentile(judgeLatency, 0.5),
    judgeP95: percentile(judgeLatency, 0.95),
  },
  costUsd: {
    ...cost,
    total: cost.engine + cost.relay + cost.judge,
    enginePerRun: cost.engine / all.length,
    judgePerVerdict: total.judged ? cost.judge / total.judged : 0,
    ...(judging && !onApi ? { judgeListPrice: judgeList } : {}),
  },
  wallMs,
  failures: cases.flatMap((c) =>
    runsOf
      .get(c.id)!
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !r.hardPass || (r.verdict && !r.verdict.pass))
      .map(({ r, i }) => ({
        id: c.id,
        category: categoryOf(c),
        split: SPLITS[c.id],
        run: i,
        hard: r.checks.filter((x) => !x.pass).map((x) => ({ check: x.name, why: x.why, ...(x.to ? { to: x.to } : {}) })),
        judge: r.verdict && !r.verdict.pass ? { aspect: r.verdict.aspect, reason: r.verdict.reason } : null,
      })),
  ),
};
mkdirSync(RESULTS, { recursive: true });
const stem = join(RESULTS, `relay-${stamp()}-${label.replace(/[^a-z0-9.-]+/gi, "_")}`);
writeFileSync(`${stem}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(
  `${stem}.json`,
  `${JSON.stringify({ summary: { ...summary, failures: undefined }, cases: cases.map((c) => ({ id: c.id, category: categoryOf(c), split: SPLITS[c.id], tags: c.tags, say: c.say, to: c.to, runs: runsOf.get(c.id) })) }, null, 2)}\n`,
);
writeFileSync(`${stem}.md`, `${lines.join("\n")}\n`);
console.log(`\nResults: ${stem}.summary.json (summary), .json (every run), .md (report)`);
process.exit(0);
