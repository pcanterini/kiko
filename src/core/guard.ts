// Kiko's safety gate, the app's side: turned on in Settings (it's off by
// default since 2026-11-02), Kiko asks before anything that sends, deletes, pays or posts, whatever
// the agent's own permission mode or allow rules. Off, the hooks pass before the rules even run
// (hooks/lib.mjs guardSaved reads the setting from the settings file).
//
// The hooks run the rules (hooks/guard.mjs) before every shell command and MCP call, in code, and
// send the app only the calls they flag (a few in a hundred): `GuardCheck`, with what matched for
// sure (`hits`) and what only looks risky (`unclear`). Here: the verdict (`decideGuard`): off in
// Settings, or every kind it found turned off, it passes; a hit asks; an unclear one goes to the
// classifier within a budget, and when that can't say, one whose words look risky (`hint`) asks.
// The agent then asks you as it would any prompt (Claude Code: the hook's "ask" makes it show its
// own; Codex: its hook holds the call as a card itself), and that prompt is marked as the gate's
// (`noteGuard`, then `guardOf` when it comes): said plainly ("Kiko project wants to push to GitHub:
// allow it?"), needing "allow it", allowed only once.
//
// Imports nothing that loads .env or writes logs: the app's part (src/app/guard.ts) logs.
import { KIND_INFO, KINDS, type GuardFound, type GuardHit, type GuardKind, type GuardUnclear } from "../../hooks/guard.mjs";
import { guardOn } from "../../hooks/lib.mjs";
import type { Held, ToolUse } from "../agents/types.ts";
import { NAME } from "./name.ts";

export { guardOn, KIND_INFO, KINDS, type GuardHit, type GuardKind, type GuardUnclear };

/** One tool call the rules flagged, as an agent's hook sends it. */
export type GuardCheck = GuardFound & {
  agent: string;
  sessionId: string;
  cwd: string;
  tool: ToolUse;
  /** The session's permission mode, where the agent says it ("bypassPermissions"). */
  mode?: string;
};

/** What a hook sends for the gate (hooks/claude-code-hook.mjs, hooks/codex-hook.mjs), as far as the check needs. */
type GuardEventFields = {
  session_id?: unknown;
  cwd?: unknown;
  permission_mode?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  guard?: { hits?: unknown; unclear?: unknown };
};

/** A gate event's check as core takes it; null when it isn't one. */
export function guardCheckOf(e: GuardEventFields, agent: string): GuardCheck | null {
  if (typeof e.session_id !== "string" || typeof e.cwd !== "string" || typeof e.tool_name !== "string" || !e.guard || typeof e.guard !== "object") return null;
  const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
  const list = (v: unknown) => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object" && typeof x.rule === "string" && typeof x.what === "string") as Record<string, unknown>[]) : []);
  const kind = (v: unknown) => ((KINDS as unknown[]).includes(v) ? (v as GuardKind) : undefined);
  const hits: GuardHit[] = [];
  for (const h of list(e.guard.hits)) {
    const k = kind(h.kind);
    if (k) hits.push({ kind: k, rule: str(h.rule), what: str(h.what) });
  }
  const unclear: GuardUnclear[] = list(e.guard.unclear).map((u) => {
    const hint = kind(u.hint);
    return { rule: str(u.rule), what: str(u.what), ...(hint ? { hint } : {}), ...(typeof u.args === "string" ? { args: str(u.args, 600) } : {}) };
  });
  return {
    agent,
    sessionId: e.session_id,
    cwd: e.cwd,
    tool: { name: e.tool_name, input: e.tool_input && typeof e.tool_input === "object" ? (e.tool_input as Record<string, unknown>) : undefined },
    hits,
    unclear,
    ...(typeof e.permission_mode === "string" ? { mode: e.permission_mode } : {}),
  };
}

/** What the gate makes of it: ask (which kind, which rule, and what decided: a rule, the classifier, or unsure), or pass (why). */
export type GuardVerdict = { ask: true; kind: GuardKind; rule: string; what: string; by: "rule" | "classifier" | "unsure"; reason: string } | { ask: false; why: string; rule?: string };

/** The classifier's read of an unclear call: the kind it does, or null for none of them. */
type GuardClass = { kind: GuardKind | null; costUsd?: number; ms?: number };

type GuardOptions = {
  /** The setting: on unless turned off. */
  on: boolean;
  /** Kinds turned off in Settings. */
  off: readonly string[];
  /** The classifier, when it's on; none: an unclear call asks when its words look risky. */
  classify?: (unclear: GuardUnclear, tool: ToolUse) => Promise<GuardClass>;
  /** How long the classifier may take (the hook waits 6 s for the whole verdict). */
  budgetMs?: number;
};

/** The classifier's longest: well inside the hook's wait (hooks/claude-code-hook.mjs GUARD_WAIT_MS). */
export const CLASSIFY_BUDGET_MS = 2500;

/** The reason Claude Code shows in its own prompt: "Kiko asks first: this posts (push to GitHub)." */
export const guardReason = (kind: GuardKind, what: string) => `${NAME} asks first: this ${kind} (${what}).`;

/** The card's "wants to …": "run: git push (Kiko asks first: posts)". */
export const guardWhat = (what: string, kind: GuardKind) => `${what} (${NAME} asks first: ${kind})`;

/** Said: "Kiko project wants to push to GitHub: allow it?" */
export const guardLine = (who: string, what: string) => `${who} wants to ${what}: allow it?`;

