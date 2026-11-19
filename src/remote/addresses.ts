// Every way the phone can reach this Mac, sent in welcome and paired (protocol/: `addresses`). The
// phone keeps them and tries them in turn, so pairing once at home is enough to find the Mac anywhere
// Tailscale reaches: the home network's addresses and the Bonjour name at home, Tailscale's address
// and MagicDNS name from anywhere. With the relay on (KIKO_RELAY_URL), a phone set up for it
// also gets the relay's entry, last: its url and the Mac's room.
import type { HubAddress } from "../platform/types.ts";

export type PhoneAddress = { kind: "home" | "bonjour" | "tailscale"; host: string; port: number } | RelayAddress;
/** The relay: `host` and `port` from its url, for an app that only reads those (it's tried last, and fails harmlessly). */
type RelayAddress = { kind: "relay"; host: string; port: number; url: string; room: string };

/** Home addresses past this many are left out (VMs, Docker and the like add bridges). */
const MAX_HOME = 6;

/**
 * The list for the phone, in the order it's best tried in: the home network's addresses (Wi-Fi and
 * Ethernet first), the Bonjour name, then Tailscale's address and name. `found` is the platform's
 * `network.addresses()`; `bonjour` the Mac's `.local` name.
 */
export function reachableAt(found: HubAddress[], bonjour: string, port: number): PhoneAddress[] {
  const ethernetFirst = (a: HubAddress) => (/^en\d/.test(a.interface) ? 0 : 1);
  const home = found
    .filter((a) => a.kind === "lan")
    .sort((a, b) => ethernetFirst(a) - ethernetFirst(b))
    .slice(0, MAX_HOME)
    .map((a): PhoneAddress => ({ kind: "home", host: a.address, port }));
  const tailscale = found.filter((a) => a.kind === "tailscale").map((a): PhoneAddress => ({ kind: "tailscale", host: a.address, port }));
  const all: PhoneAddress[] = [...home, ...(bonjour ? [{ kind: "bonjour" as const, host: bonjour, port }] : []), ...tailscale];
  const seen = new Set<string>();
  return all.filter((a) => {
    const key = a.host.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The relay's entry: its url and the Mac's room there. */
export function relayAddress(url: string, room: string): RelayAddress {
  const u = new URL(url);
  const port = Number(u.port) || (u.protocol === "ws:" ? 80 : 443);
  return { kind: "relay", host: u.hostname, port, url: url.replace(/\/+$/, ""), room };
}
