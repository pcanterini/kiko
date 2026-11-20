// A release's THIRD_PARTY_NOTICES.md (scripts/notices/notices.ts, run by scripts/release.sh): every
// package a file of the bundle came from, with its licence id and full text; a release stops when one
// has no text; GPL family and unknown licences are pointed out. On a made-up pnpm node_modules, then
// the script itself, then this repo's own production dependencies (so adding one without a licence
// text fails `pnpm check`, not the release).
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bundledPackages, concern, missing, PORTED, packageDirOf, portedIn, productionPackages, readPackage, render, SUPPLIED, summary } from "../../../scripts/notices/notices.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(REPO, "scripts", "notices", "notices.ts");
const BUN_FOR = readFileSync(join(REPO, "scripts", "notices", "bun", "VERSION"), "utf8").trim();

/** A package in pnpm's layout under root: node_modules/.pnpm/<name>@<version>/node_modules/<name>, its files as given. */
function pkg(root: string, name: string, version: string, license: string | undefined, files: Record<string, string> = {}): string {
  const dir = join(root, "node_modules", ".pnpm", `${name.replace("/", "+")}@${version}`, "node_modules", name);
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, ...(license ? { license } : {}) }));
  writeFileSync(join(dir, "lib", "index.js"), "export {};\n");
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return `node_modules/.pnpm/${name.replace("/", "+")}@${version}/node_modules/${name}/lib/index.js`;
}

function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), "notices-"));
  const inputs = [
    "src/main.ts",
    "package.json",
    "stub:react-devtools-core",
    pkg(root, "zeta", "1.0.0", "MIT", { license: "MIT License\n\nCopyright (c) Zeta\n" }),
    pkg(root, "@scope/alpha", "2.1.0", "Apache-2.0", { LICENSE: "Apache License 2.0 text", NOTICE: "Alpha\nCopyright Alpha Inc.\n", "README.md": "not a licence" }),
    pkg(root, "ticks", "0.1.0", "ISC", { "LICENSE.txt": "ISC, with ``` and ```` in it\n" }),
  ];
  // The same file twice, and another file of a package already in: one entry each.
  inputs.push(inputs[3], inputs[3].replace("index.js", "other.js"));
  return { root, inputs };
}

