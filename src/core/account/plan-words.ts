// What Kiko says about an account's plan (the account service's API.md, "Plans and quotas" and "The
// AI proxy"): the trial starting or refused, `kiko account`'s plan line, and the lines the proxy's
// answers turn into, each said once. Shares of a quota are said as a percentage, never dollars. No
// token, no key, nothing else here.
//
// Kiko Pro (phase 3): its month's share used everywhere it's shown; in Settings and `kiko account`
// the weekly pace beside or under it (information only, never a cap); when it renews, or ends once
// cancelled; a payment that failed; and past its month's allowance, the plan paused until it
// renews, with your own key to go on now. While Pro is on sale (core/env.ts proOnSale), the trial's
// reminders and lines also say how to get it (`kiko upgrade`, or "upgrade" to the app); off, nothing
// about buying is said. Your own key is always said as an equal choice. The trial's end and today's
// share used carry the Kiko window's words too (KeyOffer: its key, ADD_KEY_KEY, opens your own key's
// paste there; app/key-offer.ts), the command kept for where there's no window.
import { proOnSale } from "../env.ts";
import { COMMAND, NAME } from "../name.ts";
import type { SettingFact } from "../ui-store.ts";
import type { Plan, Trial } from "./client.ts";
import { type AiUse, keysInUseFor, keysLine, keysOverPlanLines, NO_AI_KEYS, ownKeysOnly } from "./key-words.ts";

const DAY = 86_400_000;

/** "Mon 10 Nov, 14:02", in this Mac's time zone. */
export const when = (ms: number) => new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
/** "10 Nov". */
export const dayOf = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
/** "14:00", today's time in this Mac's time zone. */
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Whole days left, rounded up ("1 day left" on the last day). */
export const daysLeft = (endsAt: number, now: number) => Math.max(0, Math.ceil((endsAt - now) / DAY));
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const percent = (share: number) => `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`;

/** How to go on without the trial: your own key, free forever. */
export const OWN_KEY = `your own OpenRouter key (${COMMAND} keys set openrouter), free forever with no account`;

/** Said once the trial started (setup's Free trial). */
export const trialStartedLine = (endsAt: number | null) =>
  `${endsAt ? `Your free trial runs until ${when(endsAt)}.` : "Your free trial has started."} ${NAME}'s AI calls go through ${NAME}, so you don't need a key.`;

/** Why a trial didn't start, in words (API.md, POST /trial/start's errors). */
export function trialRefusedLine(code: string, reason: string | null, email: string | null, o: { resetsAt?: number | null; retryAfter?: number | null; now?: number } = {}): string {
  switch (code) {
    // All of today's free trials are taken (the trials' daily cap): nothing claimed, the same email can start it later.
    case "trials_paused": {
      const at = o.resetsAt ?? (o.retryAfter ? (o.now ?? Date.now()) + o.retryAfter * 1000 : null);
      return `Free trials are full for today; try again ${at ? `after ${when(at)}` : "tomorrow"}, or use your own OpenRouter key (no account needed: ${COMMAND} keys set openrouter).`;
    }
    case "trial_used":
      return `${email ?? "This email"} has already used its free trial. Go on with ${OWN_KEY}.`;
    case "has_plan":
      return `This account has ${NAME} Pro already: nothing to start.`;
    case "email_not_allowed":
      return reason === "no_mail"
        ? `A free trial needs an email address that can receive mail, and ${email ? `${email.split("@").pop()}` : "this one"} can't. Use ${OWN_KEY}, or sign in with another email.`
        : `A free trial needs an email address that isn't a throwaway one. Use ${OWN_KEY}, or sign in with another email.`;
    case "email_unverified":
      return `This account's email isn't verified, so it can't start a trial: ${COMMAND} logout, then sign in again.`;
    case "rate_limited":
      return `Too many free trials were started from this network today. Try again tomorrow, or use ${OWN_KEY}.`;
    default:
      return `The free trial couldn't start (${code}). Use ${OWN_KEY}.`;
  }
}

/** True while a plan is in effect, as last known: a trial or Pro not past its end. */
export const planActive = (plan: Plan | null | undefined, now = Date.now()) => !!plan && plan.name !== "none" && (plan.endsAt === null || plan.endsAt > now);

