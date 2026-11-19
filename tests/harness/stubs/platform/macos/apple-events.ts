// Never a real AppleScript from the harness: each one asked for is kept in T.appleScripts, and prints nothing.
export type ScriptRunner = (script: string, args?: string[], timeoutMs?: number) => Promise<string>;
export const runAppleScript: ScriptRunner = async (script, args = []) => {
  const T = (globalThis as any).T;
  (T.appleScripts ??= []).push({ script, args });
  return "";
};
