// The account server's public endpoints, as the Mac uses them (the account service's API.md, "Kiko
// account API (for the Mac)"): the only file that knows their paths and shapes, so a change on the
// server is a change here. The Mac is a public client: it sends the API's address (core/env.ts
// accountUrl), the client id `kiko-cli` (no secret), a User-Agent and the Mac's name (Kiko-Mac-Name:
// what the account page calls it, "Kiko on Lacy's MacBook Pro"), and nothing else.
//
// Sign-in is the device authorization grant (RFC 8628): `deviceCode` asks for a code, the browser
// approves it, `deviceToken` is polled until then. What comes back is the session token (kept in the
// Keychain by ./account.ts). With it: `session` says who's signed in (each call slides the session),
// `accessToken` gets a 10-minute signed token, `phone` tells the server whether a phone is paired
// (while one is, the session never expires from disuse), `signOut` ends this Mac's session, and
// `deleteCode` then `deleteAccount` delete the account (a fresh code from its email first).
// Kiko Pro (phase 3): `checkout` asks for a Stripe Checkout page to buy it, `portal` for Stripe's
// billing page to manage it; each answers a link, opened in the browser (never the clipboard).
//
// Every answer is sorted into what the caller acts on. `401 {"error":"signed_out"}` is the only
// answer that means signed out. A timeout, no network, a 5xx, a captive portal's HTML, a redirect, or
// any other 401 is "unreachable", and the session token stays. No token is ever logged or put in an error.
import { execFileSync } from "node:child_process";
import { hostname, release } from "node:os";
import pkg from "../../../package.json" with { type: "json" };
import { NAME } from "../name.ts";

/** Sent with each device-flow call: names this app to the server. Public, as RFC 8628's clients are (API.md: "kiko-cli"). */
export const CLIENT_ID = "kiko-cli";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** The API's routes, under its base (`https://api.kiko.sh/v1`). */
const PATHS = {
  deviceCode: "/device/code",
  deviceToken: "/device/token",
  session: "/session",
  accessToken: "/token",
  phone: "/session/phone",
  signOut: "/logout",
  startTrial: "/trial/start",
  deleteCode: "/account/delete/code",
  deleteAccount: "/account/delete",
  checkout: "/billing/checkout",
  portal: "/billing/portal",
  relayPass: "/relay/pass",
};

/** How long one call may take. */
const CALL_MS = 10_000;

/**
 * macOS's version from Darwin's (os.release): Darwin 20–24 are macOS 11–15, and from Darwin 25
 * (macOS 26) the two go up together, one apart. Null off a Mac.
 */
export function macosVersion(darwin: string = release(), os: NodeJS.Platform = process.platform): string | null {
  const major = Number.parseInt(darwin, 10);
  if (os !== "darwin" || !Number.isFinite(major) || major < 20) return null;
  return String(major >= 25 ? major + 1 : major - 9);
}

/** What the approval page and the list of signed-in Macs say this is: "Kiko/0.4.0 (macOS 26)". */
export const userAgent = () => `${NAME}/${pkg.version}${macosVersion() ? ` (macOS ${macosVersion()})` : ""}`;

/** A code to approve (RFC 8628 §3.2). `interval` and `expiresIn` in seconds. */
export type DeviceStart = { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string | null; interval: number; expiresIn: number };

/** The server couldn't be reached, or answered nothing usable: nothing changes. `why`, for the log and a line (never a token). */
export type Unreachable = { kind: "unreachable"; why: string };
/** The server said no, plainly (a 4xx that isn't signed_out): `why` its words. */
export type Refused = { kind: "refused"; why: string };

export type DevicePoll =
  | { kind: "approved"; token: string; email: string | null }
  /** `retryAfter`: seconds the server asked to wait (a 429), on top of the longer interval. */
  | { kind: "slow_down"; retryAfter?: number }
  | { kind: "pending" }
  | { kind: "denied" }
  /** The code ran out (expired_token). */
  | { kind: "expired" }
  /** The code is unknown or used already, or another client's (invalid_grant): it can't be approved now. */
  | { kind: "used" }
  | Refused
  | Unreachable;

/**
 * Kiko Pro as it's paid for (phase 3), as GET /session's plan says it: monthly or yearly, when it
 * renews, when it ends once cancelled (null unless it is), a payment that failed (null, or until
 * when Pro goes on meanwhile), and this week's share of the month's allowance with the pace it's
 * used at (information only: never a cap). Times in ms since the epoch; shares 0 to 1.
 */
