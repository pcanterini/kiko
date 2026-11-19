// OpenRouter (OpenAI-compatible chat completions) as an alternative to Haiku for the
// spoken summary and the router. Plain fetch, no SDK.
//
// Latency defaults, applied to every request:
// - provider.sort = "latency": try the endpoint with the lowest recent time to first token
//   first, instead of OpenRouter's default price-weighted load balancing. Fallbacks stay on.
// - reasoning off ("none") where the model allows it; models that always reason get their
//   lowest effort. Thinking before a one-sentence summary only adds delay.
// Usage and cost come back on every response (the last SSE chunk when streaming); OpenRouter
// no longer needs `usage: { include: true }`.
// Prompt caching: Claude models need a cache_control breakpoint (`cache`); DeepSeek and Gemini
// cache on their own. The cost OpenRouter reports already prices cache reads and writes.
// Where each call goes (your own key, else the Kiko account's trial proxy) is model-route.ts's
// choice; `call` names the call's type for the proxy.

import { type CallType, modelCalls } from "./model-route.ts";

/** Like the Anthropic API's: input_tokens doesn't count tokens read from or written to the cache. */
type OpenRouterUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/** Claude Haiku through OpenRouter: the model of the one-key setup, and Haiku's stand-in with no Anthropic key (keys.ts pickEngines). */
export const OPENROUTER_HAIKU = "anthropic/claude-haiku-5.5";

/**
 * The curated list for the settings picker, best first. Benchmarked October 2026 on the real
 * summarizer and router prompts: all four got the router cases right (DeepSeek missed once in
 * 18 tries); TTFT is for the spoken summary with the latency sort.
 */
export const OPENROUTER_MODELS: Array<{ id: string; label: string; hint: string }> = [
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", hint: "fastest, cheapest" },
  { id: "inception/mercury-3", label: "Mercury 3", hint: "fast, sends the whole reply at once" },
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", hint: "reliable tools, costs more" },
  { id: OPENROUTER_HAIKU, label: "Claude Haiku 5.5", hint: "Haiku through OpenRouter; the default without an Anthropic key" },
];

// Models whose reasoning can't be turned off (OpenRouter's `reasoning.mandatory`), with the
// lowest effort they take. Everything else gets effort "none".
const MANDATORY_REASONING: Record<string, string> = {
  "google/gemini-3.5-flash-lite": "minimal",
  "google/gemini-3.8-flash": "low",
  "google/gemini-3.5-flash": "low",
  "z-ai/glm-5.3-flash": "low",
};

type Common = {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal;
  /** Overrides the default provider routing ({ sort: "latency" }). */
  provider?: Record<string, unknown>;
  /** Cache the system prompt (and the tools before it) on Claude models; other models ignore it. */
  cache?: boolean;
  /** What the call is for (model-route.ts CallType): the trial proxy allows each type its own shape. */
  call: CallType;
  /** Finer, for the proxy's usage records ("more_about"). */
  what?: string;
};

