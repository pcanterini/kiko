// Whether the Mac can reach the internet, as the app's own traffic shows it: the relay's socket and
// the model calls (core/anthropic.ts, core/model-route.ts). Nothing is sent to find out. Added
// 2026-11-12: the Mac's internet dropped for two minutes: the relay couldn't look up relay.kiko.sh, the clean-up and the router timed out, and two
// messages for Rowan waited 12s each for a router that couldn't answer before "Something went wrong".
// Known to be down, decide.ts skips the classifier and the router at once, and the words are kept
// (core/kept.ts) and routed again once something gets through (onBack) or a retry comes due.
//
// Down means a network error (the relay's or a model call's: a name that won't resolve, a network
// that can't be reached) since the last thing that got through, or a model call timing out while the
// relay is disconnected too (or the router timing out twice in a row); and only for HOLD_MS after
// that sign, so a Mac with no relay tries the models again now and then rather than staying
// "offline" with nothing to tell it otherwise. The
// relay's own retries (every half minute or so while it's down) keep the sign fresh. Back is only
// something getting through again (the relay's ready, a model's answer): `onBack` once per outage.
import { type Clock, realClock } from "./clock.ts";

/** Errors that say the network itself is the problem, not the service: DNS, no route, no network. */
const NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN", "ECONNREFUSED", "ETIMEDOUT", "ENONET", "EADDRNOTAVAIL"]);

// A sign of being down counts this long, unless a newer one comes (the relay retries well within it).
export const HOLD_MS = 90_000;

export type Down = { why: "network" | "timeouts"; detail: string; since: number };

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
  /** The last network error, or a timeout that counted (relay down), and when. */
  private failed: { at: number; why: Down["why"]; detail: string } | null = null;
  /** The last time something got through. */
  private okAt = 0;
  /** The relay's socket: up, down (dialling again), or not in use. */
  private relay: "up" | "down" | "off" = "off";
  /** The router's last time out (callTimedOut), 0 for none. */
  private routerTimeoutAt = 0;
  /** A sign of being down since the last success: the next success is "back". */
  private wasDown = false;

  /** Something got through after the app took the network as down: once per outage. */
  onBack: () => void = () => {};

  constructor(clock: Clock = realClock) {
    this.clock = clock;
  }

  /** Down now, and why; null when not known to be. */
  down(): Down | null {
    const f = this.failed;
    if (!f || f.at < this.okAt || this.clock.now() - f.at > HOLD_MS) return null;
    return { why: f.why, detail: f.detail, since: f.at };
  }

  /** A model call (or anything else of the app's) got an answer: the network works. */
  ok() {
    this.okAt = this.clock.now();
    this.back();
  }

  /** A model call failed: a network error counts at once; a timeout only while the relay is down too. */
  callFailed(where: string, err: unknown) {
    const code = networkCode(err);
    if (code) return this.note("network", `${where}: ${code}`);
  }

  /**
   * A model call gave up waiting (its own time limit, not a cancel): a sign with the relay down too;
   * without the relay to say, the router's second in a row with nothing through between (each is
   * two 8s tries, which it never needs online), so its retries don't each wait 12s.
   */
  callTimedOut(where: string) {
    if (this.relay === "down") return this.note("timeouts", `${where}: timeout, relay down`);
    if (where !== "router") return;
    const before = this.routerTimeoutAt;
    this.routerTimeoutAt = this.clock.now();
    if (before > this.okAt) this.note("timeouts", "router: timed out twice");
  }

  relayConnected() {
    this.relay = "up";
    this.ok();
  }

  relayDisconnected() {
    if (this.relay !== "off") this.relay = "down";
  }

  /** The relay's socket failed: "getaddrinfo ENOTFOUND relay.kiko.sh" is the network; anything else is only the relay. */
  relayError(err: unknown) {
    this.relay = "down";
    const code = networkCode(err);
    if (code) this.note("network", `relay: ${code}`);
  }

  /** The relay was turned off: its being away says nothing about the network. */
  relayOff() {
    this.relay = "off";
  }

  private note(why: Down["why"], detail: string) {
    // A network error is the stronger sign: a timeout doesn't replace one still counting.
    const now = this.clock.now();
    if (why === "timeouts" && this.failed?.why === "network" && this.failed.at >= this.okAt && now - this.failed.at <= HOLD_MS) return;
    this.failed = { at: now, why, detail };
    this.wasDown = true;
  }

  private back() {
    if (!this.wasDown) return;
    this.wasDown = false;
    this.failed = null;
    this.onBack();
  }
}

export const online = new Online();
