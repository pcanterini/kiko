// The phone's `account` message (protocol/README.md, "The plan on the phone"): the Mac's plan and
// trial status, as Settings → Account and `kiko account` say it, read from the same place
// (Account.view(), account.json as last checked) and decided by the same function
// (core/account/plan-words.ts planStatus), so the phone can't say something the Mac doesn't. Only what's shown: no email, no
// token. Null while accounts aren't open: then nothing is sent. Kiko Pro adds when it renews, when it
// ends once cancelled, a payment that failed (and when Pro stops then), and that it's managed on the
// Mac (`kiko account billing`, there whenever accounts are): nothing is bought on the phone. With
// your own key set, Pro still says Pro (`ownKey` beside it: the phone says why its allowance isn't
// used, as the Mac does). And the Mac's own words for them (`planText`, `planNote`, `keysText`:
// plan-words.ts aiWords, as Settings → Account and `kiko account` say them), so the phone can say
// which of your keys does what, and which one pays, exactly as the Mac does.
import type { AccountView } from "../core/account/account.ts";
import type { AiUse } from "../core/account/key-words.ts";
import { phoneReason, type PlanReason } from "../core/account/phone-plan.ts";
import { aiWords, planStatus } from "../core/account/plan-words.ts";

export type AccountStatus = {
  type: "account";
  signedIn: boolean;
  /** Your own OpenRouter key is set: it runs every OpenRouter call, so a trial or plan isn't used for them (yours always wins). */
  ownKey: boolean;
  /** The plan in the Mac's words, as Settings → Account's Plan row: "Free trial · 5 days left", "Kiko Pro (monthly) · renews 3 Dec", "No plan", "Signed out". */
  planText?: string;
  /** Under it, with a plan in effect and your own keys in use: which one pays now, and for Pro how to use it instead (on the Mac). */
  planNote?: string;
  /** Your own keys in use, as the Mac says it: "Your own keys: Anthropic for routing and summaries, OpenRouter for quick checks"; absent when the plan runs it all. */
  keysText?: string;
  plan: "none" | "trial" | "pro";
  /** A trial's end (ms since 1970), running or ended. */
  endsAt?: number | null;
  /** The share used, 0 to 100: the trial's usage, or Pro's month. */
  usedPct?: number | null;
  ended?: boolean;
  endedWhy?: "time" | "cap" | null;
  /** Pro paid for: when it renews (ms since 1970), or null. */
  renewsAt?: number | null;
  /** Pro cancelled: when it ends (ms since 1970); null unless it is. */
  cancelAt?: number | null;
  /** Pro's last payment failed: until when Pro goes on meanwhile (ms since 1970, or null); null when none did. */
  paymentFailed?: { graceEndsAt: number | null } | null;
  /** Pro is managed on the Mac (`kiko account billing`): sent with Pro paid for, whenever accounts are on (on sale or not). */
  billingOnMac?: boolean;
  /**
   * Whether the plan includes the iPhone app (core/account/phone-plan.ts): `included`, or `needs_pro`
   * (a phone connected still is never cut off; the next connect is refused with `plan_required`).
   * Sent only while Kiko Pro is on sale; before that the phone is free and nothing is said.
   */
  phoneApp?: "included" | "needs_pro";
  /** With `needs_pro`: why (core/account/phone-plan.ts phoneReason), so the phone names it and its fix. */
  phoneAppReason?: PlanReason;
};

/** A share (0 to 1) as a whole percentage, as the Mac says it. */
const pct = (share: number | undefined | null) => (typeof share === "number" && Number.isFinite(share) ? Math.round(Math.max(0, Math.min(1, share)) * 100) : null);

/**
 * The status from the account as last known, and whether your own key is in use; null with no account
 * (accounts off). `o.use`: what Kiko's AI runs on now (config.ts aiUseNow), for the Mac's words
 * (unset: none sent). `o.phone`: whether the plan includes the iPhone app, while Pro is on sale (unset: not said).
 */
export function accountStatus(view: AccountView | null, ownKey: boolean, now = Date.now(), o: { phone?: boolean; use?: AiUse } = {}): AccountStatus | null {
  const found = statusOf(view, ownKey, now);
  const status = found && o.use ? { ...found, ...wordsOf(view, o.use, now) } : found;
  if (!status || o.phone === undefined) return status;
  return o.phone ? { ...status, phoneApp: "included" } : { ...status, phoneApp: "needs_pro", phoneAppReason: phoneReason(view, now) };
}

function statusOf(view: AccountView | null, ownKey: boolean, now: number): AccountStatus | null {
  if (!view) return null;
  if (view.state !== "signed-in") return { type: "account", signedIn: false, ownKey, plan: "none" };
  const base = { type: "account" as const, signedIn: true, ownKey };
  const st = planStatus(view.plan, view.trial, now);
  if (st.kind === "trial") return { ...base, plan: "trial", endsAt: st.endsAt, usedPct: pct(st.usedShare), ended: false, endedWhy: null };
  if (st.kind === "pro") {
    const paid = st.renewsAt !== null || st.cancelAt !== null || st.paymentFailed !== null;
    return {
      ...base,
      plan: "pro",
      usedPct: pct(st.usedShare),
      ...(paid ? { renewsAt: st.renewsAt, cancelAt: st.cancelAt, paymentFailed: st.paymentFailed, billingOnMac: true } : {}),
    };
  }
  if (st.kind === "ended") return { ...base, plan: "trial", endsAt: st.endsAt, usedPct: pct(st.usedShare), ended: true, endedWhy: st.why };
  return { ...base, plan: "none" };
}

/** The Mac's words (plan-words.ts aiWords, the phone's variant: its commands are the Mac's), only those there are. */
function wordsOf(view: AccountView | null, use: AiUse, now: number): Pick<AccountStatus, "planText" | "planNote" | "keysText"> {
  const w = aiWords(view, use, now, { phone: true });
  return { ...(w.plan ? { planText: w.plan } : {}), ...(w.planNote.length ? { planNote: w.planNote.join(" ") } : {}), ...(w.keys ? { keysText: w.keys } : {}) };
}

/** How often the status is looked at again, to tell the phones when it changed (it's sent only then). */
export const ACCOUNT_CHECK_MS = 60_000;
