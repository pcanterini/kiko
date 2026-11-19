// No permissions helper and no System Settings: each permission is T.permissions' (all granted unless a
// case sets it), and a pane asked to open is counted in T.panesOpened. The app looks at Input
// Monitoring once the talk key has started (app/talk-key.ts): a real look would be the terminal's.
import type { PermissionId, Permissions } from "../../../../../src/platform/types.ts";

export { PANES, parsePermissions } from "../../../../../src/platform/macos/permissions.ts";

const T = () => (globalThis as any).T;
const now = (): Permissions => ({ mic: "granted", speech: "granted", input: "granted", ...(T().permissions ?? {}) });

export const permissionStatus = async () => now();
export const requestPermission = async (which: PermissionId) => now()[which];
export function openPane(which: PermissionId | "automation") {
  T().panesOpened = [...(T().panesOpened ?? []), which];
}