export type ProTerms = {
  interval: "month" | "year" | null;
  renewsAt: number | null;
  cancelAt: number | null;
  paymentFailed: { graceEndsAt: number | null } | null;
  weekShare: number | null;
  pace: "on_track" | "fast" | null;
};

/**
 * The account's plan (API.md, "Plans and quotas"), as the server said it. Times in ms since the
 * epoch. `quota` only while a plan is in effect; `usedShare` 0 to 1 (said as a percentage, never dollars).
 * `pro`: Pro's terms when it's paid for (null for a trial, or Pro given by hand; absent in an
 * account.json from before).
 */
export type Plan = {
  name: "none" | "trial" | "pro";
  startedAt: number | null;
  endsAt: number | null;
  quota: { period: "plan" | "month"; periodEnd: number | null; usedShare: number; dailyCap: boolean; dailyResetsAt: number | null; pastCap: "stop" | "fallback" } | null;
  pro?: ProTerms | null;
};
/** The account's trial, while it's the plan on record: running or ended, and why. */
export type Trial = { startedAt: number | null; endsAt: number | null; ended: boolean; endedWhy: "time" | "cap" | null };

/** Who's signed in, whether the server has a phone paired with this session, and the plan (null: the server didn't say). */
export type Who = { kind: "ok"; email: string | null; phonePaired: boolean | null; macs: number | null; plan: Plan | null; trial: Trial | null };

/** Why a trial didn't start (API.md, POST /trial/start), plainly. */
export type TrialRefused = {
  kind: "trial-refused";
  code: "trial_used" | "has_plan" | "email_not_allowed" | "email_unverified" | "rate_limited" | string;
  reason: string | null;
  retryAfter: number | null;
  /** When it's worth trying again (`trials_paused`'s `resets_at`: the next 00:00 UTC), ms since the epoch. */
  resetsAt?: number | null;
};
export type TrialStarted = { kind: "trial"; started: boolean; plan: Plan | null; trial: Trial | null };
export type SignedOut = { kind: "signed-out" };
/** Too many codes asked for (API.md, `429 rate_limited`): `retryAfter` seconds to wait, when said. */
export type RateLimited = { kind: "rate-limited"; retryAfter: number | null };
/** The deletion's code sent to the account's email (`expiresIn` seconds). */
export type DeleteCodeSent = { kind: "code-sent"; email: string | null; expiresIn: number };
/** The deletion's code turned down (API.md, POST /account/delete): wrong (ask again), or spent or run out (a new one). */
export type CodeRefused = { kind: "code-refused"; code: "invalid_code" | "expired_code" | "too_many_attempts" };

/** A billing page to open (Stripe's Checkout, or its billing portal): an https link. */
export type BillingPage = { kind: "page"; url: string };
/**
 * The relay pass (API.md, "The relay pass"): a signed note (an EdDSA JWS, 24 hours) the Mac shows the
 * relay so its phones may join its room, issued while the plan is the trial or Pro. `expiresAt` ms
 * since the epoch.
 */
export type RelayPass = { kind: "pass"; pass: string; expiresAt: number };
/** No pass: the plan doesn't include the phone (`403 plan_required`), and whether the free trial could still start. */
export type PlanRequired = { kind: "plan-required"; trialAvailable: boolean };

/** Billing isn't set up on the server yet (`503 billing_unavailable`): Pro isn't on sale. */
export type BillingUnavailable = { kind: "billing-unavailable" };

