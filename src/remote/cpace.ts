// CPace, the password-authenticated key exchange the phone and the Mac run on the home network when
// they share only a short secret: the 6-digit pairing code, or (for a phone paired before the
// connection was encrypted) its token. CFRG's balanced PAKE, draft-irtf-cfrg-cpace (revision 21),
// suite CPACE-X25519-SHA512, initiator-responder, exactly: the phone is A (the initiator), the Mac B.
// tests/unit/remote/cpace.test.ts reproduces the draft's own test vectors (Appendix B.1).
//
// Why not just the code as a key: six digits are a million guesses, which a computer tries in a
// second against anything that lets it check one (a MAC, a record). CPace gives nothing to check
// offline: the code picks the generator g, each side sends y*g for a random y, and only someone who
// used the same code gets the same key from the other's share. A LAN eavesdropper learns nothing
// (not the key, not the code); someone in the middle gets one guess per pairing attempt, and a wrong
// one fails the Mac's first record and counts as a wrong code (Pairing: five close pairing).
//
// Only X25519, SHA-512 and arithmetic mod 2^255 - 19 (for Elligator 2, which maps the hashed code to
// a point): CryptoKit has the first two on the phone, and the map is a few lines there too.
import { createHash, randomBytes } from "node:crypto";
import { dh, hkdf2, Cipher, type Session } from "./tunnel.ts";

/** The suite's domain separator (G_X25519.DSI). */
const DSI = Buffer.from("CPace255");
/** SHA-512's input block: the generator string's padding fills it. */
const S_IN_BYTES = 128;

/** CI (the channel identifier) for each way in: pairing with the code or the QR code's secret, or a paired phone with its token. */
export const CPACE_CI = { code: Buffer.from("kiko pair v1"), token: Buffer.from("kiko token v1"), qr: Buffer.from("kiko qr v1") } as const;

/** The salt the two transport keys are drawn from ISK with (HKDF-SHA256, as Noise's split). */
export const LOCAL_KEYS_SALT = Buffer.from("kiko local v1");

// ── Strings (draft, Appendix A) ──────────────────────────────────────────────

/** The length as LEB128, then the bytes. */
function prependLen(data: Buffer): Buffer {
  const len: number[] = [];
  let n = data.length;
  do {
    len.push(n < 128 ? n : (n & 0x7f) + 0x80);
    n >>= 7;
  } while (n > 0);
  return Buffer.concat([Buffer.from(len), data]);
}

const lvCat = (...parts: Buffer[]) => Buffer.concat(parts.map(prependLen));

function generatorString(prs: Buffer, ci: Buffer, sid: Buffer): Buffer {
  const zpad = Math.max(0, S_IN_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length);
  return lvCat(DSI, prs, Buffer.alloc(zpad), ci, sid);
}

// ── Elligator 2 on Curve25519 (draft, Appendix A.5; RFC 9380) ────────────────

