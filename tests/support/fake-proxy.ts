// A stand-in for the trial proxy (the account service's API.md, "The AI proxy"), on a port of its own
// on 127.0.0.1, inside the test: /ai/chat/completions and /ai/decisions answer from a script the test
// sets (one answer per call in turn, the last one kept), and every call is recorded (its path, bearer,
// X-Kiko-Call, X-Kiko-What, body). Nothing reaches the real proxy, OpenRouter or the network.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One answer: a status, a JSON body or raw text (an SSE stream), headers; or `drop`: the connection cut. */
export type ProxyAnswer = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | "drop";

export type ProxyCall = { path: string; bearer: string | null; call: string | null; what: string | null; agent: string; body: Record<string, unknown> };

/** OpenRouter's non-streamed answer, through the proxy (as the router reads it). */
export const toolsAnswer = (o: { cost?: number; used?: number; plan?: string } = {}): ProxyAnswer => ({
  json: {
    id: "gen-1",
    model: "deepseek/deepseek-v4.1-flash",
    choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ function: { name: "send", arguments: '{"to":"a"}' } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 10, cost: o.cost ?? 0.0002 },
  },
  headers: { "x-kiko-plan": o.plan ?? "trial", "x-kiko-quota-used": (o.used ?? 0.1).toFixed(3) },
});

/** A streamed answer: `parts` as content deltas, then the usage chunk. */
export const streamAnswer = (parts: string[], o: { used?: number; plan?: string } = {}): ProxyAnswer => ({
  text: [
    ...parts.map((p) => `data: ${JSON.stringify({ id: "gen-2", choices: [{ delta: { content: p } }] })}\n\n`),
    `data: ${JSON.stringify({ id: "gen-2", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.0001 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""),
  headers: { "content-type": "text/event-stream", "x-kiko-plan": o.plan ?? "trial", "x-kiko-quota-used": (o.used ?? 0.1).toFixed(3) },
});

/** The classifier's answer. */
export const decisionsAnswer = (): ProxyAnswer => ({
  json: { model: "typesafe/jev-1.14", answers: { who: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9 } } }, usage: { cost: 0.0001 } },
});

/** One of the proxy's errors (API.md's table). */
export const proxyError = (status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): ProxyAnswer => ({
  status,
  json: { error, error_description: "test", ...extra },
  headers,
});

export async function fakeProxy(start: { chat?: ProxyAnswer[]; decisions?: ProxyAnswer[] } = {}) {
  const answers: Record<"chat" | "decisions", ProxyAnswer[]> = { chat: start.chat ?? [streamAnswer(["Hi."])], decisions: start.decisions ?? [decisionsAnswer()] };
  const calls: ProxyCall[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      const route = path === "/ai/chat/completions" ? "chat" : path === "/ai/decisions" ? "decisions" : null;
      if (!route || req.method !== "POST") return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not_found" }));
      const auth = req.headers.authorization ?? "";
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text);
      } catch {}
      const h = (n: string) => (typeof req.headers[n] === "string" ? (req.headers[n] as string) : null);
      calls.push({ path, bearer: auth.startsWith("Bearer ") ? auth.slice(7) : null, call: h("x-kiko-call"), what: h("x-kiko-what"), agent: h("user-agent") ?? "", body });
      const list = answers[route];
      const a = (list.length > 1 ? list.shift() : list[0]) ?? { status: 500, json: { error: "server_error" } };
      if (a === "drop") return void req.socket.destroy();
      if (a.text !== undefined) return void res.writeHead(a.status ?? 200, { "content-type": "text/event-stream", ...a.headers }).end(a.text);
      res.writeHead(a.status ?? 200, { "content-type": "application/json", ...a.headers }).end(JSON.stringify(a.json ?? null));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The proxy's base, as KIKO_AI_URL would give it.
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ai`;
  return {
    url,
    calls,
    answer(route: "chat" | "decisions", ...list: ProxyAnswer[]) {
      answers[route] = list;
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
