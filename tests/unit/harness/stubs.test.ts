// The app harness's stubs (tests/harness/stubs/, swapped in by tests/harness/loader.mjs) still give
// every name the app takes from the modules they stand in for. A stub that falls behind its module
// (a new export the app imports) stops `pnpm test:app` at its first line, which went unseen for days
// (decisions.ts's DETAIL_MAX and toolDetail): here it fails in `pnpm test`, naming the module and
// the names. Only the names: what the stubs do is the harness's to check.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = join(ROOT, "src");
const HARNESS = join(ROOT, "tests/harness");
const STUBS = join(HARNESS, "stubs");

/** The modules the loader swaps, as it lists them (paths under src/). */
function stubbed(): string[] {
  const loader = readFileSync(join(HARNESS, "loader.mjs"), "utf8");
  const list = /new Set\(\[([\s\S]*?)\]\)/.exec(loader)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+\.ts)"/g)].map((m) => m[1]);
}

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules" && name !== "out" && path !== STUBS) files(path, out);
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/** Every value name each stubbed module is asked for, by the app (src/) and the harness's own cases and driver: module → name → who. */
function asked(modules: Set<string>): Map<string, Map<string, string>> {
  const wanted = new Map<string, Map<string, string>>();
  // A stubbed module's own imports count only when its stub loads the real one (trim's, tmux's): else it never loads.
  const loaded = (file: string) => {
    const own = relative(SRC, file);
    return !modules.has(own) || readFileSync(join(STUBS, own), "utf8").includes(`src/${own}`);
  };
  for (const file of [...files(SRC).filter(loaded), ...files(HARNESS)]) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
      if (m[1]) continue; // import type { … }: nothing at run time
      const target = relative(SRC, resolve(dirname(file), m[3]));
      if (!modules.has(target) || resolve(SRC, target) === file) continue;
      for (const part of m[2].split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (!name || name.startsWith("type ")) continue;
        if (!wanted.has(target)) wanted.set(target, new Map());
        wanted.get(target)!.set(name, relative(ROOT, file));
      }
    }
  }
  return wanted;
}

test("every stubbed module's stub exports what the app and the harness import from it", async () => {
  const modules = stubbed();
  assert.ok(modules.length > 10, "the loader's list of stubbed modules is read");
  // What the stubs read of the harness's state as they load (the mic's devices, the Mac's volume).
  (globalThis as any).T ??= {};
  const missing: string[] = [];
  for (const [module, names] of asked(new Set(modules))) {
    const stub = await import(join(STUBS, module));
    for (const [name, by] of names) if (!(name in stub)) missing.push(`${module}: ${name} (imported by ${by})`);
  }
  assert.deepEqual(missing, [], "a stub in tests/harness/stubs/ lacks names its module exports and something imports");
});

test("every module the loader swaps has its stub", () => {
  for (const module of stubbed()) assert.ok(statSync(join(STUBS, module), { throwIfNoEntry: false })?.isFile(), `tests/harness/stubs/${module}`);
});
