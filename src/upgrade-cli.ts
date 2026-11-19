// `kiko upgrade` and `kiko account billing` (src/cli.ts and account-cli.ts run them): buying Kiko Pro
// and managing it, both on Stripe's own pages in the browser (the account server answers the link:
// core/account/client.ts checkout, portal). `kiko upgrade` only while Kiko Pro is on sale (core/env.ts
// proOnSale; off, it says so in a line); `account billing` whenever accounts are open, as managing a
// subscription isn't buying one.
//
//   kiko upgrade [--no-browser]   in the style of `kiko login`, the plan asked as setup asks it
//   (ui/onboarding.ts askProPlan):
//     ◆  Which Kiko Pro plan?
//     │  Kiko's AI included · tax included
//     │  ● $8.99 a month
//     │  ○ $89 a year (about 2 months free)
//     └
//     Opening checkout in your browser… (Enter if it didn't open)
//     Waiting for payment… Esc to stop waiting (you can still pay; Kiko picks it up)
//     ✓ Kiko Pro is on. Renews 3 Dec. Manage it any time: kiko account billing
//   Not signed in: `kiko login`'s flow first (account-cli.ts signInHere). Pro already: points to
//   `kiko account billing`. Over SSH, without a terminal's browser, or --no-browser: the link printed
//   to open on any device. The server asked every 3 s for up to 15 minutes (Account.waitForPro).
//   Never the clipboard (Kiko's rule): the link is opened or printed, nothing else.
//   kiko account billing          Stripe's billing page (card, invoices, cancelling), opened; on Pro,
//     Waiting for changes… Esc to stop waiting
//     ✓ Kiko Pro is cancelled. It stays on until 3 Dec. Changed your mind? kiko account billing
//   (or "renews again on 3 Dec", "is now yearly. Renews 3 Nov 2027."; nothing changed: said quietly).
//
// Setup's "Kiko Pro" choice (ui/onboarding.ts) runs the same flow (followCheckout) in its own step.
// Nothing here prints a token.
import { SIGNED_OUT_LINE, type BillingFailed } from "./core/account/account.ts";
import type { Plan } from "./core/account/client.ts";
import { billingChange, dayOf, planStatus } from "./core/account/plan-words.ts";
import { COMMAND, DOMAIN, NAME, PRO_PRICE } from "./core/name.ts";
import { signInHere, type AccountDeps, type WaitKey } from "./account-cli.ts";
import { PLAIN } from "./ui/cli-style.ts";

/** What `kiko upgrade` works with besides the account commands' own: the real ones, or a test's. */
export type UpgradeDeps = AccountDeps & {
  /** Kiko Pro is on sale (core/env.ts proOnSale). */
  sale: boolean;
  /** The plan picked (ui/onboarding.ts askProPlan, setup's prompt): null on Esc or Ctrl+C, said there. */
  choosePlan: () => Promise<"month" | "year" | null>;
  keys: NonNullable<AccountDeps["keys"]>;
};

/** The two plans, as offered: monthly first. */
export const PRO_CHOICES: { interval: "month" | "year"; label: string }[] = [
  { interval: "month", label: PRO_PRICE.month },
  { interval: "year", label: `${PRO_PRICE.year} (${PRO_PRICE.yearSaves})` },
];

/** The words of the flow, shared by `kiko upgrade` and setup's step. */
export const UPGRADE_WORDS = {
  question: `Which ${NAME} Pro plan?`,
  under: `${NAME}'s AI included · ${PRO_PRICE.tax}`,
  opening: "Opening checkout in your browser… (Enter if it didn't open)",
  link: (url: string) => `Open this link to pay, on any device: ${url}`,
  failed: (url: string) => `Couldn't open a browser. Open this link to pay: ${url}`,
  waiting: `Waiting for payment… Esc to stop waiting (you can still pay; ${NAME} picks it up)`,
  on: (plan: Plan | null) => {
    const st = planStatus(plan, null);
    const renews = st.kind === "pro" && st.renewsAt ? ` Renews ${dayOf(st.renewsAt)}.` : "";
    return `${NAME} Pro is on.${renews} Manage it any time: ${COMMAND} account billing`;
  },
  stopped: `Stopped waiting. If you pay, ${NAME} picks it up: ${COMMAND} account shows the plan.`,
  timeout: `No payment yet after 15 minutes. If you pay, ${NAME} picks it up: ${COMMAND} account shows the plan.`,
  already: `You have ${NAME} Pro already. Manage it: ${COMMAND} account billing`,
  alreadyOpened: `You have ${NAME} Pro already: opened your billing page in the browser.`,
  notOnSale: `${NAME} Pro isn't on sale yet.`,
};

