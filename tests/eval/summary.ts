// Summary eval: how the spoken summary of a finished turn (src/core/summarizer.ts) does on the user's
// real replies, layer by layer: the code's read of the reply (src/core/reply-shape.ts), Jev's read of
// the same (decisions.ts replyKindQuestions), the summary model's words, and its instructions (the
// variants below differ in nothing else). The cases come from logs/ (summary events: the reply, the
// conversation, your words that turn, and what was said then), with their must-keep items marked by a
// judge (Claude, on the user's subscription, not a paid API judge) in summary-cases.json; each
// variant's summaries are judged the same way, in summary-verdicts.json. Both hold the user's own
// words, so they're never in the repo: --data names their folder (summary-data.ts; private-evals/
// in the checkout is git-ignored for them), and without it the eval runs on sample/, a small
// made-up set. Model output and timings go to tests/eval/results/ (git-ignored).
//
//   node tests/eval/summary.ts --data private-evals --report        any step below, on the real cases
//   node tests/eval/summary.ts --data <dir> --extract --logs <checkout>/logs   (re)build <dir>/summary-cases.json from logs, labels kept
//   node tests/eval/summary.ts --run old,new                         summaries per variant (cached by input)
//   node tests/eval/summary.ts --jev                                 Jev's read of each reply, with its time
//   node tests/eval/summary.ts --more                                "more" and "more about <topic>" on the cases that have one
//   node tests/eval/summary.ts --judge-input                         what the judge reads: results/summary-judge-input.json
//   node tests/eval/summary.ts --report                              the scores, from the verdicts
//
// Variants: old (the summarizer before this change, from git: --base), new (the new instructions, the
// model reading the reply alone), new-code (and the code's read as hints), new-jev (and Jev's read as
// hints: the summary waits for Jev, so its first token comes that much later).
//
// Keys: as the app loads them (config.ts reads .env from the working directory, or they're in the
// environment): run it from the main checkout, `cd <main checkout> && node <worktree>/tests/eval/summary.ts`,
// in a worktree. The Keychain is never read here (KIKO_KEYCHAIN=off). Costs a little: Haiku and
// Jev per case and variant, results cached.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readCases, type SummaryCase, summaryData } from "./summary-data.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const RESULTS = join(here, "results");

