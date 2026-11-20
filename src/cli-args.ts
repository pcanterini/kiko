// `kiko`'s command line, read (src/cli.ts runs it): options first, then a command and its own
// arguments. Options are read only before the command, with Node's util.parseArgs (strict), the
// GNU/POSIX way: long options with two dashes, short ones with one and clustered (-hV), `--` ends
// them, and of two `--key`s the last one wins. Everything after
// `claude` goes to Claude Code as it is (after `codex`, to Codex; after `opencode`, to OpenCode), never read here. Imports nothing of Kiko's that loads
// .env or writes logs.
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { accountsLive, phoneLive, proOnSale } from "./core/env.ts";
import { COMMAND, DOMAIN, ENV_PREFIX, NAME, PRO_PRICE, SLUG, TITLE } from "./core/name.ts";
import { parseKey } from "./terminals/tmux/keys.ts";
import type { Style } from "./ui/cli-style.ts";

/** kiko's options. `key` takes a value (`--key C-\`, `--key=C-\`). */
const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
  key: { type: "string" },
} as const;

/** The options as they're written: nothing else is one (parseArgs would take `--no-help` too). */
const WRITTEN = ["--help", "-h", "--version", "-V", "--key"];
/** The ones that take a value. */
const VALUED = new Set(["--key"]);
const LONG = WRITTEN.filter((o) => o.startsWith("--"));

/** The commands, each with how many arguments it takes (Infinity: claude's, passed on). */
export const COMMANDS: Record<string, number> = {
  claude: Infinity,
  codex: Infinity,
  opencode: Infinity,
  attach: 1,
  ls: 0,
  "trust-scratch": 0,
  setup: 1,
  uninstall: 1,
  keys: 2,
  login: 1,
  logout: 0,
  account: 2,
  upgrade: 1,
  update: 1,
  help: 0,
  // Kiko Dev's own, not in the help: each state of the Mac overlay prototype, through the running helper app.
  "_overlay-test": 0,
  // And a preview of the dithered voice glow (ui/glow-demo.ts): --mic, --braille or --blocks, --rows N, --wide, --mono or --light.
  "_glow-demo": 8,
};

/** The account commands' lines in the help, while accounts are open (core/env.ts accountsLive). */
const ACCOUNT_USAGE = `
  login                 sign in to your ${NAME} account (for the free trial): shows a
                        one-time code, then opens ${DOMAIN} in the browser to enter it
  login --no-browser    print the link and the code instead, to open on any device
  logout                sign this Mac out${phoneLive() ? " (asks first when a phone is paired)" : ""}
  account               who's signed in, and the plan
  account billing       manage ${NAME} Pro (card, invoices, cancelling) in your browser
  account delete        delete your ${NAME} account (asks first, then a code from its email)`;

/** Buying Kiko Pro in the help, while it's on sale (core/env.ts proOnSale); managing it is with the account's lines. */
const PRO_USAGE = `
  upgrade               get ${NAME} Pro, ${NAME}'s AI included: ${PRO_PRICE.month} or
                        ${PRO_PRICE.year} (${PRO_PRICE.tax}); opens checkout in your browser`;

