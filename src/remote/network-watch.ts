// The Mac's network changing under the relay's socket (relay-client.ts), 2026-11-13. A VPN turned on
// with the phone away: the relay's socket,
// dialled again while the VPN was still coming up, went half-open, and nothing looked at it until
// its pings ran out 75 s later; the phone couldn't get through meanwhile. So the network is watched,
// and the socket checked as soon as a change settles.
//
// The signal is the interfaces' addresses (os.networkInterfaces: a VPN's utun coming or going, Wi-Fi
// joining another network, an address changing), read every POLL_MS and compared with the last
// reading. It's one getifaddrs call, nothing is run or sent, and it works the same in Node (the
// tests) and in Bun (the release); the app has no other network signal, and its helpers' wake
// (native/macos/mic.swift) is only the mic's. Waking from sleep shows as a poll coming late by the
// wall clock: the Mac was asleep (or the process stopped) in between.
//
// A VPN coming up changes the interfaces several times over a few seconds, so nothing is said until
// they've stayed the same for SETTLE_MS; and once more AGAIN_MS later, for the connection made in
// the middle of it all that dies just after (the log's).
import { networkInterfaces } from "node:os";
import { type Clock, unrefClock } from "../core/clock.ts";

/** Why the relay's socket is checked: for the log (relay_checked, relay_disconnected). */
export type NetworkWhy = "network changed" | "wake";

/** How often the interfaces are read. */
const POLL_MS = 2_000;
/** How long they must stay the same before a change is said: longer than a poll, so changes seen at one poll after another are one. */
const SETTLE_MS = 2_500;
/** A change is said once more this long after. */
const AGAIN_MS = 5_000;
/** A poll this late was the Mac asleep, not a busy moment. */
const WAKE_MS = 10_000;

export type NetworkWatchOptions = {
  /** The interfaces, read now (os.networkInterfaces): a test gives its own. */
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  clock?: Clock;
  /** Shorter waits for tests. */
  pollMs?: number;
  settleMs?: number;
  againMs?: number;
  wakeMs?: number;
};

/**
 * The interfaces as one string, to compare: each address with its interface and netmask, sorted.
 * Loopback is left out, and so is Apple's peer-to-peer Wi-Fi (awdl, llw: AirDrop, AirPlay), which
 * comes and goes all day and is never the way to the internet.
 */
export function networkSignature(interfaces: ReturnType<typeof networkInterfaces>): string {
  const all: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (/^(awdl|llw)\d/.test(name)) continue;
    for (const a of list ?? []) if (!a.internal) all.push(`${name} ${a.address} ${a.netmask}`);
  }
  return all.sort().join("\n");
}

export class NetworkWatch {
  private o: NetworkWatchOptions;
  private changed: (why: NetworkWhy) => void;
  private clock: Clock;
  private on = false;
  private seen = "";
  private polledAt = 0;
  private poll: unknown = null;
  private settle: unknown = null;
  private again: unknown = null;
  /** What's waiting to be said once it settles. */
  private why: NetworkWhy | null = null;

  /** `changed`: the network changed (or the Mac woke) and has settled; called again AGAIN_MS later. */
  constructor(changed: (why: NetworkWhy) => void, options: NetworkWatchOptions = {}) {
    this.changed = changed;
    this.o = options;
    this.clock = options.clock ?? unrefClock;
  }

  start() {
    if (this.on) return;
    this.on = true;
    this.seen = this.read();
    this.polledAt = this.clock.now();
    this.next();
  }

  stop() {
    this.on = false;
    for (const t of [this.poll, this.settle, this.again]) this.clock.clearTimeout(t);
    this.poll = this.settle = this.again = null;
    this.why = null;
  }

  private next() {
    this.poll = this.clock.setTimeout(() => this.look(), this.o.pollMs ?? POLL_MS);
  }

  private look() {
    if (!this.on) return;
    const now = this.clock.now();
    const late = now - this.polledAt - (this.o.pollMs ?? POLL_MS);
    this.polledAt = now;
    if (late >= (this.o.wakeMs ?? WAKE_MS)) this.note("wake");
    const sig = this.read();
    if (sig !== this.seen) {
      this.seen = sig;
      this.note("network changed");
    }
    this.next();
  }

  /** The interfaces now; as last seen when they can't be read (no change). */
  private read() {
    try {
      return networkSignature((this.o.interfaces ?? networkInterfaces)());
    } catch {
      return this.seen;
    }
  }

  /**
   * A change seen: said once nothing more has changed for SETTLE_MS, and again AGAIN_MS after that.
   * Waking says more than the change that comes with it.
   */
  private note(why: NetworkWhy) {
    if (this.why !== "wake") this.why = why;
    this.clock.clearTimeout(this.settle);
    this.clock.clearTimeout(this.again);
    this.again = null;
    this.settle = this.clock.setTimeout(() => {
      this.settle = null;
      const said = this.why ?? why;
      this.why = null;
      this.changed(said);
      this.again = this.clock.setTimeout(() => {
        this.again = null;
        this.changed(said);
      }, this.o.againMs ?? AGAIN_MS);
    }, this.o.settleMs ?? SETTLE_MS);
  }
}
