// What the encrypted connection at home costs (src/remote/local.ts, tunnel.ts, cpace.ts): per record,
// sealing one on the Mac and opening one (the phone's frames come in, the Mac's go out), at the sizes
// that go: a batched Opus frame (60-100 ms, ~150-300 bytes), PCM in JSON (~4-5 KB per 80-100 ms),
// text and cards, a large history page; and each handshake, the Mac's side and the phone's. No
// network: the same functions the server runs, in a loop. Run under Node and Bun (the release runs
// on Bun): `node scripts/perf/local-tunnel.ts`, `bun scripts/perf/local-tunnel.ts`; `--out <file>`
// writes the numbers as JSON.
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { CPACE_CI, cpaceInitiate, cpaceRespond, sessionOf, tokenIdOf, tokenSecret } from "../../src/remote/cpace.ts";
import { initiate, LOCAL_PROLOGUE, openRecord, RECORD, respond, sealRecord, x25519Pair } from "../../src/remote/tunnel.ts";

const runtime = typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? `node ${process.version}` : `bun ${process.versions.bun}`;

/** Median microseconds per call of `f`, over `rounds` rounds of `n` calls (after a warm-up). */
function time(f: () => void, n: number, rounds = 7) {
  for (let i = 0; i < n; i++) f();
  const out: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const t = process.hrtime.bigint();
    for (let i = 0; i < n; i++) f();
    out.push(Number(process.hrtime.bigint() - t) / 1000 / n);
  }
  out.sort((a, b) => a - b);
  return Math.round(out[Math.floor(rounds / 2)] * 100) / 100;
}

const mac = x25519Pair();
const phone = x25519Pair();
const hs = initiate({ prologue: LOCAL_PROLOGUE, local: phone, remote: mac.public });
const { session: macSession, message } = respond({ prologue: LOCAL_PROLOGUE, local: mac, message: hs.message }).answer();
const phoneSession = hs.finish(message);

const sizes: Array<[string, number]> = [
  ["Opus, 1 packet (20 ms)", 60],
  ["Opus, batched 60-100 ms", 250],
  ["text message", 1_000],
  ["PCM in JSON, ~100 ms up", 4_400],
  ["PCM in JSON, ~80 ms down", 5_200],
  ["history page", 200_000],
];
const records = sizes.map(([what, bytes]) => {
  const body = randomBytes(bytes);
  const n = bytes > 50_000 ? 200 : 5_000;
  // The Mac seals its frames; it opens the phone's (sealed by the phone's key, here in the same loop so each opens under the next counter).
  const seal = time(() => void sealRecord(macSession.send, RECORD.binary, body), n);
  const roundTrip = time(() => void openRecord(macSession.receive, sealRecord(phoneSession.send, RECORD.binary, body)), n);
  return { what, bytes, sealUs: seal, openUs: Math.round((roundTrip - seal) * 100) / 100, overheadBytes: 17 };
});

const code = "482913";
const token = randomBytes(32).toString("base64url");
const handshakes = {
  keysPhoneUs: time(() => void initiate({ prologue: LOCAL_PROLOGUE, local: phone, remote: mac.public }), 200),
  keysMacUs: time(() => {
    const h = initiate({ prologue: LOCAL_PROLOGUE, local: phone, remote: mac.public });
    respond({ prologue: LOCAL_PROLOGUE, local: mac, message: h.message }).answer();
  }, 200),
  codeMacUs: time(() => {
    const a = cpaceInitiate({ prs: Buffer.from(code), ci: CPACE_CI.code });
    sessionOf(cpaceRespond({ prs: Buffer.from(code), ci: CPACE_CI.code, theirs: a.share }).isk, "mac");
  }, 100),
  tokenMacUs: time(() => {
    const secret = tokenSecret(token);
    const id = tokenIdOf(secret);
    const a = cpaceInitiate({ prs: secret, ci: CPACE_CI.token, ada: id });
    sessionOf(cpaceRespond({ prs: secret, ci: CPACE_CI.token, ada: id, theirs: a.share }).isk, "mac");
  }, 100),
};

const result = { date: new Date().toISOString().slice(0, 10), runtime, machine: process.arch, records, handshakes };
console.log(`${runtime}:`);
for (const r of records) console.log(`  ${r.what.padEnd(28)} ${String(r.bytes).padStart(7)} B  seal ${r.sealUs} µs  open ${r.openUs} µs  (+${r.overheadBytes} B)`);
console.log(`  handshakes (µs): keys phone ${handshakes.keysPhoneUs}, keys both ${handshakes.keysMacUs}, code both ${handshakes.codeMacUs}, token both ${handshakes.tokenMacUs}`);
const out = process.argv.indexOf("--out");
if (out > 0) writeFileSync(process.argv[out + 1], `${JSON.stringify(result, null, 2)}\n`);
