// Which model service each of the app's calls goes to, for core/online.ts: the router, the summaries,
// the clean-up and the trim run on config.llm (Haiku on the Anthropic API, or an OpenRouter model);
// the classifier always goes the OpenRouter way. An OpenRouter call goes to openrouter.ai with your
// own key, else through the Kiko account's proxy (core/model-route.ts), a service of its own.
import { config } from "./config.ts";
import { modelCalls, type Route } from "./model-route.ts";
import { type Down, online, type Service } from "./online.ts";

/** Where an OpenRouter-way call (the classifier, an OpenRouter model) goes now: `via`, how it would go. */
export function openrouterService(via: Route["via"] = modelCalls.route().via): Service {
  return via === "account" ? "kiko" : "openrouter";
}

/** Where the router's call (and the other config.llm calls: `llm`) goes now. */
export function llmService(llm = config.llm, via?: Route["via"]): Service {
  return llm === "haiku" ? "anthropic" : openrouterService(via);
}

/** The router can't be asked now: the network, or its own service, known to be down. */
export const routerDown = (): Down | null => online.down(llmService());

/** The classifier can't be asked now: the network, or its service, known to be down. */
export const classifierDown = (): Down | null => online.down(openrouterService());
