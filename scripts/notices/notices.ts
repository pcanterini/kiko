// THIRD_PARTY_NOTICES.md, each release's list of what's built into it and their licences, made by
// scripts/release.sh from what is actually in it (RELEASING.md, "Third-party notices"):
//   - the JavaScript packages compiled into `kiko`: every package a file of the bundle came from
//     (the metafile scripts/bundle.ts writes beside it), with its version, licence id and full
//     licence text (and NOTICE file, Apache's), read from its folder in node_modules;
//   - Bun, the runtime `bun build --compile` puts in `kiko`: its own LICENSE.md, kept here in
//     bun/ for the Bun it was taken from (bun/VERSION), as Bun publishes no other;
//   - tmux and the libraries built into it: scripts/build-tmux.sh's THIRD-PARTY-NOTICES.txt;
//   - code ported from other projects into Kiko's own files (PORTED), when one of those files is
//     in the bundle: where it's from, its copyright and its licence text, kept in ported/.
//
//   node scripts/notices/notices.ts --meta <dist>/meta.json --bun <version> [--tmux <file>] [--out <file>]
//
// Without --out it only checks. Either way it fails (exit 1) when a bundled package has no licence
// text, or the Bun differs from the one bun/LICENSE.md is from, and says what needs care (a GPL
// family licence, or one it doesn't know) on stderr, without failing on it.
// A package that ships no licence file of its own gets one in supplied/, by name, taken from its
// repository (SUPPLIED says where): used only while the package still declares the same licence.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NAME, SLUG } from "../../src/core/name.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Licence texts for packages whose published files have none, from their repositories. */
export const SUPPLIED: Record<string, { license: string; from: string }> = {
  "yoga-layout": { license: "MIT", from: "https://github.com/facebook/yoga/blob/v3.2.1/LICENSE" },
  standardwebhooks: { license: "MIT", from: "https://github.com/standard-webhooks/standard-webhooks/blob/c7cd8a9eadf9879d6dca345e168dc8d15d19e487/libraries/LICENSE" },
};

/**
 * Code ported from other projects into Kiko's own source (not an npm package, so not in the
 * bundle's node_modules): each project, the files of Kiko's that carry it (their headers keep its
 * notice too), and its licence text, as the project publishes it, in ported/<licenseFile>.
 */
export type Ported = { name: string; version: string; license: string; from: string; files: string[]; licenseFile: string };

export const PORTED: Ported[] = [
  {
    name: "voice-glow",
    version: "0.5.0",
    license: "MIT",
    from: "https://github.com/Jakubantalik/Libraries.dev/tree/14ae9d2dad18fcee251f4b06333b492a2a41d2ed/packages/voice-glow",
    files: ["src/ui/dither-glow.ts", "src/ui/voice-envelope.ts"],
    licenseFile: "voice-glow.txt",
  },
];

/** The ported code a bundle holds: each PORTED entry one of whose files is among its inputs, with its licence text. */
export function portedIn(inputs: string[], list: Ported[] = PORTED, dir = join(HERE, "ported")): (Ported & { text: string })[] {
  const has = (file: string) => inputs.some((i) => i === file || i.endsWith(`/${file}`));
  return list.filter((p) => p.files.some(has)).map((p) => ({ ...p, text: readFileSync(join(dir, p.licenseFile), "utf8") }));
}

/** Licences that ask nothing but their notice kept (SPDX ids). */
const PERMISSIVE = new Set(["MIT", "MIT-0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0", "Unlicense", "CC0-1.0", "BlueOak-1.0.0", "Zlib", "Python-2.0"]);

export type Package = {
  name: string;
  version: string;
  /** The SPDX id or expression its package.json declares ("" when it declares none). */
  license: string;
  dir: string;
  homepage?: string;
  /** Its licence files' (and NOTICE files') texts, by file name; empty when it has none. */
  texts: { file: string; text: string }[];
};

/** A package folder's licence and NOTICE files, in name order. */
export function licenseFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|unlicense|notice)([.-].*)?$/i.test(f) && statSync(join(dir, f)).isFile())
    .sort();
}

function declared(pkg: { license?: unknown; licenses?: unknown }): string {
  const one = (l: unknown) => (typeof l === "string" ? l : l && typeof l === "object" && "type" in l ? String(l.type) : "");
  if (pkg.license) return one(pkg.license);
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map(one).filter(Boolean).join(" OR ");
  return "";
}

/** One package, read from its folder: package.json, then its licence files or a supplied one. */
export function readPackage(dir: string, supplied = SUPPLIED, suppliedDir = join(HERE, "supplied")): Package {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const license = declared(pkg);
  let texts = licenseFiles(dir).map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }));
  const extra = supplied[pkg.name];
  if (!texts.some((t) => !/^notice/i.test(t.file)) && extra && extra.license === license) {
    const file = join(suppliedDir, `${pkg.name.replace("/", "__")}.txt`);
    if (existsSync(file)) texts = [...texts, { file: `LICENSE (from ${extra.from})`, text: readFileSync(file, "utf8") }];
  }
  const homepage = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? pkg.homepage);
  return { name: pkg.name, version: pkg.version, license, dir, homepage, texts };
}