export const USAGE = `Usage: ${COMMAND} [options] [command]

Commands:
  (none)                open the ${TITLE} window here (starts ${NAME} if it isn't running)
  claude [args…]        start Claude Code here, in the ${TITLE} window (args go to claude as they are)
  codex [args…]         start Codex here, in the ${TITLE} window (args go to codex as they are)
  opencode [args…]      start OpenCode here, in the ${TITLE} window (args go to opencode)
  attach [name]         the ${TITLE} window, showing that session (${COMMAND} ls lists them)
  ls                    the sessions in ${NAME}'s tmux
  trust-scratch         trust ${NAME}'s scratch folder in Claude Code, once (it asks there)
  setup [--all]         set ${NAME} up: your agents, one key, the microphone, the talk
                        key, its voice; the steps done already left out (--all: every one)
  setup <agent>         connect an agent: add ${NAME}'s hooks to its file, or repair
                        them (claude, codex, opencode). Asks first; yours are kept, and
                        the file is backed up
  uninstall [agent]     take ${NAME}'s hooks out of an agent's file (only ${NAME}'s; none:
                        every one). Installed with install.sh, plain uninstall takes all of
                        ${NAME} off this Mac, asking first (and again for the logs)
  keys                  the API keys, and where each comes from (never shown)
  keys set <name>       enter one (hidden): checked, then kept in the Keychain
                        (openrouter, anthropic, deepgram, cartesia)
  keys remove <name>    take one out of the Keychain${accountsLive() ? ACCOUNT_USAGE : ""}${proOnSale() ? PRO_USAGE : ""}
  update                install the newest ${NAME} now (it starts the next time ${NAME} does)
  update --rollback     go back to the version before
  update --token <t>    keep your invite's install token (or its link), then update
  help                  this text

Options (before the command):
  --key <key>           the menu key, which opens the window's menu (Ctrl+Space by
                        default): C-Space, C-\\, C-], C-g, M-k, F12, or Ctrl+], Alt+K…
  -h, --help            this text
  -V, --version         the version

${ENV_PREFIX}KEY=<key> is --key <key>. --key wins over ${ENV_PREFIX}KEY, which wins over the
"Menu key" setting. When your own tmux, herdr or macOS takes that key first,
${NAME} uses another one that time (Ctrl+\\ first) and says so.

Licences: LICENSE.md (${NAME}'s) and THIRD_PARTY_NOTICES.md (what's built into
it), in ~/.local/share/${SLUG}/current/ once installed.`;

/** The help as printed: its headings bold (ui/cli-style.ts; plain on a pipe or with NO_COLOR). */
export const styledUsage = (s: Style, usage = USAGE) => usage.replace(/^(Usage:|Commands:|Options \(before the command\):)/gm, (heading) => s.bold(heading));

export type Parsed =
  | { kind: "help" }
  | { kind: "version" }
  /** `key`: --key's, as tmux names it; undefined without. */
  | { kind: "run"; command: string | undefined; args: string[]; key?: string }
  /** A usage error: said on stderr with how to get help, exit 2. */
  | { kind: "error"; message: string };

/** The version in package.json (built into an installed copy's executable). */
export function version(): string {
  return pkg.version;
}

/** How many single-character edits make `a` into `b` (Levenshtein, a swap of two neighbours counting as one). */
export function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The closest of `known` to `word`, when it's close enough to be a typo of it (a third of its length, at least 1); else null. */
export function closest(word: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestAt = Infinity;
  for (const k of known) {
    const at = distance(word, k);
    if (at < bestAt) [best, bestAt] = [k, at];
  }
  return best !== null && bestAt <= Math.max(1, Math.floor(word.length / 3)) ? best : null;
}

/** Where the options end: the index of the command (the first word that isn't an option), or after `--`. */
function split(argv: readonly string[]): { head: string[]; command: string | undefined; rest: string[] } {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") return { head: argv.slice(0, i), command: argv[i + 1], rest: argv.slice(i + 2) };
    // An option that takes a value takes the next word (`--key C-Space`), whatever it looks like.
    if (VALUED.has(a)) {
      i++;
      continue;
    }
    // The others are flags, so the first word not starting with "-" is the command; "-" alone is a word.
    if (!a.startsWith("-") || a === "-") return { head: argv.slice(0, i), command: a, rest: argv.slice(i + 1) };
  }
  return { head: [...argv], command: undefined, rest: [] };
}