/** Why a billing call gave no page, in a line (`what`: checkout or the billing page). */
export function billingFailedLine(r: BillingFailed, what: "checkout" | "billing"): string {
  switch (r.why) {
    case "billing-unavailable":
      return UPGRADE_WORDS.notOnSale;
    case "already-pro":
      return UPGRADE_WORDS.already;
    case "no-billing":
      return `Nothing is billed on this account, so there's no billing to manage.`;
    case "signed-out":
      return SIGNED_OUT_LINE;
    case "not-signed-in":
      return `Not signed in on this Mac: ${COMMAND} login signs in first.`;
    case "keychain":
      return `The Keychain couldn't be read: ${r.detail ?? "it failed"}. Nothing changed.`;
    case "refused":
      return `${DOMAIN} turned the ${what === "checkout" ? "checkout" : "billing page"} down: ${r.detail ?? "refused"}. Nothing changed.`;
    default:
      return `Couldn't reach ${DOMAIN} (${r.detail ?? "offline?"}). Nothing changed.`;
  }
}

/** How the checkout shows itself: `kiko upgrade`'s lines, or setup's live step. followCheckout says what, and when. */
export type CheckoutUi = {
  /** The browser opened at the checkout (`ok`), or couldn't be; `again`: Enter asked for it once more. */
  opened(url: string, ok: boolean, again: boolean): void;
  /** No browser here (SSH, no terminal, --no-browser): the link, to open on any device. */
  link(url: string): void;
  /** Waiting for the payment now. */
  waiting(): void;
  /** Enter and Esc (and n, unused here) while it's waited for, until the returned stop. */
  keys(on: (key: WaitKey) => void): () => void;
};

export type CheckoutEnd = { ok: true; plan: Plan } | { ok: false; why: "stopped" | "timeout" | "signed-out" | "keychain" | BillingFailed["why"]; said: string };

/**
 * Kiko Pro's checkout opened (or its link shown), then the payment waited for until the plan is Pro,
 * Esc stops it, or 15 minutes pass. Enter opens the page again. Shared by `kiko upgrade` and setup.
 */
export async function followCheckout(
  d: { account: AccountDeps["account"]; open: (url: string) => Promise<boolean>; signal?: AbortSignal },
  interval: "month" | "year",
  o: { browser: boolean },
  ui: CheckoutUi,
): Promise<CheckoutEnd> {
  const page = await d.account.checkout(interval);
  // On Pro already (bought on another Mac, given, or a payment failing): the billing page instead (API.md).
  if (!page.ok && page.why === "already-pro") {
    const portal = await d.account.portal();
    if (portal.ok && o.browser && (await d.open(portal.url))) return { ok: false, why: "already-pro", said: UPGRADE_WORDS.alreadyOpened };
    if (portal.ok) return { ok: false, why: "already-pro", said: `You have ${NAME} Pro already. Manage it here: ${portal.url}` };
    return { ok: false, why: "already-pro", said: UPGRADE_WORDS.already };
  }
  if (!page.ok) return { ok: false, why: page.why, said: billingFailedLine(page, "checkout") };
  if (o.browser) ui.opened(page.url, await d.open(page.url), false);
  else ui.link(page.url);
  ui.waiting();
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  if (d.signal?.aborted) stop.abort();
  d.signal?.addEventListener("abort", onAbort, { once: true });
  const unlisten = ui.keys((key) => {
    if (key === "esc") return stop.abort();
    if (key === "enter" && o.browser) void d.open(page.url).then((ok) => ui.opened(page.url, ok, true));
  });
  try {
    const r = await d.account.waitForPro({ signal: stop.signal });
    if (r.ok) return r;
    if (r.why === "stopped") return { ok: false, why: "stopped", said: UPGRADE_WORDS.stopped };
    if (r.why === "timeout") return { ok: false, why: "timeout", said: UPGRADE_WORDS.timeout };
    if (r.why === "signed-out") return { ok: false, why: "signed-out", said: SIGNED_OUT_LINE };
    return { ok: false, why: "keychain", said: `The Keychain couldn't be read: ${r.detail ?? "it failed"}.` };
  } finally {
    unlisten();
    d.signal?.removeEventListener("abort", onAbort);
  }
}

