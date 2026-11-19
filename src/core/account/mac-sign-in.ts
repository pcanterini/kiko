// This Mac's one sign-in under way, shared by whoever asks for it: a paired phone turned away because
// the Mac is signed out (remote/server.ts: the code goes to the phone, which opens the approval page),
// and the Mac itself (Settings → Kiko account → Sign in, which Enter on "Your phone can't connect:
// this Mac is signed out" opens: app/settings/account.ts follows this one through `follow`).
// One device code flow at a time (Account.signIn, the one `kiko login` runs): asked again while a code
// with a minute or more left is out, that code is the answer, so the phone and the Mac show the same
// one and either approval signs the Mac in. A code that runs out while someone still holds on (a
// phone waiting on its connection) is replaced by a new one; nobody holding, the sign-in just ends.
// Signed in some other way meanwhile (Settings, `kiko login` in a terminal: account.json says so),
// `settle` ends the one under way as signed in. Approved: the plan asked for before it's said, so a
// phone let in next is judged by the plan, not by "signed in, no plan known yet". From the approval
// on (Account.signIn's onApproved: the session being kept), it's past stopping: Stop, Esc or a new
// code asked for leave it to end as signed in, and whoever follows it hears that, never "Nothing
// changed" over a Mac that's signed in.
//
// What it says (MacSignInState) carries the code and the page for the screen and the phone; nothing
// here logs either, or a token.
import { EventEmitter } from "node:events";
import type { Account, SignIn } from "./account.ts";
import type { DeviceStart } from "./client.ts";

/** Who asked: a phone (its connection), or the Mac (Enter). */
export type SignInBy = "phone" | "mac";

/** Why a sign-in didn't go through, as the phone hears it (schema.json mac_sign_in why). */
export type SignInFailed = "denied" | "unreachable" | "refused" | "no_keychain" | "error";

export type MacSignInState =
  | { state: "idle" }
  | { state: "starting"; by: SignInBy }
  /**
   * The code is out: `code` (XXXX-XXXX), `url` the approval page with the code in it (for the phone:
   * the server's verification_uri_complete), `page` the page without it (the Mac opens this one, and
   * the code is typed there), `expiresAt` when it runs out (ms since 1970).
   */
  | { state: "code"; by: SignInBy; code: string; url: string; page: string; expiresAt: number; start: DeviceStart }
  | { state: "signed_in"; by: SignInBy | "elsewhere"; email: string | null }
  | { state: "failed"; by: SignInBy; why: SignInFailed; said: string };

/** A code with less than this left isn't handed out again: a new one is asked for. */
export const MIN_LEFT_MS = 60_000;
/** Codes asked for in a row while someone holds on and nobody approves (10 minutes each). */
export const MAX_CODES = 3;

const FAILED: Record<Exclude<SignIn, { ok: true }>["why"], SignInFailed | null> = {
  denied: "denied",
  expired: null,
  // Only a patient sign-in (setup, `kiko login`) ends these ways: never this one.
  used: null,
  "timed-out": null,
  unreachable: "unreachable",
  refused: "refused",
  cancelled: null,
  "no-keychain": "no_keychain",
  "save-failed": "error",
};

type Deps = {
  /** The app's account (null while accounts aren't open). */
  account: () => Account | null;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** After an approval, before it's said: the plan asked for, a paired phone told (best-effort). */
  after?: (a: Account) => Promise<void>;
};

export class MacSignIn extends EventEmitter<{ state: [MacSignInState] }> {
  private d: Required<Omit<Deps, "after">> & Pick<Deps, "after">;
  private now: MacSignInState = { state: "idle" };
  private run: AbortController | null = null;
  /** The run whose approval came back (the session being kept): past stopping. */
  private approved: AbortController | null = null;
  private holders = 0;
  private codes = 0;

  constructor(deps: Deps) {
    super();
    this.d = { now: Date.now, log: () => {}, ...deps };
  }

  state(): MacSignInState {
    return this.now;
  }

  /** A sign-in can be offered: accounts open and signed out (a phone is offered one only then). */
  available(): boolean {
    const a = this.d.account();
    return !!a && a.view().state !== "signed-in";
  }

  /**
   * Asked for by `by`: the one under way (a code with MIN_LEFT_MS or more left, or one being asked
   * for), or a new one. Its states come as "state" events (and state()).
   */
  start(by: SignInBy): MacSignInState {
    const s = this.now;
    if (s.state === "starting" || this.approving()) return s;
    if (s.state === "code" && s.expiresAt - this.d.now() >= MIN_LEFT_MS) return s;
    this.codes = 0;
    void this.begin(by);
    return this.now;
  }

