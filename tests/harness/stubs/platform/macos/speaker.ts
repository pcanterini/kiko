// Plays like native/macos/player.swift, in time: what's written queues behind what's playing, "playing" when the queue
// starts, "idle" when it runs dry; stop() drops it all and says idle if anything was queued. Each write is in
// T.cues (the buffer) and T.played ({ pcm, at, end }: when it starts and ends playing; a cut one ends then).
const T = () => (globalThis as any).T;
const msOf = (pcm: Buffer) => ((pcm.length / 2) * 1000) / 24000;
export class Speaker {
  onPlaying = () => {};
  onIdle = () => {};
  onStalled = (_: { device: string | null; unheardMs: number }) => {};
  onBack = () => {};
  private queue: Array<{ pcm: Buffer; at: number; end: number }> = [];
  private timers: any[] = [];
  start() {
    return Promise.resolve();
  }
  write(pcm: any) {
    T().cues.push(pcm);
    const at = Math.max(Date.now(), this.queue.at(-1)?.end ?? 0);
    const played = { pcm, at, end: at + msOf(pcm) };
    T().played.push(played);
    if (!this.queue.length) this.timers.push(setTimeout(() => this.onPlaying(), 2));
    this.queue.push(played);
    this.timers.push(
      setTimeout(() => {
        this.queue.splice(this.queue.indexOf(played), 1);
        if (!this.queue.length) this.onIdle();
      }, played.end - Date.now()),
    );
  }
  stop() {
    for (const t of this.timers.splice(0)) clearTimeout(t);
    const now = Date.now();
    const cut = this.queue.splice(0);
    for (const p of cut) p.end = Math.max(p.at, Math.min(p.end, now));
    if (cut.length) this.timers.push(setTimeout(() => this.onIdle(), 1));
  }
  // The gain (mute): kept in T.volume, as the player's would be.
  volume(level: number) {
    T().volume = level;
  }
  shutdown() {}
}
