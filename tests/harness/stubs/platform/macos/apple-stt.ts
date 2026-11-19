// T.hints: the last words to expect the app gave speech-to-text (setHints). T.stt: this, for a case to send
// live words (onInterim). T.sttFails: finish() fails with it.
// Like the real helper (native/macos/speech.swift), it hears one press at a time: begin() starts a press,
// and a press begun before the last one finished cancels it (its words are gone). T.pressWords: each press's
// words, taken in turn as it begins (else finish() gives T.heard as it is then, as before); T.sttPresses:
// each press begun, with its words, the audio chunks it got, and whether it was cancelled.
// Hands-free's own (made once T.stt is taken): T.listenStt. T.listenFinal: its final words; T.listenSent and
// T.listenBegins: audio sent to it and fresh transcripts started; T.listenFails: connect() fails with it.
type Press = { words: string | null; chunks: number; cancelled: boolean };

export class AppleTranscriber {
  onInterim = (_: string) => {};
  onRestarted = () => {};
  private listening = false;
  private current: Press | null = null;
  constructor(..._: any[]) {
    const T = (globalThis as any).T;
    if (T.stt) {
      this.listening = true;
      T.listenStt = this;
    } else T.stt = this;
  }
  connect() {
    const T = (globalThis as any).T;
    return this.listening && T.listenFails ? Promise.reject(new Error(T.listenFails)) : Promise.resolve();
  }
  begin() {
    const T = (globalThis as any).T;
    if (this.listening) {
      T.listenBegins = (T.listenBegins ?? 0) + 1;
      return;
    }
    if (this.current) this.current.cancelled = true;
    this.current = { words: T.pressWords?.length ? T.pressWords.shift() : null, chunks: 0, cancelled: false };
    (T.sttPresses ??= []).push(this.current);
  }
  send() {
    const T = (globalThis as any).T;
    if (this.listening) T.listenSent = (T.listenSent ?? 0) + 1;
    else if (this.current) this.current.chunks++;
  }
  finish() {
    const T = (globalThis as any).T;
    if (this.listening) return Promise.resolve(T.listenFinal ?? "");
    const press = this.current;
    this.current = null;
    if (T.sttFails) return Promise.reject(T.sttFails);
    // T.sttDelayMs: the words (as they are now) come that much later. A press with words of its own gives
    // those; none under way (it was cancelled), nothing.
    const heard = press ? (press.words ?? T.heard ?? "") : "";
    return T.sttDelayMs ? new Promise((r) => setTimeout(() => r(heard), T.sttDelayMs)) : Promise.resolve(heard);
  }
  audioSeconds() {
    return 1;
  }
  close() {
    if (this.listening) (globalThis as any).T.listenClosed = true;
  }
  setHints(terms: string[]) {
    const T = (globalThis as any).T;
    T.hints = terms;
    T.hintCalls = (T.hintCalls ?? 0) + 1;
  }
  hinted() {
    return ((globalThis as any).T.hints ?? []).length > 0;
  }
}
