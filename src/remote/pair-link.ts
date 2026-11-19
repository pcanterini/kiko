// What the pairing QR code says (protocol/README.md, "Pairing with a QR code"): one compact URL, in
// the iPhone app's own scheme, so the app's scanner reads it and the iPhone's Camera offers to open
// the app with it. Everything the phone needs to pair at once, with nothing typed: where the Mac is,
// the one-time secret the handshake runs on (CPace, as the typed code's, with 128 bits instead of
// 20), and the Mac's static key, which welcome must match. Versioned (`v`), so a later form can be
// told apart; an app that doesn't know a version says to update it.
//
// <scheme>://pair?v=1&n=<name>&h=<host>,<host>…&p=<port>&s=<secret>&k=<mac key>[&r=<relay url>&m=<room>]
//
// The scheme is the iPhone app's bundle identifier (IDENTIFIER.ios: sh.kiko.ios), which the app
// registers as its URL scheme from its own identifier: renaming the app moves both. The secret is in
// the URL, so the URL is never logged, and it goes nowhere but the screen.
import { IDENTIFIER } from "../core/name.ts";
import type { PhoneAddress } from "./addresses.ts";

/** The iPhone app's URL scheme: its bundle identifier. */
export const PAIR_SCHEME = `${IDENTIFIER}.ios`;
/** The link's own version (its `v`): a new form gets a new one. */
const PAIR_LINK_VERSION = 1;
/** Bytes of the one-time secret: 128 bits. */
export const QR_SECRET_BYTES = 16;

export type PairLink = {
  /** The Mac, as the phone will list it (the hub's name). */
  name: string;
  /** Where to dial, in order: the home network's addresses, then Tailscale's. */
  hosts: string[];
  port: number;
  /** The one-time secret (QR_SECRET_BYTES). */
  secret: Buffer;
  /** The Mac's static X25519 public key (32 bytes): welcome's macKey must be this one. */
  macKey: Buffer;
  /** The relay, when it's on: its url and the Mac's room there. */
  relay?: { url: string; room: string };
};

/** Home addresses past this many are left out of the code (each makes it bigger); welcome brings them all. */
const MAX_HOME = 3;
/** Tailscale's address and its MagicDNS name. */
const MAX_TAILSCALE = 2;
const MAX_NAME = 64;

const b64url = (b: Buffer) => b.toString("base64url");
/** Everything but what a URL's query value keeps as it is, percent-encoded (spaces as %20, never +). */
const enc = (s: string) => encodeURIComponent(s);

/** The hosts the code carries, from the Mac's addresses (addresses.ts): home first, then Tailscale. No Bonjour or relay entry. */
export function hostsFor(addresses: PhoneAddress[]): string[] {
  const home = addresses.filter((a) => a.kind === "home").slice(0, MAX_HOME);
  const tailscale = addresses.filter((a) => a.kind === "tailscale").slice(0, MAX_TAILSCALE);
  return [...home, ...tailscale].map((a) => a.host);
}

/** The URL for the QR code. */
export function pairUrl(link: PairLink): string {
  const q = [
    `v=${PAIR_LINK_VERSION}`,
    `n=${enc(link.name.slice(0, MAX_NAME))}`,
    `h=${link.hosts.map(enc).join(",")}`,
    `p=${link.port}`,
    `s=${b64url(link.secret)}`,
    `k=${b64url(link.macKey)}`,
    ...(link.relay ? [`r=${enc(link.relay.url)}`, `m=${link.relay.room}`] : []),
  ];
  return `${PAIR_SCHEME}://pair?${q.join("&")}`;
}

/**
 * A pairing URL read back (what the phone does; here for the tests and the vectors): null for
 * anything that isn't one, in the form above, with every field as it must be.
 */
export function parsePairUrl(url: string): PairLink | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${PAIR_SCHEME}:` || u.hostname !== "pair") return null;
  const q = u.searchParams;
  if (q.get("v") !== String(PAIR_LINK_VERSION)) return null;
  const secret = fromB64url(q.get("s"), QR_SECRET_BYTES);
  const macKey = fromB64url(q.get("k"), 32);
  const port = Number(q.get("p"));
  const hosts = (q.get("h") ?? "").split(",").filter(Boolean);
  if (!secret || !macKey || !Number.isInteger(port) || port < 1 || port > 65535 || !hosts.length) return null;
  const r = q.get("r");
  const m = q.get("m");
  if ((r === null) !== (m === null)) return null;
  if (r !== null && (!/^wss?:\/\//.test(r) || !/^[0-9a-f]{32}$/.test(m!))) return null;
  return { name: (q.get("n") ?? "").slice(0, MAX_NAME), hosts, port, secret, macKey, ...(r !== null ? { relay: { url: r, room: m! } } : {}) };
}

function fromB64url(s: string | null, bytes: number): Buffer | null {
  if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.length === bytes && b64url(b) === s ? b : null;
}
