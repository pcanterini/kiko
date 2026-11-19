// `kiko login`, `kiko logout` and `kiko account` (src/cli.ts runs them): this Mac's Kiko account
// (core/account/). While accounts aren't open (core/env.ts accountsLive), each says so in a line.
//   kiko login [--no-browser]   the device code flow, as `gh auth login --web` runs it (cli/cli
//                                internal/authflow/flow.go, pkg/cmd/auth/shared/login_flow.go):
//                                the one-time code shown first, then Enter opens the approval page's plain link, where you type
//                                the code: never the link with the code in it, so a link someone
//                                sends you can't sign their Mac in to your account. No terminal,
//                                over SSH, or --no-browser: the link printed instead, to open on
//                                any device. Then waited for (in a terminal: n a new code, Esc
//                                stops), a code that runs out replaced and the server's outages
//                                waited out, up to 30 minutes (Account.signIn's patient). Setup's
//                                sign-in (ui/onboarding.ts) runs the same flow (followCode)
//   kiko logout                signs this Mac out (asking first when a phone is paired: it loses
//                                access away from home)
//   kiko account               who's signed in, and the plan: the free trial's days left and the
//                                share of its usage used, Pro's share of this month, or none
//   kiko account delete        deletes the account (API.md's two steps): what goes said first (with
//                                a paid Kiko Pro that renews: it ends now, with no refund, and
//                                cancelling instead keeps it to the period's end) and asked, then a
//                                6-digit code from its email, then done; this Mac's token and
//                                account.json go with it
//   kiko account billing       Kiko Pro's billing page (Stripe's), opened in the browser, then the
//                                change made there waited for and said (./upgrade-cli.ts). There
//                                whenever accounts are: PRO_ON_SALE hides only ways to buy
// Nothing here prints a token. Like the rest of cli.ts, nothing loads .env into the environment or
// writes logs; a checkout's KIKO_ACCOUNTS in .env counts all the same (core/dev-env.ts).
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { Account, NewCode, NOT_OPEN_LINE, type Renewed, SIGNED_OUT_LINE, type SignIn } from "./core/account/account.ts";
import { accountClient, type DeviceStart, type Plan, type Trial } from "./core/account/client.ts";
import { planDetail, planLine, planRunsAi, planStatus, proPausedLine, trialRefusedLine, trialStartedLine } from "./core/account/plan-words.ts";
import { accountsLive, accountUrl, phoneLive, proOnSale } from "./core/env.ts";
import { ACCOUNT_SITE, COMMAND, DOMAIN, NAME } from "./core/name.ts";
import { SETTINGS_FILE } from "./core/settings.ts";
import { agreeLine } from "./core/terms.ts";
import { andList } from "./core/text.ts";
import { PLAIN, styleFor, type Style } from "./ui/cli-style.ts";
import type { SetupDeps } from "./ui/onboarding.ts";

/** The keys read while something is waited for (upgrade-cli.ts terminalKeys): `n` is the sign-in's new code. */
export type WaitKey = "enter" | "esc" | "n";

/** What these commands work with: the real ones (realDeps), or a test's. */
export type AccountDeps = {
  /** Accounts are open (core/env.ts accountsLive). */
  live: boolean;
  account: Account;
  out: (line: string) => void;
  /** y/N; false without a terminal. */
  confirm: (question: string) => Promise<boolean>;
  /** A line typed in answer (`question` written first, no newline); null without a terminal or when the input ends. */
  ask: (question: string) => Promise<string | null>;
  /** There's a terminal to ask in (stdin and stdout both one, as gh's CanPrompt). */
  tty: boolean;
  /** Opens `url` in the browser: false when it couldn't. */
  open: (url: string) => Promise<boolean>;
  /** `prompt` written (no newline), then Enter waited for: true on Enter (or the input ending), false when `signal` stopped it. */
  waitForEnter: (prompt: string, signal?: AbortSignal) => Promise<boolean>;
  /** How lines are styled (ui/cli-style.ts): stdout's; PLAIN when not given. */
  style?: Style;
  /** An SSH session: the browser would open on the other Mac, so the link is printed instead. */
  remote: boolean;
  /** The phones paired with this Mac, by name. */
  phones: () => string[];
  /** Ctrl+C: stops waiting for the approval. */
  signal?: AbortSignal;
  /** Kiko Pro is on sale (core/env.ts proOnSale): the lines point to `kiko upgrade`. Managing it (`account billing`) is there either way. */
  sale?: boolean;
  /** Enter, Esc (Ctrl+C counts as Esc) and n while something is waited for, to `on`, until the returned stop; none: nothing waited for. */
  keys?: (on: (key: WaitKey) => void) => () => void;
  /** Your own OpenRouter key is set (the environment, .env or the Keychain): it runs the AI, not the plan. */
  ownKey?: boolean;
};