function fail(d: AccountDeps, why: string) {
  d.out((d.style ?? PLAIN).error(`${COMMAND}: ${why}`));
  return 1;
}

/** `kiko upgrade [--no-browser]`. Returns the exit code. */
export async function upgradeCommand(args: readonly string[], d: UpgradeDeps): Promise<number> {
  const s = d.style ?? PLAIN;
  if (!d.live || !d.sale) {
    d.out(UPGRADE_WORDS.notOnSale);
    return 0;
  }
  const unknown = args.find((a) => a !== "--no-browser");
  if (unknown !== undefined) return fail(d, `upgrade takes only --no-browser (not ${unknown})`);
  const browser = !args.includes("--no-browser") && !d.remote && d.tty;
  let now = await d.account.check();
  if (now.state === "unknown") return fail(d, now.why);
  if (now.state === "signed-out") {
    // An account first: kiko login's own flow, here.
    d.out(s.dim(`${NAME} Pro is on your ${NAME} account: signing in first.`));
    const r = await signInHere(d, { browser: !args.includes("--no-browser") });
    if (!r.ok) {
      d.out(r.why === "cancelled" ? r.said : s.error(r.said));
      return 1;
    }
    if (d.phones().length) await d.account.syncPhone(true).catch(() => {});
    d.out(s.ok(r.email ? `Signed in as ${s.bold(r.email)}` : "Signed in"));
    now = await d.account.check();
    if (now.state !== "signed-in") return fail(d, now.state === "unknown" ? now.why : "signed out again");
  }
  if (!now.reached) return fail(d, `couldn't reach ${DOMAIN} (${now.why ?? "offline?"}). Nothing changed.`);
  if (planStatus(now.plan, now.trial).kind === "pro") {
    d.out(s.warn(UPGRADE_WORDS.already.replace(`${COMMAND} account billing`, s.bold(`${COMMAND} account billing`))));
    return 0;
  }
  if (!d.tty) return fail(d, `run ${COMMAND} upgrade in a terminal: it asks which plan first`);
  // Esc: none, said under the prompt itself (askProPlan).
  const interval = await d.choosePlan();
  if (interval === null) return 0;
  const end = await followCheckout(
    d,
    interval,
    { browser },
    {
      opened(url, ok, again) {
        if (ok && !again) return d.out(UPGRADE_WORDS.opening);
        if (!ok) d.out(s.warn(UPGRADE_WORDS.failed(url)));
      },
      link: (url) => d.out(UPGRADE_WORDS.link(url)),
      waiting: () => d.out(UPGRADE_WORDS.waiting),
      keys: d.keys,
    },
  );
  if (end.ok) {
    d.out(s.ok(UPGRADE_WORDS.on(end.plan).replace(`${COMMAND} account billing`, s.bold(`${COMMAND} account billing`))));
    return 0;
  }
  if (end.why === "stopped") {
    d.out(end.said);
    return 0;
  }
  if (end.why === "already-pro" || end.why === "billing-unavailable" || end.why === "timeout") {
    d.out(s.warn(end.said));
    return end.why === "already-pro" ? 0 : 1;
  }
  d.out(end.why === "signed-out" ? s.warn(end.said) : s.error(end.said));
  return 1;
}

/** `kiko account billing`'s own words. */
export const BILLING_WORDS = {
  opened: "Opened your billing page in the browser: the card, invoices and cancelling are there.",
  failed: (url: string) => `Couldn't open a browser. Open this link: ${url}`,
  link: (url: string) => `Open this link to manage billing, on any device: ${url}`,
  waiting: "Waiting for changes… Esc to stop waiting",
  unchanged: "Nothing changed on your plan.",
};

/**
 * `kiko account billing`: Stripe's billing page for the account, opened in the browser (or its link
 * shown), whenever accounts are open: managing a subscription isn't buying one, so PRO_ON_SALE off
 * still lets you cancel or see invoices. On Pro, the change made there is then waited for as `kiko
 * upgrade` waits for the payment (the server asked every 3 s for up to 15 minutes, against the plan
 * as it was when the page opened) and said: cancelled, renewing again, or switched to yearly or
 * monthly. Esc, or 15 minutes, with nothing changed (the card updated, say): said quietly.
 */
