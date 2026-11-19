// Pocket's model, where another install has it already, cloned into Pocket's own Hugging Face
// folder (src/core/pocket-tts.ts adoptSharedModel, pocketModelSources), by first-run setup's
// download before it starts (src/core/pocket-prep.ts startPocketPrep) and by the app's start of
// Pocket. Every "shared cache" here is a temp folder made as Hugging Face makes one (blobs named by
// their hash, snapshots of relative links into them; also huggingface_hub 2.3's cache-wide store),
// never the real ~/.cache/huggingface, ~/.local/share/kiko or a checkout's.
import "../../setup.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { pocketPrepState, startPocketPrep } from "../../../src/core/pocket-prep.ts";
import { adoptSharedModel, otherFlavourHub, pocketHfEnv, pocketModelSources, sharedHfHubs } from "../../../src/core/pocket-tts.ts";
import { checkWaits } from "../../support/until.ts";

const VOICE = "models--kyutai--pocket-tts";
const TWIN = "models--kyutai--pocket-tts-without-voice-cloning";
const REV = "983151f13aaeab1b13c1e5e3c2c383d49a9edf3f";
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const gitSha = (data: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(data)}\0`)
    .update(data)
    .digest("hex");
const waitFor = checkWaits(5000, 50);

const tempDir = (prefix = "pocket-adopt-") => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

type Files = Record<string, string>;

/**
 * A model folder in `hub` as Hugging Face writes it: each file's bytes in blobs/<hash> (SHA-256 for
 * the large ones, git's SHA-1 for config files), snapshots/<rev>/<file> a relative link to it, and
 * refs/main. `store`: the large ones in the cache-wide store instead (hub/blobs/<xx>/<hash>, with
 * its .refs and .lock), blobs/<sha256> a link to it.
 */
function model(hub: string, name: string, files: Files, opts: { rev?: string; store?: boolean } = {}) {
  const dir = join(hub, name);
  const rev = opts.rev ?? REV;
  mkdirSync(join(dir, "blobs"), { recursive: true });
  mkdirSync(join(dir, "refs"), { recursive: true });
  writeFileSync(join(dir, "refs", "main"), rev);
  for (const [file, data] of Object.entries(files)) {
    const large = file.endsWith(".safetensors");
    const hash = large ? sha256(data) : gitSha(data);
    if (opts.store && large) {
      const xet = sha256(`xet:${data}`);
      mkdirSync(join(hub, "blobs", xet.slice(0, 2)), { recursive: true });
      writeFileSync(join(hub, "blobs", ".huggingface-shared-blobs"), "1\n");
      writeFileSync(join(hub, "blobs", xet.slice(0, 2), xet), data);
      writeFileSync(join(hub, "blobs", xet.slice(0, 2), `${xet}.refs`), `${name}/blobs/${hash}\n`);
      writeFileSync(join(hub, "blobs", xet.slice(0, 2), `${xet}.lock`), "");
      symlinkSync(`../../blobs/${xet.slice(0, 2)}/${xet}`, join(dir, "blobs", hash));
    } else {
      writeFileSync(join(dir, "blobs", hash), data);
    }
    const link = join(dir, "snapshots", rev, file);
    mkdirSync(dirname(link), { recursive: true });
    const depth = file.split("/").length + 1;
    symlinkSync(`${"../".repeat(depth)}blobs/${hash}`, link);
  }
  return dir;
}

const WEIGHTS = "languages/english/model.safetensors";
/** Pocket's two model folders, whole. */
function pocketHub(hub: string, tag = "", opts: { rev?: string; store?: boolean } = {}) {
  model(hub, VOICE, { [WEIGHTS]: `voice weights${tag}` }, opts);
  model(hub, TWIN, { [WEIGHTS]: `twin weights${tag}`, "languages/english/tokenizer.json": `{"tokens":1}${tag}` }, opts);
  return hub;
}

/** Everything under `dir` as lstat sees it (never following a link): type, size, mode, mtime, a link's target, a file's bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      const s = lstatSync(path);
      const what = s.isSymbolicLink() ? `link ${readlinkSync(path)}` : s.isDirectory() ? "dir" : `file ${sha256(readFileSync(path, "latin1"))}`;
      out[path.slice(dir.length)] = `${what} size=${s.size} mode=${s.mode} mtime=${s.mtimeMs} ino=${s.ino}`;
      if (s.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return out;
}

/** Every link under `dir`: where it leads (resolved), which must be inside `dir`. */
function linksLeaveNothingOutside(dir: string) {
  for (const [rel, what] of Object.entries(snapshot(dir))) {
    if (!what.startsWith("link ")) continue;
    const path = join(dir, rel);
    const target = resolve(dirname(path), readlinkSync(path));
    assert.ok(target.startsWith(`${dir}/`), `${rel} leads outside Pocket's copy: ${target}`);
  }
}

