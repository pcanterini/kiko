// The relay's test vectors (protocol/relay-vectors.json): every key, message and frame of one relay
// connection, from fixed inputs, so the iPhone app's side can be built from protocol/README.md
// ("Relay") and checked byte for byte. tests/unit/remote/tunnel.test.ts makes them again and
// compares; run this to write the file after a change to the spec: `node scripts/relay-vectors.ts`.
// `--check` writes nothing: it makes them again and exits 1 unless they're the file's, byte for byte,
// so a runtime can be checked to run the tunnel (scripts/release.sh runs it on Bun, which the release
// is built with: Bun's node:crypto once lacked ChaCha20-Poly1305, and 0.2.0 refused every phone).
// Every private key is SHA-256 of a label ("kiko vector mac signing", …), so anyone can make the
// same ones; Ed25519 signatures are deterministic, and the handshake's ephemeral keys are given.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { encodeQr } from "../src/core/qr.ts";
import { CPACE_CI, cpaceInitiate, cpaceRespond, generator, LOCAL_KEYS_SALT, qrIdOf, qrRelayCredentialOf, scalarMult, sessionOf, tokenIdOf, tokenSecret } from "../src/remote/cpace.ts";
import { pairUrl, QR_SECRET_BYTES } from "../src/remote/pair-link.ts";
import {
  authMessage,
  closeBody,
  credentialHash,
  ed25519Pair,
  ed25519Sign,
  initiate,
  LOCAL_OPEN,
  LOCAL_PROLOGUE,
  nonceOf,
  prologueOf,
  RECORD,
  respond,
  roomOf,
  sealRecord,
  TUNNEL_VERSION,
  x25519Pair,
  type Cipher,
} from "../src/remote/tunnel.ts";

const label = (text: string) => createHash("sha256").update(`kiko vector ${text}`).digest();
const hex = (b: Buffer) => b.toString("hex");
const b64 = (b: Buffer) => b.toString("base64");

export function relayVectors() {
  const macSigning = ed25519Pair(label("mac signing"));
  const room = roomOf(macSigning.public);
  const macStatic = x25519Pair(label("mac static"));
  const phoneStatic = x25519Pair(label("phone static"));
  const phoneEphemeral = x25519Pair(label("phone ephemeral"));
  const macEphemeral = x25519Pair(label("mac ephemeral"));
  const relayNonce = label("relay nonce");
  const credential = label("credential");

  const signed = authMessage(room, relayNonce);
  const signature = ed25519Sign(macSigning.seed, signed);

  const prologue = prologueOf(room);
  const phone = initiate({ prologue, local: phoneStatic, remote: macStatic.public, ephemeral: phoneEphemeral });
  const message1 = Buffer.concat([Buffer.from([TUNNEL_VERSION]), phone.message]);
  const mac = respond({ prologue, local: macStatic, message: message1.subarray(1), ephemeral: macEphemeral });
  const { message: message2, session: macSession } = mac.answer();
  const phoneSession = phone.finish(message2);

  const hello = JSON.stringify({ v: 1, type: "hello", token: "dGhpcyBpcyBub3QgYSByZWFsIHRva2VuIGF0IGFsbA", device: "Test iPhone", appVersion: "0.1.0" });
  const welcome = JSON.stringify({ v: 1, type: "welcome", hubName: "Kiko on Test-Mac", phoneId: "p-0a1b2c3d", playOnPhone: false, playOnMac: true, versions: [1] });
  const opus = Buffer.from("01010003f8fffe", "hex"); // a binary frame as protocol/README.md's Opus has it: v1, the phone's kind, one 3-byte packet
  const record = (from: "phone" | "mac", cipher: Cipher, type: keyof typeof RECORD, body: Buffer, shown: Record<string, unknown>) => {
    const n = Number(cipher.n);
    const nonce = nonceOf(cipher.n);
    const frame = sealRecord(cipher, RECORD[type], body);
    return { from, n, nonce: hex(nonce), type, recordType: RECORD[type], ...shown, plaintext: hex(Buffer.concat([Buffer.from([RECORD[type]]), body])), frame: hex(frame) };
  };
  const records = [
    record("phone", phoneSession.send, "text", Buffer.from(hello), { text: hello }),
    record("mac", macSession.send, "text", Buffer.from(welcome), { text: welcome }),
    record("phone", phoneSession.send, "binary", opus, { body: hex(opus) }),
    record("mac", macSession.send, "ping", Buffer.alloc(0), { body: "" }),
    record("phone", phoneSession.send, "pong", Buffer.alloc(0), { body: "" }),
    record("mac", macSession.send, "close", closeBody(4001, "unauthorized"), { code: 4001, reason: "unauthorized" }),
  ];
  const channel = Buffer.alloc(4);
  channel.writeUInt32BE(7);

  return {
    description:
      "One relay connection, from fixed inputs: protocol/README.md, Relay, says what each step is. Hex unless named base64. Private keys are SHA-256 of 'kiko vector <label>' (UTF-8). Made by scripts/relay-vectors.ts and checked by tests/unit/remote/tunnel.test.ts.",
    keys: {
      macSigningSeed: hex(macSigning.seed),
      macSigningPublic: hex(macSigning.public),
      macSigningPublicBase64: b64(macSigning.public),
      room,
      macStaticPrivate: hex(macStatic.private),
      macStaticPublic: hex(macStatic.public),
      macStaticPublicBase64: b64(macStatic.public),
      phoneStaticPrivate: hex(phoneStatic.private),
      phoneStaticPublic: hex(phoneStatic.public),
      phoneStaticPublicBase64: b64(phoneStatic.public),
      phoneEphemeralPrivate: hex(phoneEphemeral.private),
      phoneEphemeralPublic: hex(phoneEphemeral.public),
      macEphemeralPrivate: hex(macEphemeral.private),
      macEphemeralPublic: hex(macEphemeral.public),
    },
    macSignIn: {
      challenge: { type: "challenge", nonce: b64(relayNonce) },
      signed: hex(signed),
      signature: hex(signature),
      auth: { type: "auth", key: b64(macSigning.public), sig: b64(signature) },
    },
    phoneJoin: {
      credentialBase64: b64(credential),
      credentialHash: credentialHash(credential),
      join: { type: "join", credential: b64(credential) },
      register: { type: "phones", credentials: [credentialHash(credential)] },
    },
    handshake: {
      protocolName: "Noise_IK_25519_ChaChaPoly_SHA256",
      prologue: hex(prologue),
      message1: hex(message1),
      message2: hex(message2),
      handshakeHash: hex(phoneSession.hash),
      phoneToMacKey: hex(phoneSession.send.key),
      macToPhoneKey: hex(phoneSession.receive.key),
    },
    records,
    local: localVectors({ macStatic, phoneStatic, phoneEphemeral, macEphemeral, hello, record, room }),
    macFraming: {
      description: "Between the relay and the Mac, a phone's frame goes behind its channel: 4 bytes, big-endian. Here the first record above on channel 7.",
      channel: 7,
      frame: hex(Buffer.concat([channel, Buffer.from(records[0].frame, "hex")])),
    },
  };
}

