// Kiko never puts anything on the user's clipboard, nor reads it: words go in through
// tmux's buffer, Ghostty's input text, T3's dispatch or the Stop hook. The clipboard uses left are
// yours: tmux.conf copies a mouse selection you made, and Settings → Account's Copy the code, picked
// while a sign-in's code shows (core/copy.ts, used by app/settings/account.ts alone). The app harness checks the same at run time,
// for a desktop session (tests/harness/cases/announce.ts: "desktop session after its window"). The iPhone app,
// in its own repo, checks its side with scripts/check-no-clipboard.sh. A double or triple click's
// copy goes the same way (tmux's copy-command, in tmux.conf and, for a server started with an older
// one, window.ts COPY_COMMAND).
import "../../setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SHIPPED = ["src", "hooks", "native", "bin", "statusline", "pocket", "protocol"];
const CLIPBOARD = /\b(pbcopy|pbpaste|NSPasteboard|UIPasteboard|clipboardy)\b|navigator\.clipboard/;
// tmux.conf: a drag in copy mode copies what you selected, as any terminal does; so does a double
// or triple click (copy-command, which window.ts sets too on a server that has an older tmux.conf).
const YOURS = /^bind -T copy-mode(-vi)? MouseDragEnd1Pane send -X copy-pipe-and-cancel "pbcopy"$/;
const YOURS_CLICKS = /^set -s copy-command "pbcopy"$/;
const WINDOW_COPY = { file: "src/terminals/tmux/window.ts", line: 'const COPY_COMMAND = "pbcopy";' };
// Copy the code (Settings → Account, while a sign-in's code shows): the one copy Kiko makes, when you pick it.
const CODE_COPY = { file: "src/core/copy.ts", line: 'const COPY_PROGRAM = "pbcopy";', user: "src/app/settings/account.ts" };

function files(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(dir, name);
    // A link left pointing at a removed file (an old native/*.swift alias) has nothing to read.
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return [];
    return stat.isDirectory() ? files(path) : [path];
  });
}

describe("no clipboard", () => {
  test("nothing shipped runs a clipboard command, but tmux.conf's copy of your own selection and Copy the code", () => {
    const uses = SHIPPED.flatMap((d) => files(join(ROOT, d)))
      .filter((f) => /\.(ts|tsx|js|mjs|cjs|swift|sh|py|conf)$/.test(f) || !f.includes("."))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ at: `${f.slice(ROOT.length)}:${i + 1}`, line: line.trim() }))
          .filter(({ line }) => CLIPBOARD.test(line) && !line.startsWith("//") && !line.startsWith("#") && !YOURS.test(line))
          .filter(({ at, line }) => !(at.startsWith("src/terminals/tmux/tmux.conf:") && YOURS_CLICKS.test(line)))
          .filter(({ at, line }) => !(at.startsWith(`${WINDOW_COPY.file}:`) && line === WINDOW_COPY.line))
          .filter(({ at, line }) => !(at.startsWith(`${CODE_COPY.file}:`) && line === CODE_COPY.line))
          // The quick check's guard names them only to read a command it's given: pbcopy is a change (denied), pbpaste a read.
          .filter(({ at }) => !at.startsWith("hooks/guard/read-only.mjs:")),
      );
    assert.deepEqual(uses, []);
  });
  test("the one clipboard use left is tmux's copy of your mouse selection", () => {
    const conf = readFileSync(join(ROOT, "src/terminals/tmux/tmux.conf"), "utf8").split("\n");
    assert.equal(conf.filter((l) => YOURS.test(l.trim())).length, 2);
    assert.equal(conf.filter((l) => YOURS_CLICKS.test(l.trim())).length, 1);
    // window.ts: only tmux's copy-command, set to it (selectKeys), nothing that runs it itself.
    const window = readFileSync(join(ROOT, WINDOW_COPY.file), "utf8").split("\n");
    assert.deepEqual(
      window.filter((l) => CLIPBOARD.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("*")),
      [WINDOW_COPY.line],
    );
    assert.ok(window.some((l) => l.includes('["set-option", "-s", "copy-command", COPY_COMMAND]')));
  });
  test("Copy the code: core/copy.ts's one line, and only Settings → Account uses it", () => {
    const copy = readFileSync(join(ROOT, CODE_COPY.file), "utf8").split("\n");
    assert.deepEqual(
      copy.filter((l) => CLIPBOARD.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("*")),
      [CODE_COPY.line],
    );
    const users = SHIPPED.flatMap((d) => files(join(ROOT, d)))
      .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && f.slice(ROOT.length) !== CODE_COPY.file)
      .filter((f) => /core\/copy(\.ts)?["']/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length));
    assert.deepEqual(users, [CODE_COPY.user]);
    // There, only the choice picked runs it: accountAction's "copy", nothing else.
    const account = readFileSync(join(ROOT, CODE_COPY.user), "utf8");
    assert.equal(account.match(/copyText\(/g)?.length, 1, "copyText called in one place");
    assert.equal(account.match(/copyCode\(\)/g)?.length, 2, "copyCode defined once, run once");
    assert.ok(account.includes('if (value === "copy") return void copyCode();'));
  });
});
