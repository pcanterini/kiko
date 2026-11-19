// This Mac's Kiko account: signing in with the device code flow, staying signed in, getting
// short-lived access tokens, signing out, and deleting the account. The server is behind ./client.ts.
//
// Kept in two places, never anywhere else:
//   - the session token, in the Keychain (SESSION_KEY, this flavour's service, through the keychain
//     helper like the API keys): it's what "signed in" means;
//   - who it is (the email, since when, when last checked) and its plan (the trial's dates, the share
//     of its quota used, as last told) in account.json next to the settings, so Settings → Account,
//     `kiko account` and the app's model calls (core/model-route.ts) can say it without asking the
//     server. No token in it.
// The access token (10 minutes) is held in memory only, and fetched again before it runs out.
// Kiko Pro (phase 3) is bought on Stripe's own pages: `checkout` gets the link, `waitForPro` asks the
// server every few seconds until the plan is Pro, and `portal` gets the billing page's link.
//
// Never signed out by accident: a network failure, a timeout or the
// server being down never removes the token. Only the server saying plainly that the session is gone
// does (client.ts "signed-out"), and that's kept as a state of its own (SIGNED_OUT_LINE) until the
// next sign-in. No token is ever logged, printed or put in an error.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { KeyStore } from "../../platform/types.ts";
import { COMMAND, DOMAIN, ENV_PREFIX, NAME } from "../name.ts";
import { readJsonFile, writeJsonAtomic } from "../json-file.ts";
import { SETTINGS_FILE } from "../settings.ts";
import type { AccountClient, DeviceStart, Plan, Trial } from "./client.ts";

/** The session token's name in the Keychain (beside the API keys, in this flavour's service). */
export const SESSION_KEY = `${ENV_PREFIX}ACCOUNT_SESSION`;
/** Who's signed in, without the token: next to the settings. */
export const ACCOUNT_FILE = join(dirname(SETTINGS_FILE), "account.json");

/** Said once the server has signed this Mac out (from the account page, or the account deleted). */
export const SIGNED_OUT_LINE = `Signed out on ${DOMAIN}: ${COMMAND} login signs in again.`;
/** Said by `kiko login`, `logout` and `account` while accounts aren't open (core/env.ts accountsLive). */
export const NOT_OPEN_LINE = `${NAME} accounts aren't open yet, and you don't need one: your own OpenRouter key works without (${COMMAND} keys set openrouter).`;

/** How often the server is asked while a payment is waited for, and for how long at most. */
export const PRO_POLL = { everyMs: 3000, forMs: 15 * 60_000 };

/** Why a billing call (checkout, portal) didn't give a page. */
export type BillingFailed = {
  ok: false;
  why: "not-signed-in" | "keychain" | "signed-out" | "unreachable" | "refused" | "already-pro" | "no-billing" | "billing-unavailable";
  detail?: string;
};

/**
 * The relay pass is fetched again once it has less than this left: it lasts 24 hours (7 days until
 * 2026-11-04), and is looked at hourly, so a pass is renewed about 12 hours before it runs out.
 */
export const PASS_RENEW_MS = 12 * 3_600_000;

/** The plan as the relay pass was asked under: a pass is fetched afresh once it changes (a trial started, Pro bought, renewed or ended). */
const planKey = (plan: Plan | null | undefined) => (plan ? `${plan.name}|${plan.startedAt ?? ""}|${plan.endsAt ?? ""}` : "none");

/** The relay pass, or why there's none to show the relay. */
export type PassAnswer =
  | { ok: true; pass: string; expiresAt: number; fetched: boolean }
  | { ok: false; why: "plan-required"; trialAvailable: boolean }
  | { ok: false; why: "unreachable" | "signed-out" | "not-signed-in" | "keychain" | "refused"; detail?: string };

/** An access token is fetched again once it has less than this left. */
export const REFRESH_EARLY_MS = 2 * 60_000;
/** Polls in a row that can't reach the server before sign-in gives up (one or two are a blip); not for a patient one. */
export const MAX_MISSES = 5;
/** RFC 8628 §3.5: each slow_down adds 5 seconds to the wait. */
const SLOW_DOWN_MS = 5000;
/**
 * How long a patient sign-in (setup, `kiko login`: signIn's `patient`) waits in all, its codes
 * renewed as they run out (10 minutes each) and the server's outages waited out; then it stops.
 */
export const SIGN_IN_FOR_MS = 30 * 60_000;
/** The waits while the server can't be reached (patient): longer each time, then the last again. */
export const UNREACHABLE_WAITS_MS = [2000, 4000, 8000, 15_000, 30_000] as const;

/**
 * Asks a patient sign-in under way for a fresh code at once (setup's and `kiko login`'s `n`): the
 * wait stops, the code shown is let go (nothing is said to the server: it just runs out), and a new
 * one is asked for and shown. Asked between waits, it's taken at the next one.
 */
export class NewCode {
  private asked = false;
  private wakers = new Set<() => void>();
  ask() {
    this.asked = true;
    for (const f of [...this.wakers]) f();
  }
  /** Whether it was asked since the last look (signIn's). */
  take(): boolean {
    const was = this.asked;
    this.asked = false;
    return was;
  }
  /** `f` told when it's asked, until the returned stop (signIn's wait). */
  onAsk(f: () => void): () => void {
    this.wakers.add(f);
    return () => void this.wakers.delete(f);
  }
}

