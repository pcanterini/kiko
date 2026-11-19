// Pairing phones with the hub. While pairing is open, the settings screen shows a 6-digit code;
// the phone sends it once and gets a long random token, which it keeps in its Keychain and sends
// on every later connection. The hub keeps only a hash of each token (phones.json, next to the
// settings), so the file alone doesn't let anyone in. Wrong codes are counted: a few in a row close
// pairing, so the million codes can't be tried one by one. Codes and tokens are never logged.
//
// Each phone also leaves its static X25519 public key here (`relayKey`, named for the relay, which
// came first): the encrypted tunnel's handshake names the phone by it, at home (local.ts) and through
// the relay. It comes in pair (a new phone), in hello on a token handshake (a phone paired before the
// connection was encrypted), or in relay_pair. Once the Mac has a phone's key, that key is what lets
// the phone in (with its token): a token alone no longer does. A phone set up for the relay also
// leaves its relay credential's hash, which the Mac registers with its room on the relay
// (relay-client.ts). Forgetting the phone drops all of it.
//
// The pairing code itself never crosses the network: the phone and the Mac run CPace with it
// (cpace.ts), and a wrong one shows as a first record that doesn't open (wrongCode).
//
// Or the phone scans a QR code (Settings → Phone → Pair a phone; pair-link.ts): the same, with a
// one-time secret of 128 bits in place of the 6 digits, named by an id drawn from it (cpace.ts
// qrIdOf). It works for QR_MS from when it's shown, for one phone, and stops when its screen closes;
// one that was used, has expired or was closed is refused as such (qr_used, qr_expired). Nothing is
// counted against it (128 bits aren't guessed), and the secret is never logged or written anywhere.
// While it works, a phone away from home may pair by it through the relay: the relay client registers
// a one-time credential drawn from the secret with the Mac's room (qrRelay), and drops it as the code
// stops working (onQrChange).
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { qrIdOf, qrRelayCredentialOf, tokenIdOf } from "./cpace.ts";
import { QR_SECRET_BYTES } from "./pair-link.ts";
import { readJsonFile, writeJsonAtomic } from "../core/json-file.ts";

export type Phone = {
  id: string;
  name: string;
  tokenHash: string;
  pairedAt: number;
  lastSeenAt: number | null;
  playOnPhone: boolean;
  /** The phone's static X25519 public key, base64: its tunnel's, at home and through the relay. */
  relayKey?: string;
  /** For the relay: SHA-256 of its relay credential's raw bytes, hex (tunnel.ts credentialHash). */
  relayCredentialHash?: string;
};

/** How long a code stays open, and how many wrong ones close it. */
export const PAIRING_MS = 10 * 60_000;
export const MAX_WRONG = 5;
/** How long a pairing QR code works, from when it's shown. */
export const QR_MS = 5 * 60_000;
/** QR codes remembered once they stop working, so a phone that scans one hears why. */
const QR_KEPT = 8;

/** Why a QR code doesn't let a phone pair: used already, or expired (or its screen closed). */
export type QrRefusal = "qr_used" | "qr_expired";

type PairResult = { ok: true; phone: Phone; token: string } | { ok: false; code: "bad_code" | "pairing_closed" | "too_many_attempts" | QrRefusal };

/**
 * A QR code shown (or shown before): its secret, the id that names it, until when it works, and
 * whether it still does; `relay`, the hash of the credential it lets a phone into the relay's room with.
 */