const P = 2n ** 255n - 19n;
const A = 486662n;
const mod = (x: bigint) => ((x % P) + P) % P;
function pow(base: bigint, exp: bigint) {
  let r = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const inv = (x: bigint) => pow(x, P - 2n);

/** RFC 7748's decodeUCoordinate for 255 bits: little-endian, the top bit dropped. */
function decodeU(bytes: Buffer): bigint {
  let n = 0n;
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  return n;
}

function encodeU(u: bigint): Buffer {
  const out = Buffer.alloc(32);
  let n = mod(u);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** The draft's elligator2(r): a u-coordinate on Curve25519 (Z = 2). */
function elligator2(r: bigint): bigint {
  const v = mod(-A * inv(1n + 2n * r * r));
  const legendre = pow(v * v * v + A * v * v + v, (P - 1n) / 2n);
  const eps = legendre === P - 1n ? -1n : legendre;
  return mod(eps * v - (1n - eps) * A * inv(2n));
}

/** G_X25519.calculate_generator with SHA-512: the generator's u-coordinate, 32 bytes. */
export function generator(prs: Buffer, ci: Buffer, sid: Buffer = Buffer.alloc(0)): Buffer {
  const hash = createHash("sha512")
    .update(generatorString(prs, ci, sid))
    .digest()
    .subarray(0, 32);
  return encodeU(elligator2(decodeU(hash)));
}

/** X25519(y, g), refusing the neutral element (scalar_mult_vfy): tunnel.ts dh throws on an all-zero result. */
export const scalarMult = (scalar: Buffer, point: Buffer) => dh(scalar, point);

/** ISK = SHA-512(lv_cat("CPace255_ISK", sid, K) || lv_cat(Ya, ADa) || lv_cat(Yb, ADb)). */
function iskOf(o: { k: Buffer; ya: Buffer; ada: Buffer; yb: Buffer; adb: Buffer; sid?: Buffer }): Buffer {
  const head = lvCat(Buffer.concat([DSI, Buffer.from("_ISK")]), o.sid ?? Buffer.alloc(0), o.k);
  return createHash("sha512")
    .update(Buffer.concat([head, lvCat(o.ya, o.ada), lvCat(o.yb, o.adb)]))
    .digest();
}

type CpaceInputs = { prs: Buffer; ci: Buffer; ada?: Buffer; adb?: Buffer; sid?: Buffer };

/** The phone's side (A): its share now, the ISK once the Mac's comes. `scalar` only for vectors and tests. */
export function cpaceInitiate(o: CpaceInputs & { scalar?: Buffer }) {
  const g = generator(o.prs, o.ci, o.sid);
  const y = o.scalar ?? randomBytes(32);
  const share = scalarMult(y, g);
  return {
    share,
    finish(theirs: Buffer): Buffer {
      return iskOf({ k: scalarMult(y, theirs), ya: share, ada: o.ada ?? Buffer.alloc(0), yb: theirs, adb: o.adb ?? Buffer.alloc(0), sid: o.sid });
    },
  };
}

/** The Mac's side (B): its share and the ISK, from the phone's share. Throws (TunnelError bad_key) on a low-order share. */
export function cpaceRespond(o: CpaceInputs & { theirs: Buffer; scalar?: Buffer }): { share: Buffer; isk: Buffer } {
  if (o.theirs.length !== 32) throw new Error("a CPace share is 32 bytes");
  const g = generator(o.prs, o.ci, o.sid);
  const y = o.scalar ?? randomBytes(32);
  const share = scalarMult(y, g);
  const isk = iskOf({ k: scalarMult(y, o.theirs), ya: o.theirs, ada: o.ada ?? Buffer.alloc(0), yb: share, adb: o.adb ?? Buffer.alloc(0), sid: o.sid });
  return { share, isk };
}

/**
 * The records' keys from ISK, as Noise's split draws them: (k1, k2) = HKDF-SHA256(salt
 * LOCAL_KEYS_SALT, ISK), k1 for the phone's records and k2 for the Mac's, each counter from 0.
 */
export function sessionOf(isk: Buffer, side: "phone" | "mac"): Session {
  const [k1, k2] = hkdf2(LOCAL_KEYS_SALT, isk);
  const phone = new Cipher(k1);
  const mac = new Cipher(k2);
  const hash = createHash("sha256").update(isk).digest();
  return side === "phone" ? { send: phone, receive: mac, hash } : { send: mac, receive: phone, hash };
}

// ── The token's way in ───────────────────────────────────────────────────────

/** A phone's token as CPace's password: SHA-256 of its UTF-8 (the hash phones.json keeps), raw. */
export const tokenSecret = (token: string) => createHash("sha256").update(token).digest();

/**
 * Which phone a token handshake is from, without giving its secret away: the first 16 bytes of
 * SHA-256("kiko phone id v1" || 0x00 || the token's secret). Sent in the clear (and bound in as ADa).
 */
export const tokenIdOf = (secret: Buffer) =>
  createHash("sha256")
    .update(Buffer.concat([Buffer.from("kiko phone id v1\0"), secret]))
    .digest()
    .subarray(0, 16);

// ── The QR code's way in ─────────────────────────────────────────────────────

/**
 * Which pairing QR code a handshake is for, without giving its secret away: the first 16 bytes of
 * SHA-256("kiko qr id v1" || 0x00 || the secret). Sent in the clear (and bound in as ADa), so the Mac
 * can say that code was used already, or has expired, rather than only that something didn't match.
 */
export const qrIdOf = (secret: Buffer) =>
  createHash("sha256")
    .update(Buffer.concat([Buffer.from("kiko qr id v1\0"), secret]))
    .digest()
    .subarray(0, 16);

/**
 * What lets a phone away from home into the Mac's room on the relay to pair by the QR code
 * (protocol/README.md, "Pairing through the relay"): SHA-256("kiko qr relay v1" || 0x00 || the
 * secret), 32 bytes, joined with as any relay credential. The Mac registers only its hash, while the
 * code works; neither gives the secret away, and the relay that sees it can't pair with it.
 */
export const qrRelayCredentialOf = (secret: Buffer) =>
  createHash("sha256")
    .update(Buffer.concat([Buffer.from("kiko qr relay v1\0"), secret]))
    .digest();

/**
 * A pairing's CPace both ways in this process, and a record each way under its keys: null when this
 * runtime's crypto does it all, else what failed (as tunnel.ts selfCheck, for app/phone.ts).
 */
export function cpaceSelfCheck(): string | null {
  try {
    const a = cpaceInitiate({ prs: Buffer.from("000000"), ci: CPACE_CI.code });
    const b = cpaceRespond({ prs: Buffer.from("000000"), ci: CPACE_CI.code, theirs: a.share });
    const phone = sessionOf(a.finish(b.share), "phone");
    const mac = sessionOf(b.isk, "mac");
    const sealed = phone.send.seal(Buffer.from("ping"));
    return mac.receive.open(sealed).toString() === "ping" ? null : "a record came out different";
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).slice(0, 160);
  }
}