  /** Someone waits on the sign-in (a phone's held connection): a code that runs out is replaced meanwhile. The release. */
  hold(): () => void {
    this.holders++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.holders--;
    };
  }

  /**
   * Account.signIn's shape over the shared one, for a sign-in shown on the Mac (Settings → Kiko
   * account → Sign in): the one under way joined (a phone's code, if one is out) or a new one,
   * `onCode` called with each code (again when one is replaced), resolved as it ends. `signal`
   * stops only the following: the sign-in itself goes on while a phone holds on to it.
   */
  follow(o: { onCode: (start: DeviceStart) => void | Promise<void>; signal?: AbortSignal }): Promise<SignIn> {
    return new Promise<SignIn>((resolve) => {
      let shown: string | null = null;
      const done = (r: SignIn) => {
        this.off("state", on);
        o.signal?.removeEventListener("abort", stopped);
        resolve(r);
      };
      const on = (s: MacSignInState) => {
        if (s.state === "code" && s.code !== shown) {
          shown = s.code;
          void o.onCode(s.start);
        } else if (s.state === "signed_in") done({ ok: true, email: s.email });
        else if (s.state === "failed") done({ ok: false, why: s.why === "no_keychain" ? "no-keychain" : s.why === "error" ? "save-failed" : s.why, said: s.said });
        else if (s.state === "idle") done({ ok: false, why: "cancelled", said: "Sign-in stopped. Nothing changed." });
      };
      const stopped = () => {
        // Approved already: it ends signed in in a moment, and that's the answer.
        if (this.approving()) return;
        if (this.holders === 0) this.stop();
        done({ ok: false, why: "cancelled", said: "Sign-in stopped. Nothing changed." });
      };
      this.on("state", on);
      if (o.signal?.aborted) return stopped();
      o.signal?.addEventListener("abort", stopped, { once: true });
      const now = this.start("mac");
      if (now.state === "code") on(now);
    });
  }

  /** The sign-in under way stopped (nothing kept); once approved, past stopping: it ends signed in. */
  stop() {
    if (!this.run || this.approving()) return;
    this.run.abort();
    this.run = null;
    this.set({ state: "idle" });
  }

  /**
   * Signed in some other way (Settings, `kiko login`, another Mac's approval of an older code)? Then
   * the one under way ends as signed in. True when it did.
   */
  settle(): boolean {
    const s = this.now;
    if ((s.state !== "starting" && s.state !== "code") || this.approving()) return false;
    const v = this.d.account()?.view();
    if (v?.state !== "signed-in") return false;
    this.run?.abort();
    this.run = null;
    this.d.log("mac_sign_in", { ended: "signed-in", by: "elsewhere" });
    this.set({ state: "signed_in", by: "elsewhere", email: v.email });
    return true;
  }

  /** The run under way was approved: its session is being kept, and it ends signed in. */
  private approving(): boolean {
    return this.run !== null && this.approved === this.run;
  }

  private set(s: MacSignInState) {
    this.now = s;
    this.emit("state", s);
  }

  private async begin(by: SignInBy): Promise<void> {
    this.run?.abort();
    const a = this.d.account();
    if (!a) return this.set({ state: "failed", by, why: "refused", said: "Kiko accounts aren't open." });
    const run = new AbortController();
    this.run = run;
    this.codes++;
    this.d.log("mac_sign_in", { started: by, code: this.codes });
    this.set({ state: "starting", by });
    let r: SignIn;
    try {
      r = await a.signIn({
        signal: run.signal,
        onApproved: () => {
          if (this.run === run) this.approved = run;
        },
        onCode: (start) => {
          if (this.run !== run) return;
          const expiresAt = this.d.now() + start.expiresIn * 1000;
          this.set({ state: "code", by, code: start.userCode, url: start.verificationUriComplete ?? start.verificationUri, page: start.verificationUri, expiresAt, start });
        },
      });
    } catch (err) {
      r = { ok: false, why: "save-failed", said: `Couldn't sign in: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (this.run !== run) return; // stopped, replaced, or settled meanwhile
    if (r.ok) {
      try {
        await this.d.after?.(a);
      } catch {}
      if (this.run !== run) return;
      this.run = null;
      this.approved = null;
      this.d.log("mac_sign_in", { ended: "signed-in", by });
      return this.set({ state: "signed_in", by, email: r.email });
    }
    // Ran out: a new code while someone still waits (not forever), else nothing to say.
    if (r.why === "expired" && this.holders > 0 && this.codes < MAX_CODES) return this.begin(by);
    this.run = null;
    this.approved = null;
    this.d.log("mac_sign_in", { ended: r.why, by });
    const why = FAILED[r.why];
    if (!why) return this.set({ state: "idle" });
    this.set({ state: "failed", by, why, said: r.said });
  }
}