describe("the packages in a bundle", () => {
  test("the folder of the package a bundled file is in", () => {
    assert.equal(packageDirOf("node_modules/.pnpm/ink@8.0.0_react@19/node_modules/ink/build/index.js"), "node_modules/.pnpm/ink@8.0.0_react@19/node_modules/ink");
    assert.equal(packageDirOf("node_modules/.pnpm/@clack+core@1.5.1/node_modules/@clack/core/dist/index.mjs"), "node_modules/.pnpm/@clack+core@1.5.1/node_modules/@clack/core");
    assert.equal(packageDirOf("src/main.ts"), undefined);
    assert.equal(packageDirOf("stub:react-devtools-core"), undefined);
  });

  test("each once, in name order, with its licence id and every licence and NOTICE file", () => {
    const { root, inputs } = fakeRepo();
    const list = bundledPackages(inputs, root);
    assert.deepEqual(
      list.map((p) => `${p.name}@${p.version} ${p.license}`),
      ["@scope/alpha@2.1.0 Apache-2.0", "ticks@0.1.0 ISC", "zeta@1.0.0 MIT"],
    );
    assert.deepEqual(
      list[0].texts.map((t) => t.file),
      ["LICENSE", "NOTICE"],
    );
    assert.match(list[2].texts[0].text, /Copyright \(c\) Zeta/);
    assert.deepEqual(missing(list), []);
    assert.equal(summary(list), "1 Apache-2.0, 1 ISC, 1 MIT");
  });

  test("one with no licence text stops the release; a supplied one counts only while the licence is the same", () => {
    const root = mkdtempSync(join(tmpdir(), "notices-"));
    const bare = pkg(root, "bare", "1.0.0", "MIT");
    const noticeOnly = pkg(root, "notice-only", "1.0.0", "Apache-2.0", { NOTICE: "just a notice" });
    assert.equal(missing(bundledPackages([bare, noticeOnly], root)).length, 2);
    assert.match(missing(bundledPackages([bare], root))[0], /^bare@1\.0\.0 \(MIT, /);

    const supplied = join(root, "supplied");
    mkdirSync(supplied);
    writeFileSync(join(supplied, "bare.txt"), "MIT License\n\nCopyright (c) Bare\n");
    const dir = join(root, packageDirOf(bare) as string);
    const filled = readPackage(dir, { bare: { license: "MIT", from: "https://example.com/bare/LICENSE" } }, supplied);
    assert.deepEqual(missing([filled]), []);
    assert.equal(filled.texts[0].file, "LICENSE (from https://example.com/bare/LICENSE)");
    // The package now says another licence: the supplied text isn't its any more.
    assert.equal(missing([readPackage(dir, { bare: { license: "ISC", from: "x" } }, supplied)]).length, 1);
  });

  test("what needs care: the GPL family, none, and licences it doesn't know", () => {
    for (const fine of ["MIT", "ISC", "Apache-2.0", "BSD-3-Clause", "Unlicense", "(MIT OR CC0-1.0)", "MIT AND ISC"]) assert.equal(concern(fine), undefined, fine);
    // A choice that includes the GPL is still pointed out (the check doesn't decide which one applies).
    for (const care of ["GPL-3.0", "LGPL-2.1-only", "AGPL-3.0-or-later", "MIT AND GPL-2.0", "(MIT OR GPL-3.0-or-later)"]) assert.match(concern(care) ?? "", /GPL family/, care);
    assert.match(concern("") ?? "", /no licence/);
    assert.match(concern("SEE LICENSE IN LICENSE.txt") ?? "", /not a licence this check knows/);
    assert.match(concern("WTFPL") ?? "", /not a licence this check knows/);
  });

  test("the file: Bun's licence, each package's texts in full, tmux's, and fences its texts can't close", () => {
    const { root, inputs } = fakeRepo();
    const packages = bundledPackages(inputs, root);
    const md = render({ packages, bun: { version: "9.9.9", license: "Bun itself is MIT-licensed.\n\n## JavaScriptCore\n\nLGPL" }, tmux: "==== tmux 3.8 ====\nISC" });
    assert.match(md, /^# Third-party notices\n/);
    assert.match(md, /\[Bun 9\.9\.9\]\(#bun\)/);
    assert.match(md, /\n### JavaScriptCore\n/, "Bun's headings sit under its own");
    assert.match(md, /\| @scope\/alpha \| 2\.1\.0 \| Apache-2\.0 \|/);
    assert.match(md, /### zeta 1\.0\.0\n\nLicence: MIT\./);
    assert.ok(md.includes("Copyright Alpha Inc."), "NOTICE files go in");
    assert.match(md, /## tmux\n[\s\S]*==== tmux 3\.8 ====/);
    assert.match(md, /## Not in this release[\s\S]*Pocket TTS/);
    // ticks' text has a run of four backticks: its fence is five.
    assert.ok(md.includes("`````text\nISC, with ``` and ```` in it\n`````"));
    assert.equal(
      md,
      render({
        packages: bundledPackages([...inputs].reverse(), root),
        bun: { version: "9.9.9", license: "Bun itself is MIT-licensed.\n\n## JavaScriptCore\n\nLGPL" },
        tmux: "==== tmux 3.8 ====\nISC",
      }),
      "the same whatever the inputs' order",
    );
  });
});

describe("ported code", () => {
  test("listed when one of its files is in the bundle, with its licence text; left out otherwise", () => {
    const { inputs } = fakeRepo();
    assert.deepEqual(portedIn(inputs), []);
    const withGlow = portedIn([...inputs, "src/ui/voice-envelope.ts"]);
    assert.deepEqual(
      withGlow.map((p) => p.name),
      ["voice-glow"],
    );
    assert.match(withGlow[0].text, /^MIT License\n\nCopyright \(c\) 2026 Jakub Antalik\n/);
    // An absolute or ../ path to the same file counts too.
    assert.equal(portedIn(["../repo/src/ui/dither-glow.ts"]).length, 1);
    assert.equal(portedIn(["src/ui/dither-glow.tsx"]).length, 0);
  });

  test("the file: its own section, after the packages, with where it's from, the files and the full licence", () => {
    const { root, inputs } = fakeRepo();
    const md = render({ packages: bundledPackages(inputs, root), bun: { version: "9.9.9", license: "Bun" }, tmux: "tmux", ported: portedIn(["src/ui/dither-glow.ts"]) });
    assert.match(md, /3\. \[Ported code\]\(#ported-code\)[^\n]*\n4\. \[tmux\]\(#tmux\)[^\n]*\n5\. \[Not in this release\]/);
    assert.match(md, /## JavaScript packages[\s\S]*## Ported code[\s\S]*## tmux/);
    assert.match(md, /### voice-glow 0\.5\.0\n\nLicence: MIT\. Source: https:\/\/github\.com\/Jakubantalik\/Libraries\.dev\/tree\/[0-9a-f]{40}\/packages\/voice-glow/);
    assert.match(md, /In: `src\/ui\/dither-glow\.ts`, `src\/ui\/voice-envelope\.ts`\./);
    assert.ok(md.includes("Copyright (c) 2026 Jakub Antalik"));
    assert.ok(md.includes('THE SOFTWARE IS PROVIDED "AS IS"'));
    // Without any: no section, the numbering as before.
    const none = render({ packages: [], bun: { version: "9.9.9", license: "Bun" } });
    assert.doesNotMatch(none, /Ported code/);
    assert.match(none, /\n3\. \[Not in this release\]/);
  });
});

describe("the script", () => {
  const run = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  test("writes the file, and says what needs care without failing", () => {
    const { root, inputs } = fakeRepo();
    const meta = join(root, "meta.json");
    writeFileSync(meta, JSON.stringify({ inputs: Object.fromEntries(inputs.map((i) => [i, {}])), outputs: {} }));
    writeFileSync(join(root, "tmux.txt"), "==== tmux 3.8 ====\n");
    const out = join(root, "THIRD_PARTY_NOTICES.md");
    const r = run(["--meta", meta, "--bun", BUN_FOR, "--root", root, "--tmux", join(root, "tmux.txt"), "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /3 packages in the bundle \(1 Apache-2\.0, 1 ISC, 1 MIT\)/);
    assert.match(r.stderr, /needs care: Bun .*JavaScriptCore/);
    const md = readFileSync(out, "utf8");
    assert.match(md, /### @scope\/alpha 2\.1\.0/);
    assert.match(md, /==== tmux 3\.8 ====/);
    assert.match(md, /\n### Linked libraries\n/, "Bun's own LICENSE.md");
  });

  test("fails on a package with no licence text, writing nothing", () => {
    const { root, inputs } = fakeRepo();
    inputs.push(pkg(root, "gpl-thing", "1.0.0", "GPL-3.0"));
    const meta = join(root, "meta.json");
    writeFileSync(meta, JSON.stringify({ inputs: Object.fromEntries(inputs.map((i) => [i, {}])) }));
    const out = join(root, "out.md");
    const r = run(["--meta", meta, "--bun", BUN_FOR, "--root", root, "--out", out]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gpl-thing@1\.0\.0 \(GPL-3\.0, .*\) has no licence text/);
    assert.equal(existsSync(out), false);
  });

  test("fails on another Bun than the one its licence was taken from, and on a metafile with no packages", () => {
    const { root, inputs } = fakeRepo();
    const meta = join(root, "meta.json");
    writeFileSync(meta, JSON.stringify({ inputs: Object.fromEntries(inputs.map((i) => [i, {}])) }));
    const r = run(["--meta", meta, "--bun", "0.0.1", "--root", root]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Bun 0\.0\.1: curl -fsSL https:\/\/raw\.githubusercontent\.com\/oven-sh\/bun\/bun-v0\.0\.1\/LICENSE\.md/);
    writeFileSync(meta, JSON.stringify({ inputs: { "src/main.ts": {} } }));
    assert.match(run(["--meta", meta, "--bun", BUN_FOR, "--root", root]).stderr, /no package found/);
    assert.equal(run(["--meta", meta]).status, 2);
  });
});

describe("this repo", () => {
  test("every production dependency has a licence text (or one supplied), and each supplied one is there", () => {
    const list = productionPackages(REPO);
    assert.ok(list.length > 10, `${list.length} packages`);
    assert.deepEqual(missing(list), []);
    for (const name of Object.keys(SUPPLIED)) assert.ok(existsSync(join(REPO, "scripts", "notices", "supplied", `${name.replace("/", "__")}.txt`)), name);
  });

  test("each ported project's licence text is there, and each of its files exists and keeps its notice in its header", () => {
    for (const p of PORTED) {
      const licence = readFileSync(join(REPO, "scripts", "notices", "ported", p.licenseFile), "utf8");
      const holder = licence.match(/^Copyright \(c\) .+$/m)?.[0];
      assert.ok(holder, p.name);
      for (const file of p.files) {
        const head = readFileSync(join(REPO, file), "utf8").slice(0, 6000);
        assert.ok(head.includes(holder), `${file} keeps "${holder}"`);
        assert.ok(head.includes("Permission is hereby granted, free of charge"), `${file} keeps the permission notice`);
        assert.ok(head.includes(p.name), `${file} names ${p.name}`);
      }
    }
  });
});