/**
 * The home network's ways in (protocol/README.md, "Encrypted at home"): the keys handshake (Noise
 * IK as above, with its own prologue), CPace with the pairing code, CPace with a token; and the
 * CPace draft's own vector (draft-irtf-cfrg-cpace-21, B.1), so a side can check its Elligator 2 and
 * ISK against the draft's numbers before ours. CPace scalars are SHA-256 of a label, like the keys.
 */
function localVectors(o: {
  macStatic: ReturnType<typeof x25519Pair>;
  phoneStatic: ReturnType<typeof x25519Pair>;
  phoneEphemeral: ReturnType<typeof x25519Pair>;
  macEphemeral: ReturnType<typeof x25519Pair>;
  hello: string;
  room: string;
  record: (from: "phone" | "mac", cipher: Cipher, type: keyof typeof RECORD, body: Buffer, shown: Record<string, unknown>) => Record<string, unknown>;
}) {
  const welcome = JSON.stringify({ v: 1, type: "welcome", hubName: "Kiko on Test-Mac", phoneId: "p-0a1b2c3d", playOnPhone: false, playOnMac: true, versions: [1], macKey: b64(o.macStatic.public) });

  const phone = initiate({ prologue: LOCAL_PROLOGUE, local: o.phoneStatic, remote: o.macStatic.public, ephemeral: o.phoneEphemeral });
  const message1 = Buffer.concat([Buffer.from([LOCAL_OPEN.keys]), phone.message]);
  const { message: message2, session: macSession } = respond({ prologue: LOCAL_PROLOGUE, local: o.macStatic, message: phone.message, ephemeral: o.macEphemeral }).answer();
  const phoneSession = phone.finish(message2);
  const keys = {
    prologue: hex(LOCAL_PROLOGUE),
    message1: hex(message1),
    message2: hex(message2),
    handshakeHash: hex(phoneSession.hash),
    phoneToMacKey: hex(phoneSession.send.key),
    macToPhoneKey: hex(phoneSession.receive.key),
    records: [o.record("phone", phoneSession.send, "text", Buffer.from(o.hello), { text: o.hello }), o.record("mac", macSession.send, "text", Buffer.from(welcome), { text: welcome })],
  };

  const cpace = (way: "code" | "token" | "qr", prs: Buffer, first: string) => {
    const phoneScalar = label(`phone cpace ${way}`);
    const macScalar = label(`mac cpace ${way}`);
    const ada = way === "token" ? tokenIdOf(prs) : way === "qr" ? qrIdOf(prs) : Buffer.alloc(0);
    const a = cpaceInitiate({ prs, ci: CPACE_CI[way], ada, scalar: phoneScalar });
    const b = cpaceRespond({ prs, ci: CPACE_CI[way], ada, theirs: a.share, scalar: macScalar });
    const isk = a.finish(b.share);
    if (!isk.equals(b.isk)) throw new Error("CPace: the two ISKs differ");
    const phoneS = sessionOf(isk, "phone");
    const macS = sessionOf(isk, "mac");
    return {
      prs: hex(prs),
      ci: hex(CPACE_CI[way]),
      ada: hex(ada),
      generator: hex(generator(prs, CPACE_CI[way])),
      phoneScalar: hex(phoneScalar),
      macScalar: hex(macScalar),
      phoneShare: hex(a.share),
      macShare: hex(b.share),
      k: hex(scalarMult(macScalar, a.share)),
      isk: hex(isk),
      keysSalt: hex(LOCAL_KEYS_SALT),
      phoneToMacKey: hex(phoneS.send.key),
      macToPhoneKey: hex(phoneS.receive.key),
      firstFrame: hex(Buffer.concat([Buffer.from([LOCAL_OPEN[way]]), ada, a.share])),
      answer: hex(b.share),
      records: [o.record("phone", phoneS.send, "text", Buffer.from(first), { text: first }), o.record("mac", macS.send, "text", Buffer.from(welcome), { text: welcome })],
    };
  };
  const code = "482913";
  const pair = JSON.stringify({ v: 1, type: "pair", code, device: "Test iPhone", appVersion: "0.1.0", key: b64(o.phoneStatic.public) });
  const token = JSON.parse(o.hello).token as string;
  const helloWithKey = JSON.stringify({ ...JSON.parse(o.hello), key: b64(o.phoneStatic.public) });
  // The QR code: a fixed secret, the URL it's shown as (with and without the relay), and that URL's
  // symbol as the Mac draws it, row by row (1 dark), for a side to check its scanner against.
  const qrSecret = label("qr secret").subarray(0, QR_SECRET_BYTES);
  const qrPair = JSON.stringify({ v: 1, type: "pair", code: qrSecret.toString("base64url"), device: "Test iPhone", appVersion: "0.1.0", key: b64(o.phoneStatic.public) });
  const link = { name: "Kiko on Test-Mac", hosts: ["192.168.1.20", "100.101.102.103", "test-mac.tail1234.ts.net"], port: 7333, secret: qrSecret, macKey: o.macStatic.public };
  const url = pairUrl(link);
  const relayUrl = pairUrl({ ...link, relay: { url: "wss://relay.example.com", room: o.room } });
  const symbol = encodeQr(url);
  // Pairing by it through the relay: the credential drawn from the secret, the phone's join with it,
  // and the Mac's registration of its hash with the room (for the code's 5 minutes).
  const qrCredential = qrRelayCredentialOf(qrSecret);

  const draftIn = {
    prs: Buffer.from("Password"),
    ci: Buffer.from("0b415f696e69746961746f720b425f726573706f6e646572", "hex"),
    sid: Buffer.from("7e4b4791d6a8ef019b936c79fb7f2c57", "hex"),
    ada: Buffer.from("ADa"),
    adb: Buffer.from("ADb"),
  };
  const ya = Buffer.from("21b4f4bd9e64ed355c3eb676a28ebedaf6d8f17bdc365995b319097153044080", "hex");
  const yb = Buffer.from("848b0779ff415f0af4ea14df9dd1d3c29ac41d836c7808896c4eba19c51ac40a", "hex");
  const da = cpaceInitiate({ ...draftIn, scalar: ya });
  const db = cpaceRespond({ ...draftIn, theirs: da.share, scalar: yb });
  return {
    description:
      "On the home network, the phone's first frame is one byte saying how it opens (1 keys, 2 code, 3 token, 4 qr) then that handshake's first message. keys: Noise IK as in handshake, with this prologue. code, token and qr: CPace (CPACE-X25519-SHA512, initiator-responder, sid empty, ADb empty), then (k1, k2) = HKDF-SHA256(salt keysSalt, ISK) split as Noise does, k1 for the phone's records. token: prs = SHA-256 of the token's UTF-8, ada = the phone's id, first 16 bytes of SHA-256('kiko phone id v1' || 0x00 || prs). qr: prs = the QR code's 16-byte secret, ada = the code's id, first 16 bytes of SHA-256('kiko qr id v1' || 0x00 || secret); url is the pairing URL the code carries (relayUrl: with the relay), and symbol the QR code the Mac makes of url (rows top to bottom, 1 dark, no quiet zone); relayCredential = SHA-256('kiko qr relay v1' || 0x00 || secret), what a phone away from home joins the Mac's room with to pair by the code (relayJoin; the relay keeps only relayCredentialHash, which the Mac registers: relayPairing), then the same first frame as at home, through the relay. cpaceDraft: draft-irtf-cfrg-cpace-21's own vector B.1.",
    keys,
    code: { code, ...cpace("code", Buffer.from(code), pair) },
    token: { token, tokenId: hex(tokenIdOf(tokenSecret(token))), ...cpace("token", tokenSecret(token), helloWithKey) },
    qr: {
      secret: hex(qrSecret),
      secretBase64url: qrSecret.toString("base64url"),
      qrId: hex(qrIdOf(qrSecret)),
      ...cpace("qr", qrSecret, qrPair),
      url,
      relayUrl,
      link: { name: link.name, hosts: link.hosts, port: link.port, macKey: b64(link.macKey), relay: { url: "wss://relay.example.com", room: o.room } },
      symbol: { version: symbol.version, ecc: symbol.ecc, mask: symbol.mask, rows: symbol.modules.map((r) => r.map((m) => (m ? "1" : "0")).join("")) },
      relayCredential: hex(qrCredential),
      relayCredentialBase64: b64(qrCredential),
      relayCredentialHash: credentialHash(qrCredential),
      relayJoin: JSON.stringify({ type: "join", credential: b64(qrCredential) }),
      relayPairing: JSON.stringify({ type: "pairing", credential: credentialHash(qrCredential), ttl: 300 }),
    },
    cpaceDraft: {
      prs: hex(draftIn.prs),
      ci: hex(draftIn.ci),
      sid: hex(draftIn.sid),
      ada: hex(draftIn.ada),
      adb: hex(draftIn.adb),
      ya: hex(ya),
      yb: hex(yb),
      generator: hex(generator(draftIn.prs, draftIn.ci, draftIn.sid)),
      phoneShare: hex(da.share),
      macShare: hex(db.share),
      k: hex(scalarMult(yb, da.share)),
      isk: hex(db.isk),
    },
  };
}

