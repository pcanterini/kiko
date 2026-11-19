// Every way the phone can reach the Mac (src/remote/addresses.ts), as welcome and paired carry it: the
// home addresses, the Bonjour name, then Tailscale's address and MagicDNS name. A real server on
// 127.0.0.1 with a fake network (no interfaces read, no Tailscale CLI, no Bonjour), and a fake phone.
import "../../setup.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { LocalPhone } from "../../support/local-phone.ts";
import type { HubAddress } from "../../../src/platform/types.ts";
import { reachableAt } from "../../../src/remote/addresses.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";

const HOME: HubAddress = { address: "192.168.1.20", kind: "lan", interface: "en0" };
const TAILSCALE: HubAddress = { address: "100.64.0.10", kind: "tailscale", interface: "utun4" };
const MAGIC_DNS: HubAddress = { address: "test-mac.tail1a2b3c.ts.net", kind: "tailscale", interface: "MagicDNS" };

test("home addresses (Wi-Fi and Ethernet first), the Bonjour name, then Tailscale's address and name", () => {
  const bridge: HubAddress = { address: "192.168.64.1", kind: "lan", interface: "bridge100" };
  assert.deepEqual(reachableAt([bridge, HOME, TAILSCALE, MAGIC_DNS], "Test-Mac.local", 7333), [
    { kind: "home", host: "192.168.1.20", port: 7333 },
    { kind: "home", host: "192.168.64.1", port: 7333 },
    { kind: "bonjour", host: "Test-Mac.local", port: 7333 },
    { kind: "tailscale", host: "100.64.0.10", port: 7333 },
    { kind: "tailscale", host: "test-mac.tail1a2b3c.ts.net", port: 7333 },
  ]);
});

test("Tailscale off: home and Bonjour only; no network: Bonjour only; never the same host twice", () => {
  assert.deepEqual(
    reachableAt([HOME], "mac.local", 7333).map((a) => a.kind),
    ["home", "bonjour"],
  );
  assert.deepEqual(reachableAt([], "mac.local", 7400), [{ kind: "bonjour", host: "mac.local", port: 7400 }]);
  assert.equal(reachableAt([HOME, { ...HOME, interface: "en1" }], "mac.local", 7333).length, 2);
});

test("a Mac with many bridges sends at most six home addresses, and Tailscale's still", () => {
  const many = Array.from({ length: 10 }, (_, i): HubAddress => ({ address: `10.0.${i}.1`, kind: "lan", interface: `bridge${i}` }));
  const list = reachableAt([...many, TAILSCALE], "mac.local", 7333);
  assert.equal(list.filter((a) => a.kind === "home").length, 6);
  assert.equal(list.at(-1)?.host, TAILSCALE.address);
  assert.equal(list.length, 8);
});

const hub: PhoneHub = {
  talkStart: () => null,
  talkAudio: () => {},
  talkEnd: () => {},
  type: () => null,
  permission: () => null,
  answers: () => null,
  talking: () => false,
  playOnMac: () => {},
  catchUp: () => {},
  catchUpSummary: () => {},
  catchUpStop: () => false,
};

/** A phone: every message it gets, checked against the schema. */
function phone(port: number) {
  const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
  const got: any[] = [];
  const waiting: Array<() => void> = [];
  ws.on("message", (data) => {
    const m = JSON.parse(String(data));
    assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
    got.push(m);
    for (const w of waiting.splice(0)) w();
  });
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  return {
    async send(m: Record<string, unknown>) {
      await opened;
      ws.send(JSON.stringify({ v: 1, ...m }));
    },
    async next(type: string): Promise<any> {
      for (;;) {
        const i = got.findIndex((m) => m.type === type);
        if (i >= 0) return got.splice(i, 1)[0];
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    },
    close: () => ws.close(),
  };
}

test("paired and welcome carry every address, looked up again as each phone connects", async () => {
  let found = [HOME, TAILSCALE, MAGIC_DNS];
  let lookups = 0;
  const advertised: string[] = [];
  const pairing = new Pairing(join(process.cwd(), "phones-addresses.json"));
  const server = new PhoneServer({
    hub,
    pairing,
    port: 0,
    host: "127.0.0.1",
    network: {
      addresses: async () => (lookups++, found),
      advertise: (name, type) => (advertised.push(`${name} ${type}`), { stop() {} }),
      hostname: () => "Test-Mac.local",
    },
  });
  const port = await server.start();
  try {
    assert.equal(lookups, 1, "looked up before it listens");
    assert.deepEqual(advertised, ["Kiko Dev on Test-Mac _kiko._tcp"]);
    const everything = [
      { kind: "home", host: "192.168.1.20", port },
      { kind: "bonjour", host: "Test-Mac.local", port },
      { kind: "tailscale", host: "100.64.0.10", port },
      { kind: "tailscale", host: "test-mac.tail1a2b3c.ts.net", port },
    ];

    const first = phone(port);
    await first.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
    const paired = await first.next("paired");
    assert.deepEqual(paired.addresses, everything);
    assert.deepEqual((await first.next("welcome")).addresses, everything);
    assert.equal(lookups, 2, "and again as the phone connected");
    first.close();

    // Tailscale turned off on the Mac: the next phone to connect hears only home and Bonjour.
    found = [HOME];
    const again = phone(port);
    await again.send({ type: "hello", token: paired.token, device: "Test iPhone", appVersion: "0.1.0" });
    assert.deepEqual((await again.next("welcome")).addresses, everything.slice(0, 2));
    again.close();
  } finally {
    server.stop();
  }
});
