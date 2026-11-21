// Whether the Mac can reach the internet, and each model service, as the app's own traffic shows
// it: the relay's socket and the model calls (core/anthropic.ts, core/model-route.ts). Nothing is
// sent to find out. Added 2026-11-12: the Mac's internet dropped for two minutes: the relay couldn't
// look up relay.kiko.sh, the clean-up and the router timed out, and two messages for Rowan waited
// 12s each for a router that couldn't answer before "Something went wrong".
//
// Split by service 2026-11-20: one service timing out (OpenRouter, for the optional classifier)
// made the whole app "offline", so the router (Haiku on the Anthropic API, answering fine) was
// never asked and the words waited 80s. Now a model call's failure is a sign about its own service
// (`Service`) only: decide.ts skips the classifier when the classifier's service is down, and the
// router when the router's is (core/services.ts says which serves what). The whole network is down
// only on the relay's own network error (a name that won't resolve, no network): the relay is a
// host of its own, so that's a real connectivity check. A service's sign with a code that says the
// Mac's own network (DNS, no route: LOCAL_CODES) is said as "offline", and anything getting through
// disproves it; one that says only that host (a time out, refused) is said with the service's name
// ("Can't reach Anthropic: …") and only that service's own answer, or HOLD_MS, clears it.
//
// A timeout counts as a sign about its service while the relay is disconnected too, or when the
// router times out twice in a row with nothing of its service through between. Each sign holds
// only for HOLD_MS, so a Mac with no relay tries the models again now and then rather than staying
// "offline" with nothing to tell it otherwise. Back is something getting through that clears a
// sign: `onBack` once for each.
import { type Clock, realClock } from "./clock.ts";
import { NAME } from "./name.ts";

/** Errors that say the network itself is the problem, not the service: DNS, no route, no network. */
const NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN", "ECONNREFUSED", "ETIMEDOUT", "ENONET", "EADDRNOTAVAIL"]);
/** Of those, the ones that say the Mac's own network (names don't resolve, no network): not one host. */
const LOCAL_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "ENETUNREACH", "ENETDOWN", "ENONET", "EADDRNOTAVAIL"]);

// A sign of being down counts this long, unless a newer one comes (the relay retries well within it).
export const HOLD_MS = 90_000;

/** The model services the app calls: the Anthropic API, OpenRouter (your own key), and the Kiko account's proxy. */
export type Service = "anthropic" | "openrouter" | "kiko";

/** A service as it's said: "Can't reach Anthropic". */
export function serviceName(s: Service) {
  return s === "anthropic" ? "Anthropic" : s === "openrouter" ? "OpenRouter" : `${NAME}'s AI`;
}

/**
 * Down now, and why. `service`: only that service is known to be unreachable (said by its name);
 * none, the network itself is.
 */
export type Down = { why: "network" | "timeouts"; detail: string; since: number; service?: Service };

/** `n`: its place in the order things happened (a clock's milliseconds can tie). */
type Sign = { at: number; n: number; why: Down["why"]; detail: string; local: boolean };

/** The network error's code behind an error (Node's fetch: TypeError "fetch failed", its cause), if it's one of NETWORK_CODES. */
export function networkCode(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return code;
    const message = e instanceof Error ? e.message : "";
    const named = message.match(/\b(E[A-Z_]{3,})\b/)?.[1];
    if (named && NETWORK_CODES.has(named)) return named;
  }
  return null;
}

export class Online {
  private clock: Clock;
  /** The network's own sign (the relay's network error), and when. */
  private net: Sign | null = null;
  /** Each service's last sign. */
  private signs = new Map<Service, Sign>();
  /** Events so far, in order: what each sign and success is numbered by. */
  private seq = 0;
  /** The last thing that got through (its number). */
  private okN = 0;
  /** Each service's last answer (its number). */
  private okOf = new Map<Service, number>();
  /** The relay's socket: up, down (dialling again), or not in use. */
  private relay: "up" | "down" | "off" = "off";
  /** Each service's last router time out (its number: callTimedOut), for "twice in a row". */
  private routerTimeoutAt = new Map<Service, number>();
  /** Signs noted since they were last cleared: the next success that clears one is "back". */
  private pending = new Set<"net" | Service>();