/** The example messages that carry the vectors' relay values (the room, the Mac's two keys, the phone's credential). */
export const RELAY_EXAMPLES = ["relay_paired.json", "welcome.relay.json", "welcome.json"];

/** What the examples must say, from the vectors: by field name, as an app reads them. */
export function relayValues(v = relayVectors()) {
  return { room: v.keys.room, macKey: v.keys.macStaticPublicBase64, signingKey: v.keys.macSigningPublicBase64, credential: v.phoneJoin.credentialBase64 };
}

/** `text` (an example, as written) with every relay value it has replaced by the vectors', its layout kept. */
export function withRelayValues(text: string, v = relayVectors()): string {
  const now = relayValues(v);
  const was = JSON.parse(text);
  const relay = was.addresses?.find((a: { kind?: string }) => a.kind === "relay");
  const old: Record<string, unknown> = { room: was.room ?? relay?.room, macKey: was.macKey, signingKey: was.signingKey, credential: was.credential };
  let out = text;
  for (const [key, value] of Object.entries(now)) if (typeof old[key] === "string" && old[key] !== value) out = out.replaceAll(old[key] as string, value);
  return out;
}

if (import.meta.main && process.argv.includes("--check")) {
  const runtime = typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? `node ${process.version}` : `bun ${process.versions.bun}`;
  let made = "";
  try {
    made = `${JSON.stringify(relayVectors(), null, 2)}\n`;
  } catch (err) {
    console.error(`relay vectors: ${runtime} can't make them: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const want = readFileSync(new URL("../protocol/relay-vectors.json", import.meta.url), "utf8");
  if (made !== want) {
    console.error(`relay vectors: ${runtime} makes them differently from protocol/relay-vectors.json`);
    process.exit(1);
  }
  console.log(`relay vectors: ${runtime} makes them byte for byte`);
} else if (import.meta.main) {
  const v = relayVectors();
  const file = new URL("../protocol/relay-vectors.json", import.meta.url);
  writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`);
  console.log(`Wrote ${file.pathname}`);
  // The examples that carry its values follow it, so the iPhone app's tests (which check one against the other) agree.
  for (const name of RELAY_EXAMPLES) {
    const example = new URL(`../protocol/examples/${name}`, import.meta.url);
    writeFileSync(example, withRelayValues(readFileSync(example, "utf8"), v));
    console.log(`Wrote ${example.pathname}`);
  }
}