export type AccountClient = {
  deviceCode(): Promise<({ kind: "ok" } & DeviceStart) | Refused | Unreachable>;
  deviceToken(deviceCode: string): Promise<DevicePoll>;
  session(token: string): Promise<Who | SignedOut | Refused | Unreachable>;
  /** `expiresAt`: ms since the epoch (from `expires_in`). */
  accessToken(token: string): Promise<{ kind: "ok"; jwt: string; expiresAt: number } | SignedOut | Refused | Unreachable>;
  /** A phone paired with this Mac (at least one), or the last one unpaired. */
  phone(token: string, paired: boolean): Promise<Who | SignedOut | Refused | Unreachable>;
  /** "ok" also when the server had no such session any more (it's gone either way). */
  signOut(token: string): Promise<{ kind: "ok" } | Refused | Unreachable>;
  /** Starts the free trial (the abuse checks are the server's): started, or running already, or why not. */
  startTrial(token: string): Promise<TrialStarted | TrialRefused | SignedOut | Refused | Unreachable>;
  /** Step 1 of deleting the account: a 6-digit code sent to its email. */
  deleteCode(token: string): Promise<DeleteCodeSent | RateLimited | SignedOut | Refused | Unreachable>;
  /** Step 2: the account deleted with that code (every Mac signed out), or the code turned down. */
  deleteAccount(token: string, code: string): Promise<{ kind: "deleted" } | CodeRefused | SignedOut | Refused | Unreachable>;
  /** Kiko Pro's checkout, monthly or yearly: its page, or Pro already (`409 already_pro`), or not on sale. */
  checkout(token: string, interval: "month" | "year"): Promise<BillingPage | { kind: "already-pro" } | BillingUnavailable | SignedOut | Refused | Unreachable>;
  /** Stripe's billing page for this account (card, invoices, cancelling): its page, or nothing bought here (`404 no_billing`). */
  portal(token: string): Promise<BillingPage | { kind: "no-billing" } | BillingUnavailable | SignedOut | Refused | Unreachable>;
  /** The relay pass for this Mac's relay room (put in the pass as `room`), while the plan is the trial or Pro; else plan_required. */
  relayPass(token: string, room: string): Promise<RelayPass | PlanRequired | SignedOut | Refused | Unreachable>;
};

type Answer = { status: number; body: unknown; json: boolean; headers: Headers };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What a fetch failing means, in a few words. */
function failed(err: unknown): Unreachable {
  const e = err as { name?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return { kind: "unreachable", why: "it didn't answer in time" };
  const code = e?.cause?.code;
  return { kind: "unreachable", why: code ? `offline? (${code})` : `offline? (${message(err)})` };
}

/** An error's code (API.md: go by `error`, never by the text). */
const errorOf = (a: Answer) => (a.json && typeof (a.body as { error?: unknown })?.error === "string" ? (a.body as { error: string }).error : null);

/** A short reason from an error body: its code, and its words for logs. */
function reasonOf(a: Answer): string {
  const b = a.body as Record<string, unknown> | null;
  const said = [b?.error_description, b?.error].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const text = (said ?? `it answered ${a.status}`).replace(/\s+/g, " ").trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

/** A token as it may be kept: printable, no spaces, a sane length. */
const tokenLike = (v: unknown): v is string => typeof v === "string" && /^[\x21-\x7e]{16,4096}$/.test(v);

const time = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

/** A time as the server writes it: an ISO string, or a number (ms, or seconds when it's that small). */
const instant = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  return time(v);
};

/** A field by either spelling (API.md's snake_case, or camelCase). */
const field = (o: Record<string, unknown>, camel: string, snake: string): unknown => (camel in o ? o[camel] : o[snake]);

/** A percentage (0 to 100) as a share (0 to 1); null when it isn't one. */
const share = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : null);

/** Pro's terms, from a plan that's Pro (the contract's `interval`, `renewsAt`, `cancelAt`, `paymentFailed`, `weekUsedPct`, `pace`); null with none of them. */
function proTermsFrom(p: Record<string, unknown>): ProTerms | null {
  const interval = field(p, "interval", "interval");
  const failed = field(p, "paymentFailed", "payment_failed") as Record<string, unknown> | null | undefined;
  const pace = field(p, "pace", "pace");
  const terms: ProTerms = {
    interval: interval === "month" || interval === "year" ? interval : null,
    renewsAt: instant(field(p, "renewsAt", "renews_at")),
    cancelAt: instant(field(p, "cancelAt", "cancel_at")),
    paymentFailed: failed && typeof failed === "object" ? { graceEndsAt: instant(field(failed, "graceEndsAt", "grace_ends_at")) } : null,
    weekShare: share(field(p, "weekUsedPct", "week_used_pct")),
    pace: pace === "on_track" || pace === "fast" ? pace : null,
  };
  return Object.values(terms).some((v) => v !== null) ? terms : null;
}