const read = (hub: string, name: string, file = WEIGHTS, rev = REV) => readFileSync(join(hub, name, "snapshots", rev, file), "utf8");

/** A world: shared caches in a temp folder, and Pocket's venv (its own HF folder, pocket-hf/, beside it). */
function world() {
  const dir = tempDir();
  const venv = join(dir, "share", "pocket-venv");
  const ours = pocketHfEnv(venv).HF_HUB_CACHE;
  return { dir, venv, ours, hub: (name: string) => join(dir, name) };
}

describe("where Pocket's model may be already: a fixed list of exact folders, never a search", () => {
  const home = "/Users/someone";
  const none = {} as NodeJS.ProcessEnv;

  test("Hugging Face's own order (HF_HUB_CACHE, the older HUGGINGFACE_HUB_CACHE, HF_HOME/hub, XDG_CACHE_HOME, ~/.cache), then the other flavour's", () => {
    const env = { HF_HUB_CACHE: "/hf/hub-cache", HUGGINGFACE_HUB_CACHE: "/hf/old", HF_HOME: "/hf/home", XDG_CACHE_HOME: "/xdg" } as NodeJS.ProcessEnv;
    assert.deepEqual(pocketModelSources(env, home, false), [
      "/hf/hub-cache",
      "/hf/old",
      "/hf/home/hub",
      "/xdg/huggingface/hub",
      "/Users/someone/.cache/huggingface/hub",
      "/Users/someone/.local/share/kiko/pocket-hf/hub",
    ]);
    assert.deepEqual(
      pocketModelSources(none, home, false),
      ["/Users/someone/.cache/huggingface/hub", "/Users/someone/.local/share/kiko/pocket-hf/hub"],
      "nothing set: the default, then the release's",
    );
  });

  test("each folder once; unset, empty and relative ones left out; ~ for the home", () => {
    const env = { HF_HUB_CACHE: "~/.cache/huggingface/hub", HF_HOME: "", XDG_CACHE_HOME: "relative/cache" } as NodeJS.ProcessEnv;
    assert.deepEqual(sharedHfHubs(env, home), ["/Users/someone/.cache/huggingface/hub"]);
  });

  test("the release looks in the Kiko Dev checkout ~/.local/bin/kiko-dev links to; with no link, only the shared caches", () => {
    const dir = tempDir();
    const checkout = join(dir, "git", "kiko");
    mkdirSync(join(checkout, "bin"), { recursive: true });
    writeFileSync(join(checkout, "bin", "kiko-dev"), "");
    const fakeHome = join(dir, "home");
    assert.equal(otherFlavourHub(fakeHome, true), undefined, "no link");
    assert.deepEqual(pocketModelSources(none, fakeHome, true), [join(fakeHome, ".cache", "huggingface", "hub")]);
    mkdirSync(join(fakeHome, ".local", "bin"), { recursive: true });
    symlinkSync(join(checkout, "bin", "kiko-dev"), join(fakeHome, ".local", "bin", "kiko-dev"));
    assert.equal(otherFlavourHub(fakeHome, true), join(checkout, "pocket", "pocket-hf", "hub"));
    assert.equal(otherFlavourHub(fakeHome, false), join(fakeHome, ".local", "share", "kiko", "pocket-hf", "hub"), "a checkout: the release's");
  });

  test("KIKO_POCKET_MODEL_FROM (the tests'): exactly those, nothing else", () => {
    assert.deepEqual(pocketModelSources({ KIKO_POCKET_MODEL_FROM: "/a:/b" } as NodeJS.ProcessEnv, home, false), ["/a", "/b"]);
    assert.deepEqual(pocketModelSources({ KIKO_POCKET_MODEL_FROM: "" } as NodeJS.ProcessEnv, home, false), []);
    assert.deepEqual(sharedHfHubs(), [process.env.KIKO_POCKET_MODEL_FROM], "this run's: never the real ones");
    assert.deepEqual(pocketModelSources(), [process.env.KIKO_POCKET_MODEL_FROM]);
    assert.match(String(process.env.KIKO_POCKET_MODEL_FROM), /\/no-shared-hf-hub$/);
  });
});