const { values: flags } = parseArgs({
  options: {
    data: { type: "string" },
    extract: { type: "boolean", default: false },
    logs: { type: "string" },
    run: { type: "string" },
    jev: { type: "boolean", default: false },
    more: { type: "boolean", default: false },
    "judge-input": { type: "boolean", default: false },
    report: { type: "boolean", default: false },
    case: { type: "string" },
    concurrency: { type: "string", default: "3" },
    length: { type: "string", default: "normal" },
    base: { type: "string", default: "7a14bb4" },
    fresh: { type: "boolean", default: false },
    as: { type: "string" },
    variants: { type: "string" },
    heard: { type: "string", default: "new" },
    round: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (flags.help) {
  console.log(
    "node tests/eval/summary.ts [--data <dir>] [--extract --logs <dir>] [--run old,new,new-code,new-jev] [--jev] [--more] [--judge-input] [--report] [--case id,id] [--length short|normal] [--fresh]",
  );
  process.exit(0);
}
const DATA = summaryData(flags.data);
const CASES_FILE = DATA.casesFile;
const VERDICTS_FILE = DATA.verdictsFile;

// ── Environment, before any src/ module loads ──────────────────────────────────────────────
process.env.KIKO_KEYCHAIN = "off";
process.env.KIKO_SETTINGS = join(here, "no-saved-settings.json");
process.env.KIKO_STT = "apple";
process.env.KIKO_TTS = "say";
process.env.KIKO_LLM = "haiku";
process.env.KIKO_SUMMARY_LENGTH = flags.length;
process.env.KIKO_SHADOW_MODEL = "off";
process.env.KIKO_LOG_DIR = join(here, "logs");
mkdirSync(RESULTS, { recursive: true });

const readJson = <T>(file: string, fallback: T): T => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback);
const writeJson = (file: string, data: unknown) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

// ── Extract: cases from logs ───────────────────────────────────────────────────────────────
if (flags.extract) {
  // Real replies: only into a folder of their own, never over the sample in the repo.
  if (DATA.sample) {
    console.error("--extract writes the user's own replies: pass --data <dir> (outside the repo, or private-evals/).");
    process.exit(1);
  }
  mkdirSync(DATA.dir, { recursive: true });
  const dir = flags.logs ?? join(root, "logs");
  // No model is called here, but config.ts wants a key to load: a stand-in, never sent anywhere.
  process.env.ANTHROPIC_API_KEY ||= "not-used-by-extract";
  const old = new Map(readJson<SummaryCase[]>(CASES_FILE, []).map((c) => [c.id, c]));
  const all = new Map<string, SummaryCase>();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && f !== "latest.jsonl")
    .sort()) {
    let needsUser: { start: string; value: number } | null = null;
    let last: SummaryCase | null = null;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if ((e.event === "classify" || e.event === "jev") && e.what === "stop") needsUser = { start: String(e.state?.claude_reply ?? "").slice(0, 80), value: e.answers?.needs_user?.noul ?? null };
      if (e.event === "announce" && last && e.folder === last.name && last.firstTokenMsThen === null) last.firstTokenMsThen = e.firstTokenMs ?? null;
      if (e.event !== "summary" || typeof e.prompt !== "string") continue;
      const p: string = e.prompt;
      const reply = p.match(/<(\w+)_reply>([\s\S]*)<\/\1_reply>/);
      if (!reply || !e.text) continue;
      const name = p.match(/^<(session_name|folder)>([^<]*)<\/\1>/);
      const block = (tag: string) => p.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1];
      const flat = reply[2].replace(/\s+/g, " ").trim();
      const c: SummaryCase = {
        id: hash(reply[2]),
        at: e.t,
        name: name?.[2] ?? "session",
        titled: name?.[1] === "session_name",
        nameSession: /^<[^>]+>[^<]*<\/[^>]+> \(name the session\)/.test(p),
        tag: reply[1],
        context: (block("recent_conversation") ?? "").split("\n").filter((l) => l && l !== "(unknown)"),
        asked: (block("user_asked") ?? "").split("\n").filter(Boolean),
        reply: reply[2],
        needsUser: needsUser && flat.startsWith(needsUser.start.slice(0, 60)) ? needsUser.value : null,
        spokenThen: e.text,
        firstTokenMsThen: null,
      };
      last = c;
      all.set(c.id, c);
    }
  }
  // A spread, not the most common kind over and over: the code's read sorts them (the judge decides
  // what each really is), and each group is sampled evenly over time. The ones judged already stay.
  const { shapeOf } = await import("../../src/core/reply-shape.ts");
  const { claudeAsked } = await import("../../src/core/summarizer.ts");
  const groups = new Map<string, SummaryCase[]>();
  for (const c of all.values()) {
    if (c.reply.length < 20) continue;
    const s = shapeOf(c.reply, c.asked, claudeAsked(c.reply, c.needsUser));
    const key = c.reply.length > 2500 ? "long" : s.kinds.includes("failure") ? "failure" : s.kinds[0];
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const WANT: Record<string, number> = { failure: 16, decision: 16, answer: 14, plan: 10, report: 12, done: 6, long: 10 };
  const picked = new Map<string, SummaryCase>([...old].filter(([id]) => all.has(id)));
  for (const [key, list] of groups) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    const n = WANT[key] ?? 4;
    for (let i = 0; i < n && i < list.length; i++) {
      const c = list[Math.floor(((i + 0.5) * list.length) / n)];
      if (!picked.has(c.id)) picked.set(c.id, c);
    }
  }
  const out = [...picked.values()].map((c) => ({ ...c, ...pick(old.get(c.id), ["kinds", "mustKeep", "topic", "offTopic"]) }));
  out.sort((a, b) => a.at.localeCompare(b.at));
  writeJson(CASES_FILE, out);
  console.log(`${out.length} cases from ${all.size} replies (${[...groups].map(([k, v]) => `${k} ${v.length}`).join(", ")}) → ${CASES_FILE}`);
  process.exit(0);
}

function pick<T extends object>(o: T | undefined, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => o && (o as any)[k] !== undefined).map((k) => [k, (o as any)[k]]));
}

