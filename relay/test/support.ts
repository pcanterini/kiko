// The relay, run locally for a test: wrangler's startWorker (the same workerd that runs it on
// Cloudflare) on 127.0.0.1 with a port of its own, nothing kept on disk, nothing remote, and no
// telemetry; disposed of after. Wrangler never reads a .env here (the relay has none, and loading
// one is switched off). Plus a small client for a Mac or a phone, on Node's own WebSocket.
import { createHash } from "node:crypto";
import { join } from "node:path";

process.env.WRANGLER_SEND_METRICS = "false";
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
process.env.WRANGLER_LOG = process.env.WRANGLER_LOG ?? "warn";

const { unstable_startWorker, getPlatformProxy } = await import("wrangler");

/**
 * A local relay: its URL, a way to write its KV while it runs (`kvPut`: as the account service writes the
 * revocation list), and its end.
 */
export type LocalRelay = { url: string; dispose(): Promise<void>; kvPut?(binding: string, key: string, value: string): Promise<void> };

/**
 * Every socket in a test comes from 127.0.0.1: the per-address limits (src/limits.ts pendingPerIp,
 * ipRate), made generous for the tests that aren't about them (test/limits.test.ts is, with
 * CF-Connecting-IP set per socket: locally the header a client sends is kept; on Cloudflare it's
 * always Cloudflare's own).
 */
export const ONE_ADDRESS = { pendingPerIp: 1000, ipRate: { perSecond: 1000, burst: 1000 } };
/**
 * requirePass is on by default (src/limits.ts: a missing or malformed RELAY_LIMITS fails closed);
 * the tests that aren't about the pass turn it off, explicitly, as development would.
 */
export const NO_PASS = { requirePass: false, ...ONE_ADDRESS };

/**
 * The Worker from wrangler.jsonc, local. `vars`: plain-text bindings to set (RELAY_LIMITS, PASS_JWKS_URL).
 * `persist`: a directory (a temporary one of the test's own) its storage and KV are kept in, so a relay
 * started after on the same one finds them (a fresh isolate, the same KV); else nothing is kept.
 */
export async function startRelay(vars: Record<string, string> = {}, o: { persist?: string } = {}): Promise<LocalRelay> {
  const worker = await unstable_startWorker({
    config: new URL("../wrangler.jsonc", import.meta.url).pathname,
    bindings: Object.fromEntries(Object.entries(vars).map(([k, value]) => [k, { type: "plain_text", value }])),
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist: o.persist ?? false, remote: false, watch: false, logLevel: "warn" },
  } as Parameters<typeof unstable_startWorker>[0]);
  const url = (await worker.url).href.replace(/^http/, "ws").replace(/\/$/, "");
  type Kv = { put(key: string, value: string): Promise<void> };
  type Mf = { getKVNamespace(binding: string): Promise<Kv> };
  const mf = () => (worker.raw.runtimes[0] as unknown as { mf?: Mf }).mf;
  return {
    url,
    dispose: () => worker.dispose(),
    async kvPut(binding, key, value) {
      const m = mf();
      if (!m) throw new Error("no local runtime");
      await (await m.getKVNamespace(binding)).put(key, value);
    },
  };
}

/**
 * Writes `entries` into the local KV namespace bound as `binding`, kept in `persist` (the directory a
 * relay is then started on, startRelay's `persist`): as the account service writes the revocation list.
 * Done before that relay starts (two local runtimes never share the directory at once).
 */
export async function writeKv(persist: string, binding: string, entries: Record<string, string>): Promise<void> {
  type Kv = { put(key: string, value: string): Promise<void> };
  const proxy = await getPlatformProxy<Record<string, Kv>>({
    configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
    // The relay's local runtime keeps its state under <persist>/v3 (wrangler's own root); this one takes the root as given.
    persist: { path: join(persist, "v3") },
    remoteBindings: false,
  } as Parameters<typeof getPlatformProxy>[0]);
  try {
    for (const [key, value] of Object.entries(entries)) await proxy.env[binding].put(key, value);
  } finally {
    await proxy.dispose();
  }
}

/**
 * The relay for the end-to-end test and the interop harness: the local one, or, with
 * KIKO_RELAY_TEST_URL set (e.g. wss://relay.kiko.sh), a deployed one. Only those two use it, and
 * everything else stays hermetic: the Mac's keys and the phone's are made fresh for the run, so a
 * deployed relay sees a throwaway room and nothing of yours. (Not KIKO_RELAY_URL: the app's own.)
 */
export async function relayForEndToEnd(): Promise<LocalRelay> {
  const remote = process.env.KIKO_RELAY_TEST_URL;
  if (remote) return { url: remote.replace(/\/+$/, ""), dispose: async () => {} };
  // The Mac and the phone here are the app's own code with no account: requirePass off, explicitly.
  // (A deployed relay with requirePass on refuses this run's Mac, which has no pass: plan_required.)
  return startRelay({ RELAY_LIMITS: JSON.stringify(NO_PASS) });
}

/** One side's socket to the relay: every text message parsed and kept, every binary one kept, both waited for. */
export class Client {
  readonly ws: WebSocket;
  readonly texts: any[] = [];
  readonly frames: Uint8Array[] = [];
  closeCode: number | null = null;
  private waiting: Array<() => void> = [];

  /** `headers`: sent with the upgrade (Node's WebSocket takes them), e.g. a Mac's Kiko-Relay-Pass. */
  constructor(url: string, headers?: Record<string, string>) {
    this.ws = headers ? new WebSocket(url, { headers } as unknown as string[]) : new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") {
        if (e.data !== "pong") this.texts.push(JSON.parse(e.data));
        else this.texts.push({ type: "pong" });
      } else this.frames.push(new Uint8Array(e.data as ArrayBuffer));
      this.wake();
    });
    this.ws.addEventListener("close", (e) => {
      this.closeCode = e.code;
      this.wake();
    });
  }

  opened() {
    return new Promise<void>((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error("couldn't connect")), { once: true });
    });
  }

  send(m: Record<string, unknown> | string | Uint8Array) {
    if (m instanceof Uint8Array) return this.ws.send(new Uint8Array(m));
    this.ws.send(typeof m === "string" ? m : JSON.stringify(m));
  }

  /** The next text message of this type, taken out of what's kept. */
  async next(type: string, ms = 5_000) {
    return this.until(() => {
      const i = this.texts.findIndex((m) => m.type === type);
      return i >= 0 ? this.texts.splice(i, 1)[0] : undefined;
    }, ms);
  }

  async frame(ms = 5_000) {
    return this.until(() => this.frames.shift(), ms);
  }

  /** The close code, once closed. */
  async closed(ms = 5_000) {
    return this.until(() => (this.closeCode === null ? undefined : { code: this.closeCode }), ms, true).then((x) => x.code);
  }

  async until<T>(check: () => T | undefined, ms: number, evenClosed = false): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = check();
      if (v !== undefined) return v;
      if (!evenClosed && this.closeCode !== null) throw new Error(`closed (${this.closeCode})`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiting.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  private wake() {
    for (const w of this.waiting.splice(0)) w();
  }

  close() {
    this.ws.close();
  }
}

export const sha256hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A channel's frame as the Mac sends it to the relay: 4 bytes of channel, big-endian, then the frame. */
export function onChannel(channel: number, frame: Uint8Array) {
  const out = new Uint8Array(4 + frame.length);
  new DataView(out.buffer).setUint32(0, channel);
  out.set(frame, 4);
  return out;
}
