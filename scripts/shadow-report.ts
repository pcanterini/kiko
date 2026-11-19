// `pnpm shadow:report [logs folder or .jsonl files…]`: how the shadow classifier model (shadow.ts)
// compares with the one deciding on real use. Pairs each "shadow" log line with the "classify" line
// ("jev" in logs before 2026-11-01) of the same id (the deciding model's, whichever it was: Jev, or d1-ultra on your words since it took
// those over), then prints how often they'd decide the same, the decisions where they don't (with
// what the app did next), and each model's latency and cost, by model name. Reads the app's logs/ (or KIKO_LOG_DIR) by default.
// No network, no .env: it only reads logs.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { LOG_DIR } from "../src/core/app-root.ts";
import { APP_PARTS } from "../src/core/routing-rules.ts";
import { flat } from "../src/core/text.ts";

// What the app acts on (src/app/state.ts QUIET_WORTH and QUIET_NEEDS_USER): below both, a finished turn isn't read
// out (announce: results); below the second, it gets the short reply window.
export const QUIET_WORTH = 0.3;
export const QUIET_NEEDS_USER = 0.5;

export type LogEvent = { event: string; t: string; [key: string]: any };
export type LogFile = { name: string; events: LogEvent[] };
type Kind = "utterance" | "stop";

export type Pair = {
  file: string;
  id: string;
  what: Kind;
  t: string;
  /** The deciding model's "classify" line. */
  primary: LogEvent;
  shadow: LogEvent;
  /** The user's words, or Claude's reply. */
  text: string;
  /** What the app did next, as far as the log shows. */
  did: string;
};

/** The classifier's line for a decision (src/core/classifier.ts): "classify", or "jev" in logs before 2026-11-01. */
export const isClassify = (e: LogEvent) => e.event === "classify" || e.event === "jev";

/** A log file's events; lines that aren't JSON are skipped. */
export function parseLog(name: string, text: string): LogFile {
  const events: LogEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return { name, events };
}

/** A log line's model without the date the endpoint adds: "typesafe/jev-1.14-20261014" → "typesafe/jev-1.14". */
export const modelOf = (e: LogEvent | undefined) => String(e?.model ?? "?").replace(/-\d{8}$/, "");
/** "liquid/d1-ultra" → "d1-ultra", for the report's lines. */
const short = (model: string) => model.split("/").pop()!;

/**
 * Pairs the deciding model's utterance and stop decisions with the shadow model's, by id within
 * each file. Shadow lines that failed, and either side without the other, are counted apart.
 */
export function pairUp(files: LogFile[]) {
  const pairs: Pair[] = [];
  const failed: LogEvent[] = [];
  let primaryOnly = 0;
  let shadowOnly = 0;
  for (const { name, events } of files) {
    const shadows = new Map<string, LogEvent>();
    for (const e of events) if (e.event === "shadow" && e.id) shadows.set(e.id, e);
    const names = sessionNames(events);
    const seen = new Set<string>();
    events.forEach((e, i) => {
      if (!isClassify(e) || !e.id || (e.what !== "utterance" && e.what !== "stop")) return;
      const s = shadows.get(e.id);
      if (!s) return void primaryOnly++;
      seen.add(e.id);
      if (s.error || !s.answers) return void failed.push(s);
      const what: Kind = e.what;
      const text = what === "utterance" ? String(e.state?.user_said ?? "") : String(e.state?.claude_reply ?? "");
      const did = what === "utterance" ? didAfterWords(events, i, names) : didAfterReply(events, i, text);
      pairs.push({ file: name, id: e.id, what, t: e.t, primary: e, shadow: s, text, did });
    });
    // A shadow line whose deciding call failed: nothing to compare it with.
    for (const [id, s] of shadows) if (!seen.has(id)) s.error ? failed.push(s) : shadowOnly++;
  }
  return { pairs, failed, primaryOnly, shadowOnly };
}

// ── What each side decided ──────────────────────────────────────────────────

type Read = { key: string; show: string };
type Check = { what: Kind; label: string; read: (answers: any, handles?: Record<string, { name: string }>) => Read | null };

