// A stand-in for the account API's public endpoints (src/core/account/client.ts; the account
// service's API.md, under /v1), on a port of
// its own on 127.0.0.1, inside the test: each route answers from a script the test sets, one answer
// per call in turn (the last one kept), and every call is recorded (its path, method, bearer, body).
// Nothing reaches the real server or the network. And a key store in memory (platform/types.ts
// KeyStore), so no test reaches the Keychain.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { KeyStore } from "../../src/platform/types.ts";

/** One answer: a status and a JSON body (`null` is JSON null), or raw text (`html`), or `drop`: the connection cut, or `hang`: never answered (until the server closes). */
export type Answer = { status?: number; json?: unknown; html?: string; headers?: Record<string, string> } | "drop" | "hang";

export type Route = "code" | "token" | "session" | "access" | "phone" | "signOut" | "trial" | "deleteCode" | "delete" | "checkout" | "portal" | "relayPass";
const PATHS: Record<string, Route> = {
  "/v1/device/code": "code",
  "/v1/device/token": "token",
  "/v1/session": "session",
  "/v1/token": "access",
  "/v1/session/phone": "phone",
  "/v1/logout": "signOut",
  "/v1/trial/start": "trial",
  "/v1/account/delete/code": "deleteCode",
  "/v1/account/delete": "delete",
  "/v1/billing/checkout": "checkout",
  "/v1/billing/portal": "portal",
  "/v1/relay/pass": "relayPass",
};

export type Call = { route: Route; method: string; bearer: string | null; body: unknown; agent: string };

/** API.md's one sign-out answer. */
export const SIGNED_OUT: Answer = { status: 401, json: { error: "signed_out", error_description: "the session is revoked" } };
/** API.md's answer while a code waits for approval. */
export const PENDING: Answer = { status: 400, json: { error: "authorization_pending" } };

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * An account's `plan` and `trial`, as API.md's "Plans and quotas" has them: a trial `daysLeft` from
 * now with `used` of its cap; Pro; none; or a trial that ended (`ended`: "time" or "cap").
 */
export function planJson(o: { plan?: "none" | "trial" | "pro"; daysLeft?: number; used?: number; ended?: "time" | "cap" } = {}) {
  const now = Date.now();
  if (o.ended) {
    const end = o.ended === "time" ? now - DAY : now + 3 * DAY;
    return {
      plan: { name: "none", source: null, started_at: null, ends_at: null, quota: null },
      trial: { started_at: iso(end - 7 * DAY), ends_at: iso(end), ended: true, ended_why: o.ended },
    };
  }
  const name = o.plan ?? "trial";
  if (name === "none") return { plan: { name: "none", source: null, started_at: null, ends_at: null, quota: null }, trial: null };
  const end = now + (o.daysLeft ?? 7) * DAY - 60_000;
  const start = name === "trial" ? end - 7 * DAY : now - 3 * DAY;
  const proEnd = now + 300 * DAY;
  const cap = name === "trial" ? 2 : 5;
  return {
    plan: {
      name,
      source: name === "trial" ? "trial" : "admin",
      started_at: iso(start),
      ends_at: iso(name === "trial" ? end : proEnd),
      quota: {
        period: name === "trial" ? "plan" : "month",
        period_start: iso(start),
        period_end: iso(name === "trial" ? end : start + 30 * DAY),
        cap_usd: cap,
        used_usd: (o.used ?? 0) * cap,
        used_share: o.used ?? 0,
        daily_cap_usd: name === "trial" ? 0.5 : null,
        daily_used_usd: 0,
        daily_resets_at: iso(Math.floor(now / DAY) * DAY + DAY),
        past_cap: name === "trial" ? "stop" : "fallback",
      },
    },
    trial: name === "trial" ? { started_at: iso(start), ends_at: iso(end), ended: false, ended_why: null } : null,
  };
}

/**
 * Kiko Pro as bought (the billing contract): planJson's Pro with its terms beside it, in the
 * contract's spelling. `used` and `week` as percentages (0 to 100).
 */
