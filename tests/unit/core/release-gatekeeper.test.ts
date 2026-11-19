// The release's last check before packing (scripts/signing/gatekeeper.ts, run by scripts/release.sh
// after notarizing): Gatekeeper must accept a quarantined copy of every executable as Notarized
// Developer ID, asked again until it does or the time is up, and never by starting a copy. Without
// Apple: spctl's verdict parsed, the waiting on a fake clock, and the script itself with stand-ins
// for spctl and xattr (KIKO_SPCTL, KIKO_XATTR) that say "not found" a few times first.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { type Assessment, parseAssessment, waitForGatekeeper } from "../../../scripts/signing/gatekeeper.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(REPO, "scripts", "signing", "gatekeeper.ts");

// What spctl -vv says (2026-11-02, macOS 27), of a quarantined copy.
const NOTARIZED = "/t/kiko: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Bald Cactus, LLC (YU89X2P36Z)\n";
const UNNOTARIZED = "/t/kiko: rejected\nsource=Unnotarized Developer ID\norigin=Developer ID Application: Bald Cactus, LLC (YU89X2P36Z)\n";

describe("spctl's verdict", () => {
  test("accepted only as Notarized Developer ID", () => {
    assert.equal(parseAssessment(0, NOTARIZED).accepted, true);
    assert.equal(parseAssessment(3, UNNOTARIZED).accepted, false);
    // --type execute's answer for any bare executable, notarized or not: not a yes.
    assert.equal(parseAssessment(3, "/t/kiko: rejected (the code is valid but does not seem to be an app)\norigin=Developer ID Application: X (Y)").accepted, false);
    // Accepted, but not as notarized (e.g. a Developer ID rule without notarization): not enough.
    assert.equal(parseAssessment(0, "/t/kiko: accepted\nsource=Developer ID\n").accepted, false);
    // The words without spctl's success: not a yes either.
    assert.equal(parseAssessment(1, NOTARIZED).accepted, false);
    assert.equal(parseAssessment(null, "").accepted, false);
  });
});

describe("waiting for Gatekeeper", () => {
  /** A fake clock the sleeps move on. */
  function clock() {
    let t = 0;
    const slept: number[] = [];
    return {
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
      slept,
    };
  }

  test("asks again, only about those not accepted yet, until all are", async () => {
    const c = clock();
    const asked: string[] = [];
    // kiko is "not found" for two rounds (the ticket service catching up), mic at once.
    const rounds: Record<string, number> = { "arm64/kiko-1/kiko": 2, "arm64/kiko-1/native/mic": 0 };
    const assess = (file: string): Assessment => {
      asked.push(file);
      return rounds[file]-- > 0 ? parseAssessment(3, UNNOTARIZED) : parseAssessment(0, NOTARIZED);
    };
    const waits: number[] = [];
    const refused = await waitForGatekeeper({ files: Object.keys(rounds), assess, timeoutMs: 600_000, intervalMs: 10_000, ...c, waiting: (p) => waits.push(p.length) });
    assert.equal(refused.size, 0);
    assert.deepEqual(asked, ["arm64/kiko-1/kiko", "arm64/kiko-1/native/mic", "arm64/kiko-1/kiko", "arm64/kiko-1/kiko"]);
    assert.deepEqual(c.slept, [10_000, 10_000]);
    assert.deepEqual(waits, [1, 1]);
  });

  test("gives up when the time is up, with what spctl last said of each still refused", async () => {
    const c = clock();
    let asked = 0;
    const refused = await waitForGatekeeper({
      files: ["a", "b"],
      assess: (file) => {
        asked++;
        return file === "a" ? parseAssessment(0, NOTARIZED) : parseAssessment(3, `round ${asked}\n${UNNOTARIZED}`);
      },
      timeoutMs: 30_000,
      intervalMs: 10_000,
      ...c,
    });
    assert.deepEqual([...refused.keys()], ["b"]);
    assert.match(refused.get("b") ?? "", /Unnotarized Developer ID/);
    // Rounds at 0, 10, 20 and 30 s; none after the time is up.
    assert.deepEqual(c.slept, [10_000, 10_000, 10_000]);
    assert.ok(c.now() <= 30_000);
    assert.equal(asked, 2 + 3);
  });

  test("no wait at all: one round", async () => {
    const c = clock();
    const refused = await waitForGatekeeper({ files: ["a"], assess: () => parseAssessment(3, UNNOTARIZED), timeoutMs: 0, intervalMs: 10_000, ...c });
    assert.equal(refused.size, 1);
    assert.deepEqual(c.slept, []);
  });
});