const choice = (a: any, handles?: Record<string, { name: string }>): Read | null => {
  if (a?.type !== "choice") return null;
  const name = handles?.[a.choice]?.name;
  return { key: a.choice, show: `${a.choice}${name ? ` ${name}` : ""} (${Number(a.confidence ?? 0).toFixed(2)})` };
};
const atLeast = (a: any, threshold: number): Read | null =>
  a?.type === "noul" ? { key: a.noul >= threshold ? "yes" : "no", show: `${a.noul >= threshold ? "yes" : "no"} (${a.noul.toFixed(2)})` } : null;

export const CHECKS: Check[] = [
  { what: "utterance", label: "audience", read: (a, h) => choice(a.audience, h) },
  { what: "utterance", label: "intent", read: (a) => choice(a.intent) },
  { what: "utterance", label: `app parts ≥ ${APP_PARTS}`, read: (a) => atLeast(a.app_parts, APP_PARTS) },
  { what: "stop", label: `worth saying ≥ ${QUIET_WORTH}`, read: (a) => atLeast(a.worth_saying, QUIET_WORTH) },
  { what: "stop", label: `needs user ≥ ${QUIET_NEEDS_USER}`, read: (a) => atLeast(a.needs_user, QUIET_NEEDS_USER) },
  {
    what: "stop",
    label: "read out (announce: results)",
    read: (a) => {
      if (a.worth_saying?.type !== "noul" || a.needs_user?.type !== "noul") return null;
      const out = a.needs_user.noul >= QUIET_NEEDS_USER || a.worth_saying.noul >= QUIET_WORTH;
      return { key: out ? "yes" : "no", show: out ? "read out" : "quiet" };
    },
  },
];

export type Disagreement = { pair: Pair; diffs: Array<{ label: string; primary: string; shadow: string }> };

/** Per check: how many pairs both sides answered, and how many of those agree. */
export function compare(pairs: Pair[]) {
  const rates = CHECKS.map((check) => ({ what: check.what, label: check.label, n: 0, agree: 0 }));
  const disagreements: Disagreement[] = [];
  for (const pair of pairs) {
    const diffs: Disagreement["diffs"] = [];
    CHECKS.forEach((check, i) => {
      if (check.what !== pair.what) return;
      const p = check.read(pair.primary.answers ?? {}, pair.shadow.handles);
      const s = check.read(pair.shadow.answers ?? {}, pair.shadow.handles);
      if (!p || !s) return;
      rates[i].n++;
      if (p.key === s.key) rates[i].agree++;
      else diffs.push({ label: check.label, primary: p.show, shadow: s.show });
    });
    if (diffs.length) disagreements.push({ pair, diffs });
  }
  return { rates, disagreements };
}

// ── What the app did next ───────────────────────────────────────────────────

/** Session id → name, from what the log says about each session. */
function sessionNames(events: LogEvent[]) {
  const names = new Map<string, string>();
  for (const e of events) {
    if (e.event === "hook_stop" && e.session_id && e.cwd && !names.has(e.session_id)) names.set(e.session_id, basename(e.cwd));
    if (e.event === "announce" && e.sessionId && e.folder) names.set(e.sessionId, e.folder);
    if (e.event === "shadow" && e.handles) for (const h of Object.values<any>(e.handles)) if (h?.id && h.name) names.set(h.id, h.name);
  }
  return names;
}

const quote = (text: unknown, max = 40) => `"${flat(String(text ?? ""), max)}"`;