export async function billingCommand(args: readonly string[], d: AccountDeps): Promise<number> {
  const s = d.style ?? PLAIN;
  const unknown = args.find((a) => a !== "--no-browser");
  if (unknown !== undefined) return fail(d, `account billing takes only --no-browser (not ${unknown})`);
  const view = d.account.view();
  if (view.state !== "signed-in") {
    d.out(view.revoked ? s.warn(SIGNED_OUT_LINE) : `Not signed in. ${s.dim(`${COMMAND} login signs in first.`)}`);
    return view.revoked ? 1 : 0;
  }
  // The plan as it is as the page opens: what it changes is told against this.
  const now = await d.account.check();
  if (now.state === "signed-out") {
    d.out(s.warn(SIGNED_OUT_LINE));
    return 1;
  }
  const before = now.state === "signed-in" ? { plan: now.plan, trial: now.trial } : { plan: view.plan, trial: view.trial };
  const pro = planStatus(before.plan, before.trial).kind === "pro";
  const r = await d.account.portal();
  if (!r.ok) {
    if (r.why === "no-billing") {
      const none = d.sale ? `Nothing is billed on this account yet: ${s.bold(`${COMMAND} upgrade`)} starts ${NAME} Pro.` : billingFailedLine(r, "billing");
      d.out(s.warn(pro ? `Your ${NAME} Pro wasn't bought with a card here, so there's no billing to manage.` : none));
      return 0;
    }
    d.out(r.why === "billing-unavailable" || r.why === "signed-out" ? s.warn(billingFailedLine(r, "billing")) : s.error(billingFailedLine(r, "billing")));
    return 1;
  }
  if (!args.includes("--no-browser") && !d.remote && d.tty) d.out((await d.open(r.url)) ? s.ok(BILLING_WORDS.opened) : s.warn(BILLING_WORDS.failed(r.url)));
  else d.out(BILLING_WORDS.link(r.url));
  // Nothing on Pro to change (a subscription that ended: its invoices), or no terminal to stop it in: done.
  if (!pro || !d.tty || !d.keys) return 0;
  d.out(BILLING_WORDS.waiting);
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  if (d.signal?.aborted) stop.abort();
  d.signal?.addEventListener("abort", onAbort, { once: true });
  const unlisten = d.keys((key) => {
    if (key === "esc") stop.abort();
  });
  try {
    const end = await d.account.waitForPlan((plan, trial) => billingChange(before, { plan, trial }) !== null, { signal: stop.signal });
    if (end.ok) {
      const change = billingChange(before, end)!;
      const line = change.line.replace(`${COMMAND} account billing`, s.bold(`${COMMAND} account billing`));
      d.out(change.kind === "ended" ? s.warn(line) : s.ok(line));
      return 0;
    }
    if (end.why === "stopped" || end.why === "timeout") {
      d.out(s.dim(BILLING_WORDS.unchanged));
      return 0;
    }
    if (end.why === "signed-out") {
      d.out(s.warn(SIGNED_OUT_LINE));
      return 1;
    }
    d.out(s.error(`The Keychain couldn't be read: ${end.detail ?? "it failed"}.`));
    return 1;
  } finally {
    unlisten();
    d.signal?.removeEventListener("abort", onAbort);
  }
}

// ── The real ones ──────────────────────────────────────────────────────────

/** Enter, Esc and n from the terminal (raw, nothing echoed; Ctrl+C counts as Esc), until the returned stop. */
export function terminalKeys(on: (key: WaitKey) => void, input: NodeJS.ReadStream = process.stdin): () => void {
  if (!input.isTTY) return () => {};
  input.setRawMode(true);
  input.setEncoding("utf8");
  const onData = (chunk: string) => {
    if (chunk === "\u001b" || chunk.includes("\u0003")) on("esc");
    else if (chunk.includes("\r") || chunk.includes("\n")) on("enter");
    else if (chunk === "n" || chunk === "N") on("n");
  };
  input.on("data", onData);
  input.resume();
  return () => {
    input.off("data", onData);
    input.setRawMode(false);
    input.pause();
  };
}

export async function realUpgradeDeps(): Promise<UpgradeDeps> {
  const [{ realDeps }, { proOnSale }, { askProPlan }] = await Promise.all([import("./account-cli.ts"), import("./core/env.ts"), import("./ui/onboarding.ts")]);
  return { ...(await realDeps()), sale: proOnSale(), choosePlan: () => askProPlan({ input: process.stdin, output: process.stdout }), keys: (on) => terminalKeys(on) };
}