export function proJson(
  o: { used?: number; week?: number; pace?: "on_track" | "fast"; interval?: "month" | "year"; renewsAt?: number | null; cancelAt?: number | null; graceEndsAt?: number | null; failed?: boolean } = {},
) {
  const base = planJson({ plan: "pro", used: (o.used ?? 31) / 100 });
  return {
    ...base,
    plan: {
      ...base.plan,
      source: "stripe",
      interval: o.interval ?? "month",
      renewsAt: o.renewsAt === undefined ? iso(Date.UTC(2026, 11, 3, 12)) : o.renewsAt === null ? null : iso(o.renewsAt),
      cancelAt: o.cancelAt ? iso(o.cancelAt) : null,
      usedPct: o.used ?? 31,
      weekUsedPct: o.week ?? 12,
      pace: o.pace ?? "on_track",
      paymentFailed: o.failed ? { graceEndsAt: o.graceEndsAt ? iso(o.graceEndsAt) : null } : null,
    },
  };
}

/** POST /billing/checkout's (and /billing/portal's) answer: Stripe's page. */
export const billingPage = (url = "https://checkout.stripe.com/c/pay/cs_test_kiko"): Answer => ({ json: { url } });
/** A billing refusal (the contract's codes): already_pro (409), no_billing (404), billing_unavailable (503). */
export const billingRefused = (error: "already_pro" | "no_billing" | "billing_unavailable"): Answer => ({
  status: error === "already_pro" ? 409 : error === "no_billing" ? 404 : 503,
  json: { error, error_description: "test" },
});

/** POST /relay/pass's answer: a pass (a JWS-looking string) running out at `expiresAt` (ms). */
export const relayPassAnswer = (expiresAt: number, n = 1): Answer => ({ json: { pass: fakeJwt(100 + n), expiresAt } });
/** POST /relay/pass refused: the plan doesn't include the phone. */
export const planRequired = (trialAvailable: boolean): Answer => ({
  status: 403,
  json: { error: "plan_required", error_description: "The phone needs Kiko Pro or the free trial", plan: "none", trialAvailable },
});

/** GET /session's answer (and POST /session/phone's); `plan`: its plan and trial (planJson), none said by default. */
export const sessionAnswer = (o: { email?: string; phonePaired?: boolean; macs?: number; plan?: { plan: unknown; trial: unknown } } = {}): Answer => ({
  json: {
    account: { id: "3kq9", email: o.email ?? EMAIL, created_at: "2026-11-03T14:02:00.000Z" },
    session: { id: "Zp2f", created_at: "2026-11-03T14:02:00.000Z", expires_at: o.phonePaired ? null : "2027-02-01T14:02:00.000Z", phone_paired: o.phonePaired ?? false },
    macs_signed_in: o.macs ?? 1,
    ...o.plan,
  },
});

/** POST /trial/start's answer: started (or running already). */
export const trialStarted = (o: { started?: boolean; daysLeft?: number } = {}): Answer => ({ json: { started: o.started ?? true, ...planJson({ daysLeft: o.daysLeft ?? 7 }) } });
/** POST /trial/start refused (API.md's codes). */
export const trialRefused = (error: string, o: { status?: number; reason?: string; retryAfter?: number } = {}): Answer => ({
  status: o.status ?? (error === "rate_limited" ? 429 : error === "email_not_allowed" || error === "email_unverified" ? 403 : 409),
  json: { error, error_description: "test", ...(o.reason ? { reason: o.reason } : {}) },
  ...(o.retryAfter ? { headers: { "retry-after": String(o.retryAfter) } } : {}),
});

