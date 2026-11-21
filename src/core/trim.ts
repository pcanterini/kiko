// Leaves out the parts of what you said that were for the voice app, not for Claude ("ah, for the
// in-app settings one", "question for the claude speech agent", "and Kiko, slow down when you read the
// results", "thanks Kiko"). Only ever deletes: a quick model call names the parts to drop, copied from
// your words, and the app checks that each one names a session or starts by saying the app's name to it
// (routing-rules.ts namesSaidToApp), and that what's left is your words with those parts removed.
// Anything else, or a slow answer, sends your words as said.
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, requestInfo } from "./anthropic.ts";
import { config } from "./config.ts";
import { cost, log } from "./log.ts";
import { online } from "./online.ts";
import { llmService } from "./services.ts";
import { streamText } from "./openrouter-llm.ts";
import { NAME, spokenName } from "./name.ts";
import { aboutAppBehaviour, namesSaidToApp, startsSaidToApp } from "./routing-rules.ts";
import { namesSession, sessionLabel, type Session } from "./sessions.ts";
import { onlyDirectionTo } from "./direction.ts";
import { cutRuns, DISFLUENT, findRun, NEGATION, tokens } from "./words.ts";

const SYSTEM = `The user talks to a voice app, ${NAME}, with push-to-talk. The app types their words, as speech-to-text heard them, into a Claude Code session. Sometimes part of what they say is for the app, not for Claude: picking or naming which session the words are for, like "ah, for the in-app settings one", "question for the claude speech agent", "this is for atlas agents", "tell the other one to", "the claude code speech one, please".

Answer with only those parts, one per line, each copied exactly from the user's words, so the app can delete them before Claude reads the rest. If there are none, answer NONE.

Never pick anything Claude should read: the request, a question, an answer or decision, context, reasons, opinions, or the user thinking out loud about the work, even when it rambles or talks about the voice app or other sessions. Words about a feature, screen or setting are for Claude: in "for the settings, it's only using part of the screen", "for the settings" is about the settings screen. Leave filler words like "uh" and "um" alone unless they're inside a part you pick. When unsure, answer NONE.`;

/**
 * The instructions for words that say the app's name to it (routing-rules.ts namesSaidToApp), by
 * the name you call it (name.ts spokenName): parts said to it are for the app too. Only for those, so
 * the trim of every other aside reads the instructions it always has.
 */
const toAppSystem = (
  name = spokenName(),
) => `The user talks to a voice app, ${NAME}${name === NAME ? "" : ` (they call it ${name})`}, with push-to-talk. The app types their words, as speech-to-text heard them, into a Claude Code session. Sometimes part of what they say is for the app, not for Claude: said to the app itself by its name, ${name}, like "and ${name}, slow down when you read the results", "${name}, read me just the summary", "${name}, you don't need to read back the reply", "thanks ${name}", "hold on ${name}, let me think"; or picking or naming which session the words are for, like "ah, for the in-app settings one", "this is for atlas agents", "tell the other one to".

Answer with only those parts, one per line, each copied exactly from the user's words, so the app can delete them before Claude reads the rest. A part said to ${name} starts at its name, or at the word just before it ("and ${name}, …", "thanks ${name}"), and runs to the end of what's said to it. If there are none, answer NONE.

Never pick anything Claude should read: the request, a question, an answer or decision, context, reasons, opinions, or the user thinking out loud about the work, even when it rambles or talks about the voice app or other sessions. Words about ${name} as part of the work are for Claude: "the ${name} overlay doesn't show the latest text", "make ${name}'s bars wider", "restart ${name} and check the logs". Leave filler words like "uh" and "um" alone unless they're inside a part you pick. When unsure, answer NONE.`;

// A slow trim isn't worth the wait: past this, your words go as said.
const TIMEOUT_MS = 1500;

let client: Anthropic | null = null;

export type Trim = { text: string; dropped: string[]; costUsd: number; ms: number };

/**
 * Asks the configured model (Haiku, or the OpenRouter model picked in settings) which parts of
 * `text` were for the app, and returns `text` without them; `dropped` is empty when it's as said.
 */
