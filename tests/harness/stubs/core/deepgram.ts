// T.hints: the last words to expect the app gave speech-to-text (setHints). T.stt: this, for a case to send
// live words (onInterim). T.sttFails: finish() fails with it.
export class Deepgram {
  onInterim = (_: string) => {};
  constructor(..._: any[]) {
    (globalThis as any).T.stt = this;
  }
  connect() {
    return Promise.resolve();
  }
  begin() {}
  send() {}
  finish() {
    const T = (globalThis as any).T;
    return T.sttFails ? Promise.reject(T.sttFails) : Promise.resolve(T.heard ?? "");
  }
  audioSeconds() {
    return 1;
  }
  close() {}
  setHints(terms: string[]) {
    const T = (globalThis as any).T;
    T.hints = terms;
    T.hintCalls = (T.hintCalls ?? 0) + 1;
  }
  hinted() {
    return ((globalThis as any).T.hints ?? []).length > 0;
  }
}
