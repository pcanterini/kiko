// The Anthropic API client every Haiku call makes (the router, summaries, the clean-up, the trim,
// matching Claude's questions): the key, the workspace, and a note of how many times the SDK
// retried each request, for the logs. The SDK retries on its own (twice by default, with backoff)
// and says nothing about it: two routes once took ~15s instead of ~2s, and the logs couldn't tell a
// slow answer from a retried one.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";
import { online } from "./online.ts";

/** The SDK's own retries behind each response: the attempt it came from, as its request header numbers it. */
const retriesOf = new WeakMap<Response, number>();

/** A client for the configured key and workspace. `maxRetries`: the SDK's own retries (it defaults to 2). */
export function anthropic(options: { maxRetries?: number } = {}) {
  return new Anthropic({
    apiKey: config.anthropicKey,
    // Keys not scoped to a workspace must name one on every request.
    defaultHeaders: config.anthropicWorkspace ? { "anthropic-workspace-id": config.anthropicWorkspace } : {},
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    // globalThis.fetch looked up on every request (the unit tests put their own in place after this
    // is made), and each response noted with the SDK's retry count (x-stainless-retry-count: 0 on the
    // first attempt).
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      // Whether it got through says whether the Mac is online (core/online.ts): any answer, or a network error.
      let response: Response;
      try {
        response = await globalThis.fetch(url, init);
      } catch (err) {
        if (!init?.signal?.aborted) online.callFailed("anthropic", err);
        throw err;
      }
      online.ok("anthropic");
      const retry = Number(new Headers(init?.headers).get("x-stainless-retry-count") ?? 0);
      retriesOf.set(response, Number.isFinite(retry) ? retry : 0);
      return response;
    },
  });
}

/**
 * For a log line: the API's id for the request (`request-id`, what Anthropic's support asks for)
 * and how many times the SDK retried it first (0 for none); only what's known.
 */
export function requestInfo(response: Response | null | undefined): { requestId?: string; retries?: number } {
  if (!response) return {};
  const requestId = response.headers.get("request-id");
  const retries = retriesOf.get(response);
  return { ...(requestId ? { requestId } : {}), ...(retries !== undefined ? { retries } : {}) };
}
