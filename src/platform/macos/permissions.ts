// The macOS permissions the helpers need (native/macos/permissions.swift): checked, asked for, and
// their System Settings panes. The permissions helper runs where the others do (helper-app.ts):
// in the helper app, so what it checks and asks for is the app's; without the app, the terminal's.
import { execFile } from "node:child_process";
import type { Permission, PermissionId, Permissions } from "../types.ts";
import { runHelper } from "./helper-app.ts";

const ALL: Permissions = { mic: "unknown", speech: "unknown", input: "unknown" };
const isPermission = (v: unknown): v is Permission => v === "granted" || v === "denied" || v === "restricted" || v === "unknown";

/** The helper's JSON line as Permissions; anything it didn't say is "unknown". */
export function parsePermissions(text: string): Permissions {
  try {
    const j = JSON.parse(text.trim().split("\n").at(-1) ?? "");
    return { mic: isPermission(j?.mic) ? j.mic : "unknown", speech: isPermission(j?.speech) ? j.speech : "unknown", input: isPermission(j?.input) ? j.input : "unknown" };
  } catch {
    return { ...ALL };
  }
}

async function run(args: string[], timeout: number): Promise<Permissions> {
  // A request waits for your answer to macOS's prompt: no timeout then (0).
  const { code, stdout } = await runHelper("permissions", args, timeout);
  return code !== 0 && !stdout ? { ...ALL } : parsePermissions(stdout);
}

/** Where each permission stands, asking nothing. */
export const permissionStatus = () => run(["status"], 10_000);

/** macOS asked for `which` (its own prompt), then where it stands. */
export const requestPermission = async (which: PermissionId) => (await run(["request", which], 0))[which];

/** Each one's pane in System Settings (Privacy & Security). */
export const PANES: Record<PermissionId | "automation", { url: string; name: string }> = {
  mic: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone", name: "Microphone" },
  speech: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition", name: "Speech Recognition" },
  input: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent", name: "Input Monitoring" },
  automation: { url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation", name: "Automation" },
};

/** Opens its pane in System Settings. */
export function openPane(which: PermissionId | "automation") {
  execFile("open", [PANES[which].url], () => {});
}
