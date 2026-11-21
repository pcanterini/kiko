// What Kiko's AI runs on right now, and how that's said: your own keys (which one does what), the
// account's plan, or nothing. Decided once (aiUse) from what the app picks its engines by
// (core/keys.ts pickEngines, config.ts `llm` and `classifier`, core/model-route.ts's order: your own
// OpenRouter key, then the plan, then none), so Settings → Account, Settings → Keys, `kiko account`,
// `kiko keys` and the phone (its `account` message) never disagree.
//
// Two parts use a model: routing your words and the spoken summaries (config.llm: Haiku on the
// Anthropic API with your Anthropic key, or a model on OpenRouter), and the classifier's quick checks
// (Jev on OpenRouter's decisions endpoint). OpenRouter's calls go through your own OpenRouter key
// when there is one, else through the plan (the trial, Pro). Speech-to-text and the voice use a paid
// key only for Deepgram and Cartesia: said only where there's room (keysDetail, keyUse).
//
// No key here, only which ones are set.
import type { KeyId } from "../keys.ts";
import { COMMAND, NAME } from "../name.ts";

/** What runs a part of Kiko's AI now: your own key (by provider), the account's plan, or nothing. */
export type Payer = "anthropic" | "openrouter" | "plan" | null;

/** What Kiko's AI runs on now. */
export type AiUse = {
  /** Routing your words and the spoken summaries: Haiku on Anthropic, an OpenRouter model on your key or the plan; null: no model. */
  router: Payer;
  /** The classifier's quick checks (on OpenRouter): your OpenRouter key, the plan, or null (off). */
  checks: "openrouter" | "plan" | null;
  /** Why the quick checks are off: turned off in Settings, or nothing to run them on (no OpenRouter key, no plan). */
  checksOff: "setting" | "no_openrouter" | null;
  /** Speech-to-text: Deepgram on your key, or Apple's (free). */
  stt: "deepgram" | "apple";
  /** The voice: Cartesia on your key, or a free one. */
  tts: "cartesia" | "free";
  /** The keys of your own that are set (used or not). */
  keys: ReadonlySet<KeyId>;
};

/** What aiUse decides from. */
export type AiUseIn = {
  /** The model that routes and summarizes, as picked (pickEngines' `llm`, config.llm): "haiku" (the Anthropic API), an OpenRouter model, or null for none. */
  llm: string | null;
  /** The quick checks are on in Settings (settings.json `classifier` not false). */
  classifier: boolean;
  /** The keys of your own that are set. */
  keys: Iterable<KeyId>;
  /** The account's plan runs Kiko's AI now (accounts open, signed in, a trial or Pro running: app-account.ts accountRunsModels). */
  planRuns: boolean;
  /** The speech-to-text and voice engines picked (pickEngines' `stt` and `tts`). */
  stt?: string;
  tts?: string;
};

/** What runs each part, by model-route.ts's order: your own key first, then the plan, then none. */
export function aiUse(i: AiUseIn): AiUse {
  const keys = new Set(i.keys);
  const openrouter = keys.has("openrouter") ? "openrouter" : i.planRuns ? "plan" : null;
  const router: Payer = i.llm === null ? null : i.llm === "haiku" ? (keys.has("anthropic") ? "anthropic" : null) : openrouter;
  const checks = i.classifier ? openrouter : null;
  return {
    router,
    checks,
    checksOff: checks ? null : i.classifier ? "no_openrouter" : "setting",
    stt: i.stt === "deepgram" && keys.has("deepgram") ? "deepgram" : "apple",
    tts: i.tts === "cartesia" && keys.has("cartesia") ? "cartesia" : "free",
    keys,
  };
}

/** The model keys of your own that run some of Kiko's AI now: Anthropic first, then OpenRouter. */
export function keysInUseFor(u: AiUse): ("anthropic" | "openrouter")[] {
  return (["anthropic", "openrouter"] as const).filter((k) => u.router === k || u.checks === k);
}

/** The plan runs some of Kiko's AI now. */
export const planUsed = (u: AiUse) => u.router === "plan" || u.checks === "plan";

/** Your own keys run all of Kiko's AI there is now: a plan in effect isn't used. */
export const ownKeysOnly = (u: AiUse) => keysInUseFor(u).length > 0 && !planUsed(u);

const PROVIDER = { anthropic: "Anthropic", openrouter: "OpenRouter" } as const;

/** Why the quick checks are off, in brackets: "(quick checks off in Settings)"; "" while they run. */
function checksOffWords(u: AiUse): string {
  if (u.checksOff === "setting") return " (quick checks off in Settings)";
  if (u.checksOff === "no_openrouter") return " (quick checks off: they need OpenRouter)";
  return "";
}

/**
 * The short line about your own keys (Settings → Account's Keys row, `kiko account`'s Keys line, the
 * phone's `keysText`): "Your own OpenRouter key"; "Your own keys: Anthropic for routing and
 * summaries, OpenRouter for quick checks"; "Your own Anthropic key (quick checks off: they need
 * OpenRouter)"; with the plan running the quick checks, "Your own Anthropic key for routing and
 * summaries; Kiko Pro for quick checks" (`plan`: its name in a sentence). Null when no key of yours
 * is in use: the plan runs it all, or nothing does (noAiKeys).
 */