/** A JWT-looking access token (no signature anyone checks here: the Mac only passes it on). */
export function fakeJwt(n = 1) {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "EdDSA", typ: "JWT" })}.${part({ sub: "acct-1", n })}.c2lnbmF0dXJlLW5vdC1jaGVja2Vk`;
}

export const SESSION_TOKEN = "sess-test-0000aaaa1111bbbb2222";
export const EMAIL = "name@example.com";
export const USER_CODE = "ABCD-EFGH";

/** The answers a sign-in that goes well gets: a code, approved on the first poll, and who it is. */
export function happyScript(): Record<Route, Answer[]> {
  return {
    code: [
      {
        json: {
          device_code: "dev-code-1",
          user_code: USER_CODE,
          verification_uri: "https://account.kiko.sh/device",
          verification_uri_complete: `https://account.kiko.sh/device?user_code=${USER_CODE}`,
          interval: 1,
          expires_in: 600,
        },
      },
    ],
    token: [{ json: { access_token: SESSION_TOKEN, token_type: "Bearer", expires_in: 7776000, scope: "", account: { id: "3kq9", email: EMAIL } } }],
    session: [sessionAnswer()],
    access: [{ json: { access_token: fakeJwt(), token_type: "Bearer", expires_in: 600 } }],
    phone: [sessionAnswer({ phonePaired: true })],
    signOut: [{ json: { signed_out: true } }],
    trial: [trialStarted()],
    deleteCode: [{ json: { sent: true, email: EMAIL, expires_in: 300 } }],
    delete: [{ json: { deleted: true } }],
    checkout: [billingPage()],
    portal: [billingPage("https://billing.stripe.com/p/session/test_kiko")],
    relayPass: [relayPassAnswer(Date.now() + 7 * DAY)],
  };
}

/** POST /account/delete turning the code down (API.md: invalid_code, expired_code, too_many_attempts). */
export const codeRefused = (error: "invalid_code" | "expired_code" | "too_many_attempts"): Answer => ({ status: 400, json: { error, error_description: "test" } });

export async function fakeAccountServer(script: Partial<Record<Route, Answer[]>> = happyScript()) {
  const answers: Partial<Record<Route, Answer[]>> = { ...script };
  const calls: Call[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = "";
      req.on("data", (c) => (text += c));
      req.on("end", () => resolve(text));
    });
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const route = PATHS[(req.url ?? "").split("?")[0]];
    const text = await read(req);
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
      return;
    }
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    const auth = req.headers.authorization ?? "";
    calls.push({ route, method: req.method ?? "", bearer: auth.startsWith("Bearer ") ? auth.slice(7) : null, body, agent: req.headers["user-agent"] ?? "" });
    const list = answers[route] ?? [];
    const a: Answer = (list.length > 1 ? list.shift() : list[0]) ?? { status: 500, json: { error: "server_error", error_description: "no answer scripted" } };
    if (a === "drop") return void req.socket.destroy();
    if (a === "hang") return;
    if (a.html !== undefined) return void res.writeHead(a.status ?? 200, { "content-type": "text/html", ...a.headers }).end(a.html);
    res.writeHead(a.status ?? 200, { "content-type": "application/json", ...a.headers }).end(JSON.stringify(a.json ?? null));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The API's base, as KIKO_ACCOUNT_URL would give it.
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    url,
    calls,
    /** The answers from now on, for a route. */
    answer(route: Route, ...list: Answer[]) {
      answers[route] = list;
    },
    /** The calls made to a route. */
    to: (route: Route) => calls.filter((c) => c.route === route),
    /** Stops listening (the server down from here on: connections refused). */
    down: () => stopListening(server),
    close: () => stopListening(server),
  };
}

/** Stops listening, and cuts the connections kept alive (fetch keeps them), so it's down at once. */
function stopListening(server: Server) {
  return new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** A key store in memory: what's in it (`kept`), and what was asked of it. */
export function memoryStore(start: Record<string, string> = {}, o: { failSet?: string; failRemove?: string } = {}) {
  const kept: Record<string, string> = { ...start };
  const ops: string[] = [];
  const store: KeyStore = {
    where: "the test's store",
    get(names) {
      ops.push(`get ${names.join(",")}`);
      return Object.fromEntries(names.filter((n) => kept[n] !== undefined).map((n) => [n, kept[n]]));
    },
    async set(name, key) {
      ops.push(`set ${name}`);
      if (o.failSet) throw new Error(o.failSet);
      kept[name] = key;
    },
    async remove(name) {
      ops.push(`remove ${name}`);
      if (o.failRemove) throw new Error(o.failRemove);
      const had = name in kept;
      delete kept[name];
      return had;
    },
    async list() {
      return Object.keys(kept);
    },
  };
  return { store, kept, ops };
}
