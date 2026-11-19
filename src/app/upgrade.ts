// "Upgrade to Pro" to the app, while Kiko Pro is on sale (core/decide.ts `upgrade`, routing-rules.ts
// asksUpgrade): `kiko upgrade`'s checkout (upgrade-cli.ts) without the terminal. Kiko says "Opening
// checkout in your browser.", opens Stripe's page, and waits for the payment in the background (the
// server asked every 3 s for up to 15 minutes, Account.waitForPro), then says once Pro is on. Not
// signed in: signing in is `kiko upgrade` (or `kiko login`) in a terminal, said so. On Pro already:
// where it's managed. Never the clipboard: the link is opened, nothing else.
import { appAccount } from "../core/account/app-account.ts";
import { planStatus } from "../core/account/plan-words.ts";
import { proOnSale } from "../core/env.ts";
import { log } from "../core/log.ts";
import { COMMAND, NAME } from "../core/name.ts";
import { ui } from "../core/ui-store.ts";
import { billingFailedLine, UPGRADE_WORDS } from "../upgrade-cli.ts";
import { openUrl, refreshPlan } from "./settings/account.ts";
import { refreshSettings } from "./settings-screen.ts";
import { speakLine } from "./speech.ts";

/** What the voice says for it (each also shown on the app's line). */
export const UPGRADE_SAID = {
  opening: "Opening checkout in your browser.",
  signIn: `Sign in first: run ${COMMAND} upgrade in a terminal.`,
  already: `You have ${NAME} Pro already. Manage it with ${COMMAND} account billing.`,
  alreadyOpened: `You have ${NAME} Pro already. I opened your billing page.`,
  notOnSale: UPGRADE_WORDS.notOnSale,
  noBrowser: `I couldn't open a browser. Run ${COMMAND} upgrade in a terminal.`,
};

/** The payment waited for now, if one is: a second "upgrade" opens the checkout again but waits once. */
let waiting: AbortController | null = null;

/** Says a line (and shows it). */
function say(line: string) {
  ui.info(`(${line})`);
  void speakLine(line);
}

/** "Upgrade to Pro": the checkout opened in the browser, and the payment waited for. */
export async function startCheckout(interval: "month" | "year") {
  const a = appAccount();
  if (!a || !proOnSale()) return say(UPGRADE_SAID.notOnSale);
  const view = a.view();
  if (view.state !== "signed-in") return say(UPGRADE_SAID.signIn);
  if (planStatus(view.plan, view.trial).kind === "pro") return say(UPGRADE_SAID.already);
  say(UPGRADE_SAID.opening);
  const page = await a.checkout(interval);
  log("upgrade_checkout", { by: "voice", interval, ok: page.ok, ...(page.ok ? {} : { why: page.why }) });
  if (!page.ok) {
    if (page.why === "signed-out") refreshPlan(a);
    // On Pro already (the server says so: bought elsewhere, or a payment failing): its billing page instead.
    if (page.why === "already-pro") {
      const portal = await a.portal();
      if (portal.ok && (await openUrl(portal.url))) return say(UPGRADE_SAID.alreadyOpened);
      return say(UPGRADE_SAID.already);
    }
    return say(billingFailedLine(page, "checkout"));
  }
  if (!(await openUrl(page.url))) return say(UPGRADE_SAID.noBrowser);
  waiting?.abort();
  const stop = new AbortController();
  waiting = stop;
  const r = await a.waitForPro({ signal: stop.signal });
  if (waiting === stop) waiting = null;
  log("upgrade_wait", { by: "voice", ended: r.ok ? "pro" : r.why });
  refreshPlan(a);
  refreshSettings();
  if (r.ok) say(UPGRADE_WORDS.on(r.plan).replace(/ Manage it any time: .*$/, ""));
}
