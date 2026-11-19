// Your words, dealt with in the order you said them (app/deliver.ts deliver): each press's words wait for
// the ones before to be decided and on their way (sent, or held a moment: hold.ts) before they're
// decided themselves. A second message never overtakes the first, and a correction ("no, that's for
// clipkit", "cancel that") sees the words it corrects. Before this, a press while the router still
// thought about the words before dropped them, without a word in the log.
//
// A turn that never lets go (a bug) can't hold the next words forever: after `maxWaitMs` they go
// ahead, and the caller logs it.

export type Turn = {
  /** The words before are on their way (or the wait ran out: `late`). */
  waitedMs: number;
  late: boolean;
  /** These words are on their way: the next ones may be decided. Once is enough; more do nothing. */
  done: () => void;
};

export class InLine {
  private last: Promise<void> = Promise.resolve();
  private now: () => number;
  private maxWaitMs: number;

  constructor(maxWaitMs = 15_000, now: () => number = Date.now) {
    this.maxWaitMs = maxWaitMs;
    this.now = now;
  }

  /** Waits for the words before to be on their way; `done` lets the next ones go. */
  async enter(): Promise<Turn> {
    const before = this.last;
    let done!: () => void;
    const mine = new Promise<void>((resolve) => (done = resolve));
    this.last = mine;
    const start = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let late = false;
    try {
      await Promise.race([before, new Promise<void>((resolve) => (timer = setTimeout(() => ((late = true), resolve()), this.maxWaitMs)))]);
    } finally {
      clearTimeout(timer);
    }
    return { waitedMs: this.now() - start, late, done };
  }
}
