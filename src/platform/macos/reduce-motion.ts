// Whether macOS's Reduce motion is on (System Settings → Accessibility → Display), for the voice
// glow (src/ui/window-glow.ts: none while it is). Read once a run, from `defaults read
// com.apple.universalaccess reduceMotion`: that one value, nothing else. Off when it can't be read,
// off the Mac, and under the test runner (the Mac's own settings are never read there).
import { execFile } from "node:child_process";

const TIMEOUT_MS = 2000;
// Nothing of the app's environment is passed on: it needs none.
const ENV = { PATH: "/usr/bin:/bin" };

/** `defaults read`'s answer as Reduce motion: "1" (or "true") on, anything else off. */
export const reduceMotionOf = (out: string | null): boolean => /^\s*(1|true|yes)\s*$/i.test(out ?? "");

type Run = (file: string, args: string[]) => Promise<string | null>;

const run: Run = (file, args) => new Promise((resolve) => execFile(file, args, { env: ENV, timeout: TIMEOUT_MS }, (err, out) => resolve(err ? null : String(out))));

/** Whether Reduce motion is on (see the header). */
export async function reduceMotion(exec: Run = run, platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (platform !== "darwin" || env.NODE_TEST_CONTEXT) return false;
  return reduceMotionOf(await exec("/usr/bin/defaults", ["read", "com.apple.universalaccess", "reduceMotion"]));
}
