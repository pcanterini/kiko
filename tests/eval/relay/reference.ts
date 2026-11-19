// The relay eval's ground truth: for each case, Opus 5.5's reading of what the user said (the
// intent, the actions, the direction to drop, the details to keep, the negations and conditions)
// and the ideal message for each session it goes to. Built once (pnpm eval:relay --build-reference),
// stored in reference.json, committed and reviewed by hand: the hard checks read it, so it stays the
// same from run to run. A case whose words, sessions or target changed is stale and built again.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasVerbatim, type Reference } from "./checks.ts";
import { PRIVATE_RELAY_IDS, type RelayCase } from "./cases.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const REFERENCE_FILE = join(here, "reference.json");
/** The private cases' references (tests/eval/private/, not in the public repo): see cases.ts. */
export const PRIVATE_REFERENCE_FILE = join(here, "..", "private", "relay-reference.json");

export type ReferenceEntry = {
  /** What the case looked like when this was built: a different one is stale. */
  inputHash: string;
  model: string;
  effort: string;
  /** Where Opus ran (--judge): the plan (costUsd 0) or the API. Missing on ones built before 2026-11-16 (the API). */
  backend?: "plan" | "api";
  builtAt: string;
  costUsd: number;
  ms: number;
  reference: Reference;
  /**
   * "auto": as Opus wrote it, code-checked; "checked": read by hand and right; "corrected": changed
   * by hand (say how in reference.notes). A rebuild never replaces a checked or corrected one.
   */
  review: "auto" | "checked" | "corrected";
  /** What code found to look at: spans not in the words, a target the case disagrees with… */
  flags: string[];
};
export type ReferenceFile = { about: string; cases: Record<string, ReferenceEntry> };

/** What the reference reads of a case: when any of it changes, the reference is stale. */
export function inputHash(c: RelayCase): string {
  const input = { say: c.say, sessions: c.sessions, recent: c.recent ?? [], waiting: c.waiting ?? null, last: c.last ?? null, to: c.to };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

/** The public and the private references, as one. */
export function readReferences(): ReferenceFile {
  const read = (path: string): ReferenceFile["cases"] => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ReferenceFile).cases : {});
  return { about: ABOUT, cases: { ...read(REFERENCE_FILE), ...read(PRIVATE_REFERENCE_FILE) } };
}

/** Written in the cases' order, so a diff shows only what changed; the private cases' to their own file. */
export function writeReferences(file: ReferenceFile, order: string[]) {
  const ids = [...order, ...Object.keys(file.cases).filter((id) => !order.includes(id))].filter((id) => file.cases[id]);
  const write = (path: string, mine: string[]) => {
    const cases: Record<string, ReferenceEntry> = {};
    for (const id of mine) cases[id] = file.cases[id];
    writeFileSync(path, `${JSON.stringify({ about: ABOUT, cases }, null, 2)}\n`);
  };
  write(
    REFERENCE_FILE,
    ids.filter((id) => !PRIVATE_RELAY_IDS.has(id)),
  );
  if (PRIVATE_RELAY_IDS.size)
    write(
      PRIVATE_REFERENCE_FILE,
      ids.filter((id) => PRIVATE_RELAY_IDS.has(id)),
    );
}

const ABOUT =
  "The relay eval's ground truth (tests/eval/relay/reference.ts): Claude Opus 5.5's reading of each case, code-checked, then reviewed by hand. review: auto (as built), checked (read and right) or corrected (changed by hand; see notes). Rebuild with pnpm eval:relay --build-reference [--force].";

/** The current reference for a case, or null when there's none or it's stale. */
export function referenceFor(file: ReferenceFile, c: RelayCase): ReferenceEntry | null {
  const e = file.cases[c.id];
  return e && e.inputHash === inputHash(c) ? e : null;
}

