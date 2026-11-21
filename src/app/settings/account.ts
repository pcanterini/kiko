// Settings → Account (core/account/): who's signed in, signing in and signing out, only while
// accounts are open (core/env.ts accountsLive). Signing in is `kiko login`'s flow (followCode) in the
// pane: the code, Open the browser (Enter), the approval waited for (Esc stops it), then "✓ Signed in
// as …" over the signed-in rows. While the code shows, Copy the code puts it on the clipboard (the
// window takes the mouse, so it can't be selected there): the one copy Kiko makes, and only when
// picked (core/copy.ts).
// With a phone paired, signing out asks first, saying what it does: other Macs stay signed in, and
// the phone loses access away from home (at home it keeps working), or, while Kiko Pro is on sale
// and the phone needs the plan, until this Mac signs in again (settings-options.ts signOutWords).
//
// And, signed in, the session kept alive: asked at start and twice a day (it slides with each use,
// so an active Mac is never signed out for being idle). Whether a phone is paired is told to the
// server (at start, and as one is paired or the last one forgotten), so the session never expires
// while one is: in the background, never in pairing's way, tried again until it's through. Offline
// or the server down: nothing changes. Signed out on the server (the account page, the account
// deleted): said once, in a line.
//
// The plan, shown: label and value rows in the row's pane (settings-options.ts accountFacts, from
// plan-words.ts planFacts: "Plan  Free trial · 6 days left", "Used  3% of the trial", or plainly that
// your own key runs the AI instead), and while the trial runs the AI a short item on the window's
// line (planBadge: "trial · 6d left", yellow near its end). Both from account.json, looked at each
// minute (the share used follows the proxy's answers: model-route.ts); the server asked again every
// PLAN_CHECK_MS while a plan runs the AI. In the background, never in the UI's way.
//
// Kiko Pro: "Plan  Kiko Pro · renews 3 Dec" (or "ends 3 Dec" once cancelled, or the payment that
// failed), and "This month  31% used · this week 12%, on track"; Manage billing opens Stripe's
// billing page in the browser (whenever accounts are open: managing isn't buying, so PRO_ON_SALE
// doesn't hide it). With your own key set, Pro still shows, with why it isn't used under it. And Pro
// bought by voice ("upgrade": startCheckout) is waited for here, then said once it's on; Pro
// cancelled or resumed (the billing page, `kiko account billing` or another Mac: account.json,
// looked at each minute) is said once, out loud.
import { execFile } from "node:child_process";
import { type Account, type AccountView, SIGNED_OUT_LINE, type AccountRow, type SignIn, type SignInShown, type SigningPhase } from "../../core/account/account.ts";
import { followCode, overSsh } from "../../account-cli.ts";
import { accountsLive, phoneLive } from "../../core/env.ts";
import { appAccount } from "../../core/account/app-account.ts";
import { billingWatcher, planActive, planBadge, planStatus, refusalNotice, reminderNotice } from "../../core/account/plan-words.ts";
import { keyOf } from "../../core/key-values.ts";
import { aiUseNow } from "../../core/config.ts";
import { copyText } from "../../core/copy.ts";
import { log } from "../../core/log.ts";
import { modelCalls } from "../../core/model-route.ts";
import { COMMAND, DOMAIN, NAME } from "../../core/name.ts";
import { accountFacts, signOutWords } from "../../core/settings-options.ts";
import { ui, type SettingRow } from "../../core/ui-store.ts";
import { refreshSettings } from "../settings-screen.ts";
import { pairing } from "../state.ts";
import { macSignIn, useSignInAccount } from "../mac-sign-in.ts";

/** How often a signed-in Mac asks the server, besides at start. */
const CHECK_MS = 12 * 60 * 60_000;
/** How soon a phone's pairing the server didn't hear of is told again. */
const PHONE_RETRY_MS = 15 * 60_000;

/** How often the plan's item and line are looked at again (account.json: no server). */
const PLAN_LOOK_MS = 60_000;
/** How often the server is asked while a plan runs the AI, for its share used and its end. */
export const PLAN_CHECK_MS = 5 * 60_000;

/** An OpenRouter key of your own: it runs the AI, and the plan isn't used. */
const ownKey = () => Boolean(keyOf("OPENROUTER_API_KEY"));

/** The window's item for the plan, from where the account stands (account.json): null for none (signed out, or no plan or trial on record). */
export function planItem(view: AccountView, o: { ownKey: boolean; now?: number }): { text: string; warn: boolean } | null {
  if (view.state !== "signed-in" || (!view.plan && !view.trial)) return null;
  return planBadge(view.plan, o);
}

/**
 * Pro cancelled or resumed since the last look (account.json, which `kiko account billing`'s wait
 * and the app's checks keep up to date): said once, out loud, as the voice's "Kiko Pro is on" is
 * (plan-words.ts billingWatcher; the first look only remembers).
 */
