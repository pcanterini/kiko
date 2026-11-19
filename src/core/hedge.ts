// One model call, made a second time when the first is slow or fails, whichever answers first
// taken. The router is between your words and the session they go to, and is usually done in
// 1–3s, but has taken ~15s. A second request started while the
// first still runs costs another call only on the rare slow one, and is safe: a call only decides,
// nothing happens until its answer is taken, and only one answer ever is.

/** How one attempt went: `won`, the answer taken; `timeout`, cut off; `lost`, cut off once the other answered. */
export type Try = {
  n: number;
  /** Started at this many ms in: 0 for the first, the hedge's wait (or a failure's time) for the second. */
  startMs: number;
  ms: number;
  how: "won" | "timeout" | "lost" | "failed" | "cancelled";
  error?: string;
  /** What the attempt itself noted for the log (request id, time to first token): `info` in run. */
  info?: Record<string, unknown>;
};

type HedgeOptions = {
  /** Cancelled from outside (a new press): every attempt is cut off, and hedged rejects with the abort. */
  signal?: AbortSignal;
  /** Not answered by then: a second attempt starts beside the first. */
  hedgeMs: number;
  /** Each attempt's own limit, from its start to its answer. */
  attemptMs: number;
  /** All attempts, the first included (2: one more). */
  tries?: number;
  /** An error a second try won't fix (a bad request, a wrong key): given up on at once. */
  retryable?: (err: unknown) => boolean;
};

/** The calls didn't answer: every attempt timed out or failed (`tries` says how). */
export class HedgeError extends Error {
  readonly tries: Try[];
  constructor(message: string, tries: Try[], cause?: unknown) {
    super(message, { cause });
    this.name = "HedgeError";
    this.tries = tries;
  }
}

/** An HTTP error the API won't answer differently on a second try: a 4xx other than 408, 409 and 429. */
export function retryable(err: unknown) {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status !== "number" || status >= 500 || status === 408 || status === 409 || status === 429;
}

/**
 * `run` once, and once more (a hedge) if it hasn't answered in `hedgeMs`, or right away if it failed
 * with an error worth retrying. The first answer is taken and the other attempt cut off (its signal
 * aborts, and whatever it answers later is dropped), so the answer is used once. `note` lets an
 * attempt add to its line in `tries` (a request id, its time to first token). Rejects with a
 * HedgeError when none answered, or with the abort when `signal` cancels it.
 */
export function hedged<T>(run: (signal: AbortSignal, n: number, note: (info: Record<string, unknown>) => void) => Promise<T>, options: HedgeOptions): Promise<{ value: T; won: number; tries: Try[] }> {
  const { signal, hedgeMs, attemptMs, tries: most = 2 } = options;
  const worthRetrying = options.retryable ?? retryable;
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);
  return new Promise((resolve, reject) => {
    const tries: Try[] = [];
    const running = new Map<number, { controller: AbortController; timer: ReturnType<typeof setTimeout>; line: Try; startedAt: number }>();
    let done = false;
    let lastError: unknown;
    let hedge: ReturnType<typeof setTimeout> | undefined;

    const end = (how: Try["how"], except?: number) => {
      done = true;
      clearTimeout(hedge);
      signal?.removeEventListener("abort", onCancel);
      for (const [n, a] of running) {
        if (n === except) continue;
        a.line.how = how;
        a.line.ms = Math.round(performance.now() - a.startedAt);
        clearTimeout(a.timer);
        a.controller.abort(new Error(how));
      }
      running.clear();
    };
    const onCancel = () => {
      if (done) return;
      end("cancelled");
      reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
    };
    // Nothing more to wait for: no attempt running, and none left to start.
    const giveUp = () => {
      if (done || running.size || tries.length < most) return;
      end("lost");
      const timedOut = tries.every((t) => t.how === "timeout");
      const message = timedOut ? `no answer: ${tries.length} tries, ${attemptMs}ms each` : `${tries.length} tries failed: ${tries.map((t) => t.error ?? t.how).join("; ")}`;
      reject(new HedgeError(message, tries, lastError));
    };

    const start = () => {
      if (done || tries.length >= most) return;
      const n = tries.length + 1;
      const controller = new AbortController();
      const line: Try = { n, startMs: since(), ms: 0, how: "lost" };
      tries.push(line);
      const startedAt = performance.now();
      const timer = setTimeout(() => {
        if (done || !running.has(n)) return;
        running.delete(n);
        line.how = "timeout";
        line.ms = Math.round(performance.now() - startedAt);
        controller.abort(new Error("timeout"));
        lastError = new Error(`no answer in ${attemptMs}ms`);
        // Timed out before the hedge: the next try now. Otherwise the other one may still answer.
        start();
        giveUp();
      }, attemptMs);
      running.set(n, { controller, timer, line, startedAt });
      const note = (info: Record<string, unknown>) => (line.info = { ...line.info, ...info });
      let value: Promise<T>;
      try {
        value = run(controller.signal, n, note);
      } catch (err) {
        value = Promise.reject(err);
      }
      value.then(
        (answer) => {
          // Cut off already (timed out, or the other answered): dropped, never used twice.
          if (done || !running.has(n)) return;
          clearTimeout(timer);
          running.delete(n);
          line.how = "won";
          line.ms = Math.round(performance.now() - startedAt);
          end("lost", n);
          resolve({ value: answer, won: n, tries });
        },
        (err) => {
          if (done || !running.has(n)) return;
          clearTimeout(timer);
          running.delete(n);
          line.how = "failed";
          line.ms = Math.round(performance.now() - startedAt);
          line.error = err instanceof Error ? err.message : String(err);
          lastError = err;
          if (!worthRetrying(err)) {
            // Wait for one still running; never start another for it.
            if (running.size) return;
            end("lost");
            return reject(err);
          }
          start();
          giveUp();
        },
      );
    };

    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", onCancel, { once: true });
    if (most > 1) hedge = setTimeout(start, hedgeMs);
    start();
  });
}
