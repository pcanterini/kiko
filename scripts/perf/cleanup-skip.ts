// Could Jev say when your words need no clean-up, so the Haiku clean-up (src/core/cleanup.ts) is
// skipped and the send goes sooner? Replays every logged Haiku clean-up ("cleanup" lines: text →
// cleaned) and asks a `needs_cleanup` yes/no question of: a no-model heuristic, Jev (config.classifierModel)
// with a few wordings on just the words, Jev with the best wording on the real logged utterance
// state, and the shadow model (config.shadowModel, d1-ultra) with the best wording. Ground truth is
// what Haiku did: a clean-up that changed words (meaningful) vs only punctuation and capitals (cosmetic).
// Offline: never touches the app, sessions or logs/ (decide()'s own log lines go to a temp folder).
//
//   node --env-file=<main checkout>/.env scripts/perf/cleanup-skip.ts [--logs logs] [--dry] [--limit 400]
//        [--concurrency 4] [--cap 1] [--out scripts/perf/cleanup-skip-<date>.json] [--items <file>]
//
// --dry: dataset, labels and the heuristic only, no network. --limit: a stratified sample (by label)
// when the dataset is bigger. --cap: stop asking once this many dollars are spent. --items: also
// write every utterance's answers there (they hold your words: keep that file out of git).
// Costs money (OpenRouter decisions, ~$0.0001 a call); the 4s time limit is classifier.ts's.
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    logs: { type: "string", default: "logs" },
    dry: { type: "boolean", default: false },
    limit: { type: "string", default: "400" },
    concurrency: { type: "string", default: "4" },
    cap: { type: "string", default: "1" },
    out: { type: "string" },
    items: { type: "string" },
    seed: { type: "string", default: "1" },
    control: { type: "string", default: "150" },
  },
});

// decide() (src/core/classifier.ts) logs every call: to a temp folder, never the app's logs/.
process.env.KIKO_LOG_DIR = mkdtempSync(join(tmpdir(), "kiko-cleanup-skip-"));
// No speech here: config.ts then needs no Deepgram or Cartesia key.
process.env.KIKO_STT = "apple";
process.env.KIKO_TTS = "say";
if (flags.dry) {
  // config.ts wants the Haiku key; a dry run makes no calls.
  process.env.ANTHROPIC_API_KEY ||= "unused";
} else if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY missing: run with node --env-file=<main checkout>/.env (a worktree has no .env).");
}
const { config } = await import("../../src/core/config.ts");
const { decide, yes } = await import("../../src/core/classifier.ts");
const { leftOut } = await import("../../src/core/cleanup.ts");
const { DISFLUENT, tokens } = await import("../../src/core/words.ts");
type Question = import("../../src/core/classifier.ts").Question;

// ── Dataset: every Haiku clean-up in the logs ────────────────────────────────────────────────
type Line = { t: string; ms?: number; event: string; [k: string]: any };
type Label = "cosmetic" | "filler" | "edit";
type Item = {
  text: string;
  cleaned: string;
  times: number;
  label: Label;
  /** Haiku's version was sent (checkCleanup passed); when false, the words went as said anyway. */
  used: boolean;
  cleanupMs: number;
  /** How long the clean-up held the send: its end past the decision's (Jev, then router or trim). Null: not matched. */
  exposedMs: number | null;
  /** It went to a session (a "cleaned" line, or a typed/held/answered send with these words), so the send waited for the clean-up. */
  sent: boolean;
  jevMs: number | null;
  /** The real utterance request's state, from its "classify" line ("jev" before 2026-11-01), when found. */
  state: Record<string, unknown> | null;
  removed: string[];
};

const at = (l: Line) => Date.parse(l.t);
const SENDS = new Set(["terminal_type", "ghostty_type", "send_held", "desktop_send", "held_reply", "answered_held", "typed_in", "stop_answer", "hook_answer"]);
const errorMs: number[] = [];
const files = readdirSync(flags.logs!)
  .filter((f) => f.endsWith(".jsonl"))
  .sort();