/** The `plan` of an answer (GET /session, POST /trial/start), read; null when it isn't there or isn't one. */
export function planFrom(v: unknown): Plan | null {
  const p = v as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || (p.name !== "none" && p.name !== "trial" && p.name !== "pro")) return null;
  const q = p.quota as Record<string, unknown> | null | undefined;
  // Pro's `usedPct` (0 to 100), when it's said, over the quota's own share.
  const pct = share(field(p, "usedPct", "used_pct"));
  const used = pct ?? (typeof q?.used_share === "number" && Number.isFinite(q.used_share) ? Math.max(0, Math.min(1, q.used_share)) : 0);
  const pro = p.name === "pro" ? proTermsFrom(p) : null;
  return {
    name: p.name,
    startedAt: time(p.started_at),
    endsAt: time(p.ends_at),
    quota:
      q && typeof q === "object"
        ? {
            period: q.period === "month" ? "month" : "plan",
            periodEnd: time(q.period_end),
            usedShare: used,
            dailyCap: typeof q.daily_cap_usd === "number",
            dailyResetsAt: time(q.daily_resets_at),
            pastCap: q.past_cap === "fallback" ? "fallback" : "stop",
          }
        : // Pro with its share said but no quota: a month's quota from it, so the share is shown.
          pct !== null
          ? { period: "month", periodEnd: null, usedShare: pct, dailyCap: false, dailyResetsAt: null, pastCap: "stop" }
          : null,
    ...(pro ? { pro } : {}),
  };
}

