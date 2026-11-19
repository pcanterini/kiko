// Catch me up on the phone: what it missed, said aloud through the app's usual speech (app.ts
// openSpeech: on phones with Play on phone, on the Mac with Play on this Mac), behind whatever is
// being said and never cutting it.
//
// - summary(): one short combined summary of the updates (one quick model call, streamed as it
//   comes), grouped by session. One update is just read; a failed call reads them one by one.
// - lines(): each line, one by one, in order: a line's play button, or Read all.
//
// A catch-up is on from the moment it's asked for until the last of it has been heard (the app
// shows Stop meanwhile: state catchingUp). stop() (the phone's Stop) drops what's still to come and,
// once it's being heard, cuts it like a press; a press stops it too (pressed()).
import { spoken } from "../core/sessions.ts";
import type { Speech } from "../core/speech-lock.ts";
import type { CatchUpUpdate } from "../core/summarizer.ts";
import type { TokenUsage } from "../core/log.ts";
import { catchUpLine, checkedLine, type Missed } from "./missed.ts";

export type CatchUpOptions = {
  /** A speech in line behind whatever is being said (app/speech.ts openSpeech). */
  open: () => Promise<Speech>;
  /** One short summary of these updates, streamed to onText. Null when cancelled; throws when the call fails. */
  summarize: (updates: CatchUpUpdate[], onText: (delta: string) => void) => Promise<{ text: string; usage: TokenUsage; costUsd: number } | null>;
  /** Stops the summary being written. */
  cancelSummary: () => void;
  /** Cuts what's being said now, as a press would. */
  cut: () => void;
  /** Resolves once nothing is being said or waits to be. */
  quiet: () => Promise<void>;
  /** A catch-up started (true), or the last one is over or stopped (false). */
  changed: (on: boolean) => void;
  /** What saying it cost (the voice), once it's all pushed. */
  voiceCost: (speech: Speech) => number;
  log: (event: string, data: Record<string, unknown>) => void;
};

type Run = {
  stopped: boolean;
  /** One of its speeches got the voice: what's heard now may be it. */
  sounding: boolean;
  /** Its speeches that have the voice and aren't over. */
  speaking: Set<Speech>;
};

/** The updates as the summary is given them: the session's name said as words. */
export function catchUpUpdates(items: Missed[]): CatchUpUpdate[] {
  return items.map((x) => ({ name: x.name && spoken(x.name), kind: x.kind, text: x.checked ? `${checkedLine(x.checked)}: ${x.text}` : x.text, at: x.at }));
}

export class CatchUp {
  private o: CatchUpOptions;
  private runs = new Set<Run>();

  constructor(options: CatchUpOptions) {
    this.o = options;
  }

  /** A catch-up is being said, or waits its turn. */
  get active() {
    return this.runs.size > 0;
  }

  /** Each line, one by one, in order. */
  lines(lines: string[]) {
    if (!lines.length) return;
    const run = this.begin();
    void this.say(run, lines).catch((err) => this.failed(run, err));
  }

  /**
   * One short summary of these updates. One update is read as it is (no call); a failed call reads
   * them one by one instead.
   */
  summary(items: Missed[]) {
    if (items.length <= 1) return this.lines(items.map(catchUpLine));
    const run = this.begin();
    void this.summarize(run, items).catch((err) => this.failed(run, err));
  }

  /**
   * The phone's Stop: what's still to come is dropped, and what's being heard of it is cut, as a
   * press would. False when no catch-up was on.
   */
  stop() {
    if (!this.runs.size) return false;
    const runs = [...this.runs];
    let cut = false;
    for (const run of runs) {
      run.stopped = true;
      for (const speech of run.speaking) speech.cancel();
      run.speaking.clear();
      cut ||= run.sounding;
      this.end(run);
    }
    this.o.cancelSummary();
    if (cut) this.o.cut();
    return true;
  }

  /** A press stopped everything being said, and dropped what waited: the catch-up with it. */
  pressed() {
    if (!this.runs.size) return;
    for (const run of [...this.runs]) {
      run.stopped = true;
      run.speaking.clear();
      this.end(run);
    }
    this.o.cancelSummary();
  }

  private begin(): Run {
    const run: Run = { stopped: false, sounding: false, speaking: new Set() };
    const was = this.active;
    this.runs.add(run);
    if (!was) this.o.changed(true);
    return run;
  }

  private end(run: Run) {
    if (!this.runs.delete(run)) return;
    if (!this.runs.size) this.o.changed(false);
  }

  private failed(run: Run, err: unknown) {
    this.o.log("error", { where: "phone_catch_up", message: err instanceof Error ? err.message : String(err) });
    this.end(run);
  }

  /** The voice is this run's: what's heard is it from now (a stopped one gives it back at once). */
  private got(run: Run, speech: Speech) {
    if (run.stopped) {
      speech.cancel();
      return false;
    }
    run.sounding = true;
    run.speaking.add(speech);
    return true;
  }

  private done(run: Run, speech: Speech) {
    run.speaking.delete(speech);
    speech.end();
    return this.o.voiceCost(speech);
  }

  /** Over once everything said has been heard (or it was stopped). */
  private async over(run: Run) {
    await this.o.quiet();
    this.end(run);
  }

  private async say(run: Run, lines: string[]) {
    // All in line now, in order: anything asked for after waits behind the lot.
    const opening = lines.map(() => this.o.open());
    for (const [i, open] of opening.entries()) {
      const speech = await open;
      if (!this.got(run, speech)) continue;
      speech.push(lines[i]);
      this.done(run, speech);
    }
    if (!run.stopped) await this.over(run);
  }

  private async summarize(run: Run, items: Missed[]) {
    const opening = this.o.open();
    let speech: Speech | null = null;
    const held: string[] = [];
    let error: string | null = null;
    const started = Date.now();
    const result = this.o
      .summarize(catchUpUpdates(items), (delta) => {
        if (run.stopped) return;
        if (speech) speech.push(delta);
        else held.push(delta);
      })
      .catch((err) => {
        error = err instanceof Error ? err.message : String(err);
        return null;
      });
    const opened = await opening;
    if (!this.got(run, opened)) return this.o.cancelSummary();
    speech = opened;
    for (const delta of held.splice(0)) opened.push(delta);
    const r = await result;
    if (run.stopped) return;
    let fallback = false;
    if (!r?.text.trim()) {
      // No summary (the call failed, or said nothing): each update as it was said, one after another.
      fallback = true;
      this.o.log("phone_catch_up_fallback", { count: items.length, error: error ?? (r ? "empty" : "cancelled") });
      const lines = items.map(catchUpLine).map((l) => (/[.!?…]["')’”]*$/.test(l.trim()) ? l.trim() : `${l.trim()}.`));
      opened.push(`${r?.text.trim() ? " " : ""}${lines.join(" ")}`);
    }
    const ttsCost = this.done(run, opened);
    this.o.log("phone_catch_up_summary", {
      count: items.length,
      ids: items.map((x) => x.id),
      text: fallback ? null : r!.text,
      fallback,
      ms: Date.now() - started,
      usage: r?.usage ?? null,
      llmCost: r?.costUsd ?? 0,
      ttsCost,
    });
    await this.over(run);
  }
}