const byText = new Map<string, Item>();
let cleanupLines = 0;
let cleanupErrors = 0;
const models = new Map<string, number>();
/** Every utterance Jev decided on, by its words: the control set's source. */
const heard = new Map<string, Record<string, unknown>>();
for (const f of files) {
  const lines: Line[] = [];
  for (const raw of readFileSync(join(flags.logs!, f), "utf8").split("\n")) {
    if (!raw) continue;
    try {
      lines.push(JSON.parse(raw));
    } catch {}
  }
  for (const [i, l] of lines.entries()) {
    if ((l.event === "classify" || l.event === "jev") && l.what === "utterance" && typeof l.state?.user_said === "string") heard.set(l.state.user_said, l.state);
    if (l.event !== "cleanup") continue;
    cleanupLines++;
    if (typeof l.cleaned !== "string") {
      cleanupErrors++;
      if (l.ms) errorMs.push(l.ms);
      continue;
    }
    models.set(l.model, (models.get(l.model) ?? 0) + 1);
    const known = byText.get(l.text);
    if (known) {
      known.times++;
      continue;
    }
    const end = at(l);
    const near = lines.slice(Math.max(0, i - 40), i + 40).filter((x) => Math.abs(at(x) - end) < 15000);
    const jev = near.filter((x) => (x.event === "classify" || x.event === "jev") && x.what === "utterance" && x.state?.user_said === l.text && at(x) <= end + 5000).at(-1);
    const route = near.find((x) => x.event === "route" && typeof x.prompt === "string" && x.prompt.includes(l.text) && at(x) >= (jev ? at(jev) : end - 5000));
    const trim = near.find((x) => x.event === "trim" && x.text === l.text);
    // Only a send to a session waits for the clean-up: one logged with these words, cleaned up or as said.
    const sent = near.some((x) => at(x) >= end - 1000 && ((x.event === "cleaned" && x.said === l.text) || (SENDS.has(x.event) && [x.text, x.reply].some((s) => s === l.text || s === l.cleaned))));
    const decided = Math.max(...[jev, route, trim].filter(Boolean).map((x) => at(x!)));
    byText.set(l.text, {
      text: l.text,
      cleaned: l.cleaned,
      times: 1,
      label: labelOf(l.text, l.cleaned),
      used: l.used !== false,
      cleanupMs: l.ms ?? 0,
      exposedMs: jev ? Math.max(0, end - decided) : null,
      sent,
      jevMs: jev?.ms ?? null,
      state: jev?.state ?? null,
      removed: leftOut(l.text, l.cleaned),
    });
  }
}

/**
 * cosmetic: the same words, in order (case, punctuation and apostrophes aside): only punctuation,
 * capitals and sentence breaks changed. filler: only filler sounds left out (uh, um, er, hmm…).
 * edit: any other word left out or changed: repeats, false starts, filler "like"/"you know", joined names.
 */
function labelOf(text: string, cleaned: string): Label {
  const from = tokens(text).map((t) => t.word);
  const to = tokens(cleaned).map((t) => t.word);
  if (from.join(" ") === to.join(" ")) return "cosmetic";
  const removed = leftOut(text, cleaned).map((w) => w.toLowerCase());
  const onlyRemoved = to.length + removed.length === from.length;
  return onlyRemoved && removed.every((w) => DISFLUENT.has(w)) ? "filler" : "edit";
}

// ── Sample, stratified by label, when there are more than --limit ─────────────────────────────
let rand = Number(flags.seed);
const random = () => ((rand = (rand * 1103515245 + 12345) % 2 ** 31), rand / 2 ** 31);
const all = [...byText.values()];
const limit = Number(flags.limit);
let items = all;
if (all.length > limit) {
  items = [];
  for (const label of ["cosmetic", "filler", "edit"] as Label[]) {
    const group = all.filter((x) => x.label === label);
    const take = Math.max(Math.min(group.length, 1), Math.round((group.length / all.length) * limit));
    items.push(...[...group].sort(() => random() - 0.5).slice(0, take));
  }
}
const count = (xs: Item[], f: (x: Item) => boolean) => xs.filter(f).length;
const positive = (x: Item) => x.label !== "cosmetic";
console.log(`${files.length} log files, ${cleanupLines} cleanup lines (${cleanupErrors} errors/timeouts), models ${JSON.stringify(Object.fromEntries(models))}`);
console.log(`${all.length} distinct texts; sample ${items.length}`);
for (const label of ["cosmetic", "filler", "edit"] as Label[]) {
  console.log(`  ${label.padEnd(9)} ${count(all, (x) => x.label === label)} (Haiku's version not used: ${count(all, (x) => x.label === label && !x.used)})`);
}