/** A link a billing call answered: https only (it's opened in the browser), else null. */
function pageOf(body: unknown): string | null {
  const url = (body as { url?: unknown } | null)?.url;
  if (typeof url !== "string") return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The `trial` of an answer, read. */
export function trialFrom(v: unknown): Trial | null {
  const t = v as Record<string, unknown> | null;
  if (!t || typeof t !== "object") return null;
  return { startedAt: time(t.started_at), endsAt: time(t.ends_at), ended: t.ended === true, endedWhy: t.ended_why === "time" || t.ended_why === "cap" ? t.ended_why : null };
}

/** GET /session's (and POST /session/phone's) answer, read. */
function whoFrom(body: unknown): Who | Unreachable {
  const b = body as { account?: { email?: unknown }; session?: { phone_paired?: unknown }; macs_signed_in?: unknown; plan?: unknown; trial?: unknown } | null;
  if (!b?.account || typeof b.account !== "object") return { kind: "unreachable", why: "an answer without an account" };
  return {
    kind: "ok",
    email: typeof b.account.email === "string" ? b.account.email : null,
    phonePaired: typeof b.session?.phone_paired === "boolean" ? b.session.phone_paired : null,
    macs: typeof b.macs_signed_in === "number" ? b.macs_signed_in : null,
    plan: planFrom(b.plan),
    trial: trialFrom(b.trial),
  };
}

/**
 * This Mac's name as you see it (System Settings → General → Sharing: "Lacy's MacBook Pro"), for
 * the account page's "Kiko on Lacy's MacBook Pro" (the Kiko-Mac-Name header, API.md); the host
 * name without .local where it can't be read. Asked once.
 */
let nameOfMac: string | null = null;
export function computerName(): string {
  if (nameOfMac !== null) return nameOfMac;
  let name = "";
  if (process.platform === "darwin") {
    try {
      name = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {}
  }
  nameOfMac = (name || hostname().replace(/\.local$/, "")).slice(0, 64);
  return nameOfMac;
}

/** The Kiko-Mac-Name header's value: the name percent-encoded (API.md: printable ASCII only), or none. */
export const macNameHeader = (name: string | null): Record<string, string> => (name ? { "Kiko-Mac-Name": encodeURIComponent(name.slice(0, 64)) } : {});

/**
 * The account API at `base` (core/env.ts accountUrl). `fetch`: the tests' own, or fetch. `macName`:
 * this Mac's name for the account page (computerName unless given; null: none sent).
 */
export function accountClient(base: string, o: { fetch?: typeof fetch; callMs?: number; now?: () => number; userAgent?: string; macName?: string | null } = {}): AccountClient {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const agent = o.userAgent ?? userAgent();
  const named = macNameHeader(o.macName === undefined ? computerName() : o.macName);
  const call = async (path: string, init: { method: "GET" | "POST"; token?: string; body?: Record<string, unknown> }): Promise<Answer | Unreachable> => {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: init.method,
        headers: {
          Accept: "application/json",
          "User-Agent": agent,
          ...named,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(o.callMs ?? CALL_MS),
      });
    } catch (err) {
      return failed(err);
    }
    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      return failed(err);
    }
    const typed = (res.headers.get("content-type") ?? "").includes("json");
    try {
      return { status: res.status, body: text ? JSON.parse(text) : undefined, json: typed, headers: res.headers };
    } catch {
      return { status: res.status, body: undefined, json: false, headers: res.headers };
    }
  };
  const unreachable = (a: Answer, what: string): Unreachable => ({ kind: "unreachable", why: `${what}: ${a.json ? reasonOf(a) : `it answered ${a.status}`}` });
  /** The one answer that means signed out (API.md, "Signed out"). */
  const signedOut = (a: Answer) => a.status === 401 && errorOf(a) === "signed_out";
  /** A 4xx in JSON with its code: the server itself said no. Anything else (a 5xx, a 429, a proxy's page) is "unreachable". */
  const plainNo = (a: Answer) => a.status >= 400 && a.status < 500 && a.status !== 429 && errorOf(a) !== null;
  /** An answer to a signed-in call, by what it means. */
  const answered = <T>(a: Answer | Unreachable, what: string, ok: (a: Answer) => T | Unreachable): T | SignedOut | Refused | Unreachable => {
    if ("kind" in a) return a;
    if (signedOut(a)) return { kind: "signed-out" };
    if (a.status !== 200 || !a.json) return plainNo(a) ? { kind: "refused", why: reasonOf(a) } : unreachable(a, what);
    return ok(a);
  };

  return {
    async deviceCode() {
      const a = await call(PATHS.deviceCode, { method: "POST", body: { client_id: CLIENT_ID } });
      if ("kind" in a) return a;
      if (a.status !== 200 || !a.json) return plainNo(a) ? { kind: "refused", why: reasonOf(a) } : unreachable(a, "no code");
      const b = a.body as Record<string, unknown>;
      if (typeof b?.device_code !== "string" || typeof b.user_code !== "string" || typeof b.verification_uri !== "string") return { kind: "unreachable", why: "an answer without a code" };
      return {
        kind: "ok",
        deviceCode: b.device_code,
        userCode: b.user_code,
        verificationUri: b.verification_uri,
        verificationUriComplete: typeof b.verification_uri_complete === "string" ? b.verification_uri_complete : null,
        // RFC 8628: 5 seconds when the server doesn't say.
        interval: typeof b.interval === "number" && b.interval > 0 ? b.interval : 5,
        expiresIn: typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in : 600,
      };
    },

    async deviceToken(deviceCode) {
      const a = await call(PATHS.deviceToken, { method: "POST", body: { grant_type: GRANT_TYPE, device_code: deviceCode, client_id: CLIENT_ID } });
      if ("kind" in a) return a;
      const b = (a.body ?? {}) as Record<string, unknown>;
      if (a.status === 200 && a.json) {
        if (!tokenLike(b.access_token)) return { kind: "unreachable", why: "an approval without a token" };
        const email = (b.account as { email?: unknown } | undefined)?.email;
        return { kind: "approved", token: b.access_token, email: typeof email === "string" ? email : null };
      }
      // 429 while polling is slow_down, after Retry-After (API.md).
      if (a.status === 429) {
        const after = Number(a.headers.get("retry-after"));
        return { kind: "slow_down", ...(Number.isFinite(after) && after > 0 ? { retryAfter: Math.min(after, 300) } : {}) };
      }
      if (!a.json) return unreachable(a, "no answer");
      switch (errorOf(a)) {
        case "authorization_pending":
          return { kind: "pending" };
        case "slow_down":
          return { kind: "slow_down" };
        case "access_denied":
          return { kind: "denied" };
        // The code ran out: start again with a new one.
        case "expired_token":
          return { kind: "expired" };
        // Unknown or used already (a code works once), or another client's: a new one too, but it didn't run out.
        case "invalid_grant":
          return { kind: "used" };
      }
      return a.status >= 500 ? unreachable(a, "the server failed") : { kind: "refused", why: reasonOf(a) };
    },

    async session(token) {
      return answered(await call(PATHS.session, { method: "GET", token }), "no session", (a) => whoFrom(a.body));
    },

    async accessToken(token) {
      return answered(await call(PATHS.accessToken, { method: "POST", token }), "no access token", (a) => {
        const b = a.body as { access_token?: unknown; expires_in?: unknown };
        if (!tokenLike(b?.access_token)) return { kind: "unreachable", why: "an answer without a token" } as const;
        const life = typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in : 600;
        return { kind: "ok", jwt: b.access_token, expiresAt: now() + life * 1000 } as const;
      });
    },

    async phone(token, paired) {
      return answered(await call(PATHS.phone, { method: "POST", token, body: { paired } }), "phone not told", (a) => whoFrom(a.body));
    },

    async startTrial(token) {
      const a = await call(PATHS.startTrial, { method: "POST", token });
      if ("kind" in a) return a;
      if (signedOut(a)) return { kind: "signed-out" };
      if (a.status === 200 && a.json) {
        const b = a.body as { started?: unknown; plan?: unknown; trial?: unknown };
        return { kind: "trial", started: b?.started !== false, plan: planFrom(b?.plan), trial: trialFrom(b?.trial) };
      }
      const code = errorOf(a);
      // The checks' answers (409, 403, and a 429 that's about trials from this network): why it didn't start.
      if (code && (plainNo(a) || (a.status === 429 && code === "rate_limited"))) {
        const after = Number(a.headers.get("retry-after"));
        const reason = (a.body as { reason?: unknown })?.reason;
        const resetsAt = time((a.body as { resets_at?: unknown })?.resets_at);
        return {
          kind: "trial-refused",
          code,
          reason: typeof reason === "string" ? reason : null,
          retryAfter: Number.isFinite(after) && after > 0 ? after : null,
          ...(resetsAt !== null ? { resetsAt } : {}),
        };
      }
      return unreachable(a, "no trial");
    },

    async deleteCode(token) {
      const a = await call(PATHS.deleteCode, { method: "POST", token });
      if ("kind" in a) return a;
      if (a.status === 429 && errorOf(a) === "rate_limited") {
        const after = Number(a.headers.get("retry-after"));
        return { kind: "rate-limited", retryAfter: Number.isFinite(after) && after > 0 ? after : null };
      }
      return answered(a, "no code sent", (ok) => {
        const b = ok.body as { sent?: unknown; email?: unknown; expires_in?: unknown };
        if (b?.sent !== true) return { kind: "unreachable", why: "an answer without the code sent" } as const;
        return { kind: "code-sent", email: typeof b.email === "string" ? b.email : null, expiresIn: typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in : 300 } as const;
      });
    },

    async deleteAccount(token, code) {
      const a = await call(PATHS.deleteAccount, { method: "POST", token, body: { code } });
      if ("kind" in a) return a;
      const error = errorOf(a);
      if (a.status === 400 && (error === "invalid_code" || error === "expired_code" || error === "too_many_attempts")) return { kind: "code-refused", code: error };
      return answered(a, "not deleted", (ok) =>
        (ok.body as { deleted?: unknown })?.deleted === true ? ({ kind: "deleted" } as const) : ({ kind: "unreachable", why: "an answer without the account deleted" } as const),
      );
    },

    async checkout(token, interval) {
      const a = await call(PATHS.checkout, { method: "POST", token, body: { interval } });
      if ("kind" in a) return a;
      if (a.status === 409 && errorOf(a) === "already_pro") return { kind: "already-pro" };
      if (a.status === 503 && errorOf(a) === "billing_unavailable") return { kind: "billing-unavailable" };
      return answered(a, "no checkout", (ok) => {
        const url = pageOf(ok.body);
        return url ? ({ kind: "page", url } as const) : ({ kind: "unreachable", why: "an answer without a checkout link" } as const);
      });
    },

    async portal(token) {
      const a = await call(PATHS.portal, { method: "POST", token });
      if ("kind" in a) return a;
      if (a.status === 404 && errorOf(a) === "no_billing") return { kind: "no-billing" };
      if (a.status === 503 && errorOf(a) === "billing_unavailable") return { kind: "billing-unavailable" };
      return answered(a, "no billing page", (ok) => {
        const url = pageOf(ok.body);
        return url ? ({ kind: "page", url } as const) : ({ kind: "unreachable", why: "an answer without a billing link" } as const);
      });
    },

    async relayPass(token, room) {
      const a = await call(PATHS.relayPass, { method: "POST", token, body: { room } });
      if ("kind" in a) return a;
      if (a.status === 403 && errorOf(a) === "plan_required") return { kind: "plan-required", trialAvailable: (a.body as { trialAvailable?: unknown })?.trialAvailable === true };
      return answered(a, "no relay pass", (ok) => {
        const b = ok.body as { pass?: unknown; expiresAt?: unknown; expires_at?: unknown };
        const expiresAt = instant(b?.expiresAt ?? b?.expires_at);
        if (!tokenLike(b?.pass) || expiresAt === null) return { kind: "unreachable", why: "an answer without a pass" } as const;
        return { kind: "pass", pass: b.pass, expiresAt } as const;
      });
    },

    async signOut(token) {
      const a = await call(PATHS.signOut, { method: "POST", token });
      if ("kind" in a) return a;
      if ((a.status >= 200 && a.status < 300) || signedOut(a)) return { kind: "ok" };
      return plainNo(a) ? { kind: "refused", why: reasonOf(a) } : unreachable(a, "not signed out there");
    },
  };
}