const billingLook = billingWatcher();

/** Shown on the app's line and said (app/speech.ts), as app/upgrade.ts says its lines. */
function sayAloud(line: string) {
  ui.info(`(${line})`);
  void import("../speech.ts").then((m) => m.speakLine(line)).catch(() => {});
}

/** The window's item brought up to date (only when it changed: each change redraws the line). */
export function refreshPlan(a: Account | null = theAccount(), now = Date.now()) {
  const change = a ? billingLook(a.view(), now) : null;
  if (change?.spoken) {
    log("account_billing_change", { kind: change.kind });
    sayAloud(change.spoken);
  }
  const badge = a ? planItem(a.view(), { ownKey: ownKey(), now }) : null;
  const was = ui.state.plan ?? null;
  if (was?.text === badge?.text && was?.warn === badge?.warn) return;
  ui.set({ plan: badge });
}

/** Sign out picked with a phone paired: the row asks "sign out anyway?" until answered or settings close. */
let confirming = false;

/** The tests' own account (a fake server's, a key store in memory): undefined for the app's one. */
let testAccount: Account | null | undefined;

/** The account, while accounts are open (the app's one: core/account/app-account.ts); null otherwise. */
const theAccount = (): Account | null => (testAccount !== undefined && accountsLive() ? testAccount : appAccount());

/** The tests' own account (undefined: the app's one again). */
export function useAccount(a: Account | null | undefined) {
  testAccount = a;
  useSignInAccount(a);
}

/**
 * Enter on the window's popup ("Your phone can't connect: this Mac is signed out of Kiko. Press
 * Enter to sign in."): Settings → Kiko account, and its Sign in started there (the phone's code, if
 * one is out: they're one sign-in). Signed in already: said, nothing opened.
 */
export function signInFromPrompt() {
  const a = theAccount();
  if (!a) return;
  if (a.view().state === "signed-in") return ui.info("(Signed in already: your phone connects again by itself.)");
  log("mac_sign_in_asked", { where: "prompt" });
  ui.act({ type: "settings", at: "account" });
  void signIn(a);
}

/**
 * Sign in, under way in the pane (`kiko login`'s device code flow, account-cli.ts followCode): what
 * it shows (core/account/account.ts SignInShown), the wait it can stop, and, while its code is
 * shown, what Open the browser (Enter) answers. Kept after it ends (signed in, or why not) until
 * settings close.
 */
let signing: { shown: SignInShown; stop: AbortController; enter: ((go: boolean) => void) | null; copied?: boolean } | null = null;

/** Where the pane's sign-in is, for the row (null: none, or ended). */
const signingPhase = (): SigningPhase | undefined => {
  const p = signing?.shown.phase;
  return p === "starting" || p === "code" || p === "waiting" ? p : undefined;
};

/** Settings → Account: none while accounts aren't open. */
export function accountRows(): SettingRow[] {
  const a = theAccount();
  if (!a) return [];
  const view = a.view();
  const signedIn = view.state === "signed-in";
  // No phone while the iPhone app isn't out (core/env.ts phoneLive): signing out never asks about one.
  const phones = phoneLive() ? pairing.list().length : 0;
  const pro = view.state === "signed-in" && planStatus(view.plan, view.trial).kind === "pro";
  const phase = signingPhase();
  const raw: AccountRow = { signedIn, confirming: signedIn && confirming, phones, ...(pro ? { billing: true } : {}), ...(phase ? { signing: phase } : {}) };
  const value = view.state === "signed-in" ? (view.email ?? "Signed in") : view.revoked ? `Signed out on ${DOMAIN}` : "Not signed in";
  // Its pane: who's signed in and the plan as last known (the trial's days and share used, Pro's
  // month, ended), your own keys in use and which one pays (config.ts aiUseNow: what runs now), or
  // what signing out does while it asks.
  const facts = accountFacts(view, { use: aiUseNow(), confirming: raw.confirming, signIn: signing?.shown, copied: signing?.copied });
  return [{ key: "account", label: `${NAME} account`, raw: JSON.stringify(raw), value, restart: false, facts }];
}

/**
 * Settings closed: a sign-out waiting for its "anyway" is let go, and so is a sign-in whose code
 * was never opened; one waiting for the approval goes on, and says when it's through. What a
 * sign-in that ended said is gone.
 */
export function forgetAccountConfirm() {
  confirming = false;
  if (!signing) return;
  if (signing.shown.phase === "starting" || signing.shown.phase === "code") stopSignIn();
  else if (signing.shown.phase === "done" || signing.shown.phase === "failed") signing = null;
}

