// Types for hooks/guard/auto-allow.mjs, whether a permission prompt's call only reads (src/core/auto-allow.ts imports it).

/** `why`: its readers ("ls, git log") when it only reads, else the first thing that made it ask. */
export type ReadOnly = { readOnly: boolean; why: string };

/** `home`: the home folder, whose git/ holds the other projects that may be read too (tests: a fake one; default: the real one). */
export type ReadOnlyOptions = { home?: string };

/** `cwd`: the session's folder, which every path must stay inside, or ~/git (unknown: no absolute, ~ or .. path). */
export function readOnlyCall(toolName: unknown, toolInput: unknown, cwd?: unknown, options?: ReadOnlyOptions): ReadOnly;
export function commandReadOnly(command: unknown, cwd?: unknown, options?: ReadOnlyOptions): ReadOnly;
export function secretIn(text: unknown): string | null;
export function gitRepoProblem(at: string, options?: { credentials?: boolean }): string | null;
export type Word = { text: string; tilde: boolean; quoted: boolean; glob: boolean };
/** `ops`: the operator after each command (";" for a newline too), null after the last. */
export function lex(src: string): { commands: Word[][]; ops: (";" | "&&" | "||" | "|" | null)[]; bad?: undefined } | { bad: string; commands?: undefined; ops?: undefined };
