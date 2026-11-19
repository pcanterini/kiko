// The plain command line's output (src/cli.ts and the commands it runs: account-cli.ts, keys-cli.ts,
// update-cli.ts, uninstall.ts), marked and styled as GitHub's CLI marks its own (cli/cli
// pkg/iostreams/color.go: SuccessIcon, WarningIcon, FailureIcon, Bold):
//   ✓ green   done, or as it should be
//   ! yellow  look at this: a warning, something to do, or a code to copy
//   X red     it went wrong, or was refused (the command exits 1)
// and bold for the values in a line (an email, a code, a name, a version), dim for hints and
// secondary lines. The markers are text and stay without colour (as gh's do); only the colour
// goes. Colour when the stream is a terminal and nothing says otherwise, as go-gh's term decides
// it (pkg/term/env.go): NO_COLOR (any value, no-color.org) or CLICOLOR=0 turn it off, as does
// TERM=dumb; CLICOLOR_FORCE (not 0) turns it on for a pipe. Setup's own screens (@clack/prompts)
// and the app's window style themselves.

/** How one stream's lines are styled. With `color` false, everything comes back as it was given, markers included. */
export type Style = {
  color: boolean;
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  /** "✓ text", the ✓ green. */
  ok(text: string): string;
  /** "! text", the ! yellow. */
  warn(text: string): string;
  /** "X text", the X red. */
  error(text: string): string;
  /** A line made elsewhere that may start with a marker ("✓ …", "✗ …", "! …", "X …"): that marker coloured (✗ as X); any other line as it is. */
  marked(line: string): string;
  /** A y/N question, as asked: "Sign out anyway? [y/N] ", the question bold and the choices dim. */
  question(text: string): string;
};

/** Whether a stream gets colour (above). `stream`: process.stdout or process.stderr, or a test's. */
export function colorOn(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR) return false;
  if (env.CLICOLOR === "0") return false;
  if (env.TERM === "dumb") return false;
  if (env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== "0") return true;
  return Boolean(stream.isTTY);
}

/** How many colours a stream gets: none (0: colorOn says no), truecolor (24), or xterm's 256. */
export type ColorDepth = 0 | 256 | 24;

/**
 * The colour depth for drawing in a stream's own colours (the logo: logo.ts): none as colorOn
 * decides it; truecolor when COLORTERM says so (truecolor, 24bit; the Kiko window's tmux sets it,
 * tmux.conf) or TERM is a -direct one; else 256, which every terminal Kiko runs in has (Apple's
 * Terminal before macOS 26 has no more).
 */
export function colorDepth(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): ColorDepth {
  if (!colorOn(stream, env)) return 0;
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "") || /-direct$/.test(env.TERM ?? "")) return 24;
  return 256;
}

/** SGR in and out. Each turns off only its own (22: bold and dim, 39: the colour), so a bold value inside a coloured line keeps the colour after it. */
const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;

/** The styles, with colour or without. */
export function styleOf(color: boolean): Style {
  const same = (text: string) => text;
  const bold = color ? sgr(1, 22) : same;
  const dim = color ? sgr(2, 22) : same;
  const green = color ? sgr(32, 39) : same;
  const yellow = color ? sgr(33, 39) : same;
  const red = color ? sgr(31, 39) : same;
  const ok = (text: string) => `${green("✓")} ${text}`;
  const warn = (text: string) => `${yellow("!")} ${text}`;
  const error = (text: string) => `${red("X")} ${text}`;
  return {
    color,
    bold,
    dim,
    green,
    yellow,
    red,
    ok,
    warn,
    error,
    marked(line) {
      const m = /^(✓|✗|!|X) (.*)$/s.exec(line);
      if (!m) return line;
      return m[1] === "✓" ? ok(m[2]) : m[1] === "!" ? warn(m[2]) : error(m[2]);
    },
    question: (text) => `${bold(text)} ${dim("[y/N]")} `,
  };
}

/** No colour: what a test gets, and a pipe. */
export const PLAIN: Style = styleOf(false);

/** The styles for a stream (colorOn). */
export const styleFor = (stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): Style => styleOf(colorOn(stream, env));
