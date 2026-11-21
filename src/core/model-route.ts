// The one place Kiko's OpenRouter calls are pointed (the Kiko account is one more model provider
// beside OpenRouter, after it):
//   1. your own OpenRouter key, when there is one: straight to openrouter.ai, no account needed, ever;
//   2. else the Kiko account, while accounts are open, you're signed in and a plan (the trial, Pro)
//      is in effect: the same calls to the trial proxy (the account service's API.md, "The AI
//      proxy"), with the 10-minute access token and the call's type (X-Kiko-Call);
//   3. else none: the call fails as it would with no key.
// The proxy's answers are OpenRouter's, so the callers (openrouter-llm.ts, classifier.ts) read them as
// ever. What only the proxy says is handled here: an access token turned down gets a new one and one
// more try (never a sign-out: only the account API's own `signed_out` is one), as does a refusal
// the plan on record says is out of date (Pro bought since the token was made); Pro past its
// month's allowance (`pro_quota_used`) is a stop until it renews: said once a period, kept in
// account.json so the calls stop going through the plan (your own key, if any, runs them; else
// none does, as with no plan); the plan's refusals (trial ended, today's share used, trials paused…)
// each become their line, said once a run (core/account/plan-words.ts), and the call fails. A
// network error or a 5xx changes nothing. Too many calls (`429 rate_limited`, not about the plan):
// Retry-After waited out when it's short (RATE_LIMIT.waitMs at most) and the call sent once more,
// else it fails quietly; only when it keeps happening is it logged and a short line said, once a run.
import { type Account } from "./account/account.ts";
import { appAccount, accountRunsModels } from "./account/app-account.ts";
import { userAgent } from "./account/client.ts";
import { type Notice, type NoAiWhy, noAiLine, refusalNotice, reminderNotice } from "./account/plan-words.ts";
import { planActive, planRunsAi } from "./account/plan-words.ts";
import { notePlanCall } from "./dollars.ts";
import { aiUrl } from "./env.ts";
import { log } from "./log.ts";
import { keyOf } from "./key-values.ts";
import { online } from "./online.ts";
import { NAME } from "./name.ts";

/** Kiko's call types, as the proxy allows them (API.md, X-Kiko-Call). */
export type CallType = "summary" | "cleanup" | "trim" | "ask" | "routing" | "classify";
export type Endpoint = "chat" | "decisions";

export const OPENROUTER_API = "https://openrouter.ai/api";
const OPENROUTER_PATHS: Record<Endpoint, string> = { chat: "/v1/chat/completions", decisions: "/alpha/decisions" };
const PROXY_PATHS: Record<Endpoint, string> = { chat: "/chat/completions", decisions: "/decisions" };

export type Route = { via: "key"; key: string } | { via: "account"; account: Account } | { via: "none" };

/**
 * A call with neither a key nor a plan to run on: its message is the line for the person (plan-words.ts
 * noAiLine), shown once a run (ui-store.ts error, by its name).
 */
export class NoAiError extends Error {
  why: NoAiWhy;
  constructor(why: NoAiWhy) {
    super(noAiLine(why));
    this.name = "NoAiError";
    this.why = why;
  }
}

type Deps = {
  ownKey: () => string | undefined;
  account: () => Account | null;
  /** The account's plan runs the calls now (as last known). */
  accountActive: () => boolean;
  aiUrl: () => string;
  fetch: typeof fetch;
  now: () => number;
  userAgent: () => string;
  /** Waits out a Retry-After (the tests' own skips it). */
  sleep: (ms: number) => Promise<void>;
  /** The app's log (never content). */
  log: (event: string, data: Record<string, unknown>) => void;
  /** A call went through the plan: no dollar amounts shown for the rest of the run (core/dollars.ts). */
  planCall: () => void;
};

/** Which way a call goes now: your own key, the account, or none. */
export function routeFor(d: Pick<Deps, "ownKey" | "account" | "accountActive">): Route {
  const key = d.ownKey()?.trim();
  if (key) return { via: "key", key };
  const account = d.account();
  if (account && d.accountActive()) return { via: "account", account };
  return { via: "none" };
}

/** A call the proxy refused for the plan's sake: the code, and the line already said. */
export class AccountAiError extends Error {
  code: string;
  constructor(code: string, line: string) {
    super(`${NAME} account: ${line}`);
    this.code = code;
  }
}

/** Too many calls: a Retry-After up to `waitMs` is waited out once; `often` refusals within `withinMs` say the busy line. */
export const RATE_LIMIT = { waitMs: 5000, often: 3, withinMs: 2 * 60_000 };
/** Said once a run when the proxy keeps saying too many calls (RATE_LIMIT). */
export const BUSY_LINE = `${NAME}'s AI is busy for a moment; trying again shortly.`;