/** A trial is near its end in its last NEAR_END.days days, or past NEAR_END.used of its usage: reminded, and shown in yellow. */
export const NEAR_END = { days: 2, used: 0.8 };

/**
 * Where the plan stands, decided once for everything that says it (`kiko account`, `kiko keys`,
 * Settings → Account, the window's item, the reminders, the phone's `account` message): a trial
 * running (its days left, share used, and whether it's near its end and why), Pro (its month's
 * share), a trial that ended (when, and by time or its usage), or none.
 */
export type PlanStatus =
  | { kind: "trial"; endsAt: number | null; daysLeft: number | null; usedShare: number; near: "used" | "days" | null }
  | ProStatus
  | { kind: "ended"; endsAt: number | null; why: "time" | "cap"; usedShare: number | null }
  | { kind: "none" };

/**
 * Pro, as shown: the month's share used, and once it's paid for, when it renews (or ends, cancelled),
 * a payment that failed (and when Pro stops then), this week's share and its pace. `usedUp`: past the
 * month's allowance, the plan doesn't run Kiko's AI until `resetsAt` (the month's end). `near`: past
 * NEAR_END.used of it (the window's item shows then).
 */
export type ProStatus = {
  kind: "pro";
  usedShare: number | null;
  renewsAt: number | null;
  cancelAt: number | null;
  paymentFailed: { graceEndsAt: number | null } | null;
  weekShare: number | null;
  pace: "on_track" | "fast" | null;
  /** Paid monthly or yearly; null when not said (Pro given by hand, an account.json from before). */
  interval: "month" | "year" | null;
  resetsAt: number | null;
  usedUp: boolean;
  near: boolean;
};

function proStatus(plan: Plan, now: number): ProStatus {
  const usedShare = plan.quota ? plan.quota.usedShare : null;
  const resetsAt = plan.quota?.periodEnd ?? null;
  const t = plan.pro ?? null;
  return {
    kind: "pro",
    usedShare,
    renewsAt: t?.renewsAt ?? null,
    cancelAt: t?.cancelAt ?? null,
    paymentFailed: t?.paymentFailed ?? null,
    weekShare: t?.weekShare ?? null,
    pace: t?.pace ?? null,
    interval: t?.interval ?? null,
    resetsAt,
    usedUp: usedShare !== null && usedShare >= 1 && (resetsAt === null || resetsAt > now),
    near: usedShare !== null && usedShare >= NEAR_END.used,
  };
}

/** Whether the plan runs Kiko's AI now, as last known: in effect, and not Pro past its month's allowance. */
export function planRunsAi(plan: Plan | null | undefined, now = Date.now()): boolean {
  if (!planActive(plan, now)) return false;
  const st = planStatus(plan, null, now);
  return !(st.kind === "pro" && st.usedUp);
}

export function planStatus(plan: Plan | null | undefined, trial: Trial | null | undefined, now = Date.now()): PlanStatus {
  if (plan && planActive(plan, now) && plan.name === "trial") {
    const endsAt = plan.endsAt ?? trial?.endsAt ?? null;
    const left = endsAt ? daysLeft(endsAt, now) : null;
    const usedShare = plan.quota?.usedShare ?? 0;
    const near = usedShare >= NEAR_END.used ? "used" : left !== null && left <= NEAR_END.days ? "days" : null;
    return { kind: "trial", endsAt, daysLeft: left, usedShare, near };
  }
  if (plan && planActive(plan, now) && plan.name === "pro") return proStatus(plan, now);
  if (trial?.ended || (plan?.name === "trial" && !planActive(plan, now)))
    return { kind: "ended", endsAt: trial?.endsAt ?? plan?.endsAt ?? null, why: trial?.endedWhy === "cap" ? "cap" : "time", usedShare: plan?.quota?.usedShare ?? null };
  return { kind: "none" };
}

/**
 * `kiko account`'s plan line: "Plan: free trial · 4 days left · 31% of its usage used."; Pro's month;
 * a trial that ended; none.
 */
