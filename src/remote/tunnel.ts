// The phone's end-to-end encrypted tunnel to the Mac through the relay (protocol/README.md, "Relay").
// The relay passes bytes along and never holds a key: the phone and the Mac swapped their static
// X25519 public keys at pairing, on the home network, and each relay connection opens with a fresh
// handshake between them. The handshake is Noise IK exactly (Noise_IK_25519_ChaChaPoly_SHA256, the
// Noise Protocol Framework, revision 34): the phone knows the Mac's static key ahead of time and sends
// its own encrypted, so the Mac learns which phone it is from the first message, and the keys come
// from all four Diffie-Hellmans (es, ss, ee, se): neither side's static key alone, nor a recording of
// the traffic, opens a session. Only primitives iOS CryptoKit has: X25519, SHA-256 (with HMAC as
// HKDF), and ChaCha20-Poly1305.
//
// ChaCha20-Poly1305 is @noble/ciphers' (pure JS, audited), not node:crypto's: the released app runs
// on Bun, whose node:crypto has no "chacha20-poly1305" cipher (ERR_CRYPTO_UNKNOWN_CIPHER), so 0.2.0
// refused every phone's handshake while every test, run on Node, passed. The rest is node:crypto's,
// and the same on both (tests/unit/remote/tunnel.test.ts runs the vectors under Bun too).
//
// After it, every frame either side sends is one record: ChaCha20-Poly1305 under that direction's
// key, with the next counter as its nonce and nothing else (no nonce on the wire). A record that
// doesn't open under the counter expected (altered, replayed, reordered or dropped) ends the tunnel.
// Inside, a type byte keeps the protocol's text and binary frames apart, plus the tunnel's own ping,
// pong and close.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, sign, timingSafeEqual, verify } from "node:crypto";

/** Noise's name for the handshake: exactly 32 bytes, so it is the first handshake hash as it is. */
const NOISE_NAME = "Noise_IK_25519_ChaChaPoly_SHA256";
/** The byte before the phone's first handshake message: the tunnel's version. */
export const TUNNEL_VERSION = 1;
/** What a record's plaintext may hold at most (the hub's WebSocket takes 1 MiB a message). */
const MAX_RECORD = 1024 * 1024;
/** What the Mac signs to open its room, before the room id and the relay's nonce. */
export const AUTH_CONTEXT = "kiko relay mac v1";

/** A record's type: its plaintext's first byte. */
export const RECORD = { text: 1, binary: 2, ping: 3, pong: 4, close: 5 } as const;
export type RecordType = (typeof RECORD)[keyof typeof RECORD];
export type Record_ = { type: RecordType; body: Buffer };

// DER wrappings for raw 32-byte keys, so node:crypto takes them as KeyObjects.
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

// ── Keys ─────────────────────────────────────────────────────────────────────

export type X25519Pair = { private: Buffer; public: Buffer };

/** An X25519 key pair: a new one, or the one for a private key given (tests and vectors). */
export function x25519Pair(privateKey?: Buffer): X25519Pair {
  const key = privateKey ? x25519Private(privateKey) : generateKeyPairSync("x25519").privateKey;
  const priv = key.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  return { private: Buffer.from(priv), public: Buffer.from(pub) };
}

const x25519Private = (raw: Buffer) => createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: "der", type: "pkcs8" });
const x25519Public = (raw: Buffer) => createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: "der", type: "spki" });

/** X25519. An all-zero result (the other side's key is a low-order point) is refused, as CryptoKit does. */
export function dh(privateKey: Buffer, publicKey: Buffer): Buffer {
  if (publicKey.length !== 32) throw new TunnelError("bad_key", "an X25519 public key is 32 bytes");
  let out: Buffer;
  try {
    out = diffieHellman({ privateKey: x25519Private(privateKey), publicKey: x25519Public(publicKey) });
  } catch {
    out = Buffer.alloc(32); // OpenSSL refuses an all-zero result itself
  }
  if (out.every((b) => b === 0)) throw new TunnelError("bad_key", "a low-order X25519 public key");
  return out;
}

export type Ed25519Pair = { seed: Buffer; public: Buffer };

/** An Ed25519 key pair from its 32-byte seed (CryptoKit's Curve25519.Signing.PrivateKey rawRepresentation). */
export function ed25519Pair(seed?: Buffer): Ed25519Pair {
  const key = seed ? createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: "der", type: "pkcs8" }) : generateKeyPairSync("ed25519").privateKey;
  return {
    seed: Buffer.from(key.export({ format: "der", type: "pkcs8" }).subarray(-32)),
    public: Buffer.from(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32)),
  };
}

