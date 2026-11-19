// Each Claude Code session's permission mode, as its hooks last said it (`permission_mode`, on Stop,
// PermissionRequest, UserPromptSubmit, PermissionDenied and the others that carry it; SessionStart
// doesn't). Claude Code keeps it nowhere else Kiko can read: not in `claude agents --json`, not in
// its process record. Shift+Tab in a session changes it with no hook of its own, so the list has the
// new one at that session's next event. Kept for this run only; forgotten as a session ends.
import { permissionModeOf, type PermissionMode } from "../../core/permission-mode.ts";

const modes = new Map<string, PermissionMode>();
/** The most kept: the oldest go first (a session that ended without its SessionEnd). */
const MAX = 200;

/** A hook's `permission_mode` for a session, kept: whether that changed what's kept (a mode it didn't have). */
export function noteMode(sessionId: unknown, raw: unknown): boolean {
  const mode = permissionModeOf(raw);
  if (typeof sessionId !== "string" || !sessionId || !mode || modes.get(sessionId) === mode) return false;
  modes.delete(sessionId);
  modes.set(sessionId, mode);
  if (modes.size > MAX) modes.delete(modes.keys().next().value!);
  return true;
}

/** A session's mode as its hooks last said it; undefined while none has. */
export const modeOf = (sessionId: string): PermissionMode | undefined => modes.get(sessionId);

export const forgetMode = (sessionId: string) => void modes.delete(sessionId);