/** When a session started, as said: "3 Nov 2026". */
const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** The line once signed in, after "✓ Authentication complete." (gh: "✓ Logged in as <user>"). */
export const signedInLine = (email: string | null, s: Style = PLAIN) => (email ? `Signed in as ${s.bold(email)}` : `Signed in on this Mac (${COMMAND} account says as whom once ${DOMAIN} answers)`);

/**
 * The plan's line (core/account/plan-words.ts planLine), its name bold: "Plan: free trial · 4 days
 * left (until Mon 10 Nov, 14:02) · 31% of its usage used."
 */
export const styledPlanLine = (line: string, s: Style = PLAIN) => line.replace(/^Plan: (.+?)( ·|\.)/, (_, name: string, after: string) => `Plan: ${s.bold(name)}${after}`);

/**
 * How the device code flow shows itself: `kiko login`'s lines (showCode), or setup's live step
 * (ui/onboarding.ts signInLive). followCode says what, and when.
 */
export type CodeUi = {
  /** The one-time code, shown first: it's typed on the page. */
  code(userCode: string): void;
  /** No browser to open here (SSH, no terminal, --no-browser): the plain link, to open on any device. */
  link(url: string): void;
  /** Enter waited for before `url` opens: false when stopped (Ctrl+C, Esc), and then nothing opens. */
  enter(url: string): Promise<boolean>;
  /** The browser opened at `url` (`ok`), or couldn't be. */
  opened(url: string, ok: boolean): void;
  /**
   * The next code, while it's waited for (Account.signIn's patient): the last ran out, or `n` asked
   * for one. Shown in place of the last; nothing opens again (it's typed on the same page).
   */
  renewed?(userCode: string, why: Renewed): void;
  /** The server out of reach while it's waited for (false: still trying), or back (true). */
  reach?(reached: boolean): void;
};

/** Said with a patient sign-in's next code (CodeUi.renewed), by `kiko login` and setup. */
export const renewedLine = (why: Renewed) => (why === "ran-out" ? "The code ran out; here's a new one." : "Here's a new code.");
/** Said while the server can't be reached as the sign-in is waited for (CodeUi.reach). */
export const UNREACHABLE_LINE = `Can't reach ${DOMAIN}, still trying…`;

/**
 * The device code shown and the browser opened, as gh's device flow does it (cli/cli
 * internal/authflow/flow.go DisplayCode, then BrowseURL): the code first, then Enter opens the
 * approval page's plain link (`verificationUri`), where the code is typed. Never the link with the
 * code in it, so a link someone sends you can't sign their Mac in to your account. `browser`
 * false: the link shown instead. Shared by `kiko login` and setup.
 */
export async function followCode(start: DeviceStart, o: { browser: boolean; open: (url: string) => Promise<boolean> }, ui: CodeUi): Promise<void> {
  const url = start.verificationUri;
  ui.code(start.userCode);
  if (!o.browser) return ui.link(url);
  if (!(await ui.enter(url))) return;
  ui.opened(url, await o.open(url));
}

/** gh's words for each (flow.go), with Kiko's site; bold where gh's are, in `s`. */
export const codeWords = (s: Style = PLAIN) => ({
  code: (userCode: string) => `First copy your one-time code: ${s.bold(userCode)}`,
  link: (url: string) => `${s.bold("Open this URL")} to continue in your web browser: ${url}`,
  enter: (url: string) => `${s.bold("Press Enter")} to open ${url} in your browser...`,
  failed: (url: string) => [`Failed opening a web browser at ${url}`, "Please try entering the URL in your browser manually"],
});

