// Whether Kiko shows dollar amounts (decided 2026-11-05), the one place every surface asks: the
// window's line and the full screen's header (`cost` in UiState, null: none), the timing and info
// lines, the quick check's line, the summary at quit, and the phone (`state`'s `cost` is left out,
// so an app of any age shows none: it shows only what the last `state` carried).
//
// On your own keys, as ever: what Kiko's calls cost you. On the subscription (the free trial or Kiko
// Pro running Kiko's AI through the account's proxy instead of an OpenRouter key of yours), none
// anywhere: what the plan spends isn't yours to count, and its use is shown as a share instead
// (core/account/plan-words.ts: "31% used", never dollars).
//
// Only Kiko's OpenRouter calls can go through the plan; the voice's keys (Deepgram, Cartesia) are
// always yours. Mixed (the plan running the AI, your own voice keys), no dollars at all, not a part:
// - hidden while there's no OpenRouter key of yours and the account has a plan in effect (the trial,
//   Pro, Pro paused past its month's allowance: still on the subscription), as last known;
// - and for the rest of the run once any model call went through the plan, a key added since or
//   not: this run's totals have the plan's spend in them.
// Your own OpenRouter key with Pro: shown (your key runs the AI; Pro's allowance isn't used).
import { accountHasPlan } from "./account/app-account.ts";
import { keyOf } from "./key-values.ts";
import { usd } from "./log.ts";

export type DollarsMode = {
  /** An OpenRouter key of your own is in use (it always wins over the plan). */
  ownKey: boolean;
  /** The account has a plan in effect, as last known (account.json). */
  plan: boolean;
  /** A model call went through the plan this run. */
  planUsed: boolean;
};

/** The rule itself: dollars only when nothing this run is, or was, paid by the subscription. */
export const dollarsShown = (m: DollarsMode) => !m.planUsed && (m.ownKey || !m.plan);

type Deps = { ownKey: () => boolean; plan: () => boolean };
const live: Deps = { ownKey: () => Boolean(keyOf("OPENROUTER_API_KEY").trim()), plan: () => accountHasPlan() };
let deps: Deps = live;
let planUsed = false;

/** A model call went through the plan (core/model-route.ts): no dollars for the rest of the run. */
export function notePlanCall() {
  planUsed = true;
}

/** Whether dollar amounts are shown now (account.json read only when it matters: no key of yours, no plan call yet). */
export function showsDollars(): boolean {
  return !planUsed && (deps.ownKey() || !deps.plan()); // dollarsShown, asked lazily
}

/** `n` dollars as the lines write them ("$0.0123"), or null while none are shown. */
export const usdShown = (n: number): string | null => (showsDollars() ? usd(n) : null);

/** `n` as a number to show (the window's line, the phone), or null while none are shown. */
export const costShown = (n: number): number | null => (showsDollars() ? n : null);

/** Tests: the mode from `d` (and a fresh run: no plan call yet); none, the app's own again. */
export function dollarsFrom(d?: Partial<Deps>) {
  deps = d ? { ...live, ...d } : live;
  planUsed = false;
}
