// The keychain helper (native/macos/keychain.swift, through src/platform/macos/keychain.ts) on a
// throwaway keychain: made here with `security create-keychain` (a random password), and deleted
// after. Never the login keychain: every call names this file (--keychain). The helper is built
// into this test's own folder, signed ad hoc, so the repo's own build is left alone. The keys are
// fake, and so are the names they're kept under (KIKO_TEST_…), but for the one fill at start.
// Also: which signing identity a build picks (from sample output; no identity is looked up here).
import "../../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { firstStart } from "../../../../src/core/first-start.ts";
import { fillKeys } from "../../../../src/core/keys.ts";
import { OWN } from "../../../../src/core/name.ts";
import { keychainStore } from "../../../../src/platform/macos/keychain.ts";
import { buildNative, pickIdentity } from "../../../../src/platform/macos/native.ts";

const can = process.platform === "darwin" && spawnSync("swiftc", ["--version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "kc-"));
const file = join(dir, "test.keychain-db");
let helper = "";

describe("the keychain helper, on a throwaway keychain", { skip: !can && "needs macOS and swiftc" }, () => {
  before(() => {
    helper = buildNative("keychain", { into: join(dir, "bin"), sign: "-" });
    execFileSync("security", ["create-keychain", "-p", randomBytes(16).toString("hex"), file], { stdio: "ignore" });
  });
  after(() => {
    spawnSync("security", ["delete-keychain", file], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  });

  const name = `KIKO_TEST_${randomBytes(4).toString("hex").toUpperCase()}`;
  const store = () => keychainStore({ file, helper: () => helper });

  test("set, get, replace, list and remove; the key only ever on stdin and stdout", async () => {
    const kc = store();
    assert.deepEqual(await kc.list(), []);
    await kc.set(name, "fake-test-0000");
    assert.deepEqual(await kc.list(), [name]);
    assert.deepEqual(kc.get([name, "KIKO_TEST_NONE"]), { [name]: "fake-test-0000" });
    await kc.set(name, "fake-test-1111");
    assert.deepEqual(kc.get([name]), { [name]: "fake-test-1111" });
    assert.equal(await kc.remove(name), true);
    assert.equal(await kc.remove(name), false);
    assert.deepEqual(kc.get([name]), {});
  });

  test("only key names; errors say what went wrong, never with a key", async () => {
    const kc = store();
    assert.throws(() => kc.get(["not-a-name"]), /not a key's name: not-a-name/);
    // A key with nothing on stdin: refused, and nothing saved.
    const run = spawnSync(helper, ["--keychain", file, "--service", OWN.keychainService, "set", name], { input: "", encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no key on stdin/);
    // No service named: refused, whatever the command (the app always names its own).
    const unnamed = spawnSync(helper, ["--keychain", file, "list"], { encoding: "utf8" });
    assert.equal(unnamed.status, 1);
    assert.match(unnamed.stderr, /--service <name> is needed/);
    assert.deepEqual(await kc.list(), []);
  });

  test("filled in at start: a key missing from the environment comes from the Keychain", async () => {
    const kc = store();
    await kc.set("OPENROUTER_API_KEY", "sk-or-test-0000000000000000aaaa");
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-test-0000" };
    const held: Record<string, string> = {};
    const { sources, error } = fillKeys(env, new Set(["ANTHROPIC_API_KEY"]), kc, held);
    assert.equal(error, undefined);
    assert.equal(held.OPENROUTER_API_KEY, "sk-or-test-0000000000000000aaaa");
    assert.equal(env.OPENROUTER_API_KEY, undefined, "held, never put in the environment");
    assert.deepEqual(sources, { ANTHROPIC_API_KEY: "environment", OPENROUTER_API_KEY: "Keychain" });
    await kc.remove("OPENROUTER_API_KEY");
  });

  test("each flavour's own service; Kiko Dev's first start copies the release's keys into its own, in the helper, one there already kept", async () => {
    const release = keychainStore({ file, service: "sh.kiko.keys", helper: () => helper });
    const dev = keychainStore({ file, helper: () => helper });
    const other = `${name}_B`;
    await release.set(name, "fake-release-0000");
    await release.set(other, "fake-release-1111");
    assert.deepEqual(await dev.list(), [], "this checkout's (Kiko Dev's) service is its own");
    await dev.set(other, "fake-dev-2222");
    const done = await firstStart({ home: mkdtempSync(join(dir, "home-")), keys: dev });
    assert.deepEqual(done?.keys, [name]);
    assert.deepEqual(dev.get([name, other]), { [name]: "fake-release-0000", [other]: "fake-dev-2222" });
    assert.deepEqual(release.get([name, other]), { [name]: "fake-release-0000", [other]: "fake-release-1111" }, "the release's stay");
    // What the copy prints: names only, never a key.
    const again = spawnSync(helper, ["--keychain", file, "--service", "sh.kiko.dev.keys", "copy", "sh.kiko.keys"], { encoding: "utf8" });
    assert.equal(again.status, 0);
    assert.equal(again.stdout.trim(), "[]");
    const bad = spawnSync(helper, ["--keychain", file, "--service", "Not A Service", "list"], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not a service's name/);
    for (const store of [release, dev]) for (const n of [name, other]) await store.remove(n);
  });

  test("signed ad hoc, under Kiko's own identifier", () => {
    const shown = spawnSync("codesign", ["-dv", helper], { encoding: "utf8" }).stderr;
    assert.match(shown, /Identifier=sh\.kiko\.keychain/);
    assert.match(shown, /Signature=adhoc/);
  });
});

test("the signing identity: Developer ID first, then Apple Development, else none (ad hoc)", () => {
  const dev = "A".repeat(40);
  const id = "B".repeat(40);
  const out = (lines: string[]) => `${lines.map((l, i) => `  ${i + 1}) ${l}`).join("\n")}\n     ${lines.length} valid identities found\n`;
  assert.equal(pickIdentity(out([`${dev} "Apple Development: Test Person (TEAM000000)"`, `${id} "Developer ID Application: Test Co (TEAM000000)"`])), id);
  assert.equal(pickIdentity(out([`${dev} "Apple Development: Test Person (TEAM000000)"`])), dev);
  assert.equal(pickIdentity(out([`${"C".repeat(40)} "Apple Distribution: Test Co (TEAM000000)"`])), null);
  assert.equal(pickIdentity("     0 valid identities found\n"), null);
});