/**
 * `kiko login`'s lines for followCode, as gh prints them, with the terms signing in accepts by the code (dim):
 *   ! First copy your one-time code: WDJB-MJHT
 *   By signing in, you agree to Kiko's Terms (kiko.sh/terms) and Privacy Policy (kiko.sh/privacy).
 *   Press Enter to open https://account.kiko.sh/device in your browser...
 * Not interactive (no terminal, SSH, --no-browser): gh's line for that, the link to open anywhere.
 */
export function showCode(d: AccountDeps, start: DeviceStart, o: { browser: boolean }): Promise<void> {
  const s = d.style ?? PLAIN;
  const say = codeWords(s);
  return followCode(
    start,
    { browser: o.browser && !d.remote && d.tty, open: d.open },
    {
      code: (userCode) => {
        d.out(s.warn(say.code(userCode)));
        d.out(s.dim(agreeLine("signing in")));
      },
      link: (url) => d.out(say.link(url)),
      // Ctrl+C here: nothing opened, and the wait that follows stops at once.
      enter: (url) => d.waitForEnter(`${say.enter(url)} `, d.signal),
      opened(url, ok) {
        if (ok) return;
        const [failed, manually] = say.failed(url);
        d.out(`${s.red("!")} ${failed}`);
        d.out(`  ${manually}`);
      },
    },
  );
}

/** Said once the code is out and the sign-in is waited for, in a terminal that reads keys (signInHere). */
export const LOGIN_WAIT_LINE = "Waiting for you to sign in. Press n for a new code, Esc to stop.";

/**
 * The device code flow, its lines printed as they come, patient (Account.signIn): a code that runs
 * out replaced and said ("The code ran out; here's a new one. Your one-time code: WXYZ-…"), the server out of reach
 * waited out ("Can't reach kiko.sh, still trying…"), up to 30 minutes. In a terminal, once the code
 * is out (and the browser opened), keys are read while it waits (LOGIN_WAIT_LINE): n a new code at
 * once, Esc (or Ctrl+C) stops.
 */
export async function signInHere(d: AccountDeps, o: { browser: boolean }): Promise<SignIn> {
  const s = d.style ?? PLAIN;
  const newCode = new NewCode();
  // Ctrl+C's stop (d.signal), and Esc's: read as a key while it waits (raw, so Ctrl+C is a key then too).
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  if (d.signal?.aborted) stop.abort();
  d.signal?.addEventListener("abort", onAbort, { once: true });
  const keys: { off: (() => void) | null } = { off: null };
  const listen = () => {
    if (keys.off || !d.tty || !d.keys || stop.signal.aborted) return;
    d.out(s.dim(LOGIN_WAIT_LINE));
    keys.off = d.keys((key) => {
      if (key === "esc") stop.abort();
      else if (key === "n") newCode.ask();
    });
  };
  try {
    return await d.account.signIn({
      signal: stop.signal,
      patient: { newCode, onReach: (ok) => d.out(ok ? s.dim(`Reached ${DOMAIN} again. Waiting for you to sign in…`) : s.warn(UNREACHABLE_LINE)) },
      onCode: async (start, renewed) => {
        if (!renewed) {
          await showCode(d, start, o);
          return listen();
        }
        // The same page as before: the new code to type there, nothing opened again.
        d.out(s.warn(`${renewedLine(renewed)} Your one-time code: ${s.bold(start.userCode)}`));
        d.out(`  Type it at ${start.verificationUri}`);
      },
    });
  } finally {
    keys.off?.();
    d.signal?.removeEventListener("abort", onAbort);
  }
}

async function login(args: readonly string[], d: AccountDeps): Promise<number> {
  const s = d.style ?? PLAIN;
  const unknown = args.find((a) => a !== "--no-browser");
  if (unknown !== undefined) return fail(d, `login takes only --no-browser (not ${unknown})`);
  const now = await d.account.check();
  if (now.state === "unknown") return fail(d, `${now.why}`);
  if (now.state === "signed-in") {
    d.out(s.warn(`${now.email ? `Signed in as ${s.bold(now.email)}` : "Signed in"} already. ${s.dim(`${COMMAND} logout signs out first.`)}`));
    return 0;
  }
  const r = await signInHere(d, { browser: !args.includes("--no-browser") });
  if (!r.ok) {
    // Stopped by you (Ctrl+C): said plainly, as nothing went wrong.
    d.out(r.why === "cancelled" ? r.said : s.error(r.said));
    return 1;
  }
  // A phone paired already: the server told, so this session never expires while it is (best-effort: the app tells it again).
  if (d.phones().length) await d.account.syncPhone(true).catch(() => {});
  d.out(s.ok("Authentication complete."));
  d.out(s.ok(signedInLine(r.email, s)));
  // The plan, asked now: the trial's days and share used, Pro, or none (and how to start the trial).
  const after = await d.account.check();
  if (after.state === "signed-in" && after.reached) d.out(`  ${styledPlanLine(planLine(after.plan, after.trial), s)}`);
  return 0;
}