export function keysLine(u: AiUse, plan = "the plan"): string | null {
  const own = keysInUseFor(u);
  if (!own.length) return null;
  if (own.length === 2) return "Your own keys: Anthropic for routing and summaries, OpenRouter for quick checks";
  if (u.router === "anthropic" && u.checks === "plan") return `Your own Anthropic key for routing and summaries; ${plan} for quick checks`;
  return `Your own ${PROVIDER[own[0]!]} key${checksOffWords(u)}`;
}

/** No key of yours and no plan running: Kiko's AI is off. */
export const NO_AI_KEYS = `None, so ${NAME}'s AI is off`;

/**
 * Said under a plan in effect (the free trial, Kiko Pro) while your own keys run some or all of
 * Kiko's AI (model-route.ts: your own key always comes first): which one pays now. All of it on your
 * keys: "Your own OpenRouter key is in use, so Pro isn't being used." and how to use Pro instead
 * (Pro only: the trial's words stop at the first line). Your Anthropic key routing and Pro running
 * the quick checks: "Pro runs the quick checks; your own Anthropic key runs routing and summaries."
 * and how to use Pro for both. Empty with no key of yours in use. `phone`: the command is the
 * Mac's ("on your Mac").
 */
export function keysOverPlanLines(u: AiUse, plan: "pro" | "trial", o: { phone?: boolean } = {}): string[] {
  const own = keysInUseFor(u);
  if (!own.length) return [];
  const who = plan === "pro" ? "Pro" : "the free trial";
  const where = o.phone ? ", on your Mac" : "";
  const remove = (ids: readonly string[]) => ids.map((id) => `${COMMAND} keys remove ${id}`).join(" and ");
  if (planUsed(u)) {
    const said = `${plan === "pro" ? "Pro" : "The free trial"} runs the quick checks; your own Anthropic key runs routing and summaries.`;
    return plan === "pro" ? [said, `To use Pro for both${where}: ${remove(["anthropic"])}`] : [said];
  }
  const which = own.length === 2 ? "keys are" : `${PROVIDER[own[0]!]} key is`;
  const said = `Your own ${which} in use, so ${who} isn't being used.`;
  return plan === "pro" ? [said, `To use Pro${where}: ${remove(own)}`] : [said];
}

/**
 * What one key of yours does now, for its row in Settings → Keys and its line in `kiko keys`: "Used
 * for routing and summaries", "Used for quick checks", "Used for routing, summaries and quick
 * checks", "Used for speech-to-text", "Used for the voice"; or why it isn't: "Not used now: …".
 * Null for a key that isn't set.
 */
export function keyUse(u: AiUse, id: KeyId): string | null {
  if (!u.keys.has(id)) return null;
  switch (id) {
    case "anthropic":
      return u.router === "anthropic" ? "Used for routing and summaries (Haiku)" : "Not used now: the model in Settings → Replies is on OpenRouter";
    case "openrouter": {
      const parts = [u.router === "openrouter" ? "routing, summaries" : null, u.checks === "openrouter" ? "quick checks" : null].filter(Boolean);
      if (parts.length === 2) return "Used for routing, summaries and quick checks";
      if (u.router === "openrouter") return `Used for routing and summaries${u.checksOff === "setting" ? " (quick checks off in Settings)" : ""}`;
      if (parts.length) return "Used for quick checks";
      return "Not used now: quick checks are off in Settings, and Haiku on Anthropic routes";
    }
    case "deepgram":
      return u.stt === "deepgram" ? "Used for speech-to-text" : "Not used now: speech-to-text is Apple's";
    case "cartesia":
      return u.tts === "cartesia" ? "Used for the voice" : "Not used now: the voice isn't Cartesia";
  }
}

/**
 * The longer account of what runs on what (`kiko keys`, under the keys): each part and what pays for
 * it, Deepgram and Cartesia included when they're used. `plan`: the plan's name in a sentence.
 * "Routing and summaries: your Anthropic key", "Quick checks: your OpenRouter key",
 * "Speech-to-text: your Deepgram key".
 */
export function keysDetail(u: AiUse, plan = "the plan"): string[] {
  const payer = (p: Payer) => (p === "anthropic" || p === "openrouter" ? `your ${PROVIDER[p]} key` : p === "plan" ? plan : "off (no key)");
  const lines = [`Routing and summaries: ${payer(u.router)}`];
  lines.push(`Quick checks: ${u.checks ? payer(u.checks) : u.checksOff === "setting" ? "off in Settings" : "off (they need OpenRouter: your key or a plan)"}`);
  lines.push(`Speech-to-text: ${u.stt === "deepgram" ? "your Deepgram key" : "Apple's, free"}`);
  lines.push(`Voice: ${u.tts === "cartesia" ? "your Cartesia key" : "free"}`);
  return lines;
}