export function planLine(plan: Plan | null, trial: Trial | null, now = Date.now(), o: { use?: AiUse | null } = {}): string {
  const st = planStatus(plan, trial, now);
  const own = Boolean(o.use && keysInUseFor(o.use).length);
  switch (st.kind) {
    case "trial": {
      const left = st.endsAt && st.daysLeft !== null ? `${days(st.daysLeft)} left (until ${when(st.endsAt)})` : "running";
      return `Plan: free trial · ${left} · ${percent(st.usedShare)} of its usage used.`;
    }
    case "pro":
      // Your own keys run all of the AI: Pro's allowance isn't used, so no share of it (planDetail says why, under it).
      return st.paymentFailed ? `Plan: ${NAME} Pro · payment failed: ${failedWords(st)}.` : `Plan: ${proHead(st)}${o.use && ownKeysOnly(o.use) ? "" : proUsed(st)}.`;
    case "ended": {
      const on = st.endsAt && st.why !== "cap" ? ` on ${dayOf(st.endsAt)}` : "";
      const ended = `Plan: none. Your free trial ended${on} (${st.why === "cap" ? "its usage was used up" : "its 7 days ran out"}).`;
      // Your own keys run the AI already: nothing to go on with.
      return own ? ended : `${ended} Go on with ${OWN_KEY}${sale() ? `, or ${NAME} Pro: ${COMMAND} upgrade` : ""}.`;
    }
    case "none":
      if (own) return "Plan: none.";
      return sale()
        ? `Plan: none. ${NAME}'s AI can run on your own OpenRouter key (${COMMAND} keys set openrouter), the free trial (${COMMAND} setup starts it) or ${NAME} Pro (${COMMAND} upgrade).`
        : `Plan: none. ${NAME}'s AI can run on your own OpenRouter key (${COMMAND} keys set openrouter), or the free trial: ${COMMAND} setup starts it.`;
  }
}

/** Kiko Pro is on sale now (core/env.ts proOnSale): read at each use. */
const sale = () => proOnSale();

/**
 * Said under the plan's line (Settings → Account, `kiko account`, `kiko keys`, the phone) while a
 * plan is in effect and your own keys run some or all of Kiko's AI (key-words.ts keysOverPlanLines):
 * which one pays now, and for Pro how to use it instead. Lines in Settings, one in a terminal (joined).
 */
export function planNoteLines(plan: Plan | null | undefined, trial: Trial | null | undefined, use: AiUse | null | undefined, now = Date.now(), o: { phone?: boolean } = {}): string[] {
  const st = planStatus(plan, trial, now);
  if (!use || (st.kind !== "pro" && st.kind !== "trial")) return [];
  return keysOverPlanLines(use, st.kind, o);
}

/** "Kiko Pro (monthly)", "Kiko Pro (yearly)", or "Kiko Pro" (given by hand, or not said). */
const proName = (st: ProStatus) => `${NAME} Pro${st.interval === "month" ? " (monthly)" : st.interval === "year" ? " (yearly)" : ""}`;

/** "Kiko Pro (monthly) · renews 3 Dec", "Kiko Pro (yearly) · ends 3 Dec" (cancelled), or "Kiko Pro" (given by hand: no billing). */
function proHead(st: ProStatus): string {
  if (st.cancelAt) return `${proName(st)} · ends ${dayOf(st.cancelAt)}`;
  if (st.renewsAt) return `${proName(st)} · renews ${dayOf(st.renewsAt)}`;
  return proName(st);
}

/** " · 31% of this month used", or nothing when the share isn't known. */
const proUsed = (st: ProStatus) => (st.usedShare !== null ? ` · ${percent(st.usedShare)} of this month used` : "");

/** "update your card (kiko account billing) · Pro stops on 10 Nov". */
const failedWords = (st: ProStatus) => `update your card (${COMMAND} account billing) · Pro stops ${st.paymentFailed?.graceEndsAt ? `on ${dayOf(st.paymentFailed.graceEndsAt)}` : "soon"}`;

/** The weekly pace, information only: "12% this week · on track", "12% this week · using it faster than usual"; null when the server didn't say. */
export function paceLine(st: ProStatus): string | null {
  if (st.weekShare === null) return null;
  const pace = st.pace === "fast" ? " · using it faster than usual" : st.pace === "on_track" ? " · on track" : "";
  return `${percent(st.weekShare)} this week${pace}`;
}

/** "It renews on 3 Dec" (the month's allowance), or "It renews next month". */
const renewsWords = (resetsAt: number | null) => (resetsAt ? `It renews on ${dayOf(resetsAt)}` : "It renews next month");