describe("adopting Pocket's model: cloned, checked, and Pocket's own", () => {
  test("both folders from the first source that has them; missing sources skipped; links kept, all inside the copy", () => {
    const w = world();
    const first = pocketHub(w.hub("first"), " (first)");
    const second = pocketHub(w.hub("second"), " (second)");
    const copied = adoptSharedModel(w.venv, [w.hub("not-there"), first, second]);
    assert.deepEqual(copied.sort(), [VOICE, TWIN]);
    assert.equal(read(w.ours, VOICE), "voice weights (first)");
    assert.equal(read(w.ours, TWIN, "languages/english/tokenizer.json"), '{"tokens":1} (first)');
    assert.equal(readlinkSync(join(w.ours, VOICE, "snapshots", REV, WEIGHTS)), `../../../../blobs/${sha256("voice weights (first)")}`, "the link as it was");
    assert.equal(readFileSync(join(w.ours, VOICE, "refs", "main"), "utf8"), REV);
    assert.deepEqual(readdirSync(w.ours).sort(), [VOICE, TWIN], "no half copy left");
    linksLeaveNothingOutside(w.ours);
  });

  test("the first source missing one folder: that one from the next", () => {
    const w = world();
    const first = w.hub("first");
    model(first, VOICE, { [WEIGHTS]: "voice weights (first)" });
    const second = pocketHub(w.hub("second"), " (second)");
    assert.deepEqual(adoptSharedModel(w.venv, [first, second]).sort(), [VOICE, TWIN]);
    assert.equal(read(w.ours, VOICE), "voice weights (first)");
    assert.equal(read(w.ours, TWIN), "twin weights (second)");
  });

  test("a corrupted blob: that source's whole copy discarded, the next one's taken; with no other, nothing (it downloads)", () => {
    const w = world();
    const bad = pocketHub(w.hub("bad"), " (bad)");
    writeFileSync(join(bad, VOICE, "blobs", sha256("voice weights (bad)")), "voice weights (flipped bit)");
    const good = pocketHub(w.hub("good"), " (good)");
    assert.deepEqual(adoptSharedModel(w.venv, [bad, good]).sort(), [VOICE, TWIN]);
    assert.equal(read(w.ours, VOICE), "voice weights (good)");
    assert.equal(read(w.ours, TWIN), "twin weights (bad)", "the bad source's other folder was fine");

    const alone = world();
    const corrupt = pocketHub(alone.hub("bad"), " (bad)");
    writeFileSync(join(corrupt, TWIN, "blobs", gitSha('{"tokens":1} (bad)')), '{"tokens":2}');
    assert.deepEqual(adoptSharedModel(alone.venv, [corrupt]), [VOICE], "the corrupt folder isn't adopted");
    assert.deepEqual(readdirSync(alone.ours), [VOICE], "and no clone of it left behind");
  });

  test("a partial copy (a blob missing, a half download): kept only when no source has it whole, and the server fetches the rest", () => {
    const w = world();
    const partial = pocketHub(w.hub("partial"), " (partial)");
    const missing = sha256("twin weights (partial)");
    rmSync(join(partial, TWIN, "blobs", missing));
    writeFileSync(join(partial, TWIN, "blobs", `${missing}.incomplete`), "twin wei");
    const whole = pocketHub(w.hub("whole"), " (whole)");
    adoptSharedModel(w.venv, [partial, whole]);
    assert.equal(read(w.ours, TWIN), "twin weights (whole)", "the whole one wins");

    const only = world();
    const half = pocketHub(only.hub("partial"), " (partial)");
    rmSync(join(half, TWIN, "blobs", missing));
    writeFileSync(join(half, TWIN, "blobs", `${missing}.incomplete`), "twin wei");
    mkdirSync(join(half, TWIN, ".no_exist", REV), { recursive: true });
    assert.deepEqual(adoptSharedModel(only.venv, [half]).sort(), [VOICE, TWIN]);
    assert.deepEqual(readdirSync(join(only.ours, TWIN, "blobs")), [gitSha('{"tokens":1} (partial)')], "no half download, no missing blob");
    assert.equal(existsSync(join(only.ours, TWIN, "snapshots", REV, WEIGHTS)), false, "its link leads nowhere: Hugging Face fetches that file");
    assert.equal(lstatSync(join(only.ours, TWIN, "snapshots", REV, WEIGHTS)).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(join(only.ours, TWIN)).sort(), ["blobs", "refs", "snapshots"], "only what Hugging Face keeps there");
  });

  test("an older revision than Pocket asks for: copied as it is (Hugging Face reuses each blob whose hash still matches, fetches the rest)", () => {
    const w = world();
    const old = "0000000000000000000000000000000000000001";
    pocketHub(w.hub("old"), "", { rev: old });
    assert.deepEqual(adoptSharedModel(w.venv, [w.hub("old")]).sort(), [VOICE, TWIN]);
    assert.equal(read(w.ours, VOICE, WEIGHTS, old), "voice weights");
    assert.ok(existsSync(join(w.ours, VOICE, "blobs", sha256("voice weights"))), "the blob, by its hash, for any revision that has the same file");
  });

  test("Hugging Face's cache-wide store (huggingface_hub 2.3): the file a blob links to cloned in its place, never a link into the shared cache", () => {
    const w = world();
    const shared = pocketHub(w.hub("shared"), "", { store: true });
    assert.deepEqual(adoptSharedModel(w.venv, [shared]).sort(), [VOICE, TWIN]);
    const blob = join(w.ours, VOICE, "blobs", sha256("voice weights"));
    assert.equal(lstatSync(blob).isFile(), true, "a file of its own");
    assert.equal(read(w.ours, VOICE), "voice weights");
    assert.equal(existsSync(join(w.ours, "blobs")), false, "nothing of the store's (its .refs, .lock) copied");
    linksLeaveNothingOutside(w.ours);
  });

  test("links that lead out of the copy (absolute, or into the shared folder): dropped; a model folder that's a link elsewhere: not copied", () => {
    const w = world();
    const shared = pocketHub(w.hub("shared"));
    const absolute = join(shared, VOICE, "snapshots", REV, "absolute.safetensors");
    symlinkSync(join(shared, VOICE, "blobs", sha256("voice weights")), absolute);
    const elsewhere = pocketHub(w.hub("elsewhere"));
    rmSync(join(shared, TWIN), { recursive: true });
    symlinkSync(join(elsewhere, TWIN), join(shared, TWIN));
    assert.deepEqual(adoptSharedModel(w.venv, [shared]), [VOICE]);
    assert.equal(existsSync(join(w.ours, VOICE, "snapshots", REV, "absolute.safetensors")), false);
    linksLeaveNothingOutside(w.ours);
  });

  test("Pocket's copy stands alone: the shared one deleted after, Pocket's still reads; Pocket's deleted (uninstall), the shared one's still there", () => {
    const w = world();
    const shared = pocketHub(w.hub("shared"), "", { store: true });
    adoptSharedModel(w.venv, [shared]);
    const before = snapshot(shared);
    rmSync(join(w.dir, "share"), { recursive: true }); // what `kiko uninstall` does to ~/.local/share/kiko
    assert.deepEqual(snapshot(shared), before);
    adoptSharedModel(w.venv, [shared]);
    rmSync(shared, { recursive: true });
    assert.equal(read(w.ours, VOICE), "voice weights");
    assert.equal(read(w.ours, TWIN, "languages/english/tokenizer.json"), '{"tokens":1}');
  });

  test("the shared caches left byte for byte as they were, same mtimes, same inodes", () => {
    const w = world();
    const store = pocketHub(w.hub("store"), "", { store: true });
    const plain = pocketHub(w.hub("plain"), " (plain)");
    writeFileSync(join(plain, VOICE, "blobs", sha256("voice weights (plain)")), "corrupt"); // discarded: still never touched
    const before = [snapshot(store), snapshot(plain)];
    adoptSharedModel(w.venv, [plain, store]);
    assert.deepEqual([snapshot(store), snapshot(plain)], before);
  });

  test("already adopted (or downloaded): left as it is, nothing copied", () => {
    const w = world();
    const shared = pocketHub(w.hub("shared"));
    mkdirSync(join(w.ours, VOICE), { recursive: true });
    writeFileSync(join(w.ours, VOICE, "mine"), "");
    assert.deepEqual(adoptSharedModel(w.venv, [shared]), [TWIN]);
    assert.deepEqual(readdirSync(join(w.ours, VOICE)), ["mine"]);
    assert.deepEqual(adoptSharedModel(w.venv, [shared]), [], "once");
  });

  test("a half copy left behind (an older Kiko's <name>.copying, a process that died): cleared, and copied again; a live process's own, left", () => {
    const w = world();
    const shared = pocketHub(w.hub("shared"));
    const legacy = join(w.ours, `${VOICE}.copying`);
    const dead = join(w.ours, `${TWIN}.999999999.0.copying`);
    const live = join(w.ours, `${TWIN}.${process.ppid}.0.copying`);
    for (const half of [legacy, dead, live]) {
      mkdirSync(join(half, "blobs"), { recursive: true });
      writeFileSync(join(half, "blobs", "half"), "");
    }
    assert.deepEqual(adoptSharedModel(w.venv, [shared]).sort(), [VOICE, TWIN]);
    assert.equal(read(w.ours, VOICE), "voice weights");
    assert.equal(existsSync(legacy), false);
    assert.equal(existsSync(dead), false);
    assert.equal(existsSync(live), true, "another live process's copy in progress");
  });

  test("Pocket's own folder named as a source (HF_HUB_CACHE pointing at it): skipped", () => {
    const w = world();
    pocketHub(w.ours);
    const before = snapshot(w.ours);
    assert.deepEqual(adoptSharedModel(w.venv, [w.ours]), []);
    assert.deepEqual(snapshot(w.ours), before);
  });
});