// ── Building one ─────────────────────────────────────────────────────────────────────────────
export const REFERENCE_SYSTEM = `You write the ground truth for an evaluation of Kiko, a voice app for coding agents. The user talks to Kiko with push-to-talk; speech-to-text writes their words (with its slips: misheard names, missing punctuation, "uh"s). Several coding-agent sessions are open (Claude Code, Codex…), each with a name. Kiko decides which session the words are for and types a message into it.

Kiko should relay the way a good human assistant would:
- Drop the direction: the parts that only say where the words go ("Ask MintBox,", "tell Bobby to", "to Kikodev", "this is for Atlas", "send that to Harbor", "Hey Juniper,", "for the Atlas session").
- Turn reported speech into direct speech for that session: "Tell Bobby to restart the server" becomes "Restart the server."; "Ask MintBox whether the build passed" becomes "Did the build pass?"; "Ask Orbit how it plans to handle refunds" becomes "How do you plan to handle refunds?". "Me", "I" and "my" stay the user ("tell it to give me the path" → "Give me the path.").
- Leave out words meant for Kiko itself ("and Kiko, slow down", "Kiko, read me the summary", "thanks Kiko").
- Keep the meaning and every action 100% intact: every question, instruction, detail, negation, limit, condition and order. Never add a request, a detail or a hedge that wasn't said. Keep the user's own wording otherwise, fillers and stutters may go.
- Another session named as content is content, not direction: in "Tell Bobby that MintBox already fixed the cert", only "Tell Bobby that" is direction. Words like "ask me", "tell me", "check with the docs", "send it to staging" are content when they don't name where Kiko should send the words.
- A reply to the session waiting for a reply (it just spoke and Kiko read it out) goes exactly as said, with no rewrite, even when it starts with that session's name ("Bobby, yes do it") or names another session as content. If the words clearly address a different session, or are clearly for Kiko, they aren't a reply.
- Questions about the sessions themselves ("What is Atlas working on?", "Which sessions are busy?", "Repeat what Orbit said") are for Kiko to answer, not sent. Words for Kiko alone (the time, the weather) aren't sent either.
- When it's unclear which session is meant ("ask it" with no session dealt with yet), it shouldn't be sent: Kiko should ask.
- "Both", "everyone" and two named sessions mean several sessions; each gets its own message (the same one, or each its part).

Answer with JSON:
- intent: what the user wants, in one sentence.
- actions: every question or action the target sessions must receive, one per item, in order.
- direction: each part of the words that only says where they go, copied exactly from user_said (same spelling, including any slip). Empty if none.
- kikoParts: each part of the words meant for Kiko itself, copied exactly. Empty if none.
- mustKeep: the exact details that must arrive verbatim, copied exactly: paths, file names, identifiers, numbers, versions, branches, commands, flags, quoted text, times, misspellings the user pointed out. Short spans (the detail itself, not the sentence). Empty if none.
- negations: each span holding a negation or limit (not, don't, never, no, only, unless, except, without, until, nothing, neither…) that belongs in the relayed message, copied exactly. Not ones that belong to Kiko's words or the direction.
- conditions: each span holding a condition or order (if, when, once, before, after, then, first…) that belongs in the relayed message, copied exactly.
- messages: for each session the words should go to (by its name as listed), the ideal message to type. Empty when it shouldn't be sent.
- isReply: whether the words reply to the session waiting for a reply.
- notes: anything ambiguous or debatable about this case, briefly; empty if nothing.`;

export const REFERENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "actions", "direction", "kikoParts", "mustKeep", "negations", "conditions", "messages", "isReply", "notes"],
  properties: {
    intent: { type: "string" },
    actions: { type: "array", items: { type: "string" } },
    direction: { type: "array", items: { type: "string" } },
    kikoParts: { type: "array", items: { type: "string" } },
    mustKeep: { type: "array", items: { type: "string" } },
    negations: { type: "array", items: { type: "string" } },
    conditions: { type: "array", items: { type: "string" } },
    messages: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["to", "text"], properties: { to: { type: "string" }, text: { type: "string" } } },
    },
    isReply: { type: "boolean" },
    notes: { type: "string" },
  },
} as const;

/**
 * Code's look at a fresh reference: spans not copied from the words, details missing from its own
 * ideal message, a target the case disagrees with. Reply cases get the words as said, whatever Opus
 * wrote (the reply rule), with a note when it wrote something else.
 */
export function settle(c: RelayCase, ref: Reference): { reference: Reference; flags: string[] } {
  const flags: string[] = [];
  const out: Reference = { ...ref, messages: ref.messages.map((m) => ({ ...m })) };
  for (const key of ["direction", "kikoParts", "mustKeep", "negations", "conditions"] as const) {
    const missing = out[key].filter((span) => !hasVerbatim(c.say, span));
    if (missing.length) flags.push(`${key} not in the words: ${missing.map((s) => JSON.stringify(s)).join(", ")}`);
  }
  // Message targets by the case's own session names.
  const byName = new Map(c.sessions.map((s) => [s.name.toLowerCase(), s.name]));
  for (const m of out.messages) m.to = byName.get(m.to.toLowerCase()) ?? m.to;
  const want = c.to === null ? [] : Array.isArray(c.to) ? c.to : [c.to];
  const got = out.messages.map((m) => m.to);
  const same = want.length === got.length && want.every((w) => got.some((g) => g.toLowerCase() === w.toLowerCase()));
  if (!same) flags.push(`target: the case says ${want.join(" + ") || "not sent"}, the reference ${got.join(" + ") || "not sent"}`);
  for (const m of out.messages) {
    const lost = out.mustKeep.filter((d) => !hasVerbatim(m.text, d));
    if (lost.length && out.messages.length === 1) flags.push(`its own message lacks: ${lost.map((s) => JSON.stringify(s)).join(", ")}`);
  }
  if (c.tags[0] === "reply-exact") {
    if (!out.isReply) flags.push("not read as a reply; set to one (the case is a reply)");
    const asSaid = out.messages.length === 1 && out.messages[0].text === c.say;
    if (!asSaid) {
      flags.push(`reply rule: ideal set to the words as said (Opus wrote ${JSON.stringify(out.messages.map((m) => m.text).join(" | "))})`);
    }
    out.isReply = true;
    out.messages = [{ to: c.to as string, text: c.say }];
    out.direction = [];
  }
  return { reference: out, flags };
}
