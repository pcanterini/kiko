// The terminal app each Claude Code session runs in, as its hooks last said it (`terminal`, on
// SessionStart, UserPromptSubmit, Stop and PermissionRequest: hooks/lib.mjs terminalEnv), worked
// out by core/terminal-apps.ts sessionTerminal, with the Rex block it runs in when it's in Rex.
// Claude Code keeps it nowhere Kiko can read. The Ghostty adapter scripts Ghostty only for sessions
// there (or not known yet), and Rex's looks at a session's block first. Kept for this run only;
// forgotten as a session ends.
import { isObject } from "../../core/is-object.ts";
import { sessionTerminal } from "../../core/terminal-apps.ts";

/** Each session's terminal, and the pane in it its hook said (a Rex block: REX_BLOCK), when it did. */
const terminals = new Map<string, { terminal: string; pane?: string }>();
/** The most kept: the oldest go first (a session that ended without its SessionEnd). */
const MAX = 200;

/** A Rex block's id, as the hook passes it on (hooks/lib.mjs terminalEnv; terminals/rex/rex.ts BLOCK_ID). */
const REX_BLOCK = /^block:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A hook's `terminal` for a session, kept: whether that changed what's kept. */
export function noteTerminal(sessionId: unknown, raw: unknown): boolean {
  if (typeof sessionId !== "string" || !sessionId || !isObject(raw)) return false;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const terminal = sessionTerminal({ program: str(raw.program), bundle: str(raw.bundle), kiko: raw.kiko === true });
  // Its Rex block, only for a session in Rex (a tmux of your own started in Rex keeps the block it was started in).
  const block = terminal === "rex" ? str(raw.rex) : undefined;
  const pane = block && block.length <= 64 && REX_BLOCK.test(block) ? block : undefined;
  const had = terminals.get(sessionId);
  if (had?.terminal === terminal && had.pane === pane) return false;
  terminals.delete(sessionId);
  terminals.set(sessionId, pane ? { terminal, pane } : { terminal });
  if (terminals.size > MAX) terminals.delete(terminals.keys().next().value!);
  return true;
}

/** A session's terminal as its hooks last said it; undefined while none has. */
export const terminalOf = (sessionId: string): string | undefined => terminals.get(sessionId)?.terminal;

/** The pane its hooks last said it runs in (a Rex block), for the terminal adapters to look at first (Findable.pane). */
export const paneOf = (sessionId: string): string | undefined => terminals.get(sessionId)?.pane;

export const forgetTerminal = (sessionId: string) => void terminals.delete(sessionId);