/** Said once a period, past Pro's month's allowance (`pro_quota_used`): when it renews, and your own key to go on now. */
export const proUsedUpLine = (resetsAt: number | null) => `You've used this month's ${NAME} Pro allowance. ${renewsWords(resetsAt)}; add your own OpenRouter key to keep going now.`;

/**
 * Setup's line for Pro past its month's allowance (signed in, or at the app's start): the plan stays,
 * paused until it renews, so no key is needed; your own is offered under it, optional.
 */
export const proPausedLine = (resetsAt: number | null) => `This month's ${NAME} Pro allowance is used; it renews ${resetsAt ? `on ${dayOf(resetsAt)}` : "next month"}.`;

/**
 * The line under the plan's in `kiko account` (Settings → Account has rows of its own: planFacts):
 * Pro's weekly pace; past the month's allowance, that it's paused and your own key goes on now; with
 * a payment failed, the month's share and the pace; and with your own keys in use, which one pays
 * (planNoteLines). Null with nothing to add.
 */
export function planDetail(plan: Plan | null, trial: Trial | null, o: { use?: AiUse | null; now?: number } = {}): string | null {
  const now = o.now ?? Date.now();
  const st = planStatus(plan, trial, now);
  const note = planNoteLines(plan, trial, o.use, now).join(" ");
  // All of the AI on your own keys: which one pays, and nothing about the plan's share.
  if (note && o.use && ownKeysOnly(o.use)) return note;
  if (st.kind !== "pro") return note || null;
  if (st.usedUp) return `Paused until ${st.resetsAt ? dayOf(st.resetsAt) : "next month"}: your own OpenRouter key keeps ${NAME} going now (${COMMAND} keys set openrouter)`;
  const pace = paceLine(st);
  const said = st.paymentFailed ? [st.usedShare !== null ? `${percent(st.usedShare)} of this month used` : null, pace].filter(Boolean).join(" · ") || null : pace;
  return [said, note].filter(Boolean).join(". ") || null;
}

/**
 * The plan in a few words, for a line that's about something else (`kiko keys`'s account line):
 * "free trial, 4 days left, 31% used"; "Kiko Pro, 12% of this month used"; "free trial ended"; "no plan".
 */
export function planBrief(plan: Plan | null, trial: Trial | null, now = Date.now(), o: { use?: AiUse | null } = {}): string {
  const st = planStatus(plan, trial, now);
  if (st.kind === "trial") return `free trial${st.daysLeft !== null ? `, ${days(st.daysLeft)} left` : ""}, ${percent(st.usedShare)} used`;
  if (st.kind === "pro") {
    if (st.paymentFailed) return `${NAME} Pro, payment failed (${COMMAND} account billing)`;
    // Your own keys run all of the AI: Pro's allowance isn't used, so none of its share (planNoteLines under it).
    if (o.use && ownKeysOnly(o.use)) return proHead(st).replace(" · ", ", ");
    if (st.usedUp) return `${NAME} Pro, this month's allowance used (back ${st.resetsAt ? dayOf(st.resetsAt) : "next month"})`;
    return `${proHead(st).replace(" · ", ", ")}${st.usedShare !== null ? `, ${percent(st.usedShare)} of this month used` : ""}`;
  }
  return st.kind === "ended" ? "free trial ended" : "no plan";
}

/**
 * Settings → Account's plan, as label and value rows (the same data as `kiko account`, in fewer
 * words): "Plan  Free trial · 6 days left" and "Used  3% of the trial"; "Plan  Kiko Pro · renews 3
 * Dec" and "This month  31% used · this week 12%, on track"; "Plan  Trial ended on 10 Nov"; "Plan
 * No plan". `warn` (yellow, on the value only): a trial in its last NEAR_END.days days or past
 * NEAR_END.used of its usage, Pro cancelled, a payment failed, Pro near or past its month's
 * allowance. `more`: dim lines under the value, only where something needs saying (what to do about
 * a failed payment or an ended trial; which one pays while your own keys run some of the AI).
 * `use`: what Kiko's AI runs on now (key-words.ts aiUse). Your own keys running all of it, the plan
 * isn't used: it stays in sight, with why under it (planNoteLines) and no share used (none is).
 */