describe("scripts/signing/gatekeeper.ts", () => {
  /**
   * A release-like folder whose "executables" would leave a mark if anything ran them, and stand-ins
   * for xattr (writes the attribute beside the file) and spctl (accepts a file only once it's a
   * quarantined copy, never an original, and after `notFound` refusals of it).
   */
  function setup(notFound: number) {
    const dir = mkdtempSync(join(tmpdir(), "gk-test-"));
    const ran = join(dir, "RAN");
    const release = join(dir, "build", "arm64", "kiko-9.9.9");
    mkdirSync(join(release, "native"), { recursive: true });
    for (const file of ["kiko", "native/mic"]) {
      writeFileSync(join(release, file), `#!/bin/sh\necho "$0" >> '${ran}'\n`);
      chmodSync(join(release, file), 0o755);
    }
    const stubs = join(dir, "stubs");
    mkdirSync(stubs);
    const xattr = join(stubs, "xattr");
    writeFileSync(xattr, `#!/bin/sh\n[ "$1" = -w ] && [ "$2" = com.apple.quarantine ] || exit 9\nprintf '%s' "$3" > "$4.quarantine"\n`);
    const calls = join(dir, "calls");
    mkdirSync(calls);
    const spctl = join(stubs, "spctl");
    writeFileSync(
      spctl,
      `#!/bin/sh
echo "$*" >> '${join(dir, "spctl-args")}'
for f; do :; done
n=$(cat '${calls}'/"$(basename "$f")" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > '${calls}'/"$(basename "$f")"
case $f in '${release}'/*) echo "$f: an original, not a copy" >&2; exit 7 ;; esac
grep -q ';Safari;' "$f.quarantine" 2>/dev/null || { echo "$f: rejected (not quarantined)" >&2; exit 8; }
if [ $n -le ${notFound} ]; then printf '%s: rejected\\nsource=Unnotarized Developer ID\\n' "$f" >&2; exit 3; fi
printf '%s: accepted\\nsource=Notarized Developer ID\\n' "$f" >&2
`,
    );
    chmodSync(xattr, 0o755);
    chmodSync(spctl, 0o755);
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    const run = (timeout: string) =>
      spawnSync("node", [SCRIPT, join(release, "kiko"), join(release, "native", "mic")], {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: tmp, KIKO_SPCTL: spctl, KIKO_XATTR: xattr, KIKO_GATEKEEPER_TIMEOUT: timeout, KIKO_GATEKEEPER_INTERVAL: "0.05" },
        timeout: 30_000,
      });
    return { dir, ran, release, tmp, run };
  }

  test("waits through Gatekeeper's refusals, assessing quarantined copies with the open context, never running one", () => {
    const { dir, ran, release, tmp, run } = setup(2);
    const said = run("30");
    assert.equal(said.status, 0, said.stderr);
    assert.match(said.stdout, /waiting for Apple's ticket/);
    assert.match(said.stdout, /each of the 2 executables is accepted as Notarized Developer ID/);
    const args = readFileSync(join(dir, "spctl-args"), "utf8").trim().split("\n");
    assert.equal(args.length, 6, "three rounds of two");
    for (const line of args) assert.match(line, /^--assess -vv --type open --context context:primary-signature \S+\/kiko-gatekeeper-[^/]+\/kiko-9\.9\.9\/(kiko|native\/mic)$/);
    assert.equal(existsSync(ran), false, "nothing ran a copy (or an original)");
    assert.equal(existsSync(join(release, "kiko.quarantine")), false, "the original isn't quarantined");
    assert.deepEqual(readdirSync(tmp), [], "the copies are gone");
  });

  test("an app bundle (the helper app): copied whole, every file quarantined, assessed as an app (--type execute)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gk-app-"));
    const app = join(dir, "build", "arm64", "kiko-9.9.9", "Kiko.app");
    mkdirSync(join(app, "Contents", "Helpers"), { recursive: true });
    writeFileSync(join(app, "Contents", "Helpers", "mic"), "#!/bin/sh\nexit 0\n");
    const stubs = join(dir, "stubs");
    mkdirSync(stubs);
    const xattr = join(stubs, "xattr");
    writeFileSync(xattr, `#!/bin/sh\n[ "$1" = -r ] && [ "$2" = -w ] && [ "$3" = com.apple.quarantine ] || exit 9\nprintf '%s' "$4" > "$5/.quarantine"\n`);
    const spctl = join(stubs, "spctl");
    writeFileSync(
      spctl,
      `#!/bin/sh\necho "$*" >> '${join(dir, "spctl-args")}'\nfor f; do :; done\n[ -f "$f/Contents/Helpers/mic" ] && grep -q ';Safari;' "$f/.quarantine" || exit 8\nprintf '%s: accepted\\nsource=Notarized Developer ID\\n' "$f" >&2\n`,
    );
    chmodSync(xattr, 0o755);
    chmodSync(spctl, 0o755);
    const tmp = join(dir, "tmp");
    mkdirSync(tmp);
    const said = spawnSync("node", [SCRIPT, app], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: tmp, KIKO_SPCTL: spctl, KIKO_XATTR: xattr, KIKO_GATEKEEPER_TIMEOUT: "5", KIKO_GATEKEEPER_INTERVAL: "0.05" },
      timeout: 30_000,
    });
    assert.equal(said.status, 0, said.stderr);
    assert.match(readFileSync(join(dir, "spctl-args"), "utf8"), /^--assess -vv --type execute \S+\/kiko-gatekeeper-[^/]+\/kiko-9\.9\.9\/Kiko\.app$/m);
    assert.equal(existsSync(join(app, ".quarantine")), false, "the original isn't quarantined");
    assert.deepEqual(readdirSync(tmp), [], "the copy is gone");
  });

  test("times out with each file refused, what spctl said, and nothing packed", () => {
    const { ran, tmp, run } = setup(1_000);
    const said = run("0.2");
    assert.equal(said.status, 1);
    assert.match(said.stderr, /after 0\.2 s, Gatekeeper still refuses a downloaded copy of kiko-9\.9\.9\/kiko, kiko-9\.9\.9\/native\/mic/);
    assert.match(said.stderr, /Nothing packed/);
    assert.match(said.stderr, /source=Unnotarized Developer ID/);
    assert.equal(existsSync(ran), false);
    assert.deepEqual(readdirSync(tmp), []);
  });
});