export async function trimForClaude(input: { text: string; to: { sessionId: string; cwd: string; title?: string }; sessions: Session[] }): Promise<Trim> {
  const { text, to, sessions } = input;
  const prompt = [`<sessions>${sessions.map(sessionLabel).join(", ") || "(none)"}</sessions>`, `<going_to>${sessionLabel(to)}</going_to>`, `<user_said>${text}</user_said>`].join("\n");
  const system = namesSaidToApp(text).length ? toAppSystem() : SYSTEM;
  const start = performance.now();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let answer = "";
  let costUsd = 0;
  // The request id, the SDK's retries and why the model stopped, for the log line.
  let call: Record<string, unknown> = {};
  try {
    // Plain lines, not a tool call: a forced tool call took Haiku up to twice as long.
    if (config.llm !== "haiku") {
      const r = await streamText({ model: config.llm, system, prompt, maxTokens: 150, signal, onText: () => {}, call: "trim" });
      answer = r.text;
      costUsd = r.costUsd;
      call = { ...(r.id ? { requestId: r.id } : {}), ...(r.stop ? { stop: r.stop } : {}) };
    } else {
      client ??= anthropic();
      const { data: final, response } = await client.messages
        .create(
          {
            model: config.summaryModel,
            max_tokens: 150,
            // Latency over depth: no thinking, low effort.
            thinking: { type: "disabled" },
            output_config: { effort: config.summaryEffort },
            system,
            messages: [{ role: "user", content: prompt }],
          },
          { signal },
        )
        .withResponse();
      answer = final.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      costUsd = cost.haiku(final.usage);
      call = { ...requestInfo(response), stop: final.stop_reason };
    }
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    log("trim", { model: config.llm, text, error: signal.aborted ? "timeout" : String(err), ms });
    // With the relay down too, a sign the Mac is offline (core/online.ts).
    if (signal.aborted) online.callTimedOut("trim", llmService());
    return { text, dropped: [], costUsd: 0, ms };
  }
  const ms = Math.round(performance.now() - start);
  const asked = answer
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^[-*•]\s*/, "")
        .replace(/^["“]|["”]$/g, ""),
    )
    .filter((line) => line && !/^none\.?$/i.test(line));
  // Only parts that say where the words go, or are said to the app by its name: anything else the
  // model picked is likely for Claude.
  const parts = asked.map((part) => withNameSaid(text, part)).filter((part) => namesSession(sessions, part) || startsSaidToApp(part));
  const session = sessions.find((x) => x.sessionId === to.sessionId);
  const cut = parts.length ? removeParts(text, parts, session) : null;
  const why = !asked.length ? "nothing to drop" : !parts.length ? "names no session" : !cut ? "parts not found or not safe to drop" : isTrimOf(text, cut.text) ? null : "too little left";
  log("trim", { model: config.llm, text, answer, kept: why ? undefined : cut?.text, why: why ?? undefined, costUsd, ms, ...call });
  if (why || !cut) return { text, dropped: [], costUsd, ms };
  return { ...cut, costUsd, ms };
}

/**
 * A part picked right after the app's name said to it ("you don't need to read back the reply" from
 * "…, Kiko, you don't need to read back the reply"), with the name: what's said to it starts there.
 * Any other part as picked.
 */
export function withNameSaid(text: string, part: string): string {
  const at = text.toLowerCase().indexOf(part.toLowerCase());
  if (at < 0 || startsSaidToApp(part)) return part;
  const name = namesSaidToApp(text).find((r) => r.end <= at && /^[\s,:;—–-]*$/.test(text.slice(r.end, at)));
  return name ? text.slice(name.start, at) + part : part;
}

// Words that only open what's said to the app ("and Kiko, …", "oh Kiko, …"): cut with it.
const OPENS = new Set(["and", "but", "so", "oh", "also", ...DISFLUENT]);