describe("first-run setup's download adopts the model before it downloads anything", () => {
  const scripts = (venv: string, setup: string) => {
    const script = join(dirname(venv), "setup.sh");
    writeFileSync(script, setup);
    return { script, serve: join(dirname(venv), "serve.py") };
  };

  test("the model's in Pocket's folder before setup.sh even runs, and the server's HF_HUB_CACHE is that folder; the shared cache untouched", async () => {
    const w = world();
    mkdirSync(join(w.venv, "bin"), { recursive: true });
    const shared = pocketHub(w.hub("shared"), "", { store: true });
    const before = snapshot(shared);
    const seen = join(w.dir, "seen");
    const setup = scripts(w.venv, `ls "$HF_HUB_CACHE" > '${seen}'; cat "$HF_HUB_CACHE/${VOICE}/snapshots/${REV}/${WEIGHTS}" >> '${seen}'; exit 1\n`);
    assert.equal(startPocketPrep(w.venv, setup, 1, [shared]), "started");
    await waitFor(() => pocketPrepState(w.venv) === "failed");
    assert.equal(readFileSync(seen, "utf8"), `${VOICE}\n${TWIN}\nvoice weights`);
    assert.deepEqual(snapshot(shared), before);
  });

  test("nothing to adopt, or a source it can't read: it starts all the same (and downloads, as before)", async () => {
    const w = world();
    mkdirSync(join(w.venv, "bin"), { recursive: true });
    const odd = w.hub("odd");
    mkdirSync(odd);
    writeFileSync(join(odd, VOICE), "a file, not a folder");
    assert.equal(startPocketPrep(w.venv, scripts(w.venv, "exit 1\n"), 1, [w.hub("none"), odd]), "started");
    await waitFor(() => pocketPrepState(w.venv) === "failed");
    assert.equal(existsSync(join(w.ours, VOICE)), false);
  });

  test("by default it looks only where pocketModelSources says (in a test: KIKO_POCKET_MODEL_FROM, an empty folder)", async () => {
    const w = world();
    mkdirSync(join(w.venv, "bin"), { recursive: true });
    assert.equal(startPocketPrep(w.venv, scripts(w.venv, "exit 1\n"), 1), "started");
    await waitFor(() => pocketPrepState(w.venv) === "failed");
    assert.equal(existsSync(w.ours), false);
  });
});