/** Why a patient sign-in shows another code: the last ran out ("ran-out"), or a new one was asked for (NewCode: "asked"). */
export type Renewed = "ran-out" | "asked";

/** What account.json holds. */
type Saved = {
  email?: string | null;
  since?: number;
  checkedAt?: number;
  /** Whether the server knows a phone is paired (POST /session/phone), as last told or seen; null: to be told again. */
  phoneTold?: boolean | null;
  signedOut?: { at: number; why: "revoked" };
  /** The plan and the trial as the server last said them (null: none). */
  plan?: Plan | null;
  trial?: Trial | null;
  /** One-time notices already given for this plan (core/account/plan-words.ts: "two days left", "almost used up"). */
  told?: string[];
  /** When a line said at most so often was last said (ms since 1970), by its key: "phone-refused" (once a day). */
  said?: Record<string, number>;
  /**
   * Kiko Pro was the plan at the last check but isn't now (the server says none once Pro is over):
   * when that was seen, and whether a failed payment's grace is what ended it. Kept until a plan is
   * in effect again, so the phone's refusal names it (phone-plan.ts phoneReason) instead of "no plan".
   */
  proEnded?: ProEnded | null;
};

/** Kiko Pro that ended (account.json's proEnded). */
export type ProEnded = { at: number; paymentFailed: boolean };

/** Where this Mac's account stands, as last known (account.json): no server, no Keychain. */
export type AccountView =
  | { state: "signed-in"; email: string | null; since: number | null; checkedAt: number | null; plan: Plan | null; trial: Trial | null; proEnded?: ProEnded | null }
  | { state: "signed-out"; revoked: boolean };

/** How starting the free trial ended. `said`: the line to show (never a token). */
export type TrialStart =
  | { ok: true; started: boolean; plan: Plan | null; trial: Trial | null; said: string }
  | { ok: false; why: "refused" | "unreachable" | "signed-out" | "not-signed-in" | "keychain"; code?: string; said: string };

/**
 * What Settings → Account's row carries (its `raw`, as JSON), for its options (settings-options.ts
 * accountChoices). `billing`: the account is on Kiko Pro, so Manage billing is there (on sale or not:
 * managing isn't buying). `signing`: Sign in under way in the pane (app/settings/account.ts): asking
 * for a code, its code shown (Enter opens the browser), or waiting for the approval.
 */
export type AccountRow = { signedIn: boolean; confirming: boolean; phones: number; billing?: boolean; signing?: SigningPhase };

/** Where Settings → Account's Sign in is (the device code flow, as `kiko login` runs it). */
export type SigningPhase = "starting" | "code" | "waiting";

/**
 * Settings → Account's Sign in, as its pane shows it: the phase, the code and the page it's typed
 * at; while waiting, whether the browser opened (`opened` false: it couldn't, or over SSH the link
 * shown to open anywhere: `link`). After: `done`, who signed in (null: the server didn't say), or why
 * it didn't (`failed`, said in yellow), until settings close.
 */
export type SignInShown =
  | { phase: "starting" }
  | { phase: "code"; code: string; url: string }
  | { phase: "waiting"; code: string; url: string; opened: boolean; link?: boolean }
  | { phase: "done"; email: string | null }
  | { phase: "failed"; said: string };

/**
 * How a sign-in ended. `said`: a line to show (never a token), in `kiko login`'s words. "used": the
 * code was used already or isn't known (patient only; else it's "expired", as it always was).
 * "timed-out": a patient one's SIGN_IN_FOR_MS gone by, `offline` when the server couldn't be
 * reached at the end.
 */
export type SignIn =
  | { ok: true; email: string | null }
  | { ok: false; why: "denied" | "expired" | "used" | "unreachable" | "refused" | "timed-out" | "cancelled" | "no-keychain" | "save-failed"; said: string; offline?: boolean };

/**
 * What a patient sign-in (setup, `kiko login`) takes: `newCode` (`n`), and `onReach`, told as the
 * server goes out of reach (false: "Can't reach kiko.sh, still trying…") and comes back (true).
 */
export type Patient = { newCode?: NewCode; onReach?: (reached: boolean) => void };

/** Where it stands after asking the server: `reached` false when it couldn't be asked (still signed in). */
export type Checked =
  | { state: "signed-in"; email: string | null; since: number | null; reached: boolean; why?: string; macs?: number; plan: Plan | null; trial: Trial | null }
  | { state: "signed-out"; revoked: boolean }
  | { state: "unknown"; why: string };