export function planFacts(plan: Plan | null, trial: Trial | null, o: { use?: AiUse | null; now?: number } = {}): SettingFact[] {
  const now = o.now ?? Date.now();
  const st = planStatus(plan, trial, now);
  const unused = Boolean(o.use && ownKeysOnly(o.use));
  const note = planNoteLines(plan, trial, o.use, now);
  const head: SettingFact = { label: "Plan", value: planHead(st) };
  switch (st.kind) {
    case "trial": {
      if (note.length) head.more = note;
      if (unused) return [head];
      head.warn = st.daysLeft !== null && st.daysLeft <= NEAR_END.days;
      return [head, { label: "Used", value: `${percent(st.usedShare)} of the trial`, warn: st.usedShare >= NEAR_END.used }];
    }
    case "pro": {
      head.warn = Boolean(st.cancelAt || st.paymentFailed);
      const more: string[] = [];
      if (st.paymentFailed) {
        const by = st.paymentFailed.graceEndsAt;
        more.push(by ? `Update your card in Manage billing before Pro stops on ${dayOf(by)}.` : "Update your card in Manage billing, or Pro stops soon.");
      }
      more.push(...note);
      if (more.length) head.more = more;
      const month = unused ? null : proMonth(st);
      return month ? [head, month] : [head];
    }
    case "ended":
      // Your own keys run the AI already: nothing to go on with.
      if (o.use && keysInUseFor(o.use).length) return [head];
      return [{ ...head, more: [...ADD_OWN_KEY_LINES, ...(sale() ? [`Or get ${NAME} Pro: ${COMMAND} upgrade`] : [])] }];
    case "none":
      return [head];
  }
}

/**
 * The plan in a few words, the same everywhere it's the row's value (Settings → Account's Plan, the
 * phone's `planText`): "Free trial · 5 days left", "Kiko Pro (monthly) · renews 3 Dec", "Kiko Pro
 * (yearly) · payment failed", "Trial ended on 10 Nov", "No plan".
 */
function planHead(st: PlanStatus): string {
  switch (st.kind) {
    case "trial":
      return `Free trial${st.daysLeft !== null ? ` · ${days(st.daysLeft)} left` : ""}`;
    case "pro":
      return st.paymentFailed ? `${proName(st)} · payment failed` : proHead(st);
    case "ended":
      return st.why === "cap" ? "Trial ended: its usage was used up" : st.endsAt ? `Trial ended on ${dayOf(st.endsAt)}` : "Trial ended";
    case "none":
      return "No plan";
  }
}

/**
 * What Kiko's AI runs on now, in words: the one place Settings → Account, `kiko account` and the
 * phone (`account`'s planText, planNote and keysText) take them from, so they never disagree.
 * `plan`: the plan in a few words (planHead), "Signed out", or null with accounts off. `planNote`:
 * with a plan in effect and your own keys in use, which one pays now (planNoteLines). `keys`: your
 * own keys in use (key-words.ts keysLine: "Your own OpenRouter key"); "None, so Kiko's AI is off"
 * with neither a key nor a plan; null when the plan runs it all. `phone`: the commands are the Mac's.
 */
export type AiWords = { plan: string | null; planNote: string[]; keys: string | null };

export function aiWords(view: { state: string; plan?: Plan | null; trial?: Trial | null } | null, use: AiUse, now = Date.now(), o: { phone?: boolean } = {}): AiWords {
  const signedIn = view?.state === "signed-in";
  const st: PlanStatus = signedIn ? planStatus(view.plan, view.trial, now) : { kind: "none" };
  const inEffect = st.kind === "trial" || st.kind === "pro";
  const keys = keysLine(use, st.kind === "pro" ? `${NAME} Pro` : "the free trial") ?? (inEffect ? null : NO_AI_KEYS);
  return {
    plan: !view ? null : signedIn ? planHead(st) : "Signed out",
    planNote: signedIn ? planNoteLines(view.plan, view.trial, use, now, o) : [],
    keys,
  };
}

/** How to go on without the plan, in Settings: the command on a line of its own. */
const ADD_OWN_KEY_LINES = ["To go on, add your own OpenRouter key (free):", `${COMMAND} keys set openrouter`];

/**
 * Pro's month, in a row: "31% used · this week 12%, on track"; past 80% (yellow), "85% used · this
 * week 40%, faster than usual"; past the allowance, "100% used · paused until 3 Dec" with how to go on.
 */
