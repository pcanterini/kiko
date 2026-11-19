// Types for what src/ uses of hooks/lib.mjs (the hooks run the .mjs on their own; src/core/guard.ts imports it).

/** Whether the safety gate is on in these saved settings: `guard` when saved, else on only with kinds turned off by hand (`guardOff`). */
export function guardOn(saved: unknown): boolean;
/** The safety gate as this flavour's settings file has it, as a hook reads it. */
export function guardSaved(): boolean;
/** The terminal a session runs in, as the hook's environment says (the tests read it). */
export function terminalEnv(env?: Record<string, string | undefined>): { program?: string; bundle?: string; kiko?: true; rex?: string };
/** Before a reply given through a held Stop hook: the agent is told it was spoken. */
export const VOICE_REPLY: string;
/** Hook context beside a prompt the app typed in for you: the agent is told it was dictated. */
export const VOICE_PROMPT: string;
/** The longest a told event's hook waits on the app (and a prompt's, for the app's one line back). */
export const TELL_MS: number;