export function ed25519Sign(seed: Buffer, message: Buffer): Buffer {
  return sign(null, message, createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: "der", type: "pkcs8" }));
}

/** Checks a signature as the relay does (for the tests and their fake relay: the Mac only signs). */
export function ed25519Verify(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  return verify(null, message, createPublicKey({ key: Buffer.concat([ED25519_SPKI, publicKey]), format: "der", type: "spki" }), signature);
}

/** A Mac's room on the relay: the first 16 bytes of SHA-256 of its Ed25519 public key, lowercase hex. */
export const roomOf = (signingKey: Buffer) => createHash("sha256").update(signingKey).digest().subarray(0, 16).toString("hex");

/** What the Mac signs to sign in to its room: the context, a zero byte, the room id, a zero byte, the relay's nonce. */
export const authMessage = (room: string, nonce: Buffer) => Buffer.concat([Buffer.from(`${AUTH_CONTEXT}\0${room}\0`), nonce]);

/** A credential's hash, as the Mac registers it with its room: SHA-256 of its 32 raw bytes, lowercase hex. */
export const credentialHash = (credential: Buffer) => createHash("sha256").update(credential).digest("hex");

/** The handshake's prologue: binds it to the tunnel's version and the Mac's room. */
export const prologueOf = (room: string) => Buffer.from(`kiko relay v${TUNNEL_VERSION}\0${room}`);

/**
 * On the home network (a direct connection), the first frame's first byte says how the phone opens
 * the tunnel there (protocol/README.md, "Encrypted at home"): `keys` is Noise IK exactly as through
 * the relay (the tunnel's version byte, then message 1), with LOCAL_PROLOGUE; `code`, `token` and
 * `qr` are CPace (cpace.ts) with the pairing code, the phone's token, or the pairing QR code's secret.
 */
export const LOCAL_OPEN = { keys: TUNNEL_VERSION, code: 2, token: 3, qr: 4 } as const;

/** The handshake's prologue on the home network: its own, so a handshake made for one way in never passes on the other. */
export const LOCAL_PROLOGUE = Buffer.from(`kiko local v${TUNNEL_VERSION}`);

/** Two equal-length buffers compared in constant time. */
const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

// ── Noise ────────────────────────────────────────────────────────────────────

/**
 * Where the Mac's side of a handshake stopped (for the log: never anything of the keys):
 * - short: the first message isn't 96 bytes or more.
 * - ephemeral: the phone's ephemeral key is a low-order point.
 * - not_for_this_mac: its encrypted static key didn't open: the handshake is to another key than
 *   this Mac's static one (set up with another Mac, or keys made again since), or with another
 *   prologue (another tunnel version, or another room).
 * - payload: the static key opened, the payload after it didn't (altered on the way).
 * - static_key: the phone's static key is a low-order point.
 */
export type HandshakeStep = "short" | "ephemeral" | "not_for_this_mac" | "static_key" | "payload";

export class TunnelError extends Error {
  readonly code: "bad_key" | "bad_handshake" | "bad_record" | "too_big" | "spent";
  /** For bad_handshake on the Mac's side: the step that failed. */
  readonly step?: HandshakeStep;
  constructor(code: TunnelError["code"], message: string, step?: HandshakeStep) {
    super(message);
    this.code = code;
    if (step) this.step = step;
  }
}