function proMonth(st: ProStatus): SettingFact | null {
  if (st.usedUp) {
    return {
      label: "This month",
      value: `${percent(st.usedShare ?? 1)} used · paused until ${st.resetsAt ? dayOf(st.resetsAt) : "next month"}`,
      warn: true,
      more: [`Your own OpenRouter key keeps ${NAME} going meanwhile:`, `${COMMAND} keys set openrouter`],
    };
  }
  const week = st.weekShare === null ? null : `this week ${percent(st.weekShare)}${st.pace === "fast" ? ", faster than usual" : st.pace === "on_track" ? ", on track" : ""}`;
  const value = [st.usedShare !== null ? `${percent(st.usedShare)} used` : null, week].filter(Boolean).join(" · ");
  return value ? { label: "This month", value, warn: st.near } : null;
}

/**
 * The window's short item while a trial runs the AI (ui/bar.ts, ui/classic.ts): "trial · 6d left",
 * or past 80% "trial · 85% used"; `warn` (yellow) near its end (NEAR_END). Pro only near its
 * month's cap: past 80%, "pro · 85% used" (yellow). Null otherwise: no plan, Pro under 80%, or a
 * key of your own (the plan isn't used then).
 */
export function planBadge(plan: Plan | null, o: { ownKey?: boolean; now?: number } = {}): { text: string; warn: boolean } | null {
  const st = planStatus(plan, null, o.now ?? Date.now());
  if (o.ownKey) return null;
  if (st.kind === "pro") return st.near && st.usedShare !== null ? { text: `pro · ${percent(st.usedShare)} used`, warn: true } : null;
  if (st.kind !== "trial") return null;
  if (st.near === "used") return { text: `trial · ${percent(st.usedShare)} used`, warn: true };
  return { text: st.daysLeft === null ? "trial" : `trial · ${st.daysLeft}d left`, warn: st.near === "days" };
}

/**
 * The Kiko window's key that opens the paste for your own OpenRouter key (Settings → Keys →
 * OpenRouter's hidden input, checked and kept in the Keychain) while the plan refuses (KeyOffer): in
 * the list, and in the Ctrl+Space menu. "e", as in Settings' "Enter a key…": never k (↑ in the
 * list), and plain said aloud ("press E"; an O is heard as a zero, and 0 picks Kiko's page).
 */
export const ADD_KEY_KEY = "e";

/** The refusals the window offers your own key for (ADD_KEY_KEY): the trial ended, or today's share of it used. */
export type KeyOfferWhy = "trial_ended" | "daily_cap";

/**
 * A notice's words where the Kiko window takes your key there and then (ADD_KEY_KEY): `line` shown,
 * `spoken` said, `phone` what the phone shows of what's said (the key is the Mac's: never "press E"
 * on its own); and until when it stands (`until`: today's share back; null, until a key is saved).
 */
export type KeyOffer = { why: KeyOfferWhy; until: number | null; line: string; spoken: string; phone: string };

/**
 * A notice: the line shown, and the shorter line spoken. `offer`: its words in the Kiko window, where
 * a key adds your own (`line` and `spoken` say the command, for where there's no window: --plain).
 */
export type Notice = { key: string; line: string; spoken: string; offer?: KeyOffer };

/** Why a call has nothing to run on (model-route.ts NoAiError): accounts closed, signed out, or no plan running. */
export type NoAiWhy = "no_accounts" | "signed_out" | "no_plan";

/** The line for a call with neither a key nor a plan, and how to get one: shown once a run. */
export function noAiLine(why: NoAiWhy): string {
  const key = `your own OpenRouter key (${COMMAND} keys set openrouter, or Settings → Keys)`;
  if (why === "no_accounts") return `${NAME}'s AI is off: it needs ${key}.`;
  if (why === "signed_out") return `${NAME}'s AI is off: no key, and you're signed out. Sign in for the free trial${sale() ? ` or ${NAME} Pro` : ""} (${COMMAND} login), or add ${key}.`;
  return `${NAME}'s AI is off: no key, and no plan running. ${sale() ? `Get ${NAME} Pro (${COMMAND} upgrade), or add` : "Add"} ${key}.`;
}