describe("scripts/release.sh", () => {
  const script = readFileSync(join(REPO, "scripts", "release.sh"), "utf8");

  test("on the full path, packs only after notarizing and Gatekeeper's gate (scripts/signing/notarize.ts, stopping the build)", () => {
    const notarize = script.slice(script.indexOf("notarize() {"), script.indexOf("\n}\n", script.indexOf("notarize() {")));
    assert.match(notarize, /node scripts\/signing\/notarize\.ts [^\n]*\n[^\n]*"\$BUILD\/notary" \|\|\n[^\n]*exit 1; }/);
    assert.ok(script.indexOf("\n  notarize $built") > 0 && script.indexOf("\n  notarize $built") < script.indexOf('\n  pack_arch "$arch"'), "notarized (and the gate passed) before packing");
    // notarize.ts: the ticket check, then the gate (its order is tested with stand-ins in release-ship.test.ts).
    const steps = readFileSync(join(REPO, "scripts", "signing", "notarize.ts"), "utf8");
    assert.ok(steps.indexOf("d.tickets(log, files)") > 0 && steps.indexOf("d.gatekeeper(files)") > steps.indexOf("d.tickets(log, files)"));
  });

  test("no release script quarantines a file or starts one that is (only gatekeeper.ts marks copies, and it never runs them)", () => {
    for (const file of ["scripts/release.sh", "scripts/signing/notarized.ts", "scripts/signing/notarize.ts", "scripts/signing/release-files.ts", "scripts/ship/ship.ts", "install.sh"]) {
      assert.doesNotMatch(readFileSync(join(REPO, file), "utf8"), /com\.apple\.quarantine/, file);
    }
    const gate = readFileSync(SCRIPT, "utf8");
    // Its only programs: xattr and spctl.
    assert.deepEqual([...gate.matchAll(/spawnSync\((\w+),/g)].map((m) => m[1]).sort(), ["spctl", "xattr"]);
  });
});