/**
 * `text` without `parts`, each found by its words (case and punctuation aside), in order and
 * without overlapping. Null if a part isn't there or holds a negation (dropping "not" would flip
 * what was meant). A short piece that isn't just "uh"/"um" stays: too little to be a routing aside.
 * A part that starts where the words say the app's name to it (routing-rules.ts namesSaidToApp: "and
 * Kiko, …", "Thanks Kiko") may be short ("Thanks Kiko", ", Kiko."). With a negation it goes whole
 * only when it runs to the end of a sentence and is about the app's own behaviour (routing-rules.ts
 * aboutAppBehaviour: "Kiko, you don't need to read back the reply."); otherwise only the name goes
 * and the "don't" stays in the message ("…, Kiko, don't change the colours." → "…, don't change the
 * colours."): a lost "don't" is the worst thing a trim can do. `to`, the session the words go to:
 * a part that's only a direction to it ("Ask MintBox,", "To Kikodev,": direction.ts onlyDirectionTo)
 * goes however short; before 2026-11-16 "Ask MintBox," stayed, as under three words.
 */
export function removeParts(text: string, parts: string[], to?: Session): { text: string; dropped: string[] } | null {
  const all = tokens(text);
  // The tokens where the app's name is said to it.
  const toApp = new Set(namesSaidToApp(text).flatMap(({ start, end }) => all.flatMap((t, i) => (t.start >= start && t.end <= end ? [i] : []))));
  const cuts: Array<[number, number]> = [];
  let from = 0;
  for (const part of parts) {
    const want = tokens(part).map((t) => t.word);
    if (!want.length) continue;
    const at = findRun(all, want, from) ?? findRun(all, want, 0);
    // Said to the app: its name is said to it within the part's first words, the ones before it openers.
    const saidToApp = at !== null && startsSaidToApp(part) && want.some((_, j) => toApp.has(at + j) && j <= 3);
    // The part runs to the end of a sentence, or of what was said.
    const sentenceEnd = at !== null && /^["'”’)\s]*(?:[.!?…]|$)/.test(text.slice(all[at + want.length - 1].end));
    const negated = want.some((w) => NEGATION.test(w));
    // A "don't" said to the app about something else ("Kiko, don't change the colours") is most
    // likely still for the session: only the name goes, the instruction stays.
    const nameOnly = saidToApp && negated && !(sentenceEnd && aboutAppBehaviour(part));
    if (negated && !saidToApp) return null;
    if (want.length < 3 && !want.every((w) => DISFLUENT.has(w)) && !saidToApp && !(to && onlyDirectionTo(part, to))) continue;
    if (at === null || cuts.some(([s, e]) => at < e && at + want.length > s)) return null;
    // Where the cut ends: the whole part, or for nameOnly, the end of the name said to the app (a
    // spoken name may be words of its own: "Hey Jarvis").
    let end = at + want.length;
    if (nameOnly) {
      end = at + want.findIndex((_, j) => toApp.has(at + j));
      while (toApp.has(end)) end++;
    }
    // "…, and Kiko, slow down …" picked from the name on: the "and" before it goes too, not left
    // dangling. Not for the name alone: "…, and don't change the colours" keeps its "and".
    let start = at;
    while (saidToApp && !nameOnly && start > 0 && OPENS.has(all[start - 1].word) && !/[.!?]/.test(text.slice(all[start - 1].end, all[start].start))) start--;
    if (cuts.some(([s, e]) => start < e && end > s)) start = at;
    cuts.push([start, end]);
    from = end;
  }
  if (!cuts.length) return null;
  return cutRuns(text, all, cuts);
}

/**
 * Whether `kept` is `original` with pieces left out and nothing added or changed: its words are
 * the original's words, in order, and enough is left to be a message (at least two real words,
 * and a quarter of what was said).
 */
export function isTrimOf(original: string, kept: string) {
  const from = tokens(original).map((t) => t.word);
  const left = tokens(kept).map((t) => t.word);
  if (!left.length || left.length >= from.length) return false;
  let i = 0;
  for (const word of left) {
    while (i < from.length && from[i] !== word) i++;
    if (i === from.length) return false;
    i++;
  }
  return left.filter((w) => !DISFLUENT.has(w)).length >= 2 && left.length * 4 >= from.length;
}