type Deps = {
  store: KeyStore | null;
  client: AccountClient;
  file?: string;
  now?: () => number;
  /** Waits between polls (the tests' own skips the wait). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The app's log: what happened, never a token or the email. */
  log?: (event: string, data: Record<string, unknown>) => void;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Account {
  private d: Required<Omit<Deps, "store">> & { store: KeyStore | null };
  /** The access token, in memory only. */
  private access: { jwt: string; expiresAt: number } | null = null;
  /**
   * The relay pass, in memory only (never the Keychain), for the relay room it was asked for and the
   * plan as it was then (planKey): fetched again under PASS_RENEW_MS, for another room, or once the plan changed.
   */
  private pass: { pass: string; expiresAt: number; room: string; plan: string } | null = null;
  /** Told when the plan as known changes (onPlanChange): the relay pass is asked for again at once. */
  private planListeners = new Set<() => void>();
  /** Whether the free trial could still start, as the server last said it with no pass (null: not said). */
  private trialSaid: boolean | null = null;

  constructor(deps: Deps) {
    this.d = {
      file: ACCOUNT_FILE,
      now: Date.now,
      sleep: (ms, signal) => sleep(ms, undefined, { signal }),
      log: () => {},
      ...deps,
    };
  }

  // ── What's known ────────────────────────────────────────────────────────

  private load(): Saved {
    // One that can't be read is set aside, never saved over (core/json-file.ts): signed out.
    return (readJsonFile(this.d.file) as Saved | undefined) ?? {};
  }

  private save(saved: Saved | null) {
    const was = this.planListeners.size ? planKey(this.load().plan) : null;
    if (!saved) rmSync(this.d.file, { force: true });
    else writeJsonAtomic(this.d.file, saved, { mode: 0o600 });
    if (was !== null && was !== planKey(saved?.plan)) for (const f of this.planListeners) queueMicrotask(f);
  }

  /**
   * `f` is told (soon after, never in the middle of a save) each time the plan as known changes: a
   * check that heard of a new plan, a trial started, Pro bought or ended, signed in or out. Returns the
   * way to stop.
   */
  onPlanChange(f: () => void): () => void {
    this.planListeners.add(f);
    return () => this.planListeners.delete(f);
  }

  /** As last known (account.json): for a screen, with nothing asked. */
  view(): AccountView {
    const s = this.load();
    if (typeof s.since === "number")
      return {
        state: "signed-in",
        email: s.email ?? null,
        since: s.since,
        checkedAt: s.checkedAt ?? null,
        plan: s.plan ?? null,
        trial: s.trial ?? null,
        ...(s.proEnded ? { proEnded: s.proEnded } : {}),
      };
    return { state: "signed-out", revoked: s.signedOut?.why === "revoked" };
  }

  /** The session token from the Keychain: null with none (or no Keychain); throws when it can't be read. */
  private token(): string | null {
    if (!this.d.store) return null;
    return this.d.store.get([SESSION_KEY])[SESSION_KEY] || null;
  }

  /** The server said the session is gone: the token taken out, and the state kept so it's said. */
  private async revoked(at: string) {
    this.access = null;
    this.pass = null;
    this.d.log("account_signed_out", { by: "server", at });
    try {
      await this.d.store?.remove(SESSION_KEY);
    } catch (err) {
      this.d.log("account_keychain_failed", { op: "remove", error: message(err) });
    }
    this.save({ signedOut: { at: this.d.now(), why: "revoked" } });
  }

  // ── Signing in ──────────────────────────────────────────────────────────

  /**
   * The device code flow: a code asked for, shown (`onCode`: open the browser, print it), the
   * server polled until it's approved, denied or expired. Approved: the session token kept in the
   * Keychain and who it is asked. `signal` (Ctrl+C, Esc) cancels the wait; nothing is kept then,
   * even an approval that came back on a poll that was out as it was cancelled (its session let go
   * on the server, as one the store can't keep is). `onApproved`: the approval taken, at once, in
   * the same turn as the last look at `signal`: from there it's kept, and `signal` no longer stops it.
   *
   * `patient` (setup, `kiko login`): it doesn't give up while you're still there. A code that runs
   * out is replaced (`onCode` again, with "ran-out"), `newCode` (`n`) gets a fresh one at once (with
   * "asked"), and the server out of reach (for the first code, a new one, or a poll) is waited out
   * with longer and longer waits (UNREACHABLE_WAITS_MS), `onReach` told as it goes and comes back;
   * all of it up to SIGN_IN_FOR_MS, then "timed-out". Without it, as the app's own sign-ins have it
   * (core/account/mac-sign-in.ts renews codes itself): one code, and MAX_MISSES polls unreached end it.
   */
  async signIn(o: { onCode: (start: DeviceStart, renewed?: Renewed) => void | Promise<void>; signal?: AbortSignal; onApproved?: () => void; patient?: Patient }): Promise<SignIn> {
    const { client, now } = this.d;
    const patient = o.patient ?? null;
    const newCode = patient?.newCode ?? null;
    // For the log (a patient one's): codes that ran out, new ones asked for, times the server went out of reach.
    const counts = { renewed: 0, asked: 0, outages: 0 };
    const counted = () => (patient ? { ...counts } : {});
    const fail = (why: Exclude<SignIn, { ok: true }>["why"], said: string, extra: { offline?: boolean } = {}): SignIn => (
      this.d.log("account_sign_in", { ended: why, ...counted() }), { ok: false, why, said, ...extra }
    );
    const cancelled = () => fail("cancelled", "Sign-in stopped. Nothing changed.");
    if (!this.d.store) return fail("no-keychain", `There's no Keychain here (${ENV_PREFIX}KEYCHAIN is off) to keep the sign-in in.`);
    const deadline = now() + SIGN_IN_FOR_MS;
    // Why the server can't be reached, while it can't (patient); misses in a row (either).
    let offline: string | null = null;
    let misses = 0;
    const unreached = (why: string) => {
      misses++;
      if (!patient) return;
      if (offline === null) {
        counts.outages++;
        this.d.log("account_sign_in", { unreachable: why });
        patient.onReach?.(false);
      }
      offline = why;
    };
    const reached = () => {
      misses = 0;
      if (offline === null) return;
      offline = null;
      this.d.log("account_sign_in", { reached: true });
      patient?.onReach?.(true);
    };
    const minutes = SIGN_IN_FOR_MS / 60_000;
    const timedOut = () =>
      offline !== null
        ? fail("timed-out", `Couldn't reach ${DOMAIN} for ${minutes} minutes (${offline}). Nothing changed: ${COMMAND} login tries again.`, { offline: true })
        : fail("timed-out", `Stopped waiting: no sign-in in ${minutes} minutes. Nothing changed: ${COMMAND} login starts again.`);
    /** A wait: through, stopped (`signal`), or cut short by a new code asked for. Patient: never past the deadline. */
    const wait = async (ms: number): Promise<"waited" | "cancelled" | "asked"> => {
      if (o.signal?.aborted) return "cancelled";
      if (newCode?.take()) return "asked";
      const cut = new AbortController();
      const stop = () => cut.abort();
      o.signal?.addEventListener("abort", stop, { once: true });
      const off = newCode?.onAsk(stop);
      try {
        await this.d.sleep(patient ? Math.max(0, Math.min(ms, deadline - now())) : ms, cut.signal);
      } catch {
        // Cut short: which way, said below.
      } finally {
        o.signal?.removeEventListener("abort", stop);
        off?.();
      }
      if (o.signal?.aborted) return "cancelled";
      if (newCode?.take()) return "asked";
      return cut.signal.aborted ? "cancelled" : "waited";
    };
    /** The wait while the server can't be reached: the poll's interval at least, longer with each miss. */
    const backoff = (atLeast: number) => Math.max(atLeast, UNREACHABLE_WAITS_MS[Math.min(misses, UNREACHABLE_WAITS_MS.length) - 1] ?? 0);

    let start: DeviceStart | null = null;
    // Why the next code is asked for (null: the first).
    let next: Renewed | null = null;
    let until = 0;
    let interval = 0;
    for (;;) {
      if (!start) {
        if (patient && now() >= deadline) return timedOut();
        const got = await client.deviceCode();
        if (o.signal?.aborted) return cancelled();
        if (got.kind === "unreachable") {
          if (!patient) return fail("unreachable", `Couldn't reach ${DOMAIN} (${got.why}). Nothing changed: ${COMMAND} login tries again.`);
          unreached(got.why);
          // A new code asked for meanwhile: tried again at once, as it is anyway.
          if ((await wait(backoff(0))) === "cancelled") return cancelled();
          continue;
        }
        if (got.kind === "refused") return fail("refused", `${DOMAIN} wouldn't start a sign-in: ${got.why}`);
        reached();
        start = got;
        // The code's time runs from when it was given, not from when it was shown.
        until = now() + start.expiresIn * 1000;
        interval = start.interval * 1000;
        if (next) {
          counts[next === "ran-out" ? "renewed" : "asked"]++;
          this.d.log("account_sign_in", { code: next, ...counts });
          await o.onCode(start, next);
        } else await o.onCode(start);
        next = null;
      }
      const waited = await wait(offline !== null ? backoff(interval) : interval);
      if (waited === "cancelled") return cancelled();
      if (waited === "asked") {
        start = null;
        next = "asked";
        continue;
      }
      if (patient && now() >= deadline) return timedOut();
      if (now() >= until) {
        if (!patient) return fail("expired", `The code ran out before it was approved: ${COMMAND} login gives you a new one.`);
        start = null;
        next = "ran-out";
        continue;
      }
      const r = await client.deviceToken(start.deviceCode);
      if (o.signal?.aborted) {
        if (r.kind === "approved") void client.signOut(r.token).catch(() => {});
        return cancelled();
      }
      if (r.kind === "unreachable") {
        unreached(r.why);
        if (patient || misses < MAX_MISSES) continue;
        return fail("unreachable", `Lost touch with ${DOMAIN} (${r.why}). Nothing changed: ${COMMAND} login tries again.`);
      }
      reached();
      if (r.kind === "pending") continue;
      if (r.kind === "slow_down") {
        interval += SLOW_DOWN_MS;
        // A 429: its Retry-After waited out first, once.
        if (r.retryAfter) {
          const after = await wait(r.retryAfter * 1000);
          if (after === "cancelled") return cancelled();
          if (after === "asked") {
            start = null;
            next = "asked";
          }
        }
        continue;
      }
      if (r.kind === "denied") return fail("denied", "The sign-in was denied in the browser. Nothing changed.");
      // Ran out on the server (or, right at its end, gone from it): patient, a new code.
      if (patient && (r.kind === "expired" || (r.kind === "used" && now() >= until - interval))) {
        start = null;
        next = "ran-out";
        continue;
      }
      if (r.kind === "expired" || (r.kind === "used" && !patient)) return fail("expired", `The code ran out before it was approved: ${COMMAND} login gives you a new one.`);
      if (r.kind === "used") return fail("used", `That code was used already, or isn't known. Nothing changed: ${COMMAND} login starts again.`);
      if (r.kind === "refused") return fail("refused", `${DOMAIN} turned the sign-in down: ${r.why}`);
      o.onApproved?.();
      return this.approved(r.token, r.email, counted());
    }
  }

  /** A sign-in approved: the token kept, then who it is (if the server can say now). `counted`: for the log. */
  private async approved(token: string, email: string | null, counted: Record<string, number> = {}): Promise<SignIn> {
    try {
      await this.d.store!.set(SESSION_KEY, token);
    } catch (err) {
      // Not kept: the session on the server is let go too, so it isn't left signed in nowhere.
      void this.d.client.signOut(token).catch(() => {});
      this.d.log("account_sign_in", { ended: "save-failed", ...counted });
      return { ok: false, why: "save-failed", said: `Signed in, but the Keychain couldn't keep it (${message(err).split(token).join("…")}). Nothing changed.` };
    }
    this.access = null;
    const since = this.d.now();
    // The approval says who it is; asked only when it didn't.
    const who = email === null ? await this.d.client.session(token) : null;
    const known = email ?? (who?.kind === "ok" ? who.email : null);
    // A new session has no phone paired on the server: told by syncPhone (the app, `kiko login`).
    this.save({ email: known, since, phoneTold: false, ...(known !== null ? { checkedAt: since } : {}) });
    this.d.log("account_sign_in", { ended: "signed-in", ...counted });
    return { ok: true, email: known };
  }

  // ── Staying signed in ───────────────────────────────────────────────────

  /**
   * Asks the server who's signed in (which also keeps the session alive: it slides with use).
   * Reached: account.json brought up to date. Signed out there: the token goes, and it's said from
   * then on. Not reached (offline, the server down): still signed in, nothing changed.
   */
  async check(): Promise<Checked> {
    let token: string | null;
    try {
      token = this.token();
    } catch (err) {
      return { state: "unknown", why: `the Keychain couldn't be read: ${message(err)}` };
    }
    const saved = this.load();
    if (!token) {
      // The token gone from the Keychain (taken out by hand, an uninstall): signed out, as it is.
      if (typeof saved.since === "number") this.save(null);
      return { state: "signed-out", revoked: saved.signedOut?.why === "revoked" };
    }
    const since = typeof saved.since === "number" ? saved.since : this.d.now();
    const who = await this.d.client.session(token);
    if (who.kind === "signed-out") {
      await this.revoked("check");
      return { state: "signed-out", revoked: true };
    }
    if (who.kind !== "ok") return { state: "signed-in", email: saved.email ?? null, since, reached: false, why: who.why, plan: saved.plan ?? null, trial: saved.trial ?? null };
    this.save({ ...saved, email: who.email, since, checkedAt: this.d.now(), ...(who.phonePaired !== null ? { phoneTold: who.phonePaired } : {}), ...this.planned(saved, who.plan, who.trial) });
    return { state: "signed-in", email: who.email, since, reached: true, ...(who.macs !== null ? { macs: who.macs } : {}), plan: who.plan, trial: who.trial };
  }

  /**
   * Tells the server whether a phone is paired with this Mac (`paired`: at least one), so the
   * session never expires from disuse while one is (API.md, POST /session/phone). Only when the
   * server doesn't know it already, unless `force` (once at start). Best-effort, never waited on by
   * pairing: not reached, it's "pending" and the next try (the app's) sends it. Signed out there: the
   * token goes, as anywhere.
   */
  async syncPhone(paired: boolean, force = false): Promise<"told" | "known" | "pending" | "signed-out" | "none"> {
    const saved = this.load();
    if (typeof saved.since !== "number") return "none";
    if (!force && saved.phoneTold === paired) return "known";
    let token: string | null;
    try {
      token = this.token();
    } catch {
      return "pending";
    }
    if (!token) return "none";
    const r = await this.d.client.phone(token, paired);
    if (r.kind === "signed-out") {
      await this.revoked("phone");
      return "signed-out";
    }
    const now = this.load();
    if (r.kind !== "ok") {
      this.save({ ...now, phoneTold: null });
      this.d.log("account_phone", { paired, told: false, why: r.why });
      return "pending";
    }
    this.save({ ...now, phoneTold: paired, checkedAt: this.d.now(), ...(r.email !== null ? { email: r.email } : {}) });
    this.d.log("account_phone", { paired, told: true });
    return "told";
  }

  /**
   * A short-lived access token for the account's own calls (the trial's AI, phase 2): the one held
   * while it has more than REFRESH_EARLY_MS left, else a new one. The server not reached: the one
   * held while it's still good, else none (and still signed in). Signed out there: none, and the
   * token goes.
   */
  async accessToken(): Promise<{ jwt: string } | { none: "signed-out" | "unreachable" | "keychain"; why?: string }> {
    const now = this.d.now();
    if (this.access && this.access.expiresAt - now > REFRESH_EARLY_MS) return { jwt: this.access.jwt };
    let token: string | null;
    try {
      token = this.token();
    } catch (err) {
      return { none: "keychain", why: message(err) };
    }
    if (!token) {
      this.access = null;
      return { none: "signed-out" };
    }
    const r = await this.d.client.accessToken(token);
    if (r.kind === "ok") {
      this.access = { jwt: r.jwt, expiresAt: r.expiresAt };
      return { jwt: r.jwt };
    }
    if (r.kind === "signed-out") {
      await this.revoked("access");
      return { none: "signed-out" };
    }
    if (this.access && this.access.expiresAt > now) return { jwt: this.access.jwt };
    return { none: "unreachable", why: r.why };
  }

  /** The plan as the server says it now, kept; the notices given reset when it's another plan or period. */
  private planned(saved: Saved, plan: Plan | null, trial: Trial | null): Partial<Saved> {
    const same = saved.plan?.name === plan?.name && saved.plan?.startedAt === plan?.startedAt;
    const now = this.d.now();
    // Pro over (the server says none, or Pro past its end): kept, so it's said as Pro that ended; a plan in effect again clears it.
    const inEffect = !!plan && plan.name !== "none" && (plan.endsAt === null || plan.endsAt > now);
    const wasPro = saved.plan?.name === "pro";
    const proEnded = inEffect ? undefined : wasPro ? { at: now, paymentFailed: Boolean(saved.plan?.pro?.paymentFailed) } : (saved.proEnded ?? undefined);
    return { plan, trial, told: same ? (saved.told ?? []) : [], proEnded };
  }

  /** The access token held in memory let go (the proxy turned it down): the next one is fetched afresh. */
  forgetAccess(): void {
    this.access = null;
  }

  /**
   * The share of the plan's quota used, as the proxy just said it (x-kiko-quota-used): kept when it's
   * the plan on record and it went up by a point or more, so what's shown follows between checks.
   */
  noteUsed(plan: "trial" | "pro", share: number): void {
    const saved = this.load();
    const q = saved.plan?.quota;
    if (typeof saved.since !== "number" || saved.plan?.name !== plan || !q) return;
    const used = Math.max(0, Math.min(1, share));
    if (used < q.usedShare + 0.01) return;
    this.save({ ...saved, plan: { ...saved.plan, quota: { ...q, usedShare: used } } });
  }

  /** Whether a one-time notice (`key`) was given for this plan already, as account.json keeps it. */
  told(key: string): boolean {
    return (this.load().told ?? []).includes(key);
  }

  /** A one-time notice given: kept, so it isn't given again for this plan, in this run or the next. */
  markTold(key: string): void {
    const saved = this.load();
    if (typeof saved.since !== "number" || (saved.told ?? []).includes(key)) return;
    this.save({ ...saved, told: [...(saved.told ?? []), key] });
  }

  /** When the line `key` was last said (account.json), or null. */
  lastSaid(key: string): number | null {
    const at = this.load().said?.[key];
    return typeof at === "number" ? at : null;
  }

  /** The line `key` said now: kept, for lastSaid. */
  noteSaid(key: string, at = this.d.now()): void {
    const saved = this.load();
    if (typeof saved.since !== "number") return;
    this.save({ ...saved, said: { ...(saved.said ?? {}), [key]: at } });
  }

  // ── The relay pass ──────────────────────────────────────────────────────

  /**
   * The relay pass (API.md, "The relay pass"; core/account/phone-plan.ts) for `room`, this Mac's relay
   * room (the pass names it, and the relay takes it for that room only): the one held while it has
   * more than PASS_RENEW_MS left, is for this room and was asked for under the plan as known now, else
   * a new one from the server (a new room, after a new relay identity, asks at once; so does a plan
   * that changed: a pass asked for after it is one the relay's revocation list doesn't refuse).
   * `plan_required`: none, and the held one let go, so nothing is shown the relay. Not reached: the one
   * held while it's still good (for this room). Signed out there: none, and the token goes, as
   * anywhere. In memory only.
   */
  async relayPass(room: string): Promise<PassAnswer> {
    const now = this.d.now();
    const plan = planKey(this.load().plan);
    const held = this.pass && this.pass.expiresAt > now && this.pass.room === room ? { pass: this.pass.pass, expiresAt: this.pass.expiresAt } : null;
    if (held && held.expiresAt - now > PASS_RENEW_MS && this.pass?.plan === plan) return { ok: true, ...held, fetched: false };
    const token = this.tokenFor();
    if ("why" in token) {
      this.pass = null;
      return { ok: false, ...token };
    }
    const r = await this.d.client.relayPass(token.token, room);
    if (r.kind === "pass") {
      this.pass = { pass: r.pass, expiresAt: r.expiresAt, room, plan };
      this.trialSaid = null;
      this.d.log("account_relay_pass", { got: true, expiresAt: r.expiresAt });
      return { ok: true, pass: r.pass, expiresAt: r.expiresAt, fetched: true };
    }
    if (r.kind === "plan-required") {
      this.pass = null;
      this.trialSaid = r.trialAvailable;
      return { ok: false, why: "plan-required", trialAvailable: r.trialAvailable };
    }
    if (r.kind === "signed-out") {
      this.pass = null;
      await this.revoked("relay_pass");
      return { ok: false, why: "signed-out" };
    }
    if (held) return { ok: true, ...held, fetched: false };
    return { ok: false, why: r.kind, detail: r.why };
  }

  /** The relay pass let go (Pro ended, signed out): the next relayPass asks afresh. */
  forgetPass(): void {
    this.pass = null;
  }

  /** Whether the free trial could still start, as the server said it the last time it gave no pass; null when it hasn't. */
  trialAvailableSaid(): boolean | null {
    return this.trialSaid;
  }

  // ── The free trial ──────────────────────────────────────────────────────

  /**
   * Starts the free trial (API.md, POST /trial/start): the server runs the abuse checks. Started (or
   * running already): the plan kept, and the access token held let go, so the next one carries it.
   * Refused: why, in words (core/account/plan-words.ts trialRefusedLine). Never signs out but for
   * the server saying so.
   */
  async startTrial(words: {
    started: (endsAt: number | null) => string;
    refused: (code: string, reason: string | null, email: string | null, o?: { resetsAt?: number | null; retryAfter?: number | null }) => string;
  }): Promise<TrialStart> {
    const saved = this.load();
    if (typeof saved.since !== "number") return { ok: false, why: "not-signed-in", said: `Not signed in: ${COMMAND} login signs in first.` };
    let token: string | null;
    try {
      token = this.token();
    } catch (err) {
      return { ok: false, why: "keychain", said: `The Keychain couldn't be read: ${message(err)}` };
    }
    if (!token) return { ok: false, why: "not-signed-in", said: `Not signed in: ${COMMAND} login signs in first.` };
    const r = await this.d.client.startTrial(token);
    if (r.kind === "signed-out") {
      await this.revoked("trial");
      return { ok: false, why: "signed-out", said: SIGNED_OUT_LINE };
    }
    if (r.kind === "unreachable") return { ok: false, why: "unreachable", said: `Couldn't reach ${DOMAIN} to start the trial (${r.why}). Nothing changed: ${COMMAND} setup tries again.` };
    if (r.kind === "refused") return { ok: false, why: "refused", said: `${DOMAIN} wouldn't start the trial: ${r.why}` };
    if (r.kind === "trial-refused") {
      this.d.log("account_trial", { started: false, code: r.code });
      return { ok: false, why: "refused", code: r.code, said: words.refused(r.code, r.reason, saved.email ?? null, { resetsAt: r.resetsAt ?? null, retryAfter: r.retryAfter }) };
    }
    this.access = null;
    const now = this.load();
    this.save({ ...now, checkedAt: this.d.now(), ...this.planned(now, r.plan, r.trial) });
    this.d.log("account_trial", { started: r.started });
    return { ok: true, started: r.started, plan: r.plan, trial: r.trial, said: words.started(r.plan?.endsAt ?? r.trial?.endsAt ?? null) };
  }

  // ── Kiko Pro ────────────────────────────────────────────────────────────

  /** Kiko Pro's checkout page (Stripe's), monthly or yearly, or why there's none. Signed out there: the token goes, as anywhere. */
  async checkout(interval: "month" | "year"): Promise<{ ok: true; url: string } | BillingFailed> {
    const token = this.tokenFor();
    if ("why" in token) return { ok: false, ...token };
    const r = await this.d.client.checkout(token.token, interval);
    this.d.log("account_checkout", { interval, answered: r.kind });
    return this.billed(r, "checkout");
  }

  /** Stripe's billing page for this account (the card, invoices, cancelling), or why there's none. */
  async portal(): Promise<{ ok: true; url: string } | BillingFailed> {
    const token = this.tokenFor();
    if ("why" in token) return { ok: false, ...token };
    const r = await this.d.client.portal(token.token);
    this.d.log("account_portal", { answered: r.kind });
    return this.billed(r, "portal");
  }

  private async billed(r: Awaited<ReturnType<AccountClient["checkout"]>> | Awaited<ReturnType<AccountClient["portal"]>>, at: string): Promise<{ ok: true; url: string } | BillingFailed> {
    switch (r.kind) {
      case "page":
        return { ok: true, url: r.url };
      case "signed-out":
        await this.revoked(at);
        return { ok: false, why: "signed-out" };
      case "already-pro":
      case "no-billing":
      case "billing-unavailable":
        return { ok: false, why: r.kind };
      default:
        return { ok: false, why: r.kind, detail: r.why };
    }
  }

  /**
   * Waits for Kiko Pro after a checkout: waitForPlan until the plan is Pro and in effect. Pro: a new
   * access token at once (API.md: POST /token), so the proxy sees Pro. `signal` stops the wait (Esc):
   * paying still works, and the next check picks it up.
   */
  async waitForPro(
    o: { signal?: AbortSignal; everyMs?: number; forMs?: number } = {},
  ): Promise<{ ok: true; plan: Plan } | { ok: false; why: "stopped" | "timeout" | "signed-out" | "keychain"; detail?: string }> {
    const r = await this.waitForPlan((plan) => plan?.name === "pro" && (plan.endsAt === null || plan.endsAt > this.d.now()), o);
    if (!r.ok) return r;
    this.access = null;
    // Best-effort: not reached now, the next model call asks for one all the same.
    await this.accessToken().catch(() => {});
    this.d.log("account_pro", { started: true });
    return { ok: true, plan: r.plan! };
  }

  /**
   * Waits for the plan to change as `done` says (Pro bought; a change made on the billing page): the
   * server asked every PRO_POLL.everyMs (each a check(), so account.json follows), for PRO_POLL.forMs
   * at most. `signal` stops the wait (Esc). Not reached now and then: waited on all the same.
   */
  async waitForPlan(
    done: (plan: Plan | null, trial: Trial | null) => boolean,
    o: { signal?: AbortSignal; everyMs?: number; forMs?: number } = {},
  ): Promise<{ ok: true; plan: Plan | null; trial: Trial | null } | { ok: false; why: "stopped" | "timeout" | "signed-out" | "keychain"; detail?: string }> {
    const until = this.d.now() + (o.forMs ?? PRO_POLL.forMs);
    for (;;) {
      try {
        await this.d.sleep(o.everyMs ?? PRO_POLL.everyMs, o.signal);
      } catch {
        return { ok: false, why: "stopped" };
      }
      if (o.signal?.aborted) return { ok: false, why: "stopped" };
      const r = await this.check();
      if (r.state === "signed-out") return { ok: false, why: "signed-out" };
      if (r.state === "unknown") return { ok: false, why: "keychain", detail: r.why };
      if (r.reached && done(r.plan, r.trial)) return { ok: true, plan: r.plan, trial: r.trial };
      if (this.d.now() >= until) return { ok: false, why: "timeout" };
    }
  }

  /**
   * The proxy said Pro's allowance for this month is used (`pro_quota_used`): kept as used up until
   * `resetsAt` (account.json), so the model calls stop going through the plan until then
   * (plan-words.ts planStatus `usedUp`) and your own key, if any, takes over.
   */
  noteQuotaUsed(resetsAt: number | null): void {
    const saved = this.load();
    if (typeof saved.since !== "number" || saved.plan?.name !== "pro") return;
    const q = saved.plan.quota ?? { period: "month" as const, periodEnd: null, usedShare: 1, dailyCap: false, dailyResetsAt: null, pastCap: "stop" as const };
    this.save({ ...saved, plan: { ...saved.plan, quota: { ...q, usedShare: 1, periodEnd: resetsAt ?? q.periodEnd } } });
  }

  // ── Deleting the account ────────────────────────────────────────────────

  /**
   * Step 1 of deleting the account (API.md, POST /account/delete/code): a fresh 6-digit code sent to
   * its email, so a session token alone can't delete it. Signed out there: the token goes, as anywhere.
   */
  async deleteCode(): Promise<
    | { ok: true; email: string | null; expiresIn: number }
    | { ok: false; why: "not-signed-in" | "keychain" | "signed-out" | "unreachable" | "refused" | "rate-limited"; detail?: string; retryAfter?: number | null }
  > {
    const token = this.tokenFor();
    if ("why" in token) return { ok: false, ...token };
    const r = await this.d.client.deleteCode(token.token);
    if (r.kind === "code-sent") return { ok: true, email: r.email, expiresIn: r.expiresIn };
    if (r.kind === "signed-out") {
      await this.revoked("delete");
      return { ok: false, why: "signed-out" };
    }
    if (r.kind === "rate-limited") return { ok: false, why: "rate-limited", retryAfter: r.retryAfter };
    return { ok: false, why: r.kind, detail: r.why };
  }

  /**
   * Step 2: the account deleted with the emailed code (API.md, POST /account/delete). Deleted: this
   * Mac's token taken out of the Keychain and account.json gone (every other Mac is signed out by the
   * server). A code turned down changes nothing: `code` says which (ask again, or a new code).
   */
  async deleteAccount(
    code: string,
  ): Promise<
    | { ok: true; kept?: string }
    | { ok: false; why: "not-signed-in" | "keychain" | "signed-out" | "unreachable" | "refused"; detail?: string }
    | { ok: false; why: "code"; code: "invalid_code" | "expired_code" | "too_many_attempts" }
  > {
    const token = this.tokenFor();
    if ("why" in token) return { ok: false, ...token };
    const r = await this.d.client.deleteAccount(token.token, code);
    if (r.kind === "code-refused") return { ok: false, why: "code", code: r.code };
    if (r.kind === "signed-out") {
      await this.revoked("delete");
      return { ok: false, why: "signed-out" };
    }
    if (r.kind !== "deleted") return { ok: false, why: r.kind, detail: r.why };
    this.access = null;
    this.d.log("account_deleted", {});
    let kept: string | undefined;
    try {
      await this.d.store?.remove(SESSION_KEY);
    } catch (err) {
      // The session is gone on the server anyway: the next check finds it signed out.
      kept = message(err);
      this.d.log("account_keychain_failed", { op: "remove", error: kept });
    }
    this.save(null);
    return kept ? { ok: true, kept } : { ok: true };
  }

  /** The session token for a call of the account's own, or why there's none to use. */
  private tokenFor(): { token: string } | { why: "not-signed-in" | "keychain"; detail?: string } {
    if (typeof this.load().since !== "number") return { why: "not-signed-in" };
    try {
      const token = this.token();
      return token ? { token } : { why: "not-signed-in" };
    } catch (err) {
      return { why: "keychain", detail: message(err) };
    }
  }

  // ── Signing out ─────────────────────────────────────────────────────────

  /**
   * Signs this Mac out: the server asked to end its session, then the token taken out of the
   * Keychain whatever it said (offline: the session there ends by itself, or from the account page).
   * `server`: "done", "unreachable" (with why), or "none" (no token here). `kept`: the Keychain
   * couldn't remove it (why), so it's still signed in here.
   */
  async signOut(): Promise<{ server: "done" | "unreachable" | "none"; why?: string; kept?: string }> {
    this.access = null;
    this.pass = null;
    let token: string | null = null;
    try {
      token = this.token();
    } catch (err) {
      return { server: "none", kept: `the Keychain couldn't be read: ${message(err)}` };
    }
    let server: "done" | "unreachable" | "none" = "none";
    let why: string | undefined;
    if (token) {
      const r = await this.d.client.signOut(token);
      server = r.kind === "ok" ? "done" : "unreachable";
      if (r.kind !== "ok") why = r.why;
      try {
        await this.d.store?.remove(SESSION_KEY);
      } catch (err) {
        this.d.log("account_sign_out", { server, kept: true });
        return { server, why, kept: message(err) };
      }
    }
    this.save(null);
    this.d.log("account_sign_out", { server });
    return { server, ...(why ? { why } : {}) };
  }
}
