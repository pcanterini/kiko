// Bundles src/main.ts (the installed executable's entry) and everything it imports into one
// JavaScript file, for `bun build --compile` (scripts/release.sh). Run by Bun: `bun scripts/bundle.ts <out-dir>`.
//   - Ink's React DevTools support (react-devtools-core) is never installed: a stub stands in.
//   - KIKO_VERSION: another version than package.json's, built in (only to try an update).
//   - Names kept (no identifier minifying): `bun build --compile` renames this file's names again,
//     and on short minified ones it can pick a parameter's new name equal to a name its default
//     reads (`function offeredStarters(A8 = A8)`: "Cannot access 'A8' before initialization" when a
//     session was started from the window, 2026-11-01). Whitespace and syntax are still minified.
//   - meta.json beside it: Bun's metafile, every file that went in (scripts/notices/notices.ts lists
//     the packages they came from in THIRD_PARTY_NOTICES.md). `bun build --compile` reads main.js only.
import { SLUG } from "../src/core/name.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: bun scripts/bundle.ts <out-dir>");
const version = process.env.KIKO_VERSION;

const plugin = {
  name: `${SLUG}-release`,
  setup(build: Bun.PluginBuilder) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default { initialize() {}, connectToDevTools() {} };", loader: "js" }));
    if (version)
      build.onLoad({ filter: /\/package\.json$/ }, async (args) => {
        const pkg = JSON.parse(await Bun.file(args.path).text());
        return { contents: JSON.stringify(pkg.name === SLUG ? { ...pkg, version } : pkg), loader: "json" };
      });
  },
};

const result = await Bun.build({
  entrypoints: [new URL("../src/main.ts", import.meta.url).pathname],
  outdir: out,
  target: "bun",
  format: "esm",
  minify: { whitespace: true, syntax: true, identifiers: false },
  plugins: [plugin],
  metafile: true,
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
await Bun.write(`${out}/meta.json`, JSON.stringify(result.metafile));
for (const output of result.outputs) console.log(output.path);
