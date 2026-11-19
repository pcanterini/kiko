// The iPhone app is a Kiko Pro feature (decided 2026-11-04): at home and away, it comes with Kiko Pro or the free trial. Your own
// OpenRouter key keeps the Mac free forever; the phone needs the plan either way. Only while Kiko Pro
// is on sale (core/env.ts proOnSale): off, pairing and the phone stay free, as before.
//
// Decided here, once, for everything that asks: Settings → Phone (the PRO badge on Pair a phone and
// its offer), the phone server at each connect (a phone refused gets `plan_required`), the relay pass
// (fetched only while the plan allows the phone), the phone's `account` message (`phoneApp`) and the
// Mac's once-a-day line when a paired phone was turned away.
//
// From the Mac's last known plan (account.json, as Account.view() has it, and plan-words.ts
// planActive): a trial or Pro in effect. Pro in its failed-payment grace and cancelled Pro until its
// end are in effect by their `endsAt`, as the server writes it. With the server out of reach, the
// plan as last checked holds for PHONE_GRACE_MS after that check, even past its end: a phone is never
// locked out because the Mac couldn't ask. Judged at connect only: a phone in the middle of a
// conversation is never cut off, and a pairing is never dropped (renewing brings the phone back).
import { COMMAND, NAME, PRO_PRICE } from "../name.ts";
import type { AccountView } from "./account.ts";
import { planActive, planStatus } from "./plan-words.ts";

/** How long the plan as last checked holds while the account server can't be reached: 7 days. */
export const PHONE_GRACE_MS = 7 * 86_400_000;

/**
 * Why the plan doesn't include the iPhone app, so the phone (and the Mac's line) names the one thing
 * that fixes it (protocol/README.md, The iPhone app and the plan; schema.json planReason). Never Pro's
 * fault when the Mac is only signed out.
 */
export type PlanReason = "mac_signed_out" | "no_plan" | "trial_ended" | "pro_ended" | "payment_failed_grace_over";

/** Whether the phone may connect, and when it may not, why, and whether the free trial could still start. */
export type PhonePlan = { ok: true } | { ok: false; trialAvailable: boolean; reason: PlanReason };

/**
 * Whether the plan includes the iPhone app now, as last known: always with Pro off sale (`sale`
 * false); else signed in with a trial or Pro in effect, or one that was in effect at the last check
 * within PHONE_GRACE_MS of it.
 */
export function phoneIncluded(view: AccountView | null, o: { sale: boolean; now?: number }): boolean {
  if (!o.sale) return true;
  if (!view || view.state !== "signed-in") return false;
  const plan = view.plan;
  if (!plan || (plan.name !== "trial" && plan.name !== "pro")) return false;
  const now = o.now ?? Date.now();
  if (planActive(plan, now)) return true;
  const at = view.checkedAt;
  return typeof at === "number" && planActive(plan, at) && now - at < PHONE_GRACE_MS;
}

/**
 * Whether this account could still start its free trial, as far as the Mac can tell: the server's
 * word when it gave one (POST /relay/pass's `trialAvailable`), else none had on record (signed out:
 * yes, setup signs in and starts it).
 */
export function trialAvailable(view: AccountView | null, said: boolean | null = null): boolean {
  if (said !== null) return said;
  if (!view || view.state !== "signed-in") return true;
  return !view.trial && view.plan?.name !== "trial" && view.plan?.name !== "pro";
}

/**
 * Why the plan as last known doesn't include the phone (asked only when it doesn't): signed out;
 * Pro that ended (by a failed payment's grace, or cancelled and past its end: the plan still says
 * Pro, or account.json kept that it was: proEnded); a trial that ended; else no plan.
 */
export function phoneReason(view: AccountView | null, now = Date.now()): PlanReason {
  if (!view || view.state !== "signed-in") return "mac_signed_out";
  const plan = view.plan;
  if (plan?.name === "pro") return plan.pro?.paymentFailed ? "payment_failed_grace_over" : "pro_ended";
  if (view.proEnded) return view.proEnded.paymentFailed ? "payment_failed_grace_over" : "pro_ended";
  if (planStatus(plan, view.trial, now).kind === "ended" || plan?.name === "trial") return "trial_ended";
  return "no_plan";
}

/** The phone plan, for the phone server's connect check. */
export function phonePlan(view: AccountView | null, o: { sale: boolean; now?: number; trialSaid?: boolean | null }): PhonePlan {
  return phoneIncluded(view, o) ? { ok: true } : { ok: false, trialAvailable: trialAvailable(view, o.trialSaid ?? null), reason: phoneReason(view, o.now) };
}

/** The words for it, everywhere. */
export const PHONE_WORDS = {
  /** Settings → Phone's badge on Pair a phone. */
  badge: "PRO",
  /** Settings → Phone → Pair a phone's offer, without Pro or the trial. */
  offer: `The iPhone app comes with ${NAME} Pro: ${PRO_PRICE.month} or ${PRO_PRICE.year}, ${NAME}'s AI included.`,
  trial: "Start the free trial (7 days, no card)",
  month: `${NAME} Pro, monthly`,
  year: `${NAME} Pro, yearly`,
  /**
   * Said (and shown) once a day at most, when a paired phone was turned away, by why: the one thing
   * that fixes it. Signed out: Enter signs in where it can be pressed (`enter`: the window's popup
   * asks), else where to sign in.
   */
  refused: (trial: boolean, reason: PlanReason = "no_plan", o: { enter?: boolean } = {}) => {
    switch (reason) {
      case "mac_signed_out":
        return `Your phone can't connect: this Mac is signed out of ${NAME}. ${o.enter === false ? `Sign in: Settings → ${NAME} account, or ${COMMAND} login.` : "Press Enter to sign in."}`;
      case "trial_ended":
        return `Your phone tried to connect, but your free trial ended: ${COMMAND} upgrade.`;
      case "pro_ended":
        return `Your phone tried to connect, but ${NAME} Pro ended: ${COMMAND} upgrade.`;
      case "payment_failed_grace_over":
        return `Your phone tried to connect, but ${NAME} Pro stopped after a failed payment: ${COMMAND} account billing.`;
      default:
        return trial
          ? `Your phone tried to connect. The iPhone app comes with ${NAME} Pro, or the free trial: ${COMMAND} setup.`
          : `Your phone tried to connect. The iPhone app comes with ${NAME} Pro: ${COMMAND} upgrade.`;
    }
  },
  /** The Pairing code row opened without the plan. */
  pairingCode: `The iPhone app comes with ${NAME} Pro or the free trial: Settings → Phone → Pair a phone.`,
};