/** Said once your own key is saved while the offer stands (from it, or Settings → Keys). */
export const KEY_BACK_LINE = `Key saved. ${NAME}'s AI is back on your own key.`;

/** The window's line, how to add the key (ADD_KEY_KEY), and Settings → Keys beside it. */
const ADD_KEY_LINE = `Press ${ADD_KEY_KEY} in the list to add your own OpenRouter key (free; get one at openrouter.ai/keys), or Settings → Keys`;

/** Said: the key to press, and where (the list has the keys; a session's side would type it). */
const PRESS_IT = `press ${ADD_KEY_KEY.toUpperCase()} in the ${NAME} window's list`;

/**
 * The line for a proxy's refusal (API.md, "The AI proxy"), or null for one that isn't the plan's
 * (a bug, OpenRouter failing: said as any failed model call is). Each is said once a run.
 */
export function refusalNotice(code: string, o: { endedWhy?: string; resetsAt?: number | null } = {}): Notice | null {
  switch (code) {
    case "trial_ended": {
      const why = o.endedWhy === "cap" ? " (its usage is used up)" : "";
      return {
        key: "trial_ended",
        line: `Your free trial has ended${why}: ${NAME}'s AI calls are paused. To go on: ${COMMAND} keys set openrouter, your own key (free)${sale() ? `, or ${NAME} Pro: ${COMMAND} upgrade.` : `. ${NAME} Pro is coming.`}`,
        spoken: "Your free trial has ended. Add your own OpenRouter key to keep going.",
        offer: {
          why: "trial_ended",
          until: null,
          line: `Your free trial has ended${why}: ${NAME}'s AI is paused. ${ADD_KEY_LINE}.${sale() ? ` Or get ${NAME} Pro: ${COMMAND} upgrade.` : ` ${NAME} Pro is coming.`}`,
          spoken: `Your free trial has ended. To keep going, add your own OpenRouter key: ${PRESS_IT}.`,
          phone: `Your free trial has ended. Add your own OpenRouter key on your Mac: ${PRESS_IT}.`,
        },
      };
    }
    case "daily_cap": {
      const back = o.resetsAt ? ` It's back at ${clock(o.resetsAt)}.` : " It's back tomorrow.";
      const spoken = `Today's share of your free trial is used up.${back}`;
      return {
        key: "daily_cap",
        line: `Today's share of your free trial is used up: ${NAME}'s AI calls pause until it resets.${back} Or add your own key: ${COMMAND} keys set openrouter.`,
        spoken,
        // Your own key is optional here: offered on screen, the spoken line as it was.
        offer: {
          why: "daily_cap",
          until: o.resetsAt ?? null,
          line: `Today's share of your free trial is used up: ${NAME}'s AI calls pause until it resets.${back} Or press ${ADD_KEY_KEY} in the list to add your own OpenRouter key.`,
          spoken,
          phone: spoken,
        },
      };
    }
    case "trials_paused":
      return {
        key: "trials_paused",
        line: `Free trials are busy today: use your own OpenRouter key (${COMMAND} keys set openrouter), or try again tomorrow.`,
        spoken: "Free trials are busy today. Try again tomorrow, or use your own key.",
      };
    case "no_plan":
      return {
        key: "no_plan",
        line: `Your ${NAME} account has no plan right now, so its AI calls are off. Use your own OpenRouter key: ${COMMAND} keys set openrouter.`,
        spoken: "Your account has no plan right now. Add your own OpenRouter key to keep going.",
      };
    case "blocked":
      return {
        key: "blocked",
        line: `This ${NAME} account can't use ${NAME}'s AI. Your own OpenRouter key still works: ${COMMAND} keys set openrouter.`,
        spoken: "This account can't use Kiko's AI. Your own key still works.",
      };
    // Pro past its month's allowance: a stop until it renews (there's no cheaper model to fall back
    // on any more). Said once a period (the key carries its end); allowance_used is its old name.
    case "pro_quota_used":
    case "allowance_used": {
      const said = proUsedUpLine(o.resetsAt ?? null);
      return {
        key: `pro_quota_used${o.resetsAt ? `:${o.resetsAt}` : ""}`,
        line: `${said.replace(/ now\.$/, ` now (${COMMAND} keys set openrouter).`)}`,
        spoken: said,
      };
    }
    case "model_not_allowed":
      return {
        key: "model_not_allowed",
        line: `The model picked in Settings → Model isn't one the free trial offers: pick another there, or use your own key.`,
        spoken: "That model isn't in the free trial. Pick another in Settings.",
      };
    default:
      return null;
  }
}

