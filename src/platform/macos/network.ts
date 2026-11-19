import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname as osHostname, networkInterfaces } from "node:os";
import { promisify } from "node:util";
import type { Advertised, HubAddress } from "../types.ts";

const run = promisify(execFile);

// Tailscale's CLI: on the PATH (Homebrew, the standalone package's "install CLI"), or inside the
// Mac App Store app.
const TAILSCALE = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/** 100.64.0.0/10: the range Tailscale gives out. */
const inTailnet = (ip: string) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
};

/** What `addresses()` reads, swapped in tests: the interfaces, the Tailscale CLI (its stdout), and whether a file exists. */
type NetworkDeps = {
  interfaces?: typeof networkInterfaces;
  run?: (cli: string, args: string[]) => Promise<string>;
  exists?: (path: string) => boolean;
};

const runCli = async (cli: string, args: string[]) => (await run(cli, args, { timeout: 2000, maxBuffer: 8 * 1024 * 1024 })).stdout;

/**
 * The Mac's IPv4 addresses a phone could reach: the local network's (Wi-Fi, Ethernet), and
 * Tailscale's, from its interface and `tailscale status --json`, which also gives its MagicDNS name.
 * Loopback and link-local addresses are left out; so is everything Tailscale's when it isn't running.
 */
export async function addresses(deps: NetworkDeps = {}): Promise<HubAddress[]> {
  const found: HubAddress[] = [];
  for (const [name, list] of Object.entries((deps.interfaces ?? networkInterfaces)())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      found.push({ address: a.address, kind: inTailnet(a.address) ? "tailscale" : "lan", interface: name });
    }
  }
  const tailscale = await tailscaleSelf(deps);
  for (const ip of tailscale?.ips ?? []) {
    if (!found.some((a) => a.address === ip)) found.push({ address: ip, kind: "tailscale", interface: "tailscale" });
  }
  // The local network first, then Tailscale's address, then its name.
  const sorted = found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "lan" ? -1 : 1));
  if (tailscale?.name) sorted.push({ address: tailscale.name, kind: "tailscale", interface: "MagicDNS" });
  return sorted;
}

/**
 * This Mac on its tailnet, from `tailscale status --json`: its IPv4 addresses and its MagicDNS name
 * (without the trailing dot; none when MagicDNS is off). Null when the CLI isn't there, doesn't
 * answer within 2 s, or Tailscale isn't running (stopped, logged out).
 */
async function tailscaleSelf(deps: NetworkDeps): Promise<{ ips: string[]; name: string | null } | null> {
  const exists = deps.exists ?? existsSync;
  for (const cli of TAILSCALE) {
    if (cli.startsWith("/") && !exists(cli)) continue;
    let status: any;
    try {
      status = JSON.parse(await (deps.run ?? runCli)(cli, ["status", "--json"]));
    } catch {
      continue; // not installed here, too slow, or not JSON
    }
    if (status?.BackendState !== "Running" || !status.Self) return null;
    const ips: string[] = (Array.isArray(status.Self.TailscaleIPs) ? status.Self.TailscaleIPs : []).filter((ip: unknown) => typeof ip === "string" && inTailnet(ip));
    const dns = typeof status.Self.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "") : "";
    const magicDns = status.CurrentTailnet?.MagicDNSEnabled !== false;
    return { ips, name: dns && magicDns ? dns : null };
  }
  return null;
}

/** "Test-Mac.local": how the Mac is found by name on the local network. */
export function hostname() {
  const name = osHostname();
  return name.endsWith(".local") ? name : `${name.split(".")[0]}.local`;
}

/**
 * Registers a Bonjour service with macOS's `dns-sd -R`, which keeps it advertised while it runs.
 * Stopped, or if it dies, it's gone; a failure to start only means the phone types the address.
 */
export function advertise(name: string, type: string, port: number, txt: Record<string, string>): Advertised {
  let proc: ChildProcess | null = spawn("dns-sd", ["-R", name, type, "local", String(port), ...Object.entries(txt).map(([k, v]) => `${k}=${v}`)], {
    stdio: "ignore",
  });
  proc.on("error", () => (proc = null));
  proc.on("exit", () => (proc = null));
  return {
    stop: () => {
      proc?.kill();
      proc = null;
    },
  };
}