async function logout(d: AccountDeps): Promise<number> {
  const s = d.style ?? PLAIN;
  const view = d.account.view();
  if (view.state !== "signed-in") {
    // A token without account.json (it was lost): taken out all the same.
    await d.account.signOut();
    d.out(view.revoked ? s.warn(SIGNED_OUT_LINE) : "Not signed in on this Mac.");
    return 0;
  }
  const phones = d.phones();
  if (phones.length) {
    const names = andList(phones.map((p) => s.bold(p)));
    d.out(s.warn(`${names} ${phones.length === 1 ? "is" : "are"} paired with this Mac. Your phone will lose access away from home (at home it keeps working).`));
    if (!d.tty) return fail(d, `run ${COMMAND} logout in a terminal: it asks first`);
    if (!(await d.confirm("Sign out anyway?"))) {
      d.out("Nothing changed: still signed in.");
      return 0;
    }
  }
  const r = await d.account.signOut();
  if (r.kept) return fail(d, `couldn't take the sign-in out of the Keychain: ${r.kept}. Still signed in.`);
  d.out(s.ok("Signed out on this Mac."));
  if (r.server === "unreachable") d.out(s.warn(`${DOMAIN} couldn't be reached, so its session there ends by itself, or sign it out now on the account page: ${ACCOUNT_SITE}/account`));
  return 0;
}

/** "5 minutes", "1 minute", "an hour", from seconds. */
const minutes = (secs: number) => {
  const m = Math.max(1, Math.ceil(secs / 60));
  return m === 60 ? "an hour" : `${m} minute${m === 1 ? "" : "s"}`;
};

/**
 * `kiko account delete` (API.md, "Deleting the account"): what goes is said and asked first; then a
 * fresh code sent to the account's email, typed here, and the account deleted. A wrong code is asked
 * again; one that's spent or ran out, a new one sent (asked). Done: this Mac's token and account.json
 * go too (core/account/account.ts deleteAccount), and every other Mac is signed out by the server.
 */
