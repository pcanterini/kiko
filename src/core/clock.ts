// Time as the timing classes see it (the floor, holds, listening, the Mac's output…), so a test can
// move it on by hand (tests/support/clock.ts FakeClock); `realClock` is the real one.

export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

/** The real clock, its timers never keeping the process alive by themselves (a watchdog, a poll). */
export const unrefClock: Clock = { ...realClock, setTimeout: (fn, ms) => setTimeout(fn, ms).unref() };
