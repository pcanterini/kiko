// T.routeDelayMs: the router takes that long (the "deciding…" caption and status line). T.routeText: what it says.
// T.routeDropped: calls it dropped (a handle not in <sessions>), as router.ts returns them.
export class Router {
  async route(input: any) {
    const T = (globalThis as any).T;
    if (T.routeDelayMs) await new Promise((r) => setTimeout(r, T.routeDelayMs));
    return { text: T.routeText ?? "", usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0, actions: T.route(input), dropped: T.routeDropped ?? [] };
  }
  cancel() {}
}
