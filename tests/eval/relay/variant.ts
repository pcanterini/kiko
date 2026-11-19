// A relay strategy to compare on the same cases (pnpm eval:relay --variant <name or module>). The
// engine (decide(): the decision model, the router, the trim, the clean-up) always runs; a variant
// may change the engine's own steps (`deps`) and/or rewrite each message it would send (`relay`).
// A module is any file whose default export is a Variant:
//
//   import type { Variant } from "<this repo>/tests/eval/relay/variant.ts";
//   export default { name: "framing-only", about: "…", relay: async (ctx) => ({ text: …, costUsd: … }) } satisfies Variant;
//
// The reply rule holds for every variant: words that reply to the session waiting for a reply go as
// the engine sends them; `relay` is never asked about them (unless `rewritesReplies`, for experiments).
import type { DecideDeps } from "../../../src/core/decide.ts";
import type { Session } from "../../../src/core/sessions.ts";

export type RelayContext = {
  /** The words as said (after the dictionary, when on). */
  said: string;
  /** What today's engine would type into the session. */
  engineText: string;
  /** "send" (your words), "ask" (a message the router wrote) or "resend". */
  action: string;
  /** The session it goes to: the case's name for it, and the session itself. */
  to: string;
  session: Session | null;
  sessions: Session[];
  /** The recent lines Kiko keeps (Timeline.lines). */
  recent: string[];
  /** All the sessions this go sends to (several for "ask both"). */
  allTo: string[];
  /** A reply to the session waiting for a reply. Always false here unless the variant rewritesReplies. */
  reply: boolean;
};

export type Variant = {
  name: string;
  about: string;
  /** The engine's steps, changed (another trim, the clean-up on…): given today's, returns the ones to use. */
  deps?: (base: DecideDeps) => DecideDeps;
  /** The text to type instead of the engine's. */
  relay?: (ctx: RelayContext) => Promise<{ text: string; costUsd?: number }>;
  /** Also rewrite replies to the waiting session (breaks the reply rule; for experiments only). */
  rewritesReplies?: boolean;
};

/** Today's engine, untouched: the baseline every strategy is compared with. */
export const baseline: Variant = {
  name: "baseline",
  about: "Today's engine: words as said, less what the phrase trim and the trim model drop (src/core/trim.ts).",
};

export const BUILT_IN: Record<string, Variant> = { baseline };
