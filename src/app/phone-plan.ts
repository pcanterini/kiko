// The iPhone app and the plan, in the running app (core/account/phone-plan.ts decides it): what the
// phone server asks at each connect, the Mac's once-a-day line when a paired phone was turned away,
// and the relay pass kept for the relay (fetched while the plan includes the phone, renewed with
// under 12 hours left and at once when the plan changes, shown to the relay: relay-client.ts setPass). All of it only while Kiko Pro is
// on sale (core/env.ts proOnSale): off, every phone gets in and no pass is asked for, as before.
import { appAccount } from "../core/account/app-account.ts";
import { PHONE_WORDS, phoneIncluded, phonePlan, type PhonePlan, type PlanReason } from "../core/account/phone-plan.ts";
import { proOnSale } from "../core/env.ts";
import { log } from "../core/log.ts";
import { ui } from "../core/ui-store.ts";
import { speakLine } from "./speech.ts";

const DAY = 86_400_000;
/** The relay pass is looked at this often (it's fetched only with under 12 hours left, or the plan changed: Account.relayPass). */
export const PASS_LOOK_MS = 60 * 60_000;
/** A refused phone asks the server for the plan again, at most this often (a payment just made). */
const RECHECK_MS = 60_000;

/** Whether the plan includes the phone now (always while Pro isn't on sale). */
export function phoneIncludedNow(now = Date.now()): boolean {
  const sale = proOnSale();
  if (!sale) return true;
  return phoneIncluded(appAccount()?.view() ?? null, { sale, now });
}

/** The phone server's connect check: null while Pro isn't on sale (every phone gets in). */
export function phonePlanNow(now = Date.now()): PhonePlan | null {
  if (!proOnSale()) return null;
  const a = appAccount();
  return phonePlan(a?.view() ?? null, { sale: true, now, trialSaid: a?.trialAvailableSaid() ?? null });
}

/** Whether the free trial could still start, for the offer (Settings → Phone → Pair a phone). */
export function trialOfferable(): boolean {
  const plan = phonePlanNow();
  return plan ? !plan.ok && plan.trialAvailable : false;
}

let recheckedAt = 0;

/**
 * A paired phone was turned away (at home, or the relay said so): said once a day at most, out loud
 * and on screen, by why ("Your phone can't connect: this Mac is signed out of Kiko. Press Enter to
 * sign in.", "Your phone tried to connect…"), kept in account.json so a restart doesn't say it again
 * (signed out, there's none: this run's). Signed out, in the window, its popup asks too (`ask`):
 * Enter signs in (app/mac-sign-in.ts). The server asked for the plan again (once a minute at most),
 * in case it was just bought: the phone's next try gets in.
 */
export function phoneRefused(trialAvailable: boolean, o: { reason?: PlanReason; now?: number; say?: (line: string) => void; recheck?: () => void; ask?: () => boolean } = {}) {
  const reason = o.reason ?? "no_plan";
  const now = o.now ?? Date.now();
  const a = appAccount();
  if (a && now - recheckedAt >= RECHECK_MS && a.view().state === "signed-in") {
    recheckedAt = now;
    (o.recheck ?? (() => void a.check().catch(() => {})))();
  }
  // Each reason once a day: signed out, then signed in with no plan, is said again.
  const key = reason === "mac_signed_out" ? "phone-refused-signed-out" : "phone-refused";
  const last = a?.lastSaid(key) ?? lastSaidHere.get(key) ?? null;
  if (last !== null && now - last < DAY) return;
  lastSaidHere.set(key, now);
  a?.noteSaid(key, now);
  // Signed out: Enter signs in where the window can ask (its popup), else where to sign in.
  const asked = reason === "mac_signed_out" ? (o.ask ?? askSignIn)() : false;
  const line = PHONE_WORDS.refused(trialAvailable, reason, { enter: reason === "mac_signed_out" ? asked : undefined });
  log("phone_plan_said", { trialAvailable, reason });
  (o.say ?? sayIt)(line);
}

/** Signed out, there's no account.json to keep it in: this run's, by line. */
const lastSaidHere = new Map<string, number>();

/** The window's popup for signing in (ui/window-glue.ts): asked when there's a window to show it in. */
function askSignIn(): boolean {
  const w = ui.state.window;
  if (!w) return false;
  ui.set({ window: { ...w, signInAsk: `sign-in-${Date.now()}` } });
  return true;
}

function sayIt(line: string) {
  ui.info(`(${line})`);
  void speakLine(line);
}

/** The tests' own start: nothing said yet. */
export function resetPhonePlanForTests() {
  lastSaidHere.clear();
  recheckedAt = 0;
}

/**
 * Keeps the relay's pass while the relay is on, for `room` (the relay room this Mac signs in to: the
 * pass names it, so a new room, after a new relay identity, gets a new pass): asked now and each
 * PASS_LOOK_MS, and at once when the plan as known changes (the account's onPlanChange) or `kick` is
 * called. Shown to the relay with `show` (null: none). plan_required logs once, until a pass comes
 * again. Returns the stop.
 */
export function keepRelayPass(
  room: string,
  show: (pass: string | null) => void,
  o: { lookMs?: number; account?: () => ReturnType<typeof appAccount>; onSale?: () => boolean } = {},
): { stop(): void; kick(): void } {
  const accountOf = o.account ?? appAccount;
  const onSale = o.onSale ?? proOnSale;
  let refusedLogged = false;
  let stopped = false;
  let running = false;
  /** Asked for while a look was under way (the plan changed meanwhile): looked at again after it. */
  let again = false;
  const look = async () => {
    if (stopped || !onSale()) return;
    if (running) {
      again = true;
      return;
    }
    const a = accountOf();
    if (!a) return;
    // The server asked even when the plan as last known doesn't include the phone: it may have just been bought.
    running = true;
    again = false;
    try {
      const r = await a.relayPass(room);
      if (stopped) return;
      if (r.ok) {
        refusedLogged = false;
        return show(r.pass);
      }
      if (r.why === "plan-required") {
        if (!refusedLogged) log("relay_pass", { got: false, why: "plan_required", trialAvailable: r.trialAvailable });
        refusedLogged = true;
        return show(null);
      }
      log("relay_pass", { got: false, why: r.why });
    } catch (err) {
      log("relay_pass", { got: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
      if (again && !stopped) void look();
    }
  };
  void look();
  const timer = setInterval(() => void look(), o.lookMs ?? PASS_LOOK_MS);
  timer.unref();
  // A plan heard of (a check, a trial started, Pro bought or ended): a pass asked for under it at once.
  const unlisten = accountOf()?.onPlanChange(() => void look());
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      unlisten?.();
    },
    kick: () => void look(),
  };
}