/** The pane's sign-in stopped (Stop, Esc, settings closed before the browser opened): nothing changes. */
function stopSignIn() {
  if (!signing) return;
  signing.stop.abort();
  signing.enter?.(false);
  signing.enter = null;
}

/** The pane's sign-in moved on: shown, if it's still the one under way. */
function show(run: NonNullable<typeof signing>, shown: SignInShown) {
  if (signing !== run) return;
  run.shown = shown;
  refreshSettings();
}

/**
 * Sign in, from Settings → Account: `kiko login`'s flow (account-cli.ts followCode), in the pane.
 * Its code first, then Open the browser (Enter) opens the page it's typed at, never a link with the
 * code in it; over SSH the link shown, to open on any device. Then the approval waited for (Esc
 * stops it). Through: "✓ Signed in as …" over the signed-in rows, the plan asked for, a phone
 * paired told; not: why, in yellow, and nothing changed.
 */
async function signIn(a: Account) {
  if (signingPhase()) return;
  const run: NonNullable<typeof signing> = { shown: { phase: "starting" }, stop: new AbortController(), enter: null };
  signing = run;
  refreshSettings();
  log("settings_sign_in", {});
  // The Mac's one sign-in (core/account/mac-sign-in.ts): a phone's code, if one is out, is this one too.
  const r = await macSignIn
    .follow({
      signal: run.stop.signal,
      onCode: (start) =>
        followCode(
          start,
          { browser: !overSsh(), open: openUrl },
          {
            code: (code) => show(run, { phase: "code", code, url: start.verificationUri }),
            link: (url) => show(run, { phase: "waiting", code: start.userCode, url, opened: false, link: true }),
            enter: () => (run.stop.signal.aborted ? Promise.resolve(false) : new Promise<boolean>((resolve) => (run.enter = resolve))),
            opened: (url, ok) => show(run, { phase: "waiting", code: start.userCode, url, opened: ok }),
          },
        ),
    })
    .catch((err): SignIn => ({ ok: false, why: "unreachable", said: `Couldn't sign in: ${err instanceof Error ? err.message : String(err)}` }));
  if (signing !== run) return;
  if (!r.ok) {
    // Stopped by you: nothing to say but that nothing changed.
    if (r.why === "cancelled") signing = null;
    else run.shown = { phase: "failed", said: r.said };
    ui.info(`(${r.said})`);
    return refreshSettings();
  }
  run.shown = { phase: "done", email: r.email };
  ui.info(`(Signed in as ${r.email ?? `${NAME}'s account`}.)`);
  refreshPlan(a);
  refreshSettings();
  // A phone paired already: told (best-effort, as kiko login does); then the plan, asked now.
  if (pairing.list().length) await a.syncPhone(true).catch(() => {});
  await a.check().catch(() => {});
  refreshPlan(a);
  refreshSettings();
}

/** How the code is copied: core/copy.ts (the clipboard), or the tests' own (nothing reaches it then). */
let copier = (text: string) => copyText(text);

/** The tests' own copier. */
export function setCopyText(copy: (text: string) => Promise<boolean>) {
  copier = copy;
}

/**
 * Copy the code, picked while the sign-in's code shows: exactly the code copied, then "✓ Code
 * copied" (or that it couldn't be) in the pane; the sign-in goes on waiting either way.
 */
async function copyCode() {
  const run = signing;
  const shown = run?.shown;
  if (!run || (shown?.phase !== "code" && shown?.phase !== "waiting")) return;
  const ok = await copier(shown.code).catch(() => false);
  log("settings_sign_in_copy", { ok });
  if (signing !== run) return;
  run.copied = ok;
  refreshSettings();
}

/**
 * What Settings → Account was asked: sign in (and, while its code shows, open the browser, copy the
 * code, or stop), sign out (asking first with a phone paired), manage billing, or leave it.
 */
export function accountAction(value: string) {
  const a = theAccount();
  if (!a) return;
  if (value === "signin") return void signIn(a);
  if (value === "open") {
    signing?.enter?.(true);
    if (signing) signing.enter = null;
    return;
  }
  if (value === "copy") return void copyCode();
  if (value === "stop") return stopSignIn();
  // Anything else: what a sign-in that ended said is gone.
  if (signing && !signingPhase()) signing = null;
  if (value === "signout" && phoneLive() && pairing.list().length && !confirming) {
    confirming = true;
    ui.info(`(Sign out on this Mac? ${signOutWords()} Sign out anyway, under Account.)`);
    return refreshSettings();
  }
  confirming = false;
  if (value === "billing") return void openBilling(a);
  if (value !== "signout") return refreshSettings();
  ui.info("(Signing out…)");
  void a.signOut().then(
    (r) => {
      if (r.kept) ui.info(`(Couldn't take the sign-in out of the Keychain: ${r.kept}. Still signed in.)`);
      else if (r.server === "unreachable") ui.info(`(Signed out on this Mac. ${DOMAIN} couldn't be reached: its session there ends by itself, or from the account page.)`);
      else ui.info("(Signed out on this Mac.)");
      refreshPlan(a);
      refreshSettings();
    },
    (err) => ui.error("account", err),
  );
}

/** How a link is opened: macOS `open`, or the tests' own (nothing reaches a browser then). */
let opener = (url: string) => new Promise<boolean>((resolve) => execFile("open", [url], { timeout: 10_000 }, (err) => resolve(!err)));

/** Opens a link in the browser (Manage billing, the voice's "upgrade"): true once it's handed over. Never the clipboard. */
export const openUrl = (url: string) => opener(url);

/** The tests' own opener. */
export function setOpenUrl(open: (url: string) => Promise<boolean>) {
  opener = open;
}

/** Manage billing: Stripe's billing page for the account, asked of the server and opened in the browser. */
async function openBilling(a: Account) {
  ui.info("(Opening your billing page…)");
  const r = await a.portal().catch((err) => ({ ok: false as const, why: "unreachable" as const, detail: err instanceof Error ? err.message : String(err) }));
  if (r.ok) {
    ui.info((await openUrl(r.url)) ? "(Opened your billing page in the browser.)" : `(Couldn't open a browser: run ${COMMAND} account billing in a terminal.)`);
    return refreshSettings();
  }
  const { billingFailedLine } = await import("../../upgrade-cli.ts");
  ui.info(`(${billingFailedLine(r, "billing")})`);
  if (r.why === "signed-out") refreshPlan(a);
  refreshSettings();
}

/** Signed out on the server, seen by any call: said once, and the row shows it. */
function saidSignedOut() {
  ui.info(`(${SIGNED_OUT_LINE})`);
  refreshPlan();
  refreshSettings();
}

let phoneRetry: NodeJS.Timeout | null = null;

/** Whether a phone is paired, told to the server if it doesn't know (`force`: told all the same); not through, tried again later. */
async function tellPhone(a: Account, force = false) {
  if (phoneRetry) clearTimeout(phoneRetry);
  phoneRetry = null;
  const r = await a.syncPhone(pairing.list().length > 0, force).catch(() => "pending" as const);
  if (r === "signed-out") return saidSignedOut();
  if (r === "pending") {
    phoneRetry = setTimeout(() => void tellPhone(a), PHONE_RETRY_MS);
    phoneRetry.unref();
  }
}

/**
 * Asked once now, then twice a day, while signed in (accounts open); and the phones paired told to
 * the server, now and as they change. Never signs out but for the server saying so.
 */
export function startAccountCheck() {
  const a = theAccount();
  if (!a) return;
  const check = async (first: boolean) => {
    if (a.view().state !== "signed-in") return;
    const r = await a.check();
    log("account_check", { state: r.state, ...(r.state === "signed-in" ? { reached: r.reached } : {}) });
    if (r.state === "signed-out" && r.revoked) return saidSignedOut();
    // The trial's reminders (two days left, almost used up), each said once a trial.
    if (r.state === "signed-in" && planActive(r.plan)) modelCalls.notice(reminderNotice(r.plan), a);
    // Pro past its month's allowance with no key of your own (the app started on it, no key asked):
    // said once that period, as the proxy's refusal would say it.
    const st = r.state === "signed-in" ? planStatus(r.plan, r.trial) : null;
    if (st?.kind === "pro" && st.usedUp && !ownKey()) modelCalls.notice(refusalNotice("pro_quota_used", { resetsAt: st.resetsAt }), a);
    // Once at start with phones paired, then whenever the server's idea of it differs from the Mac's.
    await tellPhone(a, first && pairing.list().length > 0);
    refreshSettings();
  };
  let checking = false;
  const quietly = (first: boolean) => {
    if (checking) return;
    checking = true;
    void check(first)
      .catch((err) => log("account_check", { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        checking = false;
        refreshPlan(a);
      });
  };
  refreshPlan(a);
  setTimeout(() => quietly(true), 5_000).unref();
  setInterval(() => quietly(false), CHECK_MS).unref();
  // The plan's item each minute (days left, the share the proxy said); the server each few minutes while a plan runs the AI.
  let lastPlanCheck = Date.now();
  setInterval(() => {
    refreshPlan(a);
    const v = a.view();
    if (v.state !== "signed-in" || !planActive(v.plan) || ownKey() || Date.now() - lastPlanCheck < PLAN_CHECK_MS) return;
    lastPlanCheck = Date.now();
    quietly(false);
  }, PLAN_LOOK_MS).unref();
  // A phone paired, or the last one forgotten: told in the background (pairing never waits for it).
  pairing.onPhonesChange = () => {
    if (a.view().state === "signed-in") void tellPhone(a);
  };
}
