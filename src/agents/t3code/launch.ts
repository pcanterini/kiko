// A new T3 Code thread, as T3's own client starts one (read from T3's source at v0.1.5): what
// `orchestration.launchThread` is sent (client-runtime operations/commands.ts startThreadTurn, with
// `bootstrap.createThread`: a new thread from the composer's first message; mobile's
// projectThreadStartTurn.ts the same). Pure: client.ts sends it.
//
//   projectId          the T3 project whose workspaceRoot is the folder asked for (core/projects.ts
//                      projectAmong found it)
//   title              the name given, else the first message (client-runtime threadTitle.ts
//                      deriveThreadTitleSeed: its words on one line, cut to 50 characters), with
//                      `generateTitle` so T3 titles it from the message as it does its own; with
//                      neither, "New thread" (T3's own word for an untitled one)
//   modelSelection     as a new draft's (web hooks/useHandleNewThread.ts): the project's default
//                      (settings' projectSettingsOverrides, else the project's own, until folded),
//                      else the settings' defaultModelSelection, else the first provider ready (each
//                      driver's default instance first: providerInstances.ts), with its default model;
//                      else the settings' fallbackModelSelection. One named ("on Codex"): that
//                      driver's first instance that's ready, with its default model
//   runtimeMode        the project's defaultRuntimeMode, else the settings', else "full-access"
//                      (contracts providerPolicy.ts DEFAULT_RUNTIME_MODE)
//   interactionMode    "default" (DEFAULT_PROVIDER_INTERACTION_MODE: not plan mode)
//   workspaceStrategy  { type: "root" }: in the project's folder, as a new local draft is; T3 may
//                      still put it in a managed folder of its own (ThreadLaunchService folderForThread)
//   initialMessage     the first message, when there is one: { messageId, text, attachments: [] };
//                      without it T3 makes the thread empty (initialMessage is optional there), which
//                      its own UI never does (its "new thread" is a local draft until you send)
//
// Not here: the composer's sticky provider (the last one you picked in T3, kept in its window), the
// usage-limit fallback, worktree mode (defaultThreadEnvMode "worktree": a new branch and worktree).
import { randomUUID } from "node:crypto";

/** T3's model selection: an instance of a provider (its driver's, "codex", "claudeAgent"), and a model. */
type ModelSelection = { instanceId: string; model: string; options?: unknown };

/** The Kiko agents a thread can run on in T3, by T3's driver kind for each. */
export const DRIVERS: Record<string, string> = { "claude-code": "claudeAgent", codex: "codex", opencode: "opencode" };

/** contracts providerPolicy.ts DEFAULT_RUNTIME_MODE. */
const DEFAULT_RUNTIME_MODE = "full-access";
const RUNTIME_MODES = new Set(["approval-required", "auto-accept-edits", "auto", "full-access"]);

/** T3's "New thread": the title of one with no name and no message. */
const UNTITLED = "New thread";

/** client-runtime threadTitle.ts deriveThreadTitleSeed for plain words: on one line, cut to 50 characters (shared String.ts truncate). */
export function titleOf(text: string): string {
  const one = text.trim().replace(/\s+/gu, " ");
  if (!one) return UNTITLED;
  return one.length <= 50 ? one : `${one.slice(0, 50)}...`;
}

/** A model selection as T3 stores one, or null: an older one names its provider where `instanceId` is now (contracts modelSelection.ts decodes it so). */
function selection(v: any): ModelSelection | null {
  const instanceId = typeof v?.instanceId === "string" ? v.instanceId : typeof v?.provider === "string" ? v.provider : "";
  if (!instanceId.trim() || typeof v?.model !== "string" || !v.model.trim()) return null;
  return { instanceId, model: v.model, ...(v.options !== undefined ? { options: v.options } : {}) };
}

/** What the project's settings say, over the settings': its override for `key`, else the project's own (until folded into the overrides). */
function projectSetting(settings: any, project: any, key: string): unknown {
  const overrides = settings?.projectSettingsOverrides?.[project?.id];
  if (overrides && Object.hasOwn(overrides, key) && overrides[key] !== undefined) return overrides[key];
  if (!settings?.projectSettingsFolded && project?.[key] != null) return project[key];
  return settings?.[key];
}

