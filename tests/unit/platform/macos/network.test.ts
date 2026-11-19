// The Mac's addresses a phone could reach (src/platform/macos/network.ts): its interfaces, and Tailscale's
// address and MagicDNS name from `tailscale status --json`. The interfaces and the CLI are fakes: the real
// `tailscale` never runs.
import "../../../setup.ts";
import assert from "node:assert/strict";
import type { networkInterfaces } from "node:os";
import { test } from "node:test";
import { addresses } from "../../../../src/platform/macos/network.ts";

const iface = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null }) as any;

const interfaces = (list: Record<string, ReturnType<typeof iface>[]>) => (() => list) as unknown as typeof networkInterfaces;

const HOME = interfaces({
  lo0: [iface("127.0.0.1", "IPv4", true)],
  en0: [iface("192.168.1.20"), iface("fe80::1", "IPv6")],
  en5: [iface("169.254.10.2")],
});

const status = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: "test-mac.tail1a2b3c.ts.net.", TailscaleIPs: ["100.64.0.10", "fd7a:115c:a1e0::1"] },
    CurrentTailnet: { MagicDNSEnabled: true },
    ...over,
  });

/** A fake CLI: what each path answers (a string, or an Error it fails with), and what was run. */
function cli(answers: Record<string, string | Error>) {
  const ran: string[] = [];
  return {
    ran,
    run: async (path: string, args: string[]) => {
      ran.push(`${path} ${args.join(" ")}`);
      const answer = answers[path] ?? new Error("ENOENT");
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test("home first, then Tailscale's address and its MagicDNS name (no trailing dot)", async () => {
  const { run, ran } = cli({ tailscale: status() });
  assert.deepEqual(await addresses({ interfaces: HOME, run, exists: () => false }), [
    { address: "192.168.1.20", kind: "lan", interface: "en0" },
    { address: "100.64.0.10", kind: "tailscale", interface: "tailscale" },
    { address: "test-mac.tail1a2b3c.ts.net", kind: "tailscale", interface: "MagicDNS" },
  ]);
  assert.deepEqual(ran, ["tailscale status --json"]);
});

test("Tailscale's interface and its status give the address once", async () => {
  const withTun = interfaces({ en0: [iface("192.168.1.20")], utun4: [iface("100.64.0.10")] });
  const { run } = cli({ tailscale: status() });
  const found = await addresses({ interfaces: withTun, run, exists: () => false });
  assert.deepEqual(
    found.map((a) => [a.address, a.interface]),
    [
      ["192.168.1.20", "en0"],
      ["100.64.0.10", "utun4"],
      ["test-mac.tail1a2b3c.ts.net", "MagicDNS"],
    ],
  );
});

test("the App Store app's CLI when there's none on the PATH", async () => {
  const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  const { run, ran } = cli({ [app]: status() });
  const found = await addresses({ interfaces: HOME, run, exists: (p) => p === app });
  assert.equal(found.filter((a) => a.kind === "tailscale").length, 2);
  assert.deepEqual(ran, ["tailscale status --json", `${app} status --json`]);
});

test("Tailscale stopped, logged out, missing or too slow: home only", async () => {
  for (const answer of [status({ BackendState: "Stopped" }), status({ BackendState: "NeedsLogin", Self: null }), new Error("timed out"), "not json"]) {
    const { run } = cli({ tailscale: answer });
    assert.deepEqual(await addresses({ interfaces: HOME, run, exists: () => false }), [{ address: "192.168.1.20", kind: "lan", interface: "en0" }], String(answer));
  }
});

test("MagicDNS off: the address without a name", async () => {
  const { run } = cli({ tailscale: status({ CurrentTailnet: { MagicDNSEnabled: false } }) });
  const found = await addresses({ interfaces: HOME, run, exists: () => false });
  assert.deepEqual(
    found.map((a) => a.address),
    ["192.168.1.20", "100.64.0.10"],
  );
});