const sha256 = (...parts: Buffer[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const hmac = (key: Buffer, ...parts: Buffer[]) => {
  const h = createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Noise's HKDF with two outputs: RFC 5869's with the chaining key as salt and no info (CryptoKit's HKDF<SHA256>, 64 bytes, split). */
export function hkdf2(chainingKey: Buffer, input: Buffer): [Buffer, Buffer] {
  const temp = hmac(chainingKey, input);
  const one = hmac(temp, Buffer.from([1]));
  const two = hmac(temp, one, Buffer.from([2]));
  return [one, two];
}

/** ChaCha20-Poly1305's nonce for counter n: four zero bytes, then n as 8 bytes little-endian (Noise's). */
export function nonceOf(n: bigint) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(n, 4);
  return nonce;
}

/** ChaCha20-Poly1305 (RFC 8439): the ciphertext, then its 16-byte tag. */
export function seal(key: Buffer, n: bigint, ad: Buffer, plaintext: Buffer) {
  return Buffer.from(chacha20poly1305(key, nonceOf(n), ad).encrypt(plaintext));
}

/** The plaintext, or a TunnelError (bad_record) when it doesn't open. */
export function open(key: Buffer, n: bigint, ad: Buffer, ciphertext: Buffer) {
  if (ciphertext.length < 16) throw new TunnelError("bad_record", "shorter than its tag");
  let out: Uint8Array;
  try {
    out = chacha20poly1305(key, nonceOf(n), ad).decrypt(ciphertext);
  } catch {
    throw new TunnelError("bad_record", "didn't open: altered, replayed, out of order, or the wrong key");
  }
  return Buffer.from(out);
}

const MAX_NONCE = 2n ** 64n - 1n; // Noise reserves the last one

/** One direction's key and counter (Noise's CipherState). */
export class Cipher {
  readonly key: Buffer;
  n = 0n;
  constructor(key: Buffer) {
    this.key = key;
  }
  seal(plaintext: Buffer, ad: Buffer = Buffer.alloc(0)) {
    if (this.n >= MAX_NONCE) throw new TunnelError("spent", "this direction's nonces are used up");
    return seal(this.key, this.n++, ad, plaintext);
  }
  open(ciphertext: Buffer, ad: Buffer = Buffer.alloc(0)) {
    if (this.n >= MAX_NONCE) throw new TunnelError("spent", "this direction's nonces are used up");
    const out = open(this.key, this.n, ad, ciphertext);
    this.n++; // only once it opened: a bad record doesn't move the counter (the tunnel ends anyway)
    return out;
  }
}

/** Noise's SymmetricState: the chaining key, the handshake hash, and the key while there is one. */
class Symmetric {
  ck: Buffer;
  h: Buffer;
  private k: Cipher | null = null;
  constructor(prologue: Buffer) {
    this.h = Buffer.from(NOISE_NAME); // exactly 32 bytes: no hash
    this.ck = this.h;
    this.mixHash(prologue);
  }
  mixHash(data: Buffer) {
    this.h = sha256(this.h, data);
  }
  mixKey(input: Buffer) {
    const [ck, k] = hkdf2(this.ck, input);
    this.ck = ck;
    this.k = new Cipher(k);
  }
  encryptAndHash(plaintext: Buffer) {
    const out = this.k ? this.k.seal(plaintext, this.h) : plaintext;
    this.mixHash(out);
    return out;
  }
  decryptAndHash(ciphertext: Buffer) {
    const out = this.k ? this.k.open(ciphertext, this.h) : ciphertext;
    this.mixHash(ciphertext);
    return out;
  }
  /** The two transport keys: the first for the phone's frames (initiator to responder), the second for the Mac's. */
  split(): [Cipher, Cipher] {
    const [a, b] = hkdf2(this.ck, Buffer.alloc(0));
    return [new Cipher(a), new Cipher(b)];
  }
}

/** A finished handshake: a key each way, and the handshake hash (the same on both sides). */
export type Session = { send: Cipher; receive: Cipher; hash: Buffer };

/**
 * The phone's side (Noise's initiator): its first message, then what to do with the Mac's answer.
 * `ephemeral` only for vectors and tests; a new one otherwise.
 */
export function initiate(o: { prologue: Buffer; local: X25519Pair; remote: Buffer; ephemeral?: X25519Pair; payload?: Buffer }) {
  const s = new Symmetric(o.prologue);
  s.mixHash(o.remote); // <- s (known ahead)
  const e = o.ephemeral ?? x25519Pair();
  s.mixHash(e.public); // -> e
  s.mixKey(dh(e.private, o.remote)); // es
  const encStatic = s.encryptAndHash(o.local.public); // s
  s.mixKey(dh(o.local.private, o.remote)); // ss
  const encPayload = s.encryptAndHash(o.payload ?? Buffer.alloc(0));
  const message = Buffer.concat([e.public, encStatic, encPayload]);
  return {
    message,
    /** The Mac's answer: the session, and its payload. Throws when it doesn't check out. */
    finish(answer: Buffer): Session & { payload: Buffer } {
      if (answer.length < 48) throw new TunnelError("bad_handshake", "the answer is too short");
      const re = answer.subarray(0, 32);
      s.mixHash(re); // <- e
      s.mixKey(dh(e.private, re)); // ee
      s.mixKey(dh(o.local.private, re)); // se
      let payload: Buffer;
      try {
        payload = s.decryptAndHash(answer.subarray(32));
      } catch {
        throw new TunnelError("bad_handshake", "the answer didn't open: not the Mac paired with");
      }
      const [send, receive] = s.split();
      return { send, receive, hash: s.h, payload };
    },
  };
}

/**
 * The Mac's side (Noise's responder): reads the phone's first message, which names the phone by its
 * static key (`remote`: the caller checks it's a paired phone's), and answers with `answer()`. A
 * message that doesn't check out throws a TunnelError saying at which step (`step`); anything else
 * thrown (the runtime's crypto failing) is thrown as it is, so it isn't taken for the phone's fault.
 */
export function respond(o: { prologue: Buffer; local: X25519Pair; message: Buffer; ephemeral?: X25519Pair }) {
  const refused = (step: HandshakeStep, message: string) => new TunnelError("bad_handshake", message, step);
  /** One step: a TunnelError from it is the phone's message failing there; anything else goes up as it is. */
  const at = <T>(step: HandshakeStep, message: string, f: () => T): T => {
    try {
      return f();
    } catch (err) {
      throw err instanceof TunnelError ? refused(step, message) : err;
    }
  };
  if (o.message.length < 32 + 48 + 16) throw refused("short", "the first message is too short");
  const s = new Symmetric(o.prologue);
  s.mixHash(o.local.public); // <- s
  const re = o.message.subarray(0, 32);
  s.mixHash(re); // -> e
  at("ephemeral", "the phone's ephemeral key is a low-order point", () => s.mixKey(dh(o.local.private, re))); // es
  const rs = at("not_for_this_mac", "the first message didn't open: not to this Mac's key, or another prologue", () => s.decryptAndHash(o.message.subarray(32, 80))); // s
  at("static_key", "the phone's static key is a low-order point", () => s.mixKey(dh(o.local.private, rs))); // ss
  const payload = at("payload", "the first message's payload didn't open: altered", () => s.decryptAndHash(o.message.subarray(80)));
  return {
    remote: rs,
    payload,
    /** The answer to send, and the session. */
    answer(answerPayload: Buffer = Buffer.alloc(0)): { message: Buffer; session: Session } {
      const e = o.ephemeral ?? x25519Pair();
      s.mixHash(e.public); // <- e
      s.mixKey(dh(e.private, re)); // ee
      s.mixKey(dh(e.private, rs)); // se
      const enc = s.encryptAndHash(answerPayload);
      const [receive, send] = s.split();
      return { message: Buffer.concat([e.public, enc]), session: { send, receive, hash: s.h } };
    },
  };
}

/**
 * One handshake and a record each way between two throwaway key pairs, in this process: null when
 * this runtime's crypto does it all, else what failed. The relay is turned on only once this passes
 * (app/phone.ts), so a runtime that can't run the tunnel says so at once instead of refusing phones.
 */
export function selfCheck(): string | null {
  try {
    const mac = x25519Pair();
    const phone = x25519Pair();
    const prologue = prologueOf("0".repeat(32));
    const hs = initiate({ prologue, local: phone, remote: mac.public });
    const read = respond({ prologue, local: mac, message: hs.message });
    if (!sameBytes(read.remote, phone.public)) return "the handshake named the wrong key";
    const { message, session } = read.answer();
    const theirs = hs.finish(message);
    const back = openRecord(session.receive, sealRecord(theirs.send, RECORD.text, Buffer.from("ping")));
    const forth = openRecord(theirs.receive, sealRecord(session.send, RECORD.binary, Buffer.from([1, 2, 3])));
    if (back.body.toString() !== "ping" || !sameBytes(forth.body, Buffer.from([1, 2, 3]))) return "a record came out different";
    return null;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    return `${typeof code === "string" ? `${code}: ` : ""}${err instanceof Error ? err.message : String(err)}`.slice(0, 160);
  }
}

// ── Records ──────────────────────────────────────────────────────────────────

/** One frame of the protocol (or the tunnel's own), sealed: type byte, body, under the next nonce. */
export function sealRecord(cipher: Cipher, type: RecordType, body: Buffer = Buffer.alloc(0)): Buffer {
  if (body.length + 1 > MAX_RECORD) throw new TunnelError("too_big", `a record holds ${MAX_RECORD} bytes at most`);
  return cipher.seal(Buffer.concat([Buffer.from([type]), body]));
}

/** A frame from the other side, opened. Throws (TunnelError) when it doesn't open or isn't a record. */
export function openRecord(cipher: Cipher, frame: Buffer): Record_ {
  if (frame.length > MAX_RECORD + 17) throw new TunnelError("too_big", "a record bigger than allowed");
  const plain = cipher.open(frame);
  const type = plain[0];
  if (!plain.length || !Object.values(RECORD).includes(type as RecordType)) throw new TunnelError("bad_record", `an unknown record type ${type}`);
  return { type: type as RecordType, body: plain.subarray(1) };
}

/** A close record's body: the WebSocket close code (2 bytes, big-endian), then the reason (UTF-8, 123 bytes at most). */
export function closeBody(code: number, reason: string) {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(code);
  return Buffer.concat([out, Buffer.from(reason).subarray(0, 123)]);
}

export function closeOf(body: Buffer): { code: number; reason: string } {
  return body.length >= 2 ? { code: body.readUInt16BE(0), reason: body.subarray(2).toString() } : { code: 1005, reason: "" };
}
