// Types for hooks/guard.mjs, the safety gate's rules (the hooks run the .mjs on its own; src/core/guard.ts imports it).

export type GuardKind = "sends" | "deletes" | "pays" | "posts";
/** A rule that matched for sure: the kind, which rule ("git push"), and what it does in a few words ("push to GitHub"). */
export type GuardHit = { kind: GuardKind; rule: string; what: string };
/** A call that looks risky but code can't tell: the classifier's to decide. `hint`: the kind its words suggest. */
export type GuardUnclear = { rule: string; what: string; hint?: GuardKind; args?: string };
export type GuardFound = { hits: GuardHit[]; unclear: GuardUnclear[] };

export const KINDS: GuardKind[];
export const KIND_INFO: Record<GuardKind, { label: string; covers: string }>;
export function guardCheck(toolName: unknown, toolInput: unknown, cwd?: string): GuardFound | null;
export function checkCommand(command: string, cwd?: string): GuardFound | null;
export function checkMcp(toolName: string, input: unknown): GuardFound | null;
export function parseShell(src: string, depth?: number): { words: string[]; heredoc?: string; writes?: string[] }[];
export function unwrap(words: string[]): string[];
export function safeToRemove(path: string, cwd?: string): boolean;
export function serverName(server: string): string;
