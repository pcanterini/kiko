// Types for hooks/guard/read-only.mjs, what a quick check's tool call does (the hook runs the .mjs on its own; src/core/quick-ask.ts imports it).

export type CommandVerdict = { verdict: "read" | "change" | "unknown"; what?: string };
export type QuickToolVerdict = { decision: "pass" } | { decision: "deny" | "ask"; why: string };

export function gitReads(words: string[]): boolean;
export function wordsVerdict(words: string[]): CommandVerdict["verdict"];
export function commandVerdict(command: unknown, depth?: number): CommandVerdict;
export function quickToolVerdict(toolName: unknown, toolInput: unknown): QuickToolVerdict;
