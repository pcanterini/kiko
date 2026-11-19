// Speaks instantly-ish: start after 5ms (T.soundDelayMs), done after T.speakMs; each in T.said with its timing.
// Stopped mid-way, it ends then, like the real one's killed `say` process exiting. The voice list and the
// one-off preview are the real ones (no case uses them).
export { macVoices, saySample } from "../../../../../src/platform/macos/say.ts";
export class Say {
  onStart = () => {};
  onEnd = () => {};
  private timers: any[] = [];
  private playing: (() => void) | null = null;
  constructor(_v?: string, _r?: string) {}
  async open(onDone: () => void = () => {}) {
    let text = "";
    let cancelled = false;
    return {
      push: (d: string) => {
        text += d;
      },
      chars: () => text.length,
      end: () => {
        if (cancelled || !text.trim()) return onDone();
        // at: asked to speak; start / end: its sound (end: when it finished or was cut).
        const said: any = { at: Date.now(), text };
        (globalThis as any).T.said.push(said);
        const done = () => {
          if (this.playing === done) this.playing = null;
          said.end = Date.now();
          this.onEnd();
          onDone();
        };
        this.timers.push(
          setTimeout(
            () => {
              this.playing = done;
              said.start = Date.now();
              this.onStart();
            },
            (globalThis as any).T.soundDelayMs ?? 5,
          ),
        );
        this.timers.push(setTimeout(done, (globalThis as any).T.speakMs));
      },
      cancel: () => {
        cancelled = true;
        this.stop();
      },
    };
  }
  stop() {
    for (const t of this.timers.splice(0)) clearTimeout(t);
    const done = this.playing;
    this.playing = null;
    if (done) setTimeout(done, 0);
  }
}