/** The package folder a bundled file is in: the path through its last node_modules/<name>. */
export function packageDirOf(input: string): string | undefined {
  const m = input.match(/^(.*node_modules\/(?:@[^/]+\/[^/]+|[^/]+))\//);
  return m?.[1];
}

/** Every package a file of the bundle came from (the metafile's inputs, relative to root), by name and version. */
export function bundledPackages(inputs: string[], root: string): Package[] {
  const dirs = new Set<string>();
  for (const input of inputs) {
    const dir = packageDirOf(input);
    if (dir) dirs.add(realpathSync(resolve(root, dir)));
  }
  return sortPackages([...dirs].map((dir) => readPackage(dir)));
}

/** The packages `dependencies` brings in, through each one's own (and optional) dependencies: what the bundle can draw from. */
export function productionPackages(root: string): Package[] {
  const seen = new Map<string, Package>();
  const find = (from: string, name: string): string | undefined => {
    for (let dir = from; ; dir = dirname(dir)) {
      const at = join(dir, "node_modules", name);
      if (existsSync(join(at, "package.json"))) return realpathSync(at);
      if (dirname(dir) === dir) return undefined;
    }
  };
  const visit = (dir: string, deps: Record<string, string>, optional: Record<string, string>) => {
    for (const name of [...Object.keys(deps), ...Object.keys(optional)]) {
      const at = find(dir, name);
      if (!at) {
        if (name in deps) throw new Error(`${name} (a dependency of ${dir}) isn't installed: pnpm install`);
        continue;
      }
      if (seen.has(at)) continue;
      const pkg = readPackage(at);
      seen.set(at, pkg);
      const json = JSON.parse(readFileSync(join(at, "package.json"), "utf8"));
      visit(at, json.dependencies ?? {}, json.optionalDependencies ?? {});
    }
  };
  const top = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  visit(root, top.dependencies ?? {}, top.optionalDependencies ?? {});
  return sortPackages([...seen.values()]);
}

const sortPackages = (list: Package[]) => list.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));

/** What needs a person's eye in a licence id: a GPL family one (GPL, LGPL, AGPL), or one not known to be permissive. Undefined when it's fine. */
export function concern(license: string): string | undefined {
  if (!license) return "declares no licence";
  if (/GPL/i.test(license)) return `${license}: a GPL family licence (copyleft), check what it asks of a binary release`;
  const ids = license
    .replace(/[()]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !/^(OR|AND|WITH)$/.test(t));
  const ok = /\bAND\b/.test(license) ? ids.every((id) => PERMISSIVE.has(id)) : ids.some((id) => PERMISSIVE.has(id));
  return ok ? undefined : `${license}: not a licence this check knows, read it`;
}

/** The problems that stop a release: a package with no licence text. */
export function missing(packages: Package[]): string[] {
  return packages.filter((p) => !p.texts.some((t) => !/^notice/i.test(t.file))).map((p) => `${p.name}@${p.version} (${p.license || "no licence declared"}, ${p.dir})`);
}

