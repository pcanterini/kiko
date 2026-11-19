export const KEYS: Record<string, number> = { right_option: 61 };
export class Hotkey {
  onDown = () => {};
  onUp = () => {};
  constructor(_k: string) {
    (globalThis as any).T.hotkey = this;
  }
  start() {
    return Promise.resolve();
  }
  stop() {}
}
export function captureKey() {
  return Promise.resolve("right_option");
}