const ALL_CASES = readCases(DATA);
if (DATA.sample) console.log(`The sample's ${ALL_CASES.length} made-up cases (--data <dir> for the real ones).`);
const only = flags.case ? new Set(flags.case.split(",")) : null;
const CASES = ALL_CASES.filter((c) => !only || only.has(c.id));

// ── The app's modules ──────────────────────────────────────────────────────────────────────
const { config } = await import("../../src/core/config.ts");
const summarizer = await import("../../src/core/summarizer.ts");
const { shapeOf } = await import("../../src/core/reply-shape.ts");
const { decide } = await import("../../src/core/classifier.ts");
const { replyKindQuestions, replyReadOf } = await import("../../src/core/decisions.ts");
type Voice = import("../../src/core/summarizer.ts").Voice;

const voiceOf = (tag: string): Voice => (tag === "claude" ? { agent: "Claude Code", speaker: "Claude" } : tag === "codex" ? { agent: "Codex", speaker: "Codex" } : { agent: "T3 Code", speaker: "" });
const needKeys = () => {
  // Whether they're there, never what they are.
  const missing = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`${missing.join(" and ")} missing: run from the main checkout (its .env), or with them in the environment.`);
};

/** The summarizer as it was at --base, for the "old" variant: written next to the results, its imports pointed at src/. */
async function oldSummarizer() {
  const file = join(RESULTS, `summarizer-${flags.base}.ts`);
  if (!existsSync(file)) {
    const src = execFileSync("git", ["-C", root, "show", `${flags.base}:src/core/summarizer.ts`], { encoding: "utf8" });
    writeFileSync(file, src.replace(/from "\.\//g, 'from "../../../src/core/'));
  }
  return (await import(file)) as typeof summarizer;
}

/** Runs `fn` over `items`, `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await fn(item);
    }),
  );
}

type Output = { text: string; ttftMs: number; ms: number; costUsd: number; waitMs?: number; inputHash: string };
// Normal's results under the variant's name; another length's beside them: summary-new-brief.json.
const resultsFile = (name: string) => join(RESULTS, `summary-${name}${flags.length === "normal" ? "" : `-${flags.length}`}.json`);

// ── Jev's read ─────────────────────────────────────────────────────────────────────────────
type JevRead = ReturnType<typeof replyReadOf> & { ms: number; costUsd: number };
async function jevRead(c: SummaryCase): Promise<JevRead> {
  const r = await decide(
    "reply_kind",
    { claude_reply: c.reply.replace(/\s+/g, " ").slice(0, 3000), user_asked: c.asked, recent_conversation: c.context.slice(-4) },
    replyKindQuestions(voiceOf(c.tag).speaker),
  );
  return { ...replyReadOf(r.answers as any), ms: r.ms, costUsd: r.costUsd };
}

if (flags.jev) {
  needKeys();
  config.classifier = true;
  const out = readJson<Record<string, JevRead>>(join(RESULTS, "summary-jev.json"), {});
  await pool(
    CASES.filter((c) => flags.fresh || !out[c.id]),
    Number(flags.concurrency),
    async (c) => {
      out[c.id] = await jevRead(c);
      process.stdout.write(".");
    },
  );
  writeJson(join(RESULTS, "summary-jev.json"), out);
  console.log(`\nJev's read of ${CASES.length} replies → results/summary-jev.json`);
}

/** Jev's read as the summary's hints: its kind, and the must-keep kinds it's fairly sure of. */
function jevHints(r: JevRead) {
  const kinds = [r.kind];
  const sure = (["failure", "skipped", "caveat", "risk"] as const).filter((k) => r[k] >= 0.6);
  return {
    kinds: kinds as any,
    mustKeep: sure.map(
      (k) =>
        `(it ${k === "failure" ? "says something failed" : k === "skipped" ? "says something was skipped or isn't done" : k === "caveat" ? "has a caveat: untested or unverified" : "did or proposes something risky"})`,
    ),
  };
}

// ── Summaries per variant ──────────────────────────────────────────────────────────────────
if (flags.run) {
  needKeys();
  config.classifier = true;
  const old = await oldSummarizer();
  for (const variant of flags.run.split(",")) {
    // --as: the same variant under another name, for a change to the instructions tried beside the last.
    const file = resultsFile(flags.as ?? variant);
    const out = readJson<Record<string, Output>>(file, {});
    const jevFile = readJson<Record<string, JevRead>>(join(RESULTS, "summary-jev.json"), {});
    await pool(CASES, Number(flags.concurrency), async (c) => {
      const voice = voiceOf(c.tag);
      const turn = { name: c.name, titled: c.titled, nameSession: c.nameSession, context: c.context, asked: c.asked, claudeReply: c.reply, voice, needsUser: Promise.resolve(c.needsUser) };
      let shape: { kinds?: any; mustKeep?: string[] } | undefined;
      let waitMs = 0;
      if (variant === "new-code") {
        const s = shapeOf(c.reply, c.asked, summarizer.claudeAsked(c.reply, c.needsUser));
        shape = { kinds: s.kinds, mustKeep: s.mustKeep.map((m) => m.text) };
      }
      const prompts = variant === "old" ? "old" : hash(readFileSync(join(root, "src/core/summarizer.ts"), "utf8"));
      const inputHash = hash(JSON.stringify([variant, prompts, flags.length, turn.claudeReply, turn.context, turn.asked, shape ?? null]));
      if (!flags.fresh && out[c.id]?.inputHash === inputHash) return;
      const start = performance.now();
      if (variant === "new-jev") {
        // The summary waits for Jev: its read is asked first, as the app would have to.
        const r = jevFile[c.id] && !flags.fresh ? jevFile[c.id] : await jevRead(c);
        waitMs = r.ms;
        shape = jevHints(r);
      }
      let first = 0;
      const s = variant === "old" ? new old.Summarizer() : new summarizer.Summarizer();
      const t0 = performance.now();
      const r = await s.summarize({ ...turn, ...(shape ? { shape } : {}) } as any, () => {
        first ||= performance.now();
      });
      if (!r) return;
      out[c.id] = {
        text: r.text,
        ttftMs: Math.round((first || performance.now()) - t0) + waitMs,
        ms: Math.round(performance.now() - start),
        costUsd: r.costUsd,
        ...(waitMs ? { waitMs } : {}),
        inputHash,
      };
      process.stdout.write(".");
    });
    writeJson(file, out);
    console.log(`\n${flags.as ?? variant}: ${Object.keys(out).length} summaries → ${file}`);
  }
}

// ── More ───────────────────────────────────────────────────────────────────────────────────
if (flags.more) {
  needKeys();
  // What was heard before "more": --heard's summaries (the variant in use), else what was said then.
  const base = readJson<Record<string, Output>>(resultsFile(flags.heard), {});
  const file = resultsFile("more");
  const out = readJson<Record<string, Output & { kind: string; topic?: string }>>(file, {});
  const jobs = CASES.flatMap((c) => [
    ...(c.topic !== undefined ? [{ c, kind: "more", topic: undefined as string | undefined }] : []),
    ...(c.topic ? [{ c, kind: "about", topic: c.topic }] : []),
    ...(c.offTopic ? [{ c, kind: "off", topic: c.offTopic }] : []),
  ]);
  await pool(jobs, Number(flags.concurrency), async ({ c, kind, topic }) => {
    const key = `${c.id}:${kind}`;
    const heard = base[c.id]?.text ?? c.spokenThen;
    const inputHash = hash(JSON.stringify([kind, topic, heard, flags.length, readFileSync(join(root, "src/core/summarizer.ts"), "utf8")]));
    if (!flags.fresh && out[key]?.inputHash === inputHash) return;
    let first = 0;
    const t0 = performance.now();
    const r = await new summarizer.Summarizer().more({ name: c.name, titled: c.titled, claudeReply: c.reply, heard, topic, asked: c.asked, voice: voiceOf(c.tag) }, () => {
      first ||= performance.now();
    });
    if (!r) return;
    out[key] = { kind, ...(topic ? { topic } : {}), text: r.text, ttftMs: Math.round(first - t0), ms: Math.round(performance.now() - t0), costUsd: r.costUsd, inputHash };
    process.stdout.write(".");
  });
  writeJson(file, out);
  console.log(`\nmore: ${Object.keys(out).length} → ${file}`);
}

// ── What the judge reads ───────────────────────────────────────────────────────────────────
// What --judge-input and --report take: --variants, else the four built in.
const VARIANTS = flags.variants ? flags.variants.split(",") : ["old", "new", "new-code", "new-jev"];
if (flags["judge-input"]) {
  const outs = Object.fromEntries(VARIANTS.map((v) => [v, readJson<Record<string, Output>>(resultsFile(v), {})]));
  const more = readJson<Record<string, Output & { kind: string; topic?: string }>>(resultsFile("more"), {});
  // Blind: each case's summaries under letters, in an order of their own; the key is kept apart.
  const key: Record<string, Record<string, string>> = {};
  const input = CASES.map((c) => {
    const have = VARIANTS.filter((v) => outs[v][c.id]);
    const order = [...have].sort((a, b) => hash(c.id + a).localeCompare(hash(c.id + b)));
    key[c.id] = Object.fromEntries(order.map((v, i) => ["ABCDEFGH"[i], v]));
    return {
      id: c.id,
      asked: c.asked,
      reply: c.reply,
      mustKeep: c.mustKeep ?? null,
      summaries: Object.fromEntries(order.map((v, i) => ["ABCDEFGH"[i], outs[v][c.id].text])),
      more: Object.values(more).length
        ? Object.fromEntries(["more", "about", "off"].filter((k) => more[`${c.id}:${k}`]).map((k) => [k, { topic: more[`${c.id}:${k}`].topic, text: more[`${c.id}:${k}`].text }]))
        : undefined,
    };
  });
  writeJson(join(RESULTS, "summary-judge-input.json"), input);
  writeJson(join(RESULTS, "summary-judge-key.json"), key);
  console.log(`${input.length} cases → results/summary-judge-input.json (key: summary-judge-key.json)`);
}

// ── Report ─────────────────────────────────────────────────────────────────────────────────
/** One summary judged: which must-keep items it says (their indexes), and how it sounds. */
export type Verdict = {
  covered: number[];
  /** 1 a report or a list read out, 5 a colleague saying it in passing. */
  tone: number;
  /** Says something the reply doesn't. */
  invented: boolean;
  /** Longer than the reply needs (or, with `tooShort`, leaves out what it shouldn't: covered says which). */
  tooLong: boolean;
  note?: string;
};
if (flags.report) {
  // Judged in rounds (each round's variants side by side, by the same judges): --round, else the last.
  type MoreVerdict = { ok: boolean; invented: boolean; tone: number; tooLong: boolean; note?: string; kind: string; text: string };
  const all = readJson<{
    rounds: Record<string, { judged: string; summaries: Record<string, Record<string, Verdict & { text?: string }>> }>;
    moreRounds?: Record<string, Record<string, MoreVerdict>>;
  }>(VERDICTS_FILE, { rounds: {} });
  const round = flags.round ?? Object.keys(all.rounds).at(-1) ?? "";
  const verdicts = all.rounds[round] ?? { judged: "", summaries: {} };
  console.log(`Judged round ${round || "none"}${verdicts.judged ? ` (${verdicts.judged})` : ""}`);
  const jev = readJson<Record<string, JevRead>>(join(RESULTS, "summary-jev.json"), {});
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter((s) => /\w/.test(s)).length;
  const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
  const p90 = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)] : NaN);
  console.log(`${CASES.length} cases, ${CASES.filter((c) => c.mustKeep?.length).length} with must-keep items (${CASES.reduce((n, c) => n + (c.mustKeep?.length ?? 0), 0)} in all)\n`);
  console.log("variant    coverage   all-kept  tone  invented  too-long  words(med/p90)  ttft ms(med/p90)");
  for (const v of VARIANTS) {
    const out = readJson<Record<string, Output>>(resultsFile(v), {});
    // Another length's verdicts are under its results' name: final-brief.
    const judged = verdicts.summaries[flags.length === "normal" ? v : `${v}-${flags.length}`] ?? {};
    const ids = CASES.map((c) => c.id).filter((id) => out[id]);
    if (!ids.length) continue;
    let items = 0;
    let kept = 0;
    let allKept = 0;
    let withItems = 0;
    const tones: number[] = [];
    let invented = 0;
    let tooLong = 0;
    let n = 0;
    for (const c of CASES) {
      const j = judged[c.id];
      if (!j || !out[c.id]) continue;
      n++;
      const need = c.mustKeep?.length ?? 0;
      items += need;
      kept += j.covered.filter((i) => i < need).length;
      if (need) {
        withItems++;
        if (j.covered.length >= need) allKept++;
      }
      tones.push(j.tone);
      if (j.invented) invented++;
      if (j.tooLong) tooLong++;
    }
    const w = ids.map((id) => words(out[id].text));
    const t = ids.map((id) => out[id].ttftMs);
    const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");
    console.log(
      `${v.padEnd(10)} ${pct(kept, items).padStart(8)} ${pct(allKept, withItems).padStart(10)} ${(tones.length ? (tones.reduce((a, b) => a + b, 0) / tones.length).toFixed(1) : "—").padStart(5)} ${String(invented).padStart(9)} ${String(tooLong).padStart(9)} ${`${median(w)}/${p90(w)}`.padStart(15)} ${`${median(t)}/${p90(t)}`.padStart(17)}   (${n} judged; sentences med ${median(ids.map((id) => sentences(out[id].text)))})`,
    );
  }
  // Jev's read and the code's, against the judge's kinds and must-keep items.
  const judgedKinds = CASES.filter((c) => c.kinds?.length);
  if (judgedKinds.length) {
    let jevKind = 0;
    let codeKind = 0;
    let jevN = 0;
    const flag: Record<string, { tp: number; fp: number; fn: number; ctp: number; cfp: number; cfn: number }> = {};
    for (const c of judgedKinds) {
      const s = shapeOf(c.reply, c.asked, summarizer.claudeAsked(c.reply, c.needsUser));
      if (s.kinds.some((k) => c.kinds!.includes(k))) codeKind++;
      const r = jev[c.id];
      if (r) {
        jevN++;
        if (c.kinds!.includes(r.kind)) jevKind++;
        for (const k of ["failure", "skipped", "caveat", "risk"] as const) {
          const f = (flag[k] ??= { tp: 0, fp: 0, fn: 0, ctp: 0, cfp: 0, cfn: 0 });
          const truth = (c.mustKeep ?? []).some((m) => m.startsWith(`${k}:`));
          const said = r[k] >= 0.6;
          const code = s.mustKeep.some((m) => m.kind === k);
          if (said && truth) f.tp++;
          else if (said) f.fp++;
          else if (truth) f.fn++;
          if (code && truth) f.ctp++;
          else if (code) f.cfp++;
          else if (truth) f.cfn++;
        }
      }
    }
    console.log(`\nKind (one of the judge's): code ${codeKind}/${judgedKinds.length}, Jev ${jevKind}/${jevN}`);
    for (const [k, f] of Object.entries(flag)) console.log(`  ${k.padEnd(8)} Jev tp ${f.tp} fp ${f.fp} fn ${f.fn}   code tp ${f.ctp} fp ${f.cfp} fn ${f.cfn}`);
    const ms = Object.values(jev).map((r) => r.ms);
    if (ms.length) console.log(`  Jev's read: ${median(ms)} ms median, ${p90(ms)} p90`);
  }
  // "More", each judged round (the texts judged are kept with their verdicts), and this run's timings.
  const more = readJson<Record<string, Output & { kind: string }>>(resultsFile("more"), {});
  for (const [name, judged] of Object.entries(all.moreRounds ?? {})) {
    for (const kind of ["more", "about", "off"]) {
      const of = Object.values(judged).filter((j) => j.kind === kind);
      if (!of.length) continue;
      const tone = of.reduce((a, j) => a + j.tone, 0) / of.length;
      console.log(
        `more ${name} ${kind.padEnd(6)} ok ${of.filter((j) => j.ok).length}/${of.length} · invented ${of.filter((j) => j.invented).length} · too long ${of.filter((j) => j.tooLong).length} · tone ${tone.toFixed(1)} · words med ${median(of.map((j) => words(j.text)))}`,
      );
    }
  }
  if (Object.keys(more).length) {
    const ttft = Object.values(more).map((o) => o.ttftMs);
    console.log(`more (this run): ${Object.keys(more).length} · first token ${median(ttft)} ms median, ${p90(ttft)} p90`);
  }
}