async function deleteAccount(args: readonly string[], d: AccountDeps): Promise<number> {
  if (args.length) return fail(d, `account delete takes nothing after it (not ${args[0]})`);
  const s = d.style ?? PLAIN;
  const now = await d.account.check();
  if (now.state === "unknown") return fail(d, now.why);
  if (now.state === "signed-out") {
    d.out(now.revoked ? s.warn(SIGNED_OUT_LINE) : `Not signed in on this Mac. ${s.dim(`${COMMAND} login signs in first, or delete the account on its page: ${ACCOUNT_SITE}/account`)}`);
    return 0;
  }
  if (!now.reached) return fail(d, `couldn't reach ${DOMAIN} (${now.why ?? "offline?"}). Nothing changed.`);
  const who = now.email ? s.bold(now.email) : "the one signed in on this Mac";
  const phones = d.phones();
  d.out(s.warn(`This deletes your ${NAME} account, ${who}, and can't be undone:`));
  d.out(`  - the account, and the sign-in of every Mac on it${now.macs && now.macs > 1 ? ` (${s.bold(String(now.macs))} Macs)` : ""}: each is signed out`);
  d.out("  - its plan, its free trial and its usage records");
  if (phones.length) d.out(`  - ${andList(phones.map((p) => s.bold(p)))} ${phones.length === 1 ? "loses" : "lose"} access away from home (at home it keeps working)`);
  d.out(`  The free trial can't be claimed again with this email: one scrambled copy of it is kept, for that alone.`);
  d.out(s.dim(`  Your own keys and settings on this Mac stay, and ${NAME} works on your own OpenRouter key.`));
  const pro = proDeleteWarning(now.plan, now.trial);
  if (pro) d.out(s.warn(pro));
  if (!d.tty) return fail(d, `run ${COMMAND} account delete in a terminal: it asks first`);
  if (!(await d.confirm(`Delete your ${NAME} account?`))) {
    d.out("Nothing changed: the account stays.");
    return 0;
  }
  for (;;) {
    const sent = await d.account.deleteCode();
    if (!sent.ok) return deleteFailed(d, sent);
    d.out(s.ok(`Sent a 6-digit code to ${sent.email ? s.bold(sent.email) : "the account's email"}. It works for ${minutes(sent.expiresIn)}.`));
    for (;;) {
      const typed = await d.ask(`${s.bold("Code from the email:")} `);
      const code = (typed ?? "").replace(/\s/g, "");
      if (!code) {
        d.out("Nothing changed: the account stays.");
        return 0;
      }
      if (!/^\d{6}$/.test(code)) {
        d.out(s.error("The code is 6 digits."));
        continue;
      }
      const r = await d.account.deleteAccount(code);
      if (r.ok) {
        d.out(s.ok(`Account deleted. Every Mac is signed out of it.`));
        if (r.kept) d.out(s.warn(`The sign-in is still in the Keychain (${r.kept}): it no longer works, and ${COMMAND} logout takes it out.`));
        d.out(`  ${NAME} still works with your own OpenRouter key: ${s.bold(`${COMMAND} keys set openrouter`)}`);
        return 0;
      }
      if (r.why !== "code") return deleteFailed(d, r);
      if (r.code === "invalid_code") {
        d.out(s.error("That code isn't right."));
        continue;
      }
      d.out(s.warn(r.code === "expired_code" ? "That code ran out." : "That code has had too many tries."));
      if (!(await d.confirm("Send a new code?"))) {
        d.out("Nothing changed: the account stays.");
        return 0;
      }
      break;
    }
  }
}

/**
 * Said before deleting an account whose Kiko Pro is paid for and renews (not cancelled, no payment
 * failing, not given by hand): deleting cancels the subscription at once with no refund
 * (the account's rule for cancellations and refunds), so cancelling instead keeps it to the end of the
 * paid month or year. Null otherwise.
 */
export function proDeleteWarning(plan: Plan | null, trial: Trial | null, now = Date.now()): string | null {
  const st = planStatus(plan, trial, now);
  if (st.kind !== "pro" || !st.renewsAt || st.cancelAt || st.paymentFailed) return null;
  return `Your ${NAME} Pro ends now, with no refund. To keep it until ${day(st.renewsAt)}, cancel instead: ${COMMAND} account billing.`;
}

/** Why a step of the deletion didn't go, in a line: nothing was deleted. */
function deleteFailed(d: AccountDeps, r: { why: string; detail?: string; retryAfter?: number | null }): number {
  const s = d.style ?? PLAIN;
  if (r.why === "signed-out") {
    d.out(s.warn(SIGNED_OUT_LINE));
    return 1;
  }
  if (r.why === "not-signed-in") return fail(d, `not signed in on this Mac: ${COMMAND} login signs in first`);
  if (r.why === "keychain") return fail(d, `the Keychain couldn't be read: ${r.detail ?? "it failed"}. Nothing changed.`);
  if (r.why === "rate-limited") return fail(d, `too many codes were asked for: try again${r.retryAfter ? ` in ${minutes(r.retryAfter)}` : " later"}. Nothing changed.`);
  if (r.why === "refused") return fail(d, `${DOMAIN} turned it down: ${r.detail ?? "refused"}. Nothing changed.`);
  return fail(d, `couldn't reach ${DOMAIN} (${r.detail ?? "offline?"}). Nothing changed.`);
}

/** What `kiko account` takes after it: managing a subscription is there whenever accounts are (PRO_ON_SALE hides only buying). */
export const ACCOUNT_SUBCOMMANDS = ["billing", "delete"] as const;

