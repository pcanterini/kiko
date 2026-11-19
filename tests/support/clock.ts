// A clock that only moves when a test says so (src/core/clock.ts Clock): timers fire in order as it's
// advanced, including ones they set themselves.
import type { Clock } from "../../src/core/clock.ts";

type Timer = { id: number; at: number; fn: () => void };

export class FakeClock implements Clock {
  t = 0;
  private timers: Timer[] = [];
  private next = 1;

  now() {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number) {
    const id = this.next++;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  }

  clearTimeout(id: unknown) {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  /** Moves time on by `ms`, firing each timer due by then at its own time. */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }

  /** Timers set and not yet fired or cleared. */
  pending() {
    return this.timers.length;
  }
}