/** A verdict that asks, from what matched. */
function asking(found: GuardHit, by: "rule" | "classifier" | "unsure"): GuardVerdict {
  return { ask: true, kind: found.kind, rule: found.rule, what: found.what, by, reason: guardReason(found.kind, found.what) };
}

// The classifier's verdicts on unclear calls, by rule and what (a script's or an MCP tool's), for a while: the same
// call again (a deploy script run twice) isn't asked of it twice.
const classified = new Map<string, { kind: GuardKind | null; at: number }>();
const CLASSIFIED_MS = 10 * 60_000;

/** Forgets the classifier's verdicts (tests). */
export function forgetClassified() {
  classified.clear();
}

/**
 * The gate's verdict on a call the rules flagged. A sure hit of a kind that's on asks at once (no
 * model). Unclear ones go to the classifier, one at a time within `budgetMs`; a kind it names asks,
 * none passes; with no answer (off, failed, too slow), one whose words look risky asks.
 */
export async function decideGuard(check: GuardCheck, opts: GuardOptions): Promise<GuardVerdict> {
  if (!opts.on) return { ask: false, why: "off" };
  const on = (kind: string) => (KINDS as string[]).includes(kind) && !opts.off.includes(kind);
  const hit = check.hits.find((h) => on(h.kind));
  if (hit) return asking(hit, "rule");
  if (check.hits.length && !check.unclear.length) return { ask: false, why: `${check.hits[0].kind} is off`, rule: check.hits[0].rule };
  let why = "nothing risky";
  for (const u of check.unclear) {
    const key = `${u.rule}\u0000${u.what}`;
    const kept = classified.get(key);
    let read: GuardClass | null = kept && Date.now() - kept.at < CLASSIFIED_MS ? { kind: kept.kind } : null;
    if (!read && opts.classify) {
      read = await within(opts.classify(u, check.tool), opts.budgetMs ?? CLASSIFY_BUDGET_MS);
      if (read) classified.set(key, { kind: read.kind, at: Date.now() });
    }
    if (read) {
      if (read.kind && on(read.kind)) return asking({ kind: read.kind, rule: u.rule, what: u.what }, "classifier");
      why = read.kind ? `${read.kind} is off` : "the classifier says none";
      continue;
    }
    // Nothing could say: risky-looking words ask.
    if (u.hint && on(u.hint)) return asking({ kind: u.hint, rule: u.rule, what: u.what }, "unsure");
    why = u.hint ? `${u.hint} is off` : "unclear, nothing to go on";
  }
  return { ask: false, why, rule: check.unclear[0]?.rule ?? check.hits[0]?.rule };
}

/** `p`'s value, or null when it fails or takes longer than `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p.catch(() => null), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

// ── The prompt that follows, marked as the gate's ──

/** What a gated prompt says of itself: its kind and what it does. */
export type Guarded = { kind: GuardKind; what: string; rule: string; by: "rule" | "classifier" | "unsure"; agent: string };

/** A tool call's key: its session, its tool, and its command (a shell's) or its input. */
function keyOf(sessionId: string, tool: ToolUse | null | undefined) {
  if (!tool) return "";
  const input = tool.input ?? {};
  const command = typeof input.command === "string" ? input.command : Array.isArray(input.command) ? JSON.stringify(input.command) : null;
  return `${sessionId}\u0000${tool.name}\u0000${command ?? JSON.stringify(input)}`;
}

// Asks made, waiting for their prompt (Claude Code's PermissionRequest comes a moment later; Codex's
// card is made from the same call), for a few minutes at most.
const pending = new Map<string, { guarded: Guarded; at: number }>();
const PENDING_MS = 5 * 60_000;
const marked = new WeakMap<Held, Guarded | null>();

/** An ask made: the prompt for this call that comes next is the gate's. */
export function noteGuard(check: GuardCheck, verdict: GuardVerdict, now = Date.now()) {
  if (!verdict.ask) return;
  for (const [key, p] of pending) if (now - p.at > PENDING_MS) pending.delete(key);
  pending.set(keyOf(check.sessionId, check.tool), { guarded: { kind: verdict.kind, what: verdict.what, rule: verdict.rule, by: verdict.by, agent: check.agent }, at: now });
}

/** The gate's mark on a held prompt, when it's the one an ask was made for; null for any other. */
export function guardOf(held: Held): Guarded | null {
  if (marked.has(held)) return marked.get(held) ?? null;
  if (!held.isPermission || held.questions) return null;
  const key = keyOf(held.sessionId, held.tool);
  const p = pending.get(key);
  const guarded = p && Date.now() - p.at <= PENDING_MS ? p.guarded : null;
  if (p) pending.delete(key);
  marked.set(held, guarded);
  return guarded;
}

/** Forgets every ask waiting for its prompt (tests). */
export function forgetPending() {
  pending.clear();
}

// ── Settings ──

/** The row's value: "On", "On, except deletes", "Off". */
export function guardValue(on: boolean, off: readonly string[]): string {
  if (!on) return "Off";
  const offKinds = KINDS.filter((k) => off.includes(k));
  if (!offKinds.length) return "On";
  if (offKinds.length === KINDS.length) return "On, every kind off";
  return `On, except ${offKinds.join(" and ")}`;
}

/** The kinds turned off, as saved: only real ones, each once. */
export const guardOffOf = (value: unknown): GuardKind[] => (Array.isArray(value) ? KINDS.filter((k) => value.includes(k)) : []);