// ── Deciders ───────────────────────────────────────────────────────────────────────────────
// a. No model: what the regex sees. Each rule alone and all together.
const FUNCTION_WORD = /^(?:the|a|an|to|and|of|for|with|in|on|at|that|is|but|or|so|my|your|this|from)$/;
const rules: Record<string, (text: string) => boolean> = {
  fillers: (t) => tokens(t).some((w) => DISFLUENT.has(w.word)),
  repeats: (t) => tokens(t).some((w, i, ws) => i > 0 && w.word === ws[i - 1].word),
  like_you_know: (t) => /,\s*like,|\byou know\b|\bi mean,/i.test(t),
  // A sentence broken off: ends on a function word ("Look at the. Check the logs."), or a dash or ellipsis.
  fragments: (t) =>
    /(?:—|--|\.\.\.|…)/.test(t) ||
    t
      .split(/[.?!]+/)
      .slice(0, -1)
      .some((s) => FUNCTION_WORD.test(tokens(s).at(-1)?.word ?? "")),
};
const base = Object.values(rules);
rules.any = (t) => base.some((f) => f(t));
// The app's own gate today (cleanup.ts worthCleaning): Haiku is only called when this says yes, so
// every clean-up in the dataset passed it.
const appGate = (t: string) => rules.fillers(t) || rules.repeats(t) || /,\s*like,|\byou know\b/i.test(t);

// Control: utterances the gate let through without a call (no filler, no repeat), so no Haiku
// answer to label them by; taken as clean. What a model would say of them is its false-alarm rate,
// had it replaced the gate.
const control = [...heard.keys()]
  .filter((t) => !byText.has(t) && !appGate(t))
  .sort(() => random() - 0.5)
  .slice(0, Number(flags.control));
// "Uh," up front and nothing else: the commonest clean-up, and the one that matters least.
rules.not_just_leading_filler = (t) => {
  const ws = tokens(t).map((w) => w.word);
  const inner = ws.slice(ws.findIndex((w) => !DISFLUENT.has(w)));
  return rules.any(inner.join(" ")) || rules.like_you_know(t) || rules.fragments(t);
};

// b, c. Decision models: one noul question.
const WORDINGS: Record<string, Question> = {
  plain: {
    type: "noul",
    instructions:
      "This is a speech-to-text transcript of what the user said out loud, about to be typed to Claude as their message. " +
      "Does it need words removed or fixed before it goes, beyond punctuation and capitals?",
    criteria: {
      true: 'It has filler sounds (uh, um, er, hmm), filler "like" or "you know", a word said twice by accident, or a false start the user broke off and said again.',
      false: "Every word belongs and it reads as the user meant it; at most punctuation or capitals need fixing.",
    },
  },
  rules: {
    type: "noul",
    instructions:
      "A clean-up step tidies the user's spoken words before Claude reads them. It only removes filler sounds (uh, um, er, ah, hmm), " +
      '"like" or "you know" when only filler, stutters and words said twice by accident ("the the", "I, I think"), and false starts ' +
      '("look at the, uh, check the logs" → "check the logs"). It never rewords, and never fixes names, grammar or misheard words. ' +
      "Would that clean-up change any word of these words?",
    criteria: {
      true: 'At least one word would be removed: a filler sound, a filler "like"/"you know", a repeat or a false start.',
      false: "No word would be removed: it's already clean, or only punctuation and capitals would change.",
    },
  },
  examples: {
    type: "noul",
    instructions: "Is this transcript of the user's speech messy: does it have words a careful editor would delete before sending it?",
    criteria: {
      true: 'Yes: "Uh, check the logs.", "Run the, the tests.", "Look at the, check the logs.", "Um, yeah, go ahead.", ' + '"It\'s like, you know, slow.", "I, I think so."',
      false: 'No, every word is meant: "Allow it.", "Yeah, run the tests.", "Rename it to Clipkit.", "No, that was for lacy.", "Just commit it."',
    },
  },
};

type Run = { name: string; model: string; wording: string; state: "words" | "real"; p: (number | null)[]; ms: number[]; costUsd: number; errors: number };
const runs: Run[] = [];
/** The same deciders on the control set, by run name. */
const controlP = new Map<string, (number | null)[]>();
let spent = 0;
const cap = Number(flags.cap);
const stateFor = (x: Item, kind: Run["state"]) => (kind === "real" && x.state ? x.state : { user_said: x.text });
const controlState = (text: string, kind: Run["state"]) => (kind === "real" ? heard.get(text)! : { user_said: text });