/** Streams plain text to onText as it arrives. Rejects with an AbortError if the signal fires. */
export async function streamText(opts: Common & { onText: (delta: string) => void }): Promise<{ text: string; usage: OpenRouterUsage; costUsd: number; id?: string; stop?: string }> {
  const res = await post(body(opts, { stream: true }), opts);
  let text = "";
  let usage: RawUsage | undefined;
  let id: string | undefined;
  let stop: string | undefined;
  for await (const chunk of sse(res, opts.signal)) {
    if (chunk.error) throw new Error(`OpenRouter stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
    if (chunk.usage) usage = chunk.usage;
    id ??= chunk.id;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) stop = choice.finish_reason;
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta) {
      text += delta;
      opts.onText(delta);
    }
    if (choice?.finish_reason === "error") throw new Error("OpenRouter stream ended with an error");
  }
  return { text, ...toUsage(usage), ...(id ? { id } : {}), ...(stop ? { stop } : {}) };
}

/** One call that must answer with tool calls (several allowed). Anthropic-format tools in. */
export async function callTools(opts: Common & { tools: Array<{ name: string; description: string; input_schema: object; strict?: boolean }> }): Promise<{
  calls: Array<{ name: string; input: Record<string, unknown> }>;
  text: string;
  usage: OpenRouterUsage;
  costUsd: number;
  /** OpenRouter's id for the request ("gen-…"), and why the model stopped, for the log. */
  id?: string;
  stop?: string;
}> {
  const tools = opts.tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
      ...(t.strict ? { strict: true } : {}),
    },
  }));
  const res = await post(body(opts, { stream: false, tools, tool_choice: "required", parallel_tool_calls: true }), opts);
  // Non-streaming responses may be preceded by whitespace keep-alives; JSON.parse skips them.
  const json = JSON.parse(await res.text()) as Completion;
  if (json.error) throw new Error(`OpenRouter error: ${json.error.message ?? JSON.stringify(json.error)}`);
  const message = json.choices?.[0]?.message;
  const calls = (message?.tool_calls ?? []).filter((c) => c?.function?.name).map((c) => ({ name: c.function.name, input: parseArgs(c.function.arguments) }));
  const stop = json.choices?.[0]?.finish_reason ?? undefined;
  return {
    calls,
    text: typeof message?.content === "string" ? message.content : "",
    ...toUsage(json.usage),
    ...(json.id ? { id: json.id } : {}),
    ...(stop ? { stop } : {}),
  };
}

// ---------------------------------------------------------------------------------------------

type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
};
type ErrorBody = { message?: string; code?: number | string };
type Chunk = {
  id?: string;
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: RawUsage;
  error?: ErrorBody;
};
type Completion = {
  id?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ function: { name: string; arguments?: string | object } }>;
    };
  }>;
  usage?: RawUsage;
  error?: ErrorBody;
};

function body(opts: Common, extra: Record<string, unknown>) {
  const mandatory = MANDATORY_REASONING[baseId(opts.model)];
  return {
    model: opts.model,
    messages: [
      {
        role: "system",
        content: opts.cache && /^~?anthropic\//.test(opts.model) ? [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }] : opts.system,
      },
      { role: "user", content: opts.prompt },
    ],
    max_tokens: opts.maxTokens,
    reasoning: mandatory ? { effort: mandatory, exclude: true } : { effort: "none" },
    provider: opts.provider ?? { sort: "latency" },
    ...extra,
  };
}

// "openai/gpt-5.4-nano:nitro" → "openai/gpt-5.4-nano"
function baseId(model: string) {
  return model.replace(/:[a-z]+$/, "");
}

async function post(payload: Record<string, unknown>, o: { call: CallType; what?: string; signal?: AbortSignal }) {
  const send = (p: Record<string, unknown>) => modelCalls.post("chat", p, { call: o.call, what: o.what, signal: o.signal });
  let res = await send(payload);
  // A model that rejects the reasoning setting (always reasons, or doesn't take efforts):
  // retry once with the model's defaults rather than fail the turn.
  if (res.status === 400 && payload.reasoning) {
    const detail = await res.text();
    if (/reason/i.test(detail)) {
      const { reasoning: _drop, ...rest } = payload;
      res = await send(rest);
    } else {
      throw new Error(`OpenRouter 400: ${errorMessage(detail)}`);
    }
  }
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${errorMessage(await res.text())}`);
  return res;
}

function errorMessage(detail: string) {
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string; metadata?: { raw?: string } } };
    return [parsed.error?.message, parsed.error?.metadata?.raw].filter(Boolean).join(": ") || detail.slice(0, 500);
  } catch {
    return detail.slice(0, 500);
  }
}

/** Parses an SSE body into JSON chunks. Skips ": OPENROUTER PROCESSING" comments; stops at [DONE]. */
async function* sse(res: Response, signal?: AbortSignal): AsyncGenerator<Chunk> {
  if (!res.body) throw new Error("OpenRouter returned no body");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  // fetch's own signal handling covers the read loop, but cancel the reader explicitly too so
  // the socket closes right away.
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (done) break;
      buffer += value;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        if (!data) continue;
        try {
          yield JSON.parse(data) as Chunk;
        } catch {
          // A malformed line shouldn't sink the stream.
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

// prompt_tokens counts cached tokens too; they're split out as the Anthropic API does.
export function toUsage(raw: RawUsage | undefined): { usage: OpenRouterUsage; costUsd: number } {
  const read = raw?.prompt_tokens_details?.cached_tokens ?? 0;
  const written = raw?.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    usage: {
      input_tokens: Math.max(0, (raw?.prompt_tokens ?? 0) - read - written),
      output_tokens: raw?.completion_tokens ?? 0,
      ...(read && { cache_read_input_tokens: read }),
      ...(written && { cache_creation_input_tokens: written }),
    },
    costUsd: raw?.cost ?? 0,
  };
}

/** Tool arguments as an object, from clean JSON, fenced or padded JSON, or an object already. */
function parseArgs(raw: string | object | undefined): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  const text = (raw ?? "").trim();
  if (!text) return {};
  const attempts = [text, text.replace(/^```(?:json)?\s*|\s*```$/g, ""), text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt);
      // Some models double-encode: "{\"session\":\"s1\"}"
      const value = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // try the next shape
    }
  }
  return {};
}
