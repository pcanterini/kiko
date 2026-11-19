// What `kiko uninstall` says it left (src/uninstall.ts leftWords): each thing only when it's
// there, the sessions still open in Kiko's tmux and Pocket's model in the shared Hugging Face
// cache (an older install's) included; and what it says beside Kiko's folder of Pocket's
// (pocketWords). Nothing here removes anything: the whole uninstall runs for real in install-live
// and early-access-live, in a home folder of their own.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { helperAppBundles, leftWords, PATH_MARK, pocketWords, withoutPathLine } from "../../../src/uninstall.ts";

test("nothing left: said so", () => {
  assert.equal(leftWords({}), "Left as they are: nothing.");
  assert.equal(leftWords({ sessions: 0, model: undefined }), "Left as they are: nothing.");
});

test("each thing that's there, in turn: logs, scratch folder, Pocket's older model, the sessions in Kiko's tmux", () => {
  assert.equal(
    leftWords({ logs: "~/.local/state/kiko", scratch: "~/Kiko/scratch", model: "~/.cache/huggingface/hub", sessions: 2 }),
    "Left as they are: the logs (~/.local/state/kiko); your scratch folder (~/Kiko/scratch); Pocket's voice model in ~/.cache/huggingface/hub (Hugging Face's cache, shared with other apps; an older install or another app put it there); 2 sessions still open in Kiko's tmux (each ends when you quit it, or when the Mac restarts; a tmux of your own reaches them: tmux -L kiko-dev attach).",
  );
  assert.match(leftWords({ sessions: 1 }), /a session still open in Kiko's tmux \(it ends when you quit it, or when the Mac restarts; a tmux of your own reaches it: tmux -L kiko-dev attach\)/);
});

test("the PATH line install.sh added comes out, and only it: the rest of the file exactly as it was", () => {
  const ours = `export PATH="$HOME/.local/bin:$PATH" ${PATH_MARK}`;
  assert.equal(withoutPathLine(`alias ll='ls -l'\n${ours}\n`), "alias ll='ls -l'\n");
  assert.equal(withoutPathLine(`${ours}\nexport EDITOR=vim`), "export EDITOR=vim");
  // Yours, even with the same words but no mark: kept, and nothing to change.
  assert.equal(withoutPathLine(`export PATH="$HOME/.local/bin:$PATH"\n`), null);
  assert.equal(withoutPathLine(""), null);
});

test("Kiko's folder, listed with what it holds of Pocket's: its Python, its own uv, its model", () => {
  const share = mkdtempSync(join(tmpdir(), "share-"));
  const venv = join(share, "pocket-venv");
  assert.equal(pocketWords(venv), "");
  mkdirSync(venv);
  assert.equal(pocketWords(venv), " (with the Pocket voice's Python)");
  mkdirSync(join(share, "pocket-hf"));
  assert.equal(pocketWords(venv), " (with the Pocket voice's Python and model)");
  mkdirSync(join(share, "pocket-uv"));
  assert.equal(pocketWords(venv), " (with the Pocket voice's Python, uv and model)");
});

test("the helper app's copies it unregisters: one in each version's folder, only those there", () => {
  const share = mkdtempSync(join(tmpdir(), "share-"));
  assert.deepEqual(helperAppBundles(share, "Kiko"), []);
  for (const v of ["0.2.2", "0.3.0", "0.3.1"]) mkdirSync(join(share, "versions", v), { recursive: true });
  for (const v of ["0.3.0", "0.3.1"]) mkdirSync(join(share, "versions", v, "Kiko.app"));
  assert.deepEqual(helperAppBundles(share, "Kiko"), [join(share, "versions", "0.3.0", "Kiko.app"), join(share, "versions", "0.3.1", "Kiko.app")]);
});