/** The reminders, each once a trial, as the trial nears its end (NEAR_END): almost used up; two days (or one) left. */
export function reminderNotice(plan: Plan | null, now = Date.now()): Notice | null {
  const st = planStatus(plan, null, now);
  if (st.kind !== "trial" || !st.near) return null;
  // While Pro is on sale, how to get it, after the reminder (and only in these two).
  const pro = sale() ? ` ${UPGRADE_HINT}` : "";
  // Settings → Keys beside the command: where your own key goes in the app.
  if (st.near === "used")
    return {
      key: "almost_used",
      line: `Your free trial is almost used up (${percent(st.usedShare)}). Then: your own OpenRouter key (Settings → Keys, or ${COMMAND} keys set openrouter), free forever with no account.${pro}`,
      spoken: `Your trial is almost used up.${pro}`,
    };
  const which = st.daysLeft === 1 ? "One day" : "Two days";
  return { key: "two_days", line: `${which} left on your free trial (until ${when(st.endsAt!)}).${pro}`, spoken: `${which} left on your free trial.${pro}` };
}

/** How to get Kiko Pro, said after the trial's two reminders while it's on sale (and nowhere else unasked). */
export const UPGRADE_HINT = `Say 'upgrade' or run ${COMMAND} upgrade when you're ready.`;

/** "3 Dec", or "3 Nov 2027" when it isn't this year. */
const dayOrYear = (ms: number, now: number) =>
  new Date(ms).getFullYear() === new Date(now).getFullYear() ? dayOf(ms) : new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * What changed on Kiko Pro between two looks at the plan (before and after the billing page: `kiko
 * account billing` waits for it, and the app says it once): cancelled (it stays on to the period's
 * end), resumed, switched to yearly or monthly, or ended. Null when nothing that shows changed (the
 * card updated, say). `line` is written; `spoken`, said by the app (cancelled and resumed only).
 */
export function billingChange(
  before: { plan: Plan | null; trial: Trial | null },
  after: { plan: Plan | null; trial: Trial | null },
  now = Date.now(),
): { kind: "cancelled" | "resumed" | "interval" | "ended"; line: string; spoken: string | null } | null {
  const was = planStatus(before.plan, before.trial, now);
  if (was.kind !== "pro") return null;
  const is = planStatus(after.plan, after.trial, now);
  if (is.kind !== "pro") return { kind: "ended", line: `${NAME} Pro has ended.`, spoken: null };
  if (!was.cancelAt && is.cancelAt) {
    const said = `${NAME} Pro is cancelled. It stays on until ${dayOf(is.cancelAt)}.`;
    return { kind: "cancelled", line: `${said} Changed your mind? ${COMMAND} account billing`, spoken: said };
  }
  if (was.cancelAt && !is.cancelAt) {
    const said = is.renewsAt ? `${NAME} Pro renews again on ${dayOf(is.renewsAt)}.` : `${NAME} Pro renews again.`;
    return { kind: "resumed", line: said, spoken: said };
  }
  if (was.interval && is.interval && was.interval !== is.interval) {
    const renews = is.renewsAt ? ` Renews ${dayOrYear(is.renewsAt, now)}.` : "";
    return { kind: "interval", line: `${NAME} Pro is now ${is.interval === "year" ? "yearly" : "monthly"}.${renews}`, spoken: null };
  }
  return null;
}

/**
 * Looks at the plan again and again (the app: account.json each minute), and gives the change since
 * the look before (billingChange) once: the first look, and a signed-out one, only remember.
 */
export function billingWatcher(): (view: { state: string; plan?: Plan | null; trial?: Trial | null }, now?: number) => ReturnType<typeof billingChange> {
  let last: { plan: Plan | null; trial: Trial | null } | null = null;
  return (view, now = Date.now()) => {
    const before = last;
    last = view.state === "signed-in" ? { plan: view.plan ?? null, trial: view.trial ?? null } : null;
    return before && last ? billingChange(before, last, now) : null;
  };
}