async function account(args: readonly string[], d: AccountDeps): Promise<number> {
  if (args[0] === "delete") return deleteAccount(args.slice(1), d);
  if (args[0] === "billing") return (await import("./upgrade-cli.ts")).billingCommand(args.slice(1), d);
  if (args.length) {
    const tries = [`${COMMAND} account`, ...ACCOUNT_SUBCOMMANDS.map((c) => `${COMMAND} account ${c}`)].join(", ");
    d.out((d.style ?? PLAIN).error(`${COMMAND} account doesn't have "${args[0]}". Try: ${tries}`));
    return 1;
  }
  const now = await d.account.check();
  if (now.state === "unknown") return fail(d, now.why);
  const s = d.style ?? PLAIN;
  if (now.state === "signed-out") {
    d.out(now.revoked ? s.warn(SIGNED_OUT_LINE) : `Not signed in. ${s.dim(`${COMMAND} login signs in: an account is only for the free trial, and your own key needs none.`)}`);
    return 0;
  }
  d.out(s.ok(`${now.email ? `Signed in as ${s.bold(now.email)}` : "Signed in"} on this Mac${now.since ? `, since ${day(now.since)}` : ""}.`));
  if (now.macs && now.macs > 1) d.out(`  ${s.bold(String(now.macs))} Macs are signed in to this account: ${ACCOUNT_SITE}/account lists them.`);
  // The plan: as the server said it now, or as last known when it couldn't be asked.
  d.out(`  ${styledPlanLine(planLine(now.plan, now.trial, Date.now(), { ownKey: d.ownKey }), s)}`);
  // Pro's weekly pace (information only), what's paused past its month's allowance, or your own key running the AI instead.
  const detail = planDetail(now.plan, now.trial, { ownKey: d.ownKey });
  if (detail) d.out(`  ${s.dim(`${detail}.`)}`);
  if (!now.reached) d.out(s.warn(`Couldn't reach ${DOMAIN} to check: ${now.why ?? "offline?"}. Still signed in.`));
  const pro = planStatus(now.plan, now.trial).kind === "pro";
  // Managing Pro whenever it's the plan; getting it only while it's on sale.
  const billing = pro ? `; ${COMMAND} account billing manages ${NAME} Pro` : d.sale ? `; ${COMMAND} upgrade gets ${NAME} Pro` : "";
  d.out(s.dim(`${COMMAND} logout signs out; ${COMMAND} account delete deletes the account${billing}.`));
  return 0;
}

function fail(d: AccountDeps, why: string) {
  d.out((d.style ?? PLAIN).error(`${COMMAND}: ${why}`));
  return 1;
}

/** `kiko login`, `logout` or `account`. Returns the exit code. */
export async function accountCommand(command: "login" | "logout" | "account", args: readonly string[], d: AccountDeps): Promise<number> {
  if (!d.live) {
    d.out(NOT_OPEN_LINE);
    return 0;
  }
  if (command === "login") return login(args, d);
  if (command === "logout") return args.length ? fail(d, `logout takes nothing after it (not ${args[0]})`) : logout(d);
  return account(args, d);
}

/**
 * Setup's account (ui/onboarding.ts SetupDeps.account): who's signed in, from account.json, and
 * `kiko login`'s flow (followCode), shown in setup's step: the code first, then Enter opens the
 * plain link; over SSH (`remote`) the link shown instead, to open on any device.
 */