/** `kiko`'s arguments (process.argv after the script), read. */
export function parseCli(argv: readonly string[]): Parsed {
  const { head, command, rest } = split(argv);
  // Unknown options first, by name, with what was probably meant.
  const { tokens } = parseArgs({ args: head, options: OPTIONS, strict: false, tokens: true });
  for (const t of tokens) {
    if (t.kind !== "option") continue;
    if (!WRITTEN.includes(t.rawName)) {
      const near = t.rawName.startsWith("--") ? closest(t.rawName, LONG) : null;
      return { kind: "error", message: `unknown option ${t.rawName}${near ? `. Did you mean ${near}?` : ""}` };
    }
    // A value given to a flag (--help=yes): only --key takes one, and needs it.
    if (VALUED.has(t.rawName)) {
      if (t.value === undefined) return { kind: "error", message: `${t.rawName} needs a key after it (C-Space, C-\\, C-], F12…)` };
      continue;
    }
    if (t.value !== undefined) return { kind: "error", message: `option ${t.rawName} doesn't take a value` };
  }
  let values: { help?: boolean; version?: boolean; key?: string };
  try {
    values = parseArgs({ args: head, options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (err) {
    return { kind: "error", message: `couldn't read the options (${err instanceof Error ? err.message : String(err)})` };
  }
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  let key: string | undefined;
  if (values.key !== undefined) {
    const parsed = parseKey(values.key);
    if ("error" in parsed) return { kind: "error", message: `--key: ${parsed.error}` };
    key = parsed.key;
  }
  if (command !== undefined) {
    const takes = COMMANDS[command];
    if (takes === undefined) {
      const near = closest(
        command,
        Object.keys(COMMANDS).filter((c) => !c.startsWith("_")),
      );
      return { kind: "error", message: `unknown command ${command}${near ? `. Did you mean ${near}?` : ""}` };
    }
    if (rest.length > takes) {
      const what = takes === 0 ? "takes no arguments" : `takes at most ${takes} argument${takes === 1 ? "" : "s"}`;
      return { kind: "error", message: `${command} ${what} (options go before the command: ${COMMAND} [options] ${command})` };
    }
    if (command === "help") return { kind: "help" };
  }
  return { kind: "run", command, args: rest, ...(key ? { key } : {}) };
}

/**
 * Codex's runs that print and quit (`codex --help`, 0.153.0): its flags for that, and every
 * subcommand but `resume` and `fork`, which open its TUI as plain `codex` does. A first word that
 * is none of them is the prompt (`codex "fix the login bug"`): its TUI.
 */
const CODEX_ONE_SHOT = new Set(["-h", "--help", "-V", "--version"]);
const CODEX_COMMANDS = new Set([
  "agents",
  "exec",
  "e",
  "review",
  "login",
  "logout",
  "mcp",
  "plugin",
  "mcp-server",
  "app-server",
  "remote-control",
  "app",
  "completion",
  "update",
  "doctor",
  "sandbox",
  "debug",
  "apply",
  "a",
  "queue",
  "archive",
  "delete",
  "migrate-rollouts",
  "unarchive",
  "cloud",
  "exec-server",
  "features",
  "help",
]);

/**
 * OpenCode's runs that print and quit, or aren't its TUI (`opencode --help`, 2.0.32): its flags for
 * that, and every subcommand but `mini` (its smaller TUI). A first word that is none of them is the
 * folder to open (`opencode ~/pixie`): its TUI.
 */
const OPENCODE_ONE_SHOT = new Set(["-h", "--help", "-v", "--version", "--completions"]);
const OPENCODE_COMMANDS = new Set(["upgrade", "update", "uninstall", "acp", "api", "debug", "auth", "mcp", "plugin", "models", "stats", "run", "session", "service", "reload", "pair", "serve"]);

/** Whether `opencode <args>` prints and quits (or runs without its TUI) rather than opening its TUI. */
export function opencodeOneShot(args: readonly string[]): boolean {
  if (args.some((a) => OPENCODE_ONE_SHOT.has(a))) return true;
  // Its first word that isn't an option (or an option's value).
  const VALUED = new Set(["--server", "-s", "--session", "--prompt", "--log-level"]);
  for (let i = 0; i < args.length; i++) {
    if (VALUED.has(args[i])) {
      i++;
      continue;
    }
    if (!args[i].startsWith("-")) return OPENCODE_COMMANDS.has(args[i]);
  }
  return false;
}

/** Whether `codex <args>` prints and quits rather than opening its TUI. */
export function codexOneShot(args: readonly string[]): boolean {
  if (args.some((a) => CODEX_ONE_SHOT.has(a))) return true;
  // Its first word that isn't an option (or an option's value: -c k=v, -m model, -C dir…).
  const VALUED = new Set([
    "-c",
    "--config",
    "--enable",
    "--disable",
    "--remote",
    "--remote-auth-token-env",
    "-i",
    "--image",
    "-m",
    "--model",
    "--local-provider",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-C",
    "--cd",
    "--add-dir",
    "-a",
    "--ask-for-approval",
  ]);
  for (let i = 0; i < args.length; i++) {
    if (VALUED.has(args[i])) {
      i++;
      continue;
    }
    if (!args[i].startsWith("-")) return CODEX_COMMANDS.has(args[i]);
  }
  return false;
}