  /** Something got through after the app took it (the network, or the `service`) as down. */
  onBack: (service?: Service) => void = () => {};

  constructor(clock: Clock = realClock) {
    this.clock = clock;
  }

  /**
   * Down now, and why; null when not known to be. With a `service`: the network, or that service;
   * without, the network only.
   */
  down(service?: Service): Down | null {
    const now = this.clock.now();
    const net = this.net;
    if (net && net.n > this.okN && now - net.at <= HOLD_MS) return { why: net.why, detail: net.detail, since: net.at };
    if (!service) return null;
    const s = this.signs.get(service);
    if (!s || !this.counts(service, s) || now - s.at > HOLD_MS) return null;
    return { why: s.why, detail: s.detail, since: s.at, ...(s.local ? {} : { service }) };
  }

  /** A model call (or anything else of the app's) got an answer: the network works, and so does `service`. */
  ok(service?: Service) {
    const n = ++this.seq;
    this.okN = n;
    if (service) this.okOf.set(service, n);
    this.back();
  }

  /** A model call to `service` failed: a network error is a sign about it at once. */
  callFailed(service: Service, err: unknown) {
    const code = networkCode(err);
    if (code) this.note(service, "network", `${service}: ${code}`, LOCAL_CODES.has(code));
  }

  /**
   * A model call to `service` gave up waiting (its own time limit, not a cancel; `where`, which
   * call): a sign with the relay down too; without the relay to say, the router's second in a row
   * with nothing through between (each is two 8s tries, which it never needs online), so its
   * retries don't each wait 12s.
   */
  callTimedOut(where: string, service: Service) {
    if (this.relay === "down") return this.note(service, "timeouts", `${where}: timeout, relay down`, true);
    if (where !== "router") return;
    const before = this.routerTimeoutAt.get(service) ?? 0;
    this.routerTimeoutAt.set(service, ++this.seq);
    if (before > (this.okOf.get(service) ?? 0)) this.note(service, "timeouts", `${serviceName(service)}: timed out twice`, false);
  }

  relayConnected() {
    this.relay = "up";
    this.ok();
  }

  relayDisconnected() {
    if (this.relay !== "off") this.relay = "down";
  }

  /**
   * The relay's socket failed: "getaddrinfo ENOTFOUND relay.kiko.sh" is the network; anything else
   * (refused, timed out) is only the relay, though it makes a model's time out count.
   */
  relayError(err: unknown) {
    this.relay = "down";
    const code = networkCode(err);
    if (code && LOCAL_CODES.has(code)) this.note(null, "network", `relay: ${code}`, true);
  }

  /** The relay was turned off: its being away says nothing about the network. */
  relayOff() {
    this.relay = "off";
  }

  /** A service's sign still stands: not answered since by it, nor (one about the Mac's own network) by anything. */
  private counts(service: Service, s: Sign) {
    if (s.n < (this.okOf.get(service) ?? 0)) return false;
    return !(s.local && s.n < this.okN);
  }

  private note(service: Service | null, why: Down["why"], detail: string, local: boolean) {
    const now = this.clock.now();
    const before = service ? this.signs.get(service) : this.net;
    // A network error is the stronger sign: a timeout doesn't replace one still counting.
    const standing = before && (service ? this.counts(service, before) : before.n > this.okN) && now - before.at <= HOLD_MS;
    if (why === "timeouts" && before?.why === "network" && standing) return;
    const sign = { at: now, n: ++this.seq, why, detail, local };
    if (service) this.signs.set(service, sign);
    else this.net = sign;
    this.pending.add(service ?? "net");
  }

  private back() {
    let cleared: "net" | Service | null = null;
    for (const key of this.pending) {
      const s = key === "net" ? this.net : this.signs.get(key);
      const stands = s && (key === "net" ? s.n > this.okN : this.counts(key, s));
      if (stands) continue;
      this.pending.delete(key);
      if (key === "net") this.net = null;
      else this.signs.delete(key);
      cleared ??= key;
    }
    if (cleared) this.onBack(cleared === "net" ? undefined : cleared);
  }
}

export const online = new Online();