type QrOffer = { id: Buffer; secret: Buffer; relay: string; until: number; state: "open" | "used" | "closed" };

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class Pairing {
  private file: string;
  private now: () => number;
  private phones: Phone[];
  private code: string | null = null;
  private until = 0;
  private wrong = 0;
  /** Pairing was closed by too many wrong codes; it stays closed until opened again. */
  private lockedOut = false;
  /** The QR codes shown, newest last: the open one (if any) and a few that stopped working. */
  private offers: QrOffer[] = [];
  /** A phone's relay key or credential came or went (relay_pair, forget): the relay client registers the credentials again. */
  onRelayChange: (() => void) | null = null;
  /** A QR code was shown, used or stopped working: the relay client opens or shuts its way in on the relay. */
  onQrChange: (() => void) | null = null;
  /**
   * A phone paired or forgotten (`count`: how many are paired now): the account tells its server
   * (app/settings/account.ts), in the background. Thrown errors are its own: pairing never waits on it.
   */
  onPhonesChange: ((count: number) => void) | null = null;

  /** Tells onPhonesChange, never letting it get in pairing's way. */
  private phonesChanged() {
    try {
      this.onPhonesChange?.(this.phones.length);
    } catch {
      // the listener's own trouble
    }
  }

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    this.phones = this.load();
  }

  /** Opens pairing with a fresh code, for PAIRING_MS. */
  open(): { code: string; until: number } {
    this.code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.until = this.now() + PAIRING_MS;
    this.wrong = 0;
    this.lockedOut = false;
    return { code: this.code, until: this.until };
  }

  close() {
    this.code = null;
    this.until = 0;
  }

  /** The code while pairing is open, and when it closes; null when it's closed. */
  current(): { code: string; until: number } | null {
    if (this.code && this.now() >= this.until) this.close();
    return this.code ? { code: this.code, until: this.until } : null;
  }

  /**
   * The code a pairing handshake runs CPace with, while pairing is open; else why not. Nothing is
   * counted: a handshake that goes no further gave nothing away (CPace leaves nothing to check offline).
   */
  codeFor(): { ok: true; code: string } | { ok: false; code: "pairing_closed" | "too_many_attempts" } {
    if (this.lockedOut) return { ok: false, code: "too_many_attempts" };
    const open = this.current();
    return open ? { ok: true, code: open.code } : { ok: false, code: "pairing_closed" };
  }

  /** A wrong code: a pairing handshake's first record didn't open, or `pair` said another code. A few in a row close pairing. */
  wrongCode(): "bad_code" | "too_many_attempts" {
    this.wrong++;
    if (this.wrong < MAX_WRONG) return "bad_code";
    this.close();
    this.lockedOut = true;
    return "too_many_attempts";
  }

  /** A phone sent `code`: a new token when it's right. Right or wrong, the code is used up only when right. */
  pair(code: string, name: string, key?: string): PairResult {
    const open = this.codeFor();
    if (!open.ok) return { ok: false, code: open.code };
    if (!sameText(code, open.code)) return { ok: false, code: this.wrongCode() };
    this.close();
    // One phone per pairing: a QR code shown beside the code stops working too.
    this.closeQr();
    return this.add(name, key);
  }

  // ── The QR code ───────────────────────────────────────────────────────────

  /** A new QR code's secret, working for QR_MS (and the id that names it); one shown before stops working. */
  openQr(): { secret: Buffer; id: Buffer; until: number } {
    this.closeQr();
    const secret = randomBytes(QR_SECRET_BYTES);
    const relay = createHash("sha256").update(qrRelayCredentialOf(secret)).digest("hex");
    const offer: QrOffer = { id: qrIdOf(secret), secret, relay, until: this.now() + QR_MS, state: "open" };
    this.offers = [...this.offers.slice(-(QR_KEPT - 1)), offer];
    this.onQrChange?.();
    return { secret, id: offer.id, until: offer.until };
  }

  /** The QR code's screen closed (or a phone paired another way): it stops working. */
  closeQr() {
    let closed = false;
    for (const o of this.offers) {
      if (o.state !== "open") continue;
      o.state = "closed";
      closed = true;
    }
    if (closed) this.onQrChange?.();
  }

  /**
   * The QR code that works now, as the relay knows it: its relay credential's hash (SHA-256 of
   * cpace.ts qrRelayCredentialOf, hex) and until when it works; null for none.
   */
  qrRelay(): { hash: string; until: number } | null {
    const open = this.qrOpen();
    const o = open && this.offers.find((x) => x.state === "open");
    return o ? { hash: o.relay, until: o.until } : null;
  }

  /** Whether the QR code with this relay credential hash paired a phone (else it expired or was closed). */
  qrUsed(hash: string): boolean {
    return this.offers.some((o) => o.relay === hash && o.state === "used");
  }

  /** The QR code that works now, and until when; null for none. */
  qrOpen(): { id: Buffer; until: number } | null {
    const o = this.offers.find((x) => x.state === "open");
    if (!o) return null;
    if (this.now() >= o.until) {
      o.state = "closed";
      return null;
    }
    return { id: o.id, until: o.until };
  }

  /**
   * The secret a QR handshake (named by `id`) runs CPace with, while that code works; else why not:
   * used already, or expired or closed (or one this Mac never showed, or showed before it restarted).
   * Every code remembered is compared, in constant time each.
   */
  qrFor(id: Buffer): { ok: true; secret: Buffer } | { ok: false; code: QrRefusal } {
    this.qrOpen(); // an expired one is closed first
    let found: QrOffer | null = null;
    for (const o of this.offers) if (o.id.length === id.length && timingSafeEqual(o.id, id)) found = o;
    if (found?.state === "open") return { ok: true, secret: found.secret };
    return { ok: false, code: found?.state === "used" ? "qr_used" : "qr_expired" };
  }

  /**
   * A phone that opened with the QR code `id` sent `pair` with its secret (base64url): a new token
   * when the code still works and the secret is its own. The code is used up, and the typed code
   * closed with it: one phone per pairing.
   */
  pairQr(id: Buffer, secret: string, name: string, key?: string): PairResult {
    const open = this.qrFor(id);
    if (!open.ok) return { ok: false, code: open.code };
    if (!sameText(secret, open.secret.toString("base64url"))) return { ok: false, code: "bad_code" };
    for (const o of this.offers) if (o.state === "open" && o.id.length === id.length && timingSafeEqual(o.id, id)) o.state = "used";
    this.close();
    this.onQrChange?.();
    return this.add(name, key);
  }

  /** A new phone, paired now: its token (kept only as a hash) and, from its pair, its static key. */
  private add(name: string, key?: string): PairResult {
    const token = randomBytes(32).toString("base64url");
    const phone: Phone = {
      id: `p-${randomBytes(4).toString("hex")}`,
      name: name.slice(0, 100) || "Phone",
      tokenHash: hash(token),
      pairedAt: this.now(),
      lastSeenAt: this.now(),
      // On: a phone in front plays what's said (one in the background or locked doesn't, and the Mac
      // stands in). Off until 0.2.2, which after a clean reinstall sent every reply to the Mac.
      playOnPhone: true,
      ...(key ? { relayKey: key } : {}),
    };
    this.phones.push(phone);
    this.save();
    this.phonesChanged();
    return { ok: true, phone, token };
  }

  /** The paired phone with this token, or null. */
  check(token: string): Phone | null {
    const h = Buffer.from(hash(token), "hex");
    // Every phone is compared, in constant time each.
    let found: Phone | null = null;
    for (const p of this.phones) if (timingSafeEqual(h, Buffer.from(p.tokenHash, "hex"))) found = p;
    return found;
  }

  list(): Phone[] {
    return this.phones.map((p) => ({ ...p }));
  }

  /** Changes a paired phone's name, last seen time or audio choice. */
  update(id: string, patch: Partial<Pick<Phone, "name" | "lastSeenAt" | "playOnPhone">>) {
    const p = this.phones.find((x) => x.id === id);
    if (!p) return;
    Object.assign(p, patch);
    this.save();
  }

  /** Forgets one phone, or every one: their tokens stop working. The ids forgotten. */
  forget(id: string | "all"): string[] {
    const gone = this.phones.filter((p) => id === "all" || p.id === id);
    this.phones = this.phones.filter((p) => !gone.includes(p));
    this.save();
    if (gone.some((p) => p.relayKey)) this.onRelayChange?.();
    if (gone.length) this.phonesChanged();
    return gone.map((p) => p.id);
  }

  /**
   * A phone set up for the relay: its static key (base64 of 32 bytes) and a new credential, whose
   * hash is kept (the credential itself goes to the phone once, in relay_paired). One it had before
   * is replaced.
   */
  setRelay(id: string, relayKey: string): string | null {
    const p = this.phones.find((x) => x.id === id);
    if (!p) return null;
    const credential = randomBytes(32);
    p.relayKey = relayKey;
    p.relayCredentialHash = createHash("sha256").update(credential).digest("hex");
    this.save();
    this.onRelayChange?.();
    return credential.toString("base64");
  }

  /** The paired phone whose static key this is (the tunnel's handshake named it, at home or through the relay), or null. Every phone compared, in constant time each. */
  byRelayKey(key: Buffer): Phone | null {
    let found: Phone | null = null;
    for (const p of this.phones) {
      const theirs = p.relayKey ? Buffer.from(p.relayKey, "base64") : null;
      if (theirs?.length === key.length && timingSafeEqual(theirs, key)) found = p;
    }
    return found ? { ...found } : null;
  }

  /** A phone's static key (base64 of 32 bytes), set or replaced; its relay credential, if any, stays. */
  setKey(id: string, key: string) {
    const p = this.phones.find((x) => x.id === id);
    if (!p || p.relayKey === key) return;
    p.relayKey = key;
    this.save();
  }

  /**
   * The phone a token handshake names (cpace.ts tokenIdOf, from its token's hash), with that hash as
   * CPace's password; null for none. Every phone compared, in constant time each.
   */
  byTokenId(id: Buffer): { phone: Phone; secret: Buffer } | null {
    let found: { phone: Phone; secret: Buffer } | null = null;
    for (const p of this.phones) {
      const secret = Buffer.from(p.tokenHash, "hex");
      const theirs = tokenIdOf(secret);
      if (theirs.length === id.length && timingSafeEqual(theirs, id)) found = { phone: { ...p }, secret };
    }
    return found;
  }

  /** The relay credentials' hashes, for the Mac's room. */
  relayCredentials(): string[] {
    return this.phones.flatMap((p) => (p.relayCredentialHash ? [p.relayCredentialHash] : []));
  }

  private load(): Phone[] {
    // A file that can't be read is set aside, never saved over (core/json-file.ts): no phones until
    // they're paired again, but the file is kept, not replaced by an empty one.
    const data = readJsonFile(this.file) as { phones?: unknown } | undefined;
    if (!Array.isArray(data?.phones)) return [];
    return data.phones
      .filter((p: any) => p && typeof p.id === "string" && /^[0-9a-f]{64}$/.test(p.tokenHash))
      .map((p: Phone) => {
        // The key alone (a phone at home) or with a relay credential, each in its form; anything else is dropped.
        const key = typeof p.relayKey === "string" && Buffer.from(p.relayKey, "base64").length === 32;
        const credential = key && /^[0-9a-f]{64}$/.test(p.relayCredentialHash ?? "");
        const { relayKey: _key, relayCredentialHash: _hash, ...rest } = p;
        return { ...rest, ...(key ? { relayKey: p.relayKey } : {}), ...(credential ? { relayCredentialHash: p.relayCredentialHash } : {}) };
      });
  }

  private save() {
    writeJsonAtomic(this.file, { phones: this.phones }, { mode: 0o600 });
  }
}

function sameText(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
