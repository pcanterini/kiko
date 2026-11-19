// What the app would do with decide()'s actions (src/core/decide.ts), as flat outcomes the tests and
// the eval match on: where words land (the waiting session's reply, typed into a terminal, or
// nowhere: the desktop app, the background), and what the "Voice can" level refuses. Deciding is the real
// code; only this last step, which in the app does I/O (sendTo, typeInto), is described here.
import type { Act, Decision, DecideState } from "../../src/core/decide.ts";
import { byAgent } from "../../src/core/can.ts";
import { voiceAllows } from "../../src/core/routing-rules.ts";
import { folderName, sessionName, type Session } from "../../src/core/sessions.ts";

export type Via = "reply" | "terminal" | "unreachable";
export type Outcome =
  /** Your words typed into / replied to a session. `from`: what produced it besides a plain pass_on. */
  (
    | { action: "send"; to: string; text: string; via: Via; from?: "start_session" }
    /** ask_session: a message the router wrote, sent to a session. */
    | { action: "ask"; to: string; message: string; via: Via }
    /** "No, that was for X": the last message sent again to X. */
    | { action: "resend"; to: string; text: string; via: Via }
    /** Its turn interrupted: Escape pressed in its terminal, or by its agent itself (T3 Code: through its server). */
    | { action: "stop"; to: string; via: "terminal" | "unreachable" }
    /** stop_session dropped by the BARE_STOP guard. */
    | { action: "stop_ignored"; to: string }
    | { action: "rename"; to: string; name: string }
    /**
     * A new session: `folder` its folder's name ("scratch" for a fresh scratch one), `how` the folder
     * was found (exact, close, named, home, new, scratch), its name and first message ("" for none).
     */
    | { action: "start"; folder: string; how: string; name: string; text: string; agent?: string; app?: string }
    /** A read-only `claude -p` run: `text` is what it's asked to find out. */
    | { action: "quick_task"; text: string; folder: string }
    | { action: "cancel_quick" }
    | { action: "trust_scratch" }
    /** Kiko Pro's checkout opened in the browser ("upgrade to Pro"), monthly or yearly. */
    | { action: "upgrade"; interval: "month" | "year" }
    /** Your dictionary changed: `write` from now on where speech-to-text writes `heard` (add), or not (remove). */
    | { action: "dictionary"; op: "add" | "remove"; heard: string; write?: string }
    /** How the voice says `word` changed: as `say` from now on (add), or as written (forget). */
    | { action: "pronounce"; op: "add" | "forget"; word: string; say?: string }
    /** The "Voice can" setting didn't allow it; the app says so. */
    | { action: "refused"; what: "message" | "stop" | "start" | "rename" | "check" | "dictionary"; to?: string }
    /** Yes to the offer that followed: Voice can turned up to Everything, and what it stopped done. */
    | { action: "voice_on" }
    | { action: "permission"; answer: string }
    /** Your words to the question the session asks: the app matches them to its options. */
    | { action: "answer"; text: string }
    | { action: "wrap_up" }
    | { action: "undo"; to?: string }
    /** "Skip that": the announcement you haven't heard isn't made. */
    | { action: "skip" }
    /** "More": a longer summary of `to`'s last reply heard, or all it says about `topic`. */
    | { action: "more"; to?: string; topic?: string }
    /** Say again the last thing said, or `to`'s last summary. */
    | { action: "repeat"; to?: string }
    /** The app speaks; `ask_user` when it's a question back to the user. */
    | { action: "say"; text: string }
    | { action: "ask_user"; text: string }
    | { action: "none" }
  ) & {
    /** The session acted on, when there is one (two sessions in one folder share a name). */
    sessionId?: string;
    /** A send whose session was a guess (decide's `unsure`): the app says where and holds it a moment. */
    unsure?: true;
  };

/** The outcomes of a decision, in order; "none" when it does nothing. */
export function outcomesOf(decision: Decision, s: DecideState): Outcome[] {
  const out = decision.actions.map((a) => {
    const o = outcomeOf(a, s);
    const unsure = "unsure" in a && a.unsure && (o.action === "send" || o.action === "ask" || o.action === "resend");
    return unsure ? { ...o, unsure: true as const } : o;
  });
  return out.length ? out : [{ action: "none" }];
}

