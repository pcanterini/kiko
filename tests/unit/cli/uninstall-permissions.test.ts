// `kiko uninstall` and the helper app's macOS permissions (src/uninstall.ts uninstallAll): asked
// right after "Uninstall Kiko?" and reset then, before the helper app is quit and unregistered from
// Launch Services and before any folder goes (tccutil finds the app by its bundle id through Launch
// Services: after lsregister -u it fails, -10814, and the grants stay). Said no: nothing reset, the
// rest goes on. The reset failing: advice that works with the app gone (System Settings), never
// "run tccutil" again. The logs question stays last.
// The whole uninstall runs here, in a home folder of this test's own (HOME set before uninstall.ts
// is loaded, so its folders are under it; checked before each run), with the socket and state file
// its own too and the helper app all fakes: never the real tccutil, lsregister or Kiko.app.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "home-"));
process.env.HOME = home;
process.env.KIKO_SOCKET = join(home, "kiko-test.sock");
process.env.KIKO_STATE = join(home, "kiko-test.state.json");
// The startup files are this home's only (uninstall takes install.sh's PATH line out of them).
delete process.env.ZDOTDIR;
delete process.env.XDG_CONFIG_HOME;
const { SHARE_DIR } = await import("../../../src/core/app-root.ts");
const { CONFIG_FOLDER } = await import("../../../src/core/name.ts");
const { permissionsKeptWords, uninstallAll } = await import("../../../src/uninstall.ts");

const config = join(home, ".config", CONFIG_FOLDER);
const bundle = join(SHARE_DIR, "versions", "0.3.3", "Kiko.app");
const paths = [config, SHARE_DIR, process.env.KIKO_SOCKET, process.env.KIKO_STATE];

beforeEach(() => {
  // Never anyone's real folders: everything uninstall removes is under this test's home.
  assert.equal(homedir(), home);
  for (const p of paths) assert.ok(p.startsWith(`${home}/`), `${p} is under the test's home`);
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "dictionary.json"), "{}");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(paths[2], "");
  writeFileSync(paths[3], "{}");
});

/** One uninstall with fakes, every step recorded in order; `forget`: the permissions question's answer; `reset`: whether tccutil works. */
async function run(o: { forget: boolean; reset?: boolean }) {
  const steps: string[] = [];
  const lines: string[] = [];
  const there = () => paths.every((p) => existsSync(p)) && existsSync(bundle);
  const code = await uninstallAll({
    confirm: async (question) => {
      if (question === "Uninstall Kiko?") {
        steps.push("confirm uninstall");
        return true;
      }
      if (question.startsWith("Forget Kiko's macOS permissions")) {
        steps.push("confirm permissions");
        return o.forget;
      }
      // The logs (a checkout's STATE_DIR is the repo itself): always no.
      steps.push(question.startsWith("Delete the logs") ? "confirm logs" : `unexpected: ${question}`);
      return false;
    },
    out: (line) => lines.push(line),
    keys: null,
    running: async () => false,
    openSessions: async () => 0,
    helperApp: {
      name: "Kiko",
      id: "sh.kiko.helper",
      bundles: () => [bundle],
      quit: async () => {
        steps.push(`quit (files there: ${there()})`);
        return true;
      },
      unregister: (path) => {
        steps.push(`unregister ${path === bundle ? "Kiko.app" : path} (files there: ${there()})`);
        return true;
      },
      forgetPermissions: () => {
        steps.push(`forget permissions (files there: ${there()})`);
        return o.reset ?? true;
      },
    },
  });
  return { code, steps, lines, gone: paths.every((p) => !existsSync(p)) };
}

test("said yes: the permissions reset first, before the helper app is quit or unregistered and before any folder goes; the logs asked last", async () => {
  const r = await run({ forget: true });
  assert.deepEqual(r.steps, [
    "confirm uninstall",
    "confirm permissions",
    "forget permissions (files there: true)",
    "quit (files there: true)",
    "unregister Kiko.app (files there: true)",
    "confirm logs",
  ]);
  assert.ok(r.lines.includes("✓ Kiko's permissions are forgotten: a new install asks again."));
  assert.equal(r.gone, true);
  assert.equal(r.code, 0);
});

test("said no: nothing reset, and the rest goes on as before", async () => {
  const r = await run({ forget: false });
  assert.deepEqual(r.steps, ["confirm uninstall", "confirm permissions", "quit (files there: true)", "unregister Kiko.app (files there: true)", "confirm logs"]);
  assert.ok(!r.lines.some((l) => /permissions (are forgotten|for Kiko weren't reset)/.test(l)), "nothing said of a reset");
  assert.equal(r.gone, true);
  assert.equal(r.code, 0);
});

test("the reset fails: System Settings, which works with the app gone (never tccutil again); the rest goes on, and it ends not all done", async () => {
  const r = await run({ forget: true, reset: false });
  const words = permissionsKeptWords("Kiko");
  assert.equal(
    words,
    "macOS's permissions for Kiko weren't reset. To remove them, open System Settings → Privacy & Security and turn Kiko off (or remove it) under Microphone, Input Monitoring and Speech Recognition.",
  );
  assert.ok(r.lines.includes(`X ${words}`), r.lines.join("\n"));
  assert.ok(!r.lines.some((l) => l.includes("tccutil")), "no tccutil advice: it fails the same way once the app's unregistered");
  assert.deepEqual(r.steps.slice(2, 5), ["forget permissions (files there: true)", "quit (files there: true)", "unregister Kiko.app (files there: true)"]);
  assert.equal(r.gone, true);
  assert.ok(r.lines.includes("! Kiko is uninstalled. (Not all of it: see above.)"), r.lines.join("\n"));
  assert.equal(r.code, 1);
});

test("no helper app (KIKO_HELPER_APP=off): the permissions never asked", async () => {
  const asked: string[] = [];
  const code = await uninstallAll({
    confirm: async (question) => {
      asked.push(question);
      return question === "Uninstall Kiko?";
    },
    out: () => {},
    keys: null,
    running: async () => false,
    openSessions: async () => 0,
  });
  assert.equal(code, 0);
  assert.ok(!asked.some((q) => q.includes("permissions")), asked.join("\n"));
});