/** "48 MIT, 2 Apache-2.0, 1 ISC" */
export function summary(packages: Package[]): string {
  const counts = new Map<string, number>();
  for (const p of packages) counts.set(p.license || "none", (counts.get(p.license || "none") ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([l, n]) => `${n} ${l}`)
    .join(", ");
}

/** A fenced block that the text can't end early: a fence longer than any run of backticks in it. */
function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text.trimEnd()}\n${fence}`;
}

export type Parts = { packages: Package[]; bun: { version: string; license: string }; tmux?: string; ported?: (Ported & { text: string })[] };

/** The whole file. */
export function render({ packages, bun, tmux, ported = [] }: Parts): string {
  const out: string[] = [];
  let n = 2;
  out.push(
    "# Third-party notices",
    "",
    `${NAME}'s own licence is LICENSE.md, beside this file. ${NAME} is built with the software below, whose licences ask for their notices to go with it. This file is made when a release is built (scripts/notices/notices.ts), from what is in it.`,
    "",
    `1. [Bun ${bun.version}](#bun), the JavaScript runtime inside the \`${SLUG}\` executable`,
    `2. [JavaScript packages](#javascript-packages) compiled into \`${SLUG}\` (${packages.length})`,
    ...(ported.length ? [`${++n}. [Ported code](#ported-code): code from other projects in ${NAME}'s own source (${ported.length})`] : []),
    ...(tmux ? [`${++n}. [tmux](#tmux) and the libraries built into it (\`bin/tmux\`, \`terminfo/\`)`] : []),
    `${++n}. [Not in this release](#not-in-this-release): what ${NAME} can download later`,
    "",
    "The Swift helpers in `native/` use only macOS's own frameworks.",
    "",
    "## Bun",
    "",
    `\`${SLUG}\` is Bun ${bun.version} (https://bun.com, https://github.com/oven-sh/bun) with ${NAME}'s JavaScript compiled into it (\`bun build --compile\`). Bun's licence, as Bun publishes it:`,
    "",
    bun.license.trim().replace(/^(#+) /gm, "$1# "),
    "",
    "Bun's own code is under the MIT License. Bun's LICENSE.md, above, names no copyright holder; the project is Oven's (oven-sh). The MIT License's terms:",
    "",
    fenced(MIT_TERMS),
    "",
    "## JavaScript packages",
    "",
    `The npm packages compiled into \`${SLUG}\`: ${summary(packages)}.`,
    "",
    "| Package | Version | Licence |",
    "|---|---|---|",
    ...packages.map((p) => `| ${p.name} | ${p.version} | ${p.license || "none declared"} |`),
  );
  for (const p of packages) {
    out.push("", `### ${p.name} ${p.version}`, "", `Licence: ${p.license || "none declared"}.${p.homepage ? ` Source: ${p.homepage.replace(/^git\+/, "")}` : ""}`);
    for (const t of p.texts) out.push("", `${t.file}:`, "", fenced(t.text));
  }
  if (ported.length) {
    out.push("", "## Ported code", "", `Code from these projects was ported into ${NAME}'s own source, compiled into \`${SLUG}\` with it. Each file keeps the project's notice in its header too.`);
    for (const p of ported)
      out.push("", `### ${p.name} ${p.version}`, "", `Licence: ${p.license}. Source: ${p.from}`, "", `In: ${p.files.map((f) => `\`${f}\``).join(", ")}.`, "", "LICENSE:", "", fenced(p.text));
  }
  if (tmux) out.push("", "## tmux", "", "`bin/tmux` and `terminfo/` (scripts/build-tmux.sh):", "", fenced(tmux));
  out.push(
    "",
    "## Not in this release",
    "",
    `${NAME} can download these on your Mac when you ask for them. They aren't part of this release and come with their own licences:`,
    "",
    "- Pocket TTS (Kyutai's `pocket-tts` and the Python packages it needs, from PyPI) and its voice model (from Hugging Face), when you choose Pocket TTS as the voice: `pocket/setup.sh`, beside this file, installs them.",
    "- uv (Astral), which `pocket/setup.sh` fetches only when the Mac has no uv or Python 3.10 or later.",
    "",
  );
  return out.join("\n");
}

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** What Bun's licence says needs care in every release: the LGPL code it links statically. */
export const BUN_CONCERNS = [
  `Bun (inside \`${SLUG}\`) statically links JavaScriptCore/WebKit (LGPL-2.1) and tinycc (LGPL-2.1): the LGPL asks that people can relink with a changed library (Bun's LICENSE.md, scripts/notices/bun/)`,
];

async function main(args: string[]): Promise<number> {
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const meta = opt("meta");
  const bunVersion = opt("bun");
  if (!meta || !bunVersion) {
    console.error("usage: node scripts/notices/notices.ts --meta <metafile> --bun <version> [--tmux <file>] [--out <file>] [--root <repo>]");
    return 2;
  }
  const root = resolve(opt("root") ?? process.cwd());
  const inputs = Object.keys(JSON.parse(readFileSync(meta, "utf8")).inputs ?? {});
  const packages = bundledPackages(inputs, root);
  const ported = portedIn(inputs);
  const tmuxFile = opt("tmux");
  const out = opt("out");

  let failed = false;
  if (packages.length === 0) {
    console.error(`notices: no package found in ${meta}'s inputs (not the bundle's metafile?)`);
    failed = true;
  }
  for (const m of missing(packages)) {
    console.error(`notices: ${m} has no licence text: add its licence to scripts/notices/supplied/ (and SUPPLIED in notices.ts), from its repository`);
    failed = true;
  }
  const bunFor = readFileSync(join(HERE, "bun", "VERSION"), "utf8").trim();
  if (bunFor !== bunVersion) {
    console.error(
      `notices: scripts/notices/bun/LICENSE.md is Bun ${bunFor}'s, and this is Bun ${bunVersion}: curl -fsSL https://raw.githubusercontent.com/oven-sh/bun/bun-v${bunVersion}/LICENSE.md -o scripts/notices/bun/LICENSE.md && echo ${bunVersion} > scripts/notices/bun/VERSION (and read what changed)`,
    );
    failed = true;
  }
  if (failed) return 1;

  for (const p of packages) {
    const c = concern(p.license);
    if (c) console.error(`notices: needs care: ${p.name}@${p.version}: ${c}`);
  }
  for (const c of BUN_CONCERNS) console.error(`notices: needs care: ${c}`);
  if (out) {
    const tmux = tmuxFile ? readFileSync(tmuxFile, "utf8") : undefined;
    writeFileSync(out, render({ packages, bun: { version: bunVersion, license: readFileSync(join(HERE, "bun", "LICENSE.md"), "utf8") }, tmux, ported }));
  }
  const portedSaid = ported.length ? `, ported: ${ported.map((p) => `${p.name} ${p.version}`).join(", ")}` : "";
  console.error(`notices: ${packages.length} packages in the bundle (${summary(packages)}), Bun ${bunVersion}${tmuxFile ? ", tmux" : ""}${portedSaid}${out ? ` -> ${out}` : ""}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
