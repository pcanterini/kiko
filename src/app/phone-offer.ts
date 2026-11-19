// Settings → Phone → Pair a phone without Kiko Pro or the trial (core/account/phone-plan.ts): the
// offer's choice carried out, then straight into pairing (the QR code) with no step between. The
// same flows as `kiko setup`'s Free trial and `kiko upgrade`, on the pairing screen instead of a
// terminal:
//   - not signed in: the device code flow (Account.signIn), the page opened in the browser with the
//     code filled in, the code shown to check;
//   - "Start the free trial": POST /trial/start (Account.startTrial), refusals said in its words;
//   - "Kiko Pro, monthly / yearly": Stripe's checkout opened and the payment waited for
//     (upgrade-cli.ts followCheckout, Account.waitForPro).
// Esc (the pairing screen's close) stops it at any step; nothing is lost (a payment made after is
// picked up by the next check). Whatever happened, the plan is what counts: one that includes the
// phone by the end (Pro bought elsewhere, the trial running already) goes on to pairing.
import type { Account } from "../core/account/account.ts";
import { phoneIncluded } from "../core/account/phone-plan.ts";
import { trialRefusedLine, trialStartedLine } from "../core/account/plan-words.ts";
import type { PlanStep } from "../core/ui-store.ts";
import { followCheckout } from "../upgrade-cli.ts";

/** What the offer can be answered with. */
export type OfferPick = "trial" | "month" | "year";

export type OfferDeps = {
  account: Account;
  /** Opens a link in the browser: false when it couldn't. */
  open: (url: string) => Promise<boolean>;
  /** The pairing screen shows this step. */
  show: (step: PlanStep) => void;
  /** Phones paired with this Mac: the server is told after a sign-in, so the session never expires while one is. */
  phones: () => number;
  /** Esc on the pairing screen. */
  signal: AbortSignal;
  now?: () => number;
};

/** How it ended: the plan includes the phone now (go on to the QR code), or why not (null: stopped, nothing to say). */
export type OfferEnd = { ok: true } | { ok: false; said: string | null };

const included = (d: OfferDeps) => phoneIncluded(d.account.view(), { sale: true, now: d.now?.() });

export async function planForPhone(pick: OfferPick, d: OfferDeps): Promise<OfferEnd> {
  const a = d.account;
  const stop = (said: string | null): OfferEnd => (d.signal.aborted ? { ok: false, said: null } : included(d) ? { ok: true } : { ok: false, said });
  if (a.view().state !== "signed-in") {
    d.show({ phase: "plan", step: "sign-in", code: null });
    const r = await a.signIn({
      signal: d.signal,
      onCode: async (start) => {
        const url = start.verificationUriComplete ?? start.verificationUri;
        d.show({ phase: "plan", step: "sign-in", code: start.userCode, url, opened: await d.open(url) });
      },
    });
    if (!r.ok) return { ok: false, said: r.why === "cancelled" ? null : r.said };
    if (d.phones()) await a.syncPhone(true).catch(() => {});
  }
  if (d.signal.aborted) return { ok: false, said: null };
  // The plan as the server has it now: the trial running already, or Pro bought elsewhere, go on at once.
  await a.check().catch(() => null);
  if (included(d)) return { ok: true };
  if (pick === "trial") {
    d.show({ phase: "plan", step: "trial" });
    const t = await a.startTrial({ started: trialStartedLine, refused: trialRefusedLine });
    return stop(t.said);
  }
  let page: string | null = null;
  const end = await followCheckout(
    { account: a, open: d.open, signal: d.signal },
    pick,
    { browser: true },
    {
      opened: (url, ok) => d.show({ phase: "plan", step: "checkout", url: (page = url), opened: ok }),
      link: (url) => d.show({ phase: "plan", step: "checkout", url: (page = url), opened: false }),
      waiting: () => d.show({ phase: "plan", step: "waiting", url: page }),
      keys: () => () => {},
    },
  );
  if (end.ok) return { ok: true };
  return stop(end.why === "stopped" ? null : end.said);
}
