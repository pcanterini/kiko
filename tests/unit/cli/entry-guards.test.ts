// The app's programs that are also imported (onboard.ts by cli.ts, pocket-start.ts by onboard.ts)
// run themselves only when they're the one run: `_run <program>` (core/app-root.ts running) or
// Node's import.meta.main. Never import.meta.filename against argv[1]: in the installed executable
// (Bun's --compile) both are the executable's own path for every module, so importing one ran it
// too. That ended `curl … | sh`'s setup before its first step (2026-11-01: onboard.ts importing
// pocket-start.ts, which exited).
import "../../setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC = fileURLToPath(new URL("../../../src/", import.meta.url));

test("no program in src/ tells it's the one run by comparing import.meta.filename (or url) with argv", () => {
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  const offending = files.filter((f) => /import\.meta\.(filename|url|path)[^\n]*process\.argv|process\.argv\[1\][^\n]*import\.meta\.(filename|url|path)/.test(readFileSync(join(SRC, f), "utf8")));
  assert.deepEqual(offending, []);
});