/** After your words: the app's steps up to your next words. */
export function didAfterWords(events: LogEvent[], i: number, names: Map<string, string>) {
  const name = (id: unknown) => names.get(String(id)) ?? String(id ?? "?").slice(0, 8);
  const steps: string[] = [];
  for (let j = i + 1; j < events.length && steps.length < 4; j++) {
    const e = events[j];
    if (e.event === "transcript" || (isClassify(e) && e.what === "utterance")) break;
    const step =
      e.event === "route_turn"
        ? e.said
          ? `router said ${quote(e.said)}`
          : `router (${e.actions ?? 0} action${e.actions === 1 ? "" : "s"})`
        : e.event === "hook_answer" && e.kind !== "PermissionRequest"
          ? `replied to ${name(e.sessionId)}`
          : e.event === "terminal_type" || e.event === "ghostty_type"
            ? `typed ${quote(e.text, 30)} into a terminal`
            : e.event === "desktop_send"
              ? `sent to ${name(e.sessionId)} in the desktop app`
              : e.event === "claude_code_send"
                ? "sent to Claude Code"
                : e.event === "trimmed"
                  ? `trimmed to ${quote(e.kept, 30)}`
                  : e.event === "redirect"
                    ? `redirected to ${name(e.to)}`
                    : e.event === "wrap_up"
                      ? "wrap-up"
                      : e.event === "undo"
                        ? "undo"
                        : e.event === "repeat"
                          ? "repeated"
                          : e.event === "quick_task_start"
                            ? "quick task"
                            : e.event === "not_allowed"
                              ? "not allowed"
                              : e.event === "rename_pending"
                                ? "rename"
                                : e.event === "start_session_redirected"
                                  ? "started a session"
                                  : e.event === "error" && /^(classify|jev)/.test(String(e.where))
                                    ? "classifier error"
                                    : "";
    if (step) steps.push(step);
  }
  return steps.join(" → ") || "nothing logged";
}

const gist = (text: unknown) =>
  String(text ?? "")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 40)
    .toLowerCase();

/** After a finished turn: whether that session's reply was read out before it finished again. */
export function didAfterReply(events: LogEvent[], i: number, reply: string) {
  // The Stop hook this decision was for: the latest one before it with the same reply.
  let stop: LogEvent | undefined;
  for (let j = i - 1; j >= Math.max(0, i - 200) && !stop; j--) {
    const e = events[j];
    if (e.event === "hook_stop" && gist(e.last_assistant_message) === gist(reply)) stop = e;
  }
  if (!stop) return "unknown";
  for (let j = i + 1; j < events.length; j++) {
    const e = events[j];
    if (e.event === "hook_stop" && e.session_id === stop.session_id) break;
    if (e.event === "announce" && e.sessionId === stop.session_id) {
      return `read out${e.windowMs ? `, ${Math.round(e.windowMs / 1000)}s reply window` : ""}`;
    }
  }
  return "not read out";
}

// ── Latency and cost ────────────────────────────────────────────────────────

/** Nearest-rank percentile of numbers (p from 0 to 100). */
export function percentile(values: number[], p: number) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Per kind of decision, per model and whether it decided or shadowed: latency and cost. */
export function costs(pairs: Pair[]) {
  const rows: Array<{ side: "primary" | "shadow"; what: Kind; model: string; served: string; n: number; median: number; p90: number; totalUsd: number }> = [];
  for (const what of ["utterance", "stop"] as const) {
    for (const side of ["primary", "shadow"] as const) {
      const byModel = new Map<string, LogEvent[]>();
      for (const p of pairs.filter((x) => x.what === what)) {
        const model = modelOf(p[side]);
        byModel.set(model, [...(byModel.get(model) ?? []), p[side]]);
      }
      for (const [model, lines] of [...byModel].sort((a, b) => b[1].length - a[1].length)) {
        const ms = lines.map((e) => Number(e.ms)).filter(Number.isFinite);
        rows.push({
          side,
          what,
          model,
          served: [...new Set(lines.map((e) => String(e.served ?? e.model ?? "?")))].join(", "),
          n: lines.length,
          median: percentile(ms, 50),
          p90: percentile(ms, 90),
          totalUsd: lines.reduce((sum, e) => sum + Number(e.costUsd ?? 0), 0),
        });
      }
    }
  }
  return rows;
}

/** Which model decided and which shadowed, per kind: "typesafe/jev-1.14 deciding, liquid/d1-ultra shadowing (78)". */
export function lineups(pairs: Pair[]) {
  const counts = new Map<string, { what: Kind; primary: string; shadow: string; n: number }>();
  for (const p of pairs) {
    const key = `${p.what} ${modelOf(p.primary)} ${modelOf(p.shadow)}`;
    const row = counts.get(key) ?? { what: p.what, primary: modelOf(p.primary), shadow: modelOf(p.shadow), n: 0 };
    row.n++;
    counts.set(key, row);
  }
  return [...counts.values()].sort((a, b) => (a.what === b.what ? b.n - a.n : a.what === "utterance" ? -1 : 1));
}

