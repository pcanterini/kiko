// The installed `kiko` executable's entry (scripts/release.sh builds it with Bun's --compile;
// a checkout runs src/cli.ts with Node instead: bin/kiko). One file holds the whole app, so it is
// also each of the app's own programs, which a checkout runs as `node src/<file>.ts`:
//   kiko _run <program> [args…]   one of core/app-root.ts PROGRAMS (start, app, onboard, pocket, the panes)
//   kiko hook <script> [args…]    a script beside it (hooks/*.mjs, statusline/kiko-status.mjs):
//                                    what the agents' hooks run, with no Node needed
//   kiko _verify-files            its own folder checked against the files it was built with
//                                    (core/release-files.ts): what an update and install.sh ask it
//   kiko …                        anything else: the CLI (src/cli.ts)
// Each is imported only when it's the one run: importing one starts it.
import { pathToFileURL } from "node:url";
import { RUN_PROGRAM, RUN_SCRIPT, running, type Program } from "./core/app-root.ts";
import { VERIFY_FILES, verifyOwnFolder } from "./core/release-files.ts";

const [command, name] = process.argv.slice(2);

// Each by its own import, so the bundler finds it.
const programs: Record<Program, () => Promise<unknown>> = {
  start: () => import("./start.ts"),
  app: () => import("./app.ts"),
  onboard: () => import("./onboard.ts"),
  pocket: () => import("./pocket-start.ts"),
  viewer: () => import("./terminals/tmux/viewer-pane.ts"),
  frame: () => import("./terminals/tmux/frame-pane.ts"),
  menu: () => import("./terminals/tmux/menu-popup.ts"),
};

if (command === RUN_PROGRAM && name && Object.hasOwn(programs, name)) {
  // What it reads of argv is what follows, as under Node (`node <file> args…`).
  process.argv.splice(2, 2);
  running.program = name as Program;
  await programs[name as Program]();
} else if (command === RUN_SCRIPT && name?.endsWith(".mjs")) {
  // The script sees itself as argv[1], as under Node.
  process.argv.splice(1, 3, name);
  await import(pathToFileURL(name).href);
} else if (command === VERIFY_FILES) {
  // Nothing else is loaded: no settings, no logs, no Keychain. The version is the bundle's own (scripts/bundle.ts).
  const { default: pkg } = await import("../package.json", { with: { type: "json" } });
  process.exitCode = verifyOwnFolder(pkg.version);
} else {
  await import("./cli.ts");
}