export function setupAccount(account: Account, o: { open: (url: string) => Promise<boolean>; remote: boolean; phones?: () => number; sale?: boolean }): NonNullable<SetupDeps["account"]> {
  return {
    signedIn() {
      const v = account.view();
      return v.state === "signed-in" ? (v.email ?? "") : null;
    },
    async signIn(ui, signal, newCode) {
      // Patient, as `kiko login` is: the next code shown in place of the last (nothing opened again), the server's outages waited out.
      const r = await account.signIn({
        signal,
        patient: { newCode, onReach: (ok) => ui.reach?.(ok) },
        onCode: (start, renewed) => (renewed ? ui.renewed?.(start.userCode, renewed) : followCode(start, { browser: !o.remote, open: o.open }, ui)),
      });
      // A phone paired already: told, best-effort (the app tells it again at its start).
      if (r.ok && (o.phones?.() ?? 0) > 0) await account.syncPhone(true).catch(() => {});
      return r;
    },
    async startTrial() {
      const r = await account.startTrial({ started: trialStartedLine, refused: trialRefusedLine });
      return r.ok ? { ok: true, said: r.said } : { ok: false, said: r.said, ...(r.code ? { code: r.code } : {}) };
    },
    async plan() {
      const r = await account.check();
      if (r.state !== "signed-in" || !r.reached) return null;
      // Active: it runs the AI now (not Pro past its month's allowance, paused until it renews).
      const st = planStatus(r.plan, r.trial);
      return {
        active: planRunsAi(r.plan),
        line: planLine(r.plan, r.trial),
        hadTrial: Boolean(r.trial) || r.plan?.name === "trial",
        pro: st.kind === "pro",
        // Pro past its month's allowance: the plan stays (no key needed), paused until it renews.
        ...(st.kind === "pro" && st.usedUp ? { paused: proPausedLine(st.resetsAt) } : {}),
      };
    },
    // Kiko Pro, while it's on sale: kiko upgrade's checkout (upgrade-cli.ts followCheckout), in setup's step.
    ...(o.sale
      ? {
          async upgrade(interval, ui, signal) {
            const { followCheckout } = await import("./upgrade-cli.ts");
            return followCheckout({ account, open: o.open, signal }, interval, { browser: !o.remote }, ui);
          },
        }
      : {}),
  };
}

/** An SSH session: the browser would open on the Mac's own screen, not yours. */
export const overSsh = (env: NodeJS.ProcessEnv = process.env) => Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);

// ── The real ones ──────────────────────────────────────────────────────────

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(styleFor(process.stdout).question(question), resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function ask(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // The input ending (Ctrl+D) is no answer.
  const answer = await new Promise<string | null>((resolve) => {
    rl.once("close", () => resolve(null));
    rl.question(question, resolve);
  });
  rl.close();
  return answer;
}

/**
 * gh's waitForEnter (a line read from stdin), in the terminal's own line mode: Enter ends it, and
 * Ctrl+C is the terminal's SIGINT as always (realDeps aborts `signal` on it). Esc does nothing here, as before.
 */
export function waitForEnter(
  prompt: string,
  signal?: AbortSignal,
  input: NodeJS.ReadableStream & { pause(): unknown } = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  output.write(prompt);
  return new Promise((resolve) => {
    const done = (entered: boolean) => {
      input.off("data", onData);
      input.off("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      input.pause();
      resolve(entered);
    };
    const onData = (chunk: Buffer | string) => {
      if (String(chunk).includes("\n") || String(chunk).includes("\r")) done(true);
    };
    const onEnd = () => done(true);
    // The prompt has no newline: ^C ends its line, so what comes next starts on its own.
    const onAbort = () => (output.write("\n"), done(false));
    input.on("data", onData);
    input.on("end", onEnd);
    signal?.addEventListener("abort", onAbort, { once: true });
    input.resume();
  });
}

/** `open <url>`: true once macOS has handed it to the browser. */
export const openInBrowser = (url: string) => new Promise<boolean>((resolve) => execFile("open", [url], { timeout: 10_000 }, (err) => resolve(!err)));

/**
 * The phones paired with this Mac (remote/pairing.ts, phones.json next to the settings), by name.
 * None while the iPhone app isn't out (core/env.ts phoneLive): nothing is said about a phone then.
 */
export async function pairedPhones(): Promise<string[]> {
  if (!phoneLive()) return [];
  const { Pairing } = await import("./remote/pairing.ts");
  return new Pairing(join(dirname(SETTINGS_FILE), "phones.json")).list().map((p) => p.name);
}

export async function realDeps(): Promise<AccountDeps> {
  const [{ keyStore }, { ownOpenRouterKey }, { terminalKeys }] = await Promise.all([import("./platform/keys.ts"), import("./keys-cli.ts"), import("./upgrade-cli.ts")]);
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  const phones = await pairedPhones().catch(() => [] as string[]);
  return {
    live: accountsLive(),
    account: new Account({ store: keyStore, client: accountClient(accountUrl()) }),
    out: (line) => console.log(line),
    confirm,
    ask,
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    open: openInBrowser,
    waitForEnter,
    style: styleFor(process.stdout),
    remote: overSsh(),
    phones: () => phones,
    signal: stop.signal,
    sale: proOnSale(),
    keys: (on) => terminalKeys(on),
    ownKey: await ownOpenRouterKey(keyStore).catch(() => false),
  };
}