// ── The report ──────────────────────────────────────────────────────────────

const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%` : "—");
const when = (t: string) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function report(files: LogFile[]) {
  const { pairs, failed, primaryOnly, shadowOnly } = pairUp(files);
  const { rates, disagreements } = compare(pairs);
  const out: string[] = [];
  const n = (what: Kind) => pairs.filter((p) => p.what === what).length;
  const kind = (what: Kind) => (what === "utterance" ? "your words" : "finished turns");
  out.push(`Deciding model vs shadow: ${pairs.length} paired decisions (${n("utterance")} utterances, ${n("stop")} finished turns) in ${files.length} log file${files.length === 1 ? "" : "s"}`);
  for (const l of lineups(pairs)) out.push(`  ${kind(l.what)}: ${l.primary} deciding, ${l.shadow} shadowing (${l.n})`);
  const extras = [
    failed.length && `${failed.length} shadow call${failed.length === 1 ? "" : "s"} failed`,
    primaryOnly && `${primaryOnly} decision${primaryOnly === 1 ? "" : "s"} with no shadow line`,
    shadowOnly && `${shadowOnly} shadow line${shadowOnly === 1 ? "" : "s"} whose deciding call failed`,
  ].filter(Boolean);
  if (extras.length) out.push(extras.join(" · "));
  if (failed.length) {
    const reasons = new Map<string, number>();
    for (const f of failed) {
      const reason = flat(String(f.error ?? "no answers"), 80);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5)) out.push(`  ${count}× ${reason}`);
  }
  if (!pairs.length) {
    out.push("", "Nothing to compare yet: run the app with KIKO_DEV_SHADOW=1 and talk to it.");
    return out.join("\n");
  }

  out.push("", "Agreement");
  const width = Math.max(...rates.map((r) => r.label.length)) + 2;
  for (const what of ["utterance", "stop"] as const) {
    out.push(`  ${kind(what)}`);
    for (const r of rates.filter((x) => x.what === what)) {
      out.push(`    ${r.label.padEnd(width)}${pct(r.agree, r.n).padStart(5)}  (${r.agree}/${r.n})`);
    }
  }

  out.push("", "Latency and cost");
  const rows = costs(pairs);
  const who = (r: (typeof rows)[number]) => `${short(r.model)}${r.side === "shadow" ? " (shadow)" : ""}, ${r.what}`;
  const whoWidth = Math.max(...rows.map((r) => who(r).length)) + 1;
  for (const r of rows) {
    out.push(
      `  ${who(r).padEnd(whoWidth)} n ${String(r.n).padStart(4)} · median ${String(r.median).padStart(5)}ms · p90 ${String(r.p90).padStart(5)}ms · ` +
        `$${r.totalUsd.toFixed(4)} total, $${(r.totalUsd / r.n).toFixed(6)} a call · ${r.served}`,
    );
  }

  out.push("", `Disagreements (${disagreements.length})`);
  for (const { pair, diffs } of disagreements) {
    const said = pair.what === "utterance" ? `you said ${quote(pair.text, 70)}` : `Claude said ${quote(pair.text, 70)}`;
    out.push(`  ${when(pair.t)} · ${said}`);
    const [p, s] = [short(modelOf(pair.primary)), short(modelOf(pair.shadow))];
    for (const d of diffs) out.push(`    ${d.label}: ${p} ${d.primary} · ${s} (shadow) ${d.shadow}`);
    out.push(`    app did: ${pair.did}`);
  }
  return out.join("\n");
}

/** The .jsonl files under a folder (not latest.jsonl, a link to one of them), or the files given. */
export function logFiles(paths: string[]) {
  const files: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`No such file or folder: ${path}`);
    if (statSync(path).isDirectory()) {
      for (const f of readdirSync(path).sort()) if (f.endsWith(".jsonl") && f !== "latest.jsonl") files.push(join(path, f));
    } else files.push(path);
  }
  return files;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const paths = logFiles(args.length ? args : [LOG_DIR]);
    console.log(report(paths.map((p) => parseLog(basename(p), readFileSync(p, "utf8")))));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
