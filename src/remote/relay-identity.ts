// The Mac's own keys for the phone, made the first time Phone is on and kept in the Keychain
// (platform/keys.ts: this flavour's service, sh.kiko.keys or sh.kiko.dev.keys). Two: a static X25519
// key, which every phone's encrypted tunnel is to (at home: local.ts; through the relay), given to
// each in welcome and relay_paired, and an Ed25519 signing key, which names the Mac's room on the
// relay (tunnel.ts roomOf) and signs it in there with no account. Neither is logged, shown or put in
// a program's arguments; the Keychain helper takes the item on its stdin. With the Keychain off
// (KIKO_KEYCHAIN=off), they're kept in a file of their own instead (fileKeyStore: next to
// phones.json, readable only by you), since a key made again each run would turn every phone away.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KeyStore } from "../platform/types.ts";
import { ed25519Pair, roomOf, x25519Pair, type Ed25519Pair, type X25519Pair } from "./tunnel.ts";

/** The Keychain item's name (its account), next to the API keys. */
export const DEVICE_KEY_NAME = "KIKO_RELAY_DEVICE_KEY";
/** The item's form: this prefix, then the Ed25519 seed and the X25519 private key, base64, after colons. */
const FORM = "kiko-device-v1";

export type RelayIdentity = { signing: Ed25519Pair; static: X25519Pair; room: string };

/** The identity for these two private keys. */
function identityOf(seed: Buffer, staticKey: Buffer): RelayIdentity {
  const signing = ed25519Pair(seed);
  return { signing, static: x25519Pair(staticKey), room: roomOf(signing.public) };
}

/** A new identity, not kept anywhere (tests; the store keeps one with loadIdentity). */
export function newIdentity(): RelayIdentity {
  const signing = ed25519Pair();
  return { signing, static: x25519Pair(), room: roomOf(signing.public) };
}

const encode = (id: RelayIdentity) => `${FORM}:${id.signing.seed.toString("base64")}:${id.static.private.toString("base64")}`;

function decode(item: string): RelayIdentity | null {
  const [form, seed, key] = item.trim().split(":");
  if (form !== FORM || !seed || !key) return null;
  const a = Buffer.from(seed, "base64");
  const b = Buffer.from(key, "base64");
  return a.length === 32 && b.length === 32 ? identityOf(a, b) : null;
}

/**
 * This Mac's identity from the store, made and saved there the first time. Null with no store.
 * Throws when the store fails (a prompt said no to): Phone stays off this run, since a key made
 * again would turn every phone away.
 */
export async function loadIdentity(store: KeyStore | null): Promise<RelayIdentity | null> {
  if (!store) return null;
  const items = store.get([DEVICE_KEY_NAME]);
  const kept = items[DEVICE_KEY_NAME] ? decode(items[DEVICE_KEY_NAME]) : null;
  if (kept) return kept;
  const made = newIdentity();
  await store.set(DEVICE_KEY_NAME, encode(made));
  return made;
}

/**
 * A KeyStore of one JSON file, readable only by you (0600), for the device key with the Keychain
 * off. Nothing else goes in it.
 */
export function fileKeyStore(file: string): KeyStore {
  const read = (): Record<string, string> => {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  };
  const write = (items: Record<string, string>) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(items)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  return {
    where: "a file",
    get: (names) => Object.fromEntries(Object.entries(read()).filter(([k, v]) => names.includes(k) && typeof v === "string")),
    set: async (name, key) => write({ ...read(), [name]: key }),
    remove: async (name) => {
      const items = read();
      if (!(name in items)) return false;
      delete items[name];
      write(items);
      return true;
    },
    list: async () => Object.keys(read()),
  };
}
