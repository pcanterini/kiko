// The relay's shared counts of rooms opened (README.md, "Limits"): one small Durable Object per
// address (`ip:<address>`, an IPv6 address by its /64) and per account (`sub:<account>`, a relay pass's
// `sub`), named so. Each keeps the rooms opened under it and when each was last seen, and says whether
// one more may open: a room seen within the window always may (a Mac reconnecting), a new one only
// while fewer than `max` were seen in it. Unlike a count in a Worker isolate's memory, it holds across
// every isolate and location, so a flood of fresh room keys can't spread itself thin to get past it.
//
// Small and cheap: a few dozen bytes per room, one storage write when a room is new or was last
// written over an hour ago, and an alarm that empties it once everything in it is past the window
// (so an address seen once costs nothing after a day). Nothing identifying is logged; the address is
// only the object's name.
import { DurableObject } from "cloudflare:workers";

type Seen = { windowMs: number; rooms: Record<string, number> };

/** A room's last-seen time is written again only this often: one write per room per hour at most. */
const REWRITE_MS = 60 * 60_000;

export class Limiter extends DurableObject {
  /**
   * Whether `room` may open under this name now: true if it was seen within `windowMs` (its time
   * refreshed), or it's new and fewer than `max` rooms were seen in that time (then it's counted).
   */
  async admit(room: string, max: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const seen = (await this.ctx.storage.get<Seen>("seen")) ?? { windowMs, rooms: {} };
    let changed = seen.windowMs !== windowMs;
    seen.windowMs = windowMs;
    for (const [r, at] of Object.entries(seen.rooms)) {
      if (now - at >= windowMs) {
        delete seen.rooms[r];
        changed = true;
      }
    }
    const was = seen.rooms[room];
    let ok = true;
    if (was === undefined && Object.keys(seen.rooms).length >= max) ok = false;
    else if (was === undefined || now - was >= Math.min(REWRITE_MS, windowMs / 2)) {
      seen.rooms[room] = now;
      changed = true;
    }
    if (changed) await this.ctx.storage.put("seen", seen);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + windowMs);
    return ok;
  }

  /** Rooms past the window go; with none left, everything does (the object costs nothing after). */
  async alarm() {
    const now = Date.now();
    const seen = await this.ctx.storage.get<Seen>("seen");
    if (!seen) return void (await this.ctx.storage.deleteAll());
    for (const [r, at] of Object.entries(seen.rooms)) if (now - at >= seen.windowMs) delete seen.rooms[r];
    const times = Object.values(seen.rooms);
    if (times.length === 0) return void (await this.ctx.storage.deleteAll());
    await this.ctx.storage.put("seen", seen);
    await this.ctx.storage.setAlarm(Math.min(...times) + seen.windowMs);
  }
}