/** A provider instance a new thread can start on (providerInstances.ts isProviderInstancePickerReady, else selectable and not in error), as the project has it enabled. */
function usable(provider: any, settings: any, projectId: string, strict: boolean) {
  const override = settings?.projectSettingsOverrides?.[projectId]?.providerInstances?.[provider?.instanceId]?.enabled;
  const enabled = typeof override === "boolean" ? override : provider?.enabled === true;
  if (!enabled || provider?.availability === "unavailable") return false;
  return strict ? provider?.status === "ready" : provider?.status !== "error";
}

/** providerInstances.ts getDefaultProviderInstanceModel: its default model that isn't custom, else its first that isn't, else its first. */
function defaultModel(provider: any): string | null {
  const models: any[] = Array.isArray(provider?.models) ? provider.models : [];
  const slug = (models.find((m) => m?.isDefault && !m?.isCustom) ?? models.find((m) => !m?.isCustom) ?? models[0])?.slug;
  return typeof slug === "string" && slug.trim() ? slug : null;
}

/** providerInstances.ts sortProviderInstanceEntries: grouped by driver in their order, each driver's default instance (its id is the driver's) first. */
function ordered(providers: any[]): any[] {
  const byDriver = new Map<string, any[]>();
  for (const p of providers) byDriver.set(p?.driver, [...(byDriver.get(p?.driver) ?? []), p]);
  return [...byDriver.values()].flatMap((group) => [...group.filter((p) => p?.instanceId === p?.driver), ...group.filter((p) => p?.instanceId !== p?.driver)]);
}

/**
 * The model a new thread in `project` starts on, from T3's config (server.getConfig: `settings`,
 * `providers`): `driver` (one named) or T3's default. Null: none T3 could start it on.
 */
export function modelFor(config: any, project: any, driver: string | null): ModelSelection | null {
  const settings = config?.settings ?? {};
  const providers = ordered(Array.isArray(config?.providers) ? config.providers : []);
  const pick = (among: any[]) => {
    const p = among.find((x) => usable(x, settings, project?.id, true)) ?? among.find((x) => usable(x, settings, project?.id, false));
    const model = p ? defaultModel(p) : null;
    return p && model ? { instanceId: String(p.instanceId), model } : null;
  };
  if (driver) return pick(providers.filter((p) => p?.driver === driver));
  const configured = selection(projectSetting(settings, project, "defaultModelSelection"));
  if (configured) return configured;
  // providerInstances.ts resolveProjectDefaultProviderModelSelection: the first driver's group first.
  const first = providers.find((p) => usable(p, settings, project?.id, false))?.driver;
  return pick(providers.filter((p) => p?.driver === first)) ?? pick(providers) ?? selection(settings.fallbackModelSelection);
}

/** The runtime mode a new thread in `project` starts in: its setting, else T3's default. */
export function runtimeModeFor(config: any, project: any): string {
  const mode = projectSetting(config?.settings ?? {}, project, "defaultRuntimeMode");
  return typeof mode === "string" && RUNTIME_MODES.has(mode) ? mode : DEFAULT_RUNTIME_MODE;
}

/** orchestration.launchThread's input (contracts OrchestrationV2ThreadLaunchInput), for a new thread in `projectId`. */
export function launchInput(o: { threadId: string; projectId: string; name: string; prompt: string; model: ModelSelection; runtimeMode: string }) {
  const prompt = o.prompt.trim();
  const name = o.name.trim();
  return {
    commandId: randomUUID(),
    creationSource: "web",
    threadId: o.threadId,
    projectId: o.projectId,
    title: name || titleOf(prompt),
    // T3 titles a thread from its first message, as its client asks (a titleSeed given): not one you named.
    generateTitle: !name && Boolean(prompt),
    modelSelection: o.model,
    runtimeMode: o.runtimeMode,
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    ...(prompt ? { initialMessage: { messageId: randomUUID(), text: prompt, attachments: [] } } : {}),
  };
}