/** Asks `model` the `wording` question about each of `states`: p(yes) per state, null on an error or past the cap. */
async function askAll(name: string, model: string, wording: string, states: unknown[], run: Pick<Run, "ms" | "costUsd" | "errors">) {
  const p: (number | null)[] = states.map(() => null);
  let next = 0;
  const worker = async () => {
    while (next < states.length && spent < cap) {
      const i = next++;
      try {
        const r = await decide("cleanup_skip", states[i], { needs_cleanup: WORDINGS[wording] }, { model });
        p[i] = yes(r.answers.needs_cleanup);
        run.ms.push(r.ms);
        run.costUsd += r.costUsd;
        spent += r.costUsd;
      } catch (err) {
        run.errors++;
        if (run.errors <= 3) console.error(`  ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Number(flags.concurrency) }, worker));
  return p;
}

async function ask(name: string, model: string, wording: string, state: Run["state"]) {
  const run: Run = { name, model, wording, state, p: [], ms: [], costUsd: 0, errors: 0 };
  runs.push(run);
  run.p = await askAll(
    name,
    model,
    wording,
    items.map((x) => stateFor(x, state)),
    run,
  );
  controlP.set(
    name,
    await askAll(
      name,
      model,
      wording,
      control.map((t) => controlState(t, state)),
      run,
    ),
  );
  console.log(`${name}: ${run.ms.length} answers (with control), ${run.errors} errors, $${run.costUsd.toFixed(4)} (total $${spent.toFixed(4)})`);
  return run;
}

/** Area under the ROC curve for "needs cleanup": how well p ranks messy above clean. */
function auc(run: Run) {
  const pos = items.flatMap((x, i) => (positive(x) && run.p[i] !== null ? [run.p[i]!] : []));
  const neg = items.flatMap((x, i) => (!positive(x) && run.p[i] !== null ? [run.p[i]!] : []));
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

if (!flags.dry) {
  const jev = config.classifierModel;
  const shadow = config.shadowModel || "liquid/d1-ultra";
  for (const w of Object.keys(WORDINGS)) await ask(`jev/${w}/words`, jev, w, "words");
  // The best wording by AUC, then again on the real request's state and by the shadow model.
  const best = runs.map((r) => ({ r, a: auc(r) ?? 0 })).sort((a, b) => b.a - a.a)[0].r.wording;
  console.log(`best wording: ${best}`);
  await ask(`jev/${best}/real`, jev, best, "real");
  await ask(`${shadow.split("/").pop()}/${best}/words`, shadow, best, "words");
  await ask(`${shadow.split("/").pop()}/${best}/real`, shadow, best, "real");
}

// ── Scoring ────────────────────────────────────────────────────────────────────────────────
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const p90 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)] : null);
const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);
const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
/** What skipping would have saved on this one: the send's wait for the clean-up (0 when nothing waited). */
const waitOf = (x: Item) => (x.sent && x.exposedMs !== null ? x.exposedMs : 0);

/** One decider's verdicts: true = needs clean-up (wait for Haiku), false = skip. */
function score(name: string, needs: boolean[], extra: { skipBelow?: number; auc?: number | null; controlNeeds?: number } = {}) {
  const tp = count(items, (x) => needs[items.indexOf(x)] && positive(x));
  const fp = count(items, (x) => needs[items.indexOf(x)] && !positive(x));
  const skipped = items.filter((_, i) => !needs[i]);
  const falseSkips = skipped.filter(positive);
  const pos = count(items, positive);
  const exposed = skipped.map(waitOf);
  return {
    name,
    ...extra,
    skip: pct(skipped.length, items.length),
    precision: pct(tp, tp + fp),
    recall: pct(tp, pos),
    falseSkips: falseSkips.length,
    falseSkipsFiller: count(falseSkips, (x) => x.label === "filler"),
    falseSkipsEdit: count(falseSkips, (x) => x.label === "edit"),
    // Harm only where Haiku's version would have been sent: a used clean-up that changed words.
    falseSkipsUsed: count(falseSkips, (x) => x.used),
    rightSkips: count(skipped, (x) => !positive(x)),
    // Per utterance, over the whole sample: the clean-up's own time, and the part of it the send waited for.
    savedCleanupMsPerUtt: Math.round(skipped.reduce((s, x) => s + x.cleanupMs, 0) / items.length),
    savedExposedMsPerUtt: Math.round(exposed.reduce((s, x) => s + x, 0) / items.length),
    examples: falseSkips.slice(0, 6).map((x) => ({ label: x.label, removed: x.removed })),
  };
}

const results: ReturnType<typeof score>[] = [];
const count2 = (xs: string[], f: (t: string) => boolean) => xs.filter(f).length;
for (const [name, rule] of Object.entries({ app_gate: appGate, ...rules })) {
  results.push(
    score(
      `heuristic/${name}`,
      items.map((x) => rule(x.text)),
      { controlNeeds: pct(count2(control, rule), control.length) },
    ),
  );
}
// Upper bounds: a decider that knew Haiku's answer. Skipping a clean-up checkCleanup would throw
// away anyway (not used) also changes nothing that's sent.
results.push(score("oracle/cosmetic", items.map(positive)));
results.push(
  score(
    "oracle/cosmetic+not-used",
    items.map((x) => positive(x) && x.used),
  ),
);
const THRESHOLDS = [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7];
for (const run of runs) {
  for (const t of THRESHOLDS) {
    // No answer (error, timeout, over the cap): wait for Haiku as today.
    // controlNeeds: of the clean control utterances, the share it would still send to Haiku.
    const c = controlP.get(run.name) ?? [];
    const controlNeeds = pct(c.filter((p) => p === null || p >= t).length, c.length);
    results.push(
      score(
        run.name,
        run.p.map((p) => p === null || p >= t),
        { skipBelow: t, auc: auc(run), controlNeeds },
      ),
    );
  }
}

const exposedAll = items.flatMap((x) => (x.sent && x.exposedMs !== null ? [x.exposedMs] : []));
const summary = {
  date: new Date().toISOString().slice(0, 10),
  what:
    "Skip the Haiku clean-up when a needs_cleanup question says the words are already clean. Ground truth: Haiku's own logged clean-ups " +
    "(cosmetic = same words, only punctuation/capitals; filler = only uh/um/er/hmm left out; edit = any other word left out or changed). " +
    "Positive = needs clean-up (filler or edit). Model deciders skip when p(yes) < skipBelow; an error or timeout never skips.",
  logs: { files: files.length, cleanupLines, cleanupErrors, models: Object.fromEntries(models) },
  dataset: {
    distinct: all.length,
    sample: items.length,
    control: control.length,
    // Every distinct utterance Jev decided on, and how many the app's gate sends to Haiku.
    utterances: heard.size,
    utterancesPassingGate: [...heard.keys()].filter(appGate).length,
    labels: Object.fromEntries((["cosmetic", "filler", "edit"] as Label[]).map((l) => [l, count(items, (x) => x.label === l)])),
    notUsed: count(items, (x) => !x.used),
    sent: count(items, (x) => x.sent),
    withRealState: count(items, (x) => x.state !== null),
    cleanupMs: { median: median(items.map((x) => x.cleanupMs)), p90: p90(items.map((x) => x.cleanupMs)) },
    // Sends only: how long each waited on the clean-up past the decision.
    exposedMs: { sends: exposedAll.length, mean: mean(exposedAll), median: median(exposedAll), p90: p90(exposedAll), zero: exposedAll.filter((x) => x === 0).length },
    cleanupErrors: { n: cleanupErrors, msMedian: median(errorMs) },
    loggedJevMs: { median: median(items.flatMap((x) => (x.jevMs ? [x.jevMs] : []))) },
  },
  runs: runs.map((r) => ({
    name: r.name,
    model: r.model,
    wording: r.wording,
    state: r.state,
    answers: r.ms.length,
    errors: r.errors,
    costUsd: r.costUsd,
    msMedian: median(r.ms),
    msP90: p90(r.ms),
    auc: auc(r),
  })),
  wordings: WORDINGS,
  spentUsd: spent,
  results,
};
console.log(JSON.stringify(summary.dataset, null, 1));
for (const r of results) {
  console.log(
    `${r.name.padEnd(36)} ${"skipBelow" in r ? String(r.skipBelow).padEnd(5) : "     "} skip ${String(r.skip).padStart(5)}%  P ${String(r.precision).padStart(5)}  R ${String(r.recall).padStart(5)}  control ${String(r.controlNeeds ?? "-").padStart(5)}%  falseSkips ${r.falseSkips} (filler ${r.falseSkipsFiller}, edit ${r.falseSkipsEdit}, used ${r.falseSkipsUsed})  right ${r.rightSkips}  saved ${r.savedExposedMsPerUtt}ms exposed / ${r.savedCleanupMsPerUtt}ms cleanup per utt`,
  );
}
if (flags.out) writeFileSync(flags.out, JSON.stringify(summary, null, 1) + "\n");
if (flags.items) {
  writeFileSync(
    flags.items,
    JSON.stringify(
      items.map((x, i) => ({ ...x, state: undefined, p: Object.fromEntries(runs.map((r) => [r.name, r.p[i]])) })),
      null,
      1,
    ) + "\n",
  );
}
console.log(`spent $${spent.toFixed(4)}`);