type ErrorBody = { error?: unknown; ended_why?: unknown; resets_at?: unknown; resetsAt?: unknown; retry_after?: unknown; limit?: unknown };

/** Refusals that a plan bought since the access token was made can be behind (Pro after the trial, or after none). */
const STALE_PLAN = new Set(["no_plan", "trial_ended", "daily_cap"]);

/** The proxy's own error code, from an answer that's one (JSON with a string `error`); else null. */
async function proxyError(res: Response): Promise<{ code: string; body: ErrorBody } | null> {
  if (res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
  try {
    const body = (await res.clone().json()) as ErrorBody;
    return typeof body?.error === "string" ? { code: body.error, body } : null;
  } catch {
    return null;
  }
}

export class ModelCalls {
  private d: Deps;
  /** When the proxy said too many calls lately (RATE_LIMIT). */
  private limited: number[] = [];
  /** Notices said this run (each once). */
  private said = new Set<string>();
  /** Where notices go: the app's line and voice (app.ts); nowhere until it's set. */
  onNotice: (n: Notice) => void = () => {};
  /** A call the plan ran (the proxy answered it, no refusal): today's share back, Pro bought (app/key-offer.ts lets its offer go). */
  onPlanOk: () => void = () => {};

  constructor(d: Partial<Deps> = {}) {
    this.d = {
      ownKey: () => keyOf("OPENROUTER_API_KEY"),
      account: appAccount,
      accountActive: () => accountRunsModels(),
      aiUrl: () => aiUrl(),
      // Whether it got through says whether the Mac, and that service, are online (core/online.ts):
      // openrouter.ai with your own key, or the account's proxy, each a service of its own.
      fetch: (...a) => {
        const service = String(a[0] instanceof Request ? a[0].url : a[0]).startsWith(OPENROUTER_API) ? "openrouter" : "kiko";
        return fetch(...a).then(
          (res) => (online.ok(service), res),
          (err) => {
            if (!a[1]?.signal?.aborted) online.callFailed(service, err);
            throw err;
          },
        );
      },
      now: Date.now,
      userAgent,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log,
      planCall: notePlanCall,
      ...d,
    };
  }

  /** Why there's no route: accounts closed, signed out, or signed in with no plan running. */
  noAiWhy(): NoAiWhy {
    const account = this.d.account();
    if (!account) return "no_accounts";
    return account.view().state === "signed-in" ? "no_plan" : "signed_out";
  }

  route(): Route {
    return routeFor(this.d);
  }

  /** A notice said once a run (`perPlan`: once a plan, kept in account.json). */
  notice(n: Notice | null, account?: Account) {
    if (!n || this.said.has(n.key)) return;
    if (account?.told(n.key)) return;
    this.said.add(n.key);
    account?.markTold(n.key);
    this.onNotice(n);
  }

  /**
   * One call to OpenRouter's `endpoint`, by the route: `payload` as OpenRouter takes it; `call` (and
   * `what`, finer) for the proxy. Answers OpenRouter's answer (or the proxy's, the same shape); throws
   * on no route, on a network failure (as fetch does), and on a plan's refusal (AccountAiError, its
   * line said once).
   */
  async post(endpoint: Endpoint, payload: Record<string, unknown>, o: { call: CallType; what?: string; signal?: AbortSignal; headers?: Record<string, string> }): Promise<Response> {
    const route = this.route();
    if (route.via === "none") throw new NoAiError(this.noAiWhy());
    const json = { "Content-Type": "application/json", "X-Title": NAME, ...o.headers };
    if (route.via === "key") {
      return this.d.fetch(`${OPENROUTER_API}${OPENROUTER_PATHS[endpoint]}`, {
        method: "POST",
        headers: { ...json, Authorization: `Bearer ${route.key}` },
        body: JSON.stringify(payload),
        signal: o.signal,
      });
    }
    const account = route.account;
    this.d.planCall();
    const body = payload;
    for (let attempt = 0; ; attempt++) {
      const token = await account.accessToken();
      if ("none" in token) {
        throw new Error(
          token.none === "signed-out"
            ? `${NAME} account: signed out`
            : `${NAME} account: no access token (${token.none === "keychain" ? "the Keychain couldn't be read" : "the account server couldn't be reached"}${token.why ? `: ${token.why}` : ""})`,
        );
      }
      const res = await this.d.fetch(`${this.d.aiUrl()}${PROXY_PATHS[endpoint]}`, {
        method: "POST",
        headers: { ...json, Authorization: `Bearer ${token.jwt}`, "User-Agent": this.d.userAgent(), "X-Kiko-Call": o.call, ...(o.what ? { "X-Kiko-What": o.what } : {}) },
        body: JSON.stringify(body),
        signal: o.signal,
      });
      this.quota(res, account);
      const err = await proxyError(res);
      if (!err) {
        if (res.ok) this.onPlanOk();
        return res;
      }
      // The access token turned down (expired, a key rotated): a new one, and once more. Never a sign-out.
      if (err.code === "invalid_token" && attempt === 0) {
        await res.body?.cancel().catch(() => {});
        account.forgetAccess();
        continue;
      }
      // Turned down for a plan the account no longer has (Pro bought since this token was made, its
      // plan on record says so): a new token, and once more.
      if (STALE_PLAN.has(err.code) && attempt === 0 && this.proOnRecord(account)) {
        await res.body?.cancel().catch(() => {});
        account.forgetAccess();
        continue;
      }
      // Too many calls (not the plan's): a short Retry-After waited out and the call sent once more;
      // else it fails quietly, as any failed call. Said only when it keeps happening.
      if (err.code === "rate_limited" && res.status === 429) {
        const after = retryAfterMs(res, err.body);
        this.noteLimited(err.body.limit);
        if (attempt === 0 && after <= RATE_LIMIT.waitMs) {
          await res.body?.cancel().catch(() => {});
          await this.d.sleep(after);
          continue;
        }
        return res;
      }
      const resetsAt = timeOf(err.body.resets_at ?? err.body.resetsAt);
      const n = refusalNotice(err.code, { endedWhy: typeof err.body.ended_why === "string" ? err.body.ended_why : undefined, resetsAt });
      // Not the plan's (OpenRouter's own 4xx, a 5xx): the answer as it is, for the caller to read.
      if (!n) return res;
      await res.body?.cancel().catch(() => {});
      // Pro past its month's allowance: no more calls through the plan until it renews (account.json),
      // said once that period (in this run or the next).
      if (err.code === "pro_quota_used" || err.code === "allowance_used") {
        account.noteQuotaUsed(resetsAt);
        this.notice(n, account);
        throw new AccountAiError(err.code, n.line);
      }
      // Ended or none: so said, and the plan as last known follows (account.json at its next check).
      this.notice({ ...n, key: n.key === "daily_cap" && resetsAt ? `daily_cap:${resetsAt}` : n.key });
      throw new AccountAiError(err.code, n.line);
    }
  }

  /** A rate-limit refusal kept: RATE_LIMIT.often within RATE_LIMIT.withinMs is logged and said, once a run. */
  private noteLimited(limit: unknown) {
    const now = this.d.now();
    this.limited = [...this.limited.filter((t) => now - t < RATE_LIMIT.withinMs), now];
    if (this.limited.length < RATE_LIMIT.often) return;
    this.d.log("proxy_rate_limited", { times: this.limited.length, limit: typeof limit === "string" ? limit : null });
    this.notice({ key: "rate_limited", line: BUSY_LINE, spoken: BUSY_LINE });
  }

  /** The plan on record (account.json) is Pro, running the AI. */
  private proOnRecord(account: Account): boolean {
    const v = account.view();
    return v.state === "signed-in" && v.plan?.name === "pro" && planRunsAi(v.plan, this.d.now());
  }

  /**
   * The proxy's x-kiko-quota-used: kept as the share used (account.json, so Settings → Account and
   * the window's item follow it between checks), and past 80% of a trial, said once a trial.
   */
  private quota(res: Response, account: Account) {
    const header = res.headers.get("x-kiko-quota-used");
    const used = header === null ? Number.NaN : Number(header);
    const on = res.headers.get("x-kiko-plan");
    if ((on === "trial" || on === "pro") && Number.isFinite(used)) account.noteUsed(on, used);
    if (on !== "trial" || !(used >= 0.8)) return;
    const v = account.view();
    if (v.state !== "signed-in" || !planActive(v.plan, this.d.now())) return;
    const plan = { ...v.plan!, quota: v.plan!.quota ? { ...v.plan!.quota, usedShare: Math.max(used, v.plan!.quota.usedShare) } : null };
    this.notice(reminderNotice(plan, this.d.now()), account);
  }
}

/** How long a 429 asks to wait: its Retry-After header, else `retry_after` (seconds), else a second. */
function retryAfterMs(res: Response, body: ErrorBody): number {
  const header = Number(res.headers.get("retry-after"));
  const said = typeof body.retry_after === "number" ? body.retry_after : Number.NaN;
  const secs = Number.isFinite(header) && header >= 0 ? header : Number.isFinite(said) && said >= 0 ? said : 1;
  return secs * 1000;
}

/** A time the proxy wrote (an ISO string, or ms), or null. */
function timeOf(v: unknown): number | null {
  const ms = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** The app's: every model call goes through it. */
export const modelCalls = new ModelCalls();
