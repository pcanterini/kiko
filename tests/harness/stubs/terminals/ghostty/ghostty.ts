const T = () => (globalThis as any).T;
export async function listTerminals() {
  return [];
}
// T.typeMs: typing takes that long (osascript takes 100-300ms), so something can be said meanwhile.
// T.typing: typing under way now, for a case to act while it is. T.typeFails: osascript fails with it.
export async function typeText(terminalId: string, text: string) {
  T().typing = (T().typing ?? 0) + 1;
  if (T().typeMs) await new Promise((r) => setTimeout(r, T().typeMs));
  T().typing--;
  if (T().typeFails) throw new Error(T().typeFails);
  T().typed.push({ terminalId, text });
}
export async function sendKey(terminalId: string, key: string) {
  T().keys.push({ terminalId, key });
}
export async function openWindow(cwd: string, command: string) {
  T().opened.push({ cwd, command });
}
export async function runWindow(cwd: string, command: string) {
  T().opened.push({ cwd, command });
}
export const ghosttyInstalled = () => true;
export const ghosttyRunning = async () => true;