function outcomeOf(a: Act, s: DecideState): Outcome {
  const find = (id: string) => s.sessions.find((x) => x.sessionId === id);
  switch (a.type) {
    case "send": {
      const o = reach(s, find(a.session.sessionId) ?? a.session, a.text);
      return o.action === "send" && a.from ? { ...o, from: a.from } : o;
    }
    case "ask": {
      const o = reach(s, a.session, a.message);
      return o.action === "send" ? { action: "ask", to: o.to, message: a.message, via: o.via, sessionId: o.sessionId } : o;
    }
    case "resend": {
      // It got these words already (the router sent them to several): nothing is sent again.
      if (a.last.sessionId === a.session.sessionId || a.last.also?.some((x) => x.sessionId === a.session.sessionId)) {
        return { action: "say", text: `That already went to ${sessionName(a.session)}.`, sessionId: a.session.sessionId };
      }
      const o = reach(s, a.session, a.text ?? a.last.text);
      return o.action === "send" ? { action: "resend", to: o.to, text: a.text ?? a.last.text, via: o.via, sessionId: o.sessionId } : o;
    }
    case "stop":
      // A key in its terminal, or its agent stops it itself (T3 Code: through its server): reached either way.
      return { action: "stop", to: sessionName(a.session), via: a.session.place?.keys || byAgent(a.session, "interrupt") ? "terminal" : "unreachable", sessionId: a.session.sessionId };
    case "stop_ignored":
      return { action: "stop_ignored", to: sessionName(a.session), sessionId: a.session.sessionId };
    case "rename":
      return { action: "rename", to: sessionName(a.session), name: a.name, sessionId: a.session.sessionId };
    case "start": {
      const where = a.where;
      return {
        action: "start",
        folder: where.kind === "scratch" ? "scratch" : folderName(where.cwd),
        how: where.kind === "project" ? where.how : where.kind,
        name: a.name,
        text: a.prompt,
        // The agent it starts in, when one was named in the words (decide.ts namedAgent); none: Claude Code, the default.
        ...(a.agent ? { agent: a.agent } : {}),
        // Asked of an agent whose sessions start in its own app (T3 Code: a thread made there).
        ...(a.app ? { app: a.app } : {}),
      };
    }
    case "quick_task":
      return { action: "quick_task", text: a.task, folder: folderName(a.cwd) };
    case "cancel_quick":
      return { action: "cancel_quick" };
    case "dictionary":
      return a.op === "add" ? { action: "dictionary", op: "add", heard: a.heard, write: a.write } : { action: "dictionary", op: "remove", heard: a.heard };
    case "pronounce":
      return a.op === "add" ? { action: "pronounce", op: "add", word: a.word, say: a.say } : { action: "pronounce", op: "forget", word: a.word };
    case "refused":
      return { action: "refused", what: a.what, ...(a.session ? { to: sessionName(a.session), sessionId: a.session.sessionId } : {}) };
    case "permission":
      return { action: "permission", answer: a.answer };
    case "answer":
      return { action: "answer", text: a.text };
    case "wrap_up":
      return { action: "wrap_up" };
    case "undo":
      return { action: "undo", ...(s.lastSent ? { to: s.lastSent.folder } : {}) };
    case "skip":
      return { action: "skip" };
    case "more": {
      const session = find(a.sessionId);
      return { action: "more", ...(session ? { to: sessionName(session) } : {}), ...(a.topic ? { topic: a.topic } : {}), sessionId: a.sessionId };
    }
    case "trust_scratch":
      return { action: "trust_scratch" };
    case "upgrade":
      return { action: "upgrade", interval: a.interval };
    case "voice_on":
      return { action: "voice_on" };
    case "repeat": {
      const session = "session" in a ? (a as { session: Session | null }).session : null;
      return session ? { action: "repeat", to: sessionName(session), sessionId: session.sessionId } : { action: "repeat" };
    }
    case "say":
      // Not the app's code: a report label. Any question in what it says counts as asking the user.
      return a.text.includes("?") ? { action: "ask_user", text: a.text } : { action: "say", text: a.text };
  }
}

/** sendTo() + typeInto(): a reply to the waiting session, else typed in if "Voice can" allows it. */
function reach(s: DecideState, to: Session | { sessionId: string; cwd: string }, text: string): Outcome {
  const name = sessionName(to);
  const sessionId = to.sessionId;
  if (s.waiting && s.waiting.permission === undefined && s.waiting.sessionId === sessionId) {
    return { action: "send", to: name, text, via: "reply", sessionId };
  }
  if (!voiceAllows(s.voiceCan, "message")) return { action: "refused", what: "message", to: name, sessionId };
  const session = to as Partial<Session>;
  const via: Via = session.place ? "terminal" : "unreachable";
  return { action: "send", to: name, text, via, sessionId };
}

/** One line for a report: `send → clipkit (terminal)`. */
export function describeOutcome(o: Outcome): string {
  switch (o.action) {
    case "send":
      return `send → ${o.to} (${o.via}${o.from ? `, from ${o.from}` : ""}${o.unsure ? ", unsure" : ""})`;
    case "ask":
      return `ask → ${o.to} (${o.via}${o.unsure ? ", unsure" : ""})`;
    case "resend":
      return `resend → ${o.to} (${o.via}${o.unsure ? ", unsure" : ""})`;
    case "stop":
      return `stop → ${o.to}${o.via === "unreachable" ? " (unreachable)" : ""}`;
    case "stop_ignored":
      return `stop ignored (bare stop) → ${o.to}`;
    case "rename":
      return `rename ${o.to} → ${o.name}`;
    case "start":
      return `start new session${o.app ? ` (${o.app})` : ""} in ${o.folder} (${o.how}${o.name ? `, named ${o.name}` : ""}${o.text ? `: "${o.text.length > 40 ? `${o.text.slice(0, 40)}…` : o.text}"` : ""})`;
    case "quick_task":
      return `quick_task in ${o.folder}: "${o.text.length > 60 ? `${o.text.slice(0, 60)}…` : o.text}"`;
    case "refused":
      return `refused (voice can) ${o.what}${o.to ? ` → ${o.to}` : ""}`;
    case "dictionary":
      return o.op === "add" ? `dictionary add "${o.heard}" → "${o.write}"` : `dictionary remove "${o.heard}"`;
    case "pronounce":
      return o.op === "add" ? `pronounce "${o.word}" as "${o.say}"` : `pronounce "${o.word}" as written`;
    case "permission":
      return `permission: ${o.answer}`;
    case "answer":
      return `answer: "${o.text}"`;
    case "undo":
      return `undo${o.to ? ` (${o.to})` : ""}`;
    case "repeat":
      return `repeat${o.to ? ` (${o.to})` : ""}`;
    case "say":
    case "ask_user":
      return `${o.action}: "${o.text.length > 70 ? `${o.text.slice(0, 70)}…` : o.text}"`;
    default:
      return o.action;
  }
}
