// Whether a release's executables are notarized, after Apple's notary service said Accepted:
//   node scripts/signing/notarized.ts [--log <notarytool's log of it>] <file>…
// (scripts/release.sh with the log; tests/live/cli/install-live.test.ts on a signed release without).
//
// A bare executable can't have its ticket stapled, so Gatekeeper looks its ticket up online, by the
// file's code-directory hash (its cdhash), when a downloaded copy first runs. Two checks of that here:
//   - with --log, Apple's log of the submission lists it (ticketContents): the ticket covers this code;
//   - Apple's ticket service has a Developer ID ticket for it (the lookup Gatekeeper and `stapler`
//     make). Only the hash is sent. A fresh ticket can take a moment to be served, so it's asked a few times.
// One answer that has it doesn't mean every answer does yet: for a few minutes after Accepted the
// service can still tell this Mac's Gatekeeper "not found" (2026-11-01, 0.2.0: about 4 minutes). So
// scripts/release.sh then runs scripts/signing/gatekeeper.ts, which waits until Gatekeeper itself
// accepts a quarantined copy of each (`spctl --assess --type open --context context:primary-signature`,
// the assessment that reflects a quarantined launch; `--type execute` says "does not seem to be an
// app" of any bare executable, notarized or not).
// An app bundle (the helper app) counts as itself and each helper in its Contents/Helpers/, each a
// code of its own in the ticket.
// Exit 0 when every file passes; 1 with what's missing.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const args = process.argv.slice(2);
const log = args[0] === "--log" ? args[1] : undefined;
const given = log ? args.slice(2) : args;
const files = given.flatMap((f) =>
  f.endsWith(".app")
    ? [
        f,
        ...readdirSync(join(f, "Contents", "Helpers"))
          .sort()
          .map((h) => join(f, "Contents", "Helpers", h)),
      ]
    : [f],
);
if (!files.length) throw new Error("usage: node scripts/signing/notarized.ts [--log <notary log>] <file>…");

/** The file's cdhash (SHA-256, truncated to 20 bytes, hex), as codesign says it (on stderr). */
function cdhash(file: string): string {
  const hash = /^CDHash=([0-9a-f]{40})$/m.exec(spawnSync("codesign", ["-dvvv", file], { encoding: "utf8" }).stderr)?.[1];
  if (!hash) throw new Error(`notarized: no cdhash for ${file}`);
  return hash;
}

const hashes = new Map(files.map((f) => [f, cdhash(f)]));
/** Where the files are (their common folder), so they're named from there: arm64/kiko-<version>/native/mic. */
const base = files.map(dirname).reduce((a, b) => {
  while (!`${b}/`.startsWith(`${a}/`)) a = dirname(a);
  return a;
});
const name = (f: string) => relative(dirname(base), f);

if (log) {
  const covered = new Set<string>(((JSON.parse(readFileSync(log, "utf8")).ticketContents ?? []) as { cdhash?: string }[]).map((t) => (t.cdhash ?? "").toLowerCase().slice(0, 40)));
  const uncovered = files.filter((f) => !covered.has(hashes.get(f) ?? ""));
  if (uncovered.length) {
    console.error(`notarized: Apple's log of it doesn't list ${uncovered.map(name).join(", ")}: not in the ticket`);
    process.exit(1);
  }
}

const LOOKUP = "https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup";
/** The files whose ticket Apple's ticket service doesn't serve (yet). */
async function unserved(): Promise<string[]> {
  const records = files.map((f) => ({ recordName: `2/2/${hashes.get(f)}` }));
  const res = await fetch(LOOKUP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ records }), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Apple's ticket service said HTTP ${res.status}`);
  const found = ((await res.json()) as { records?: { recordName?: string; recordType?: string }[] }).records ?? [];
  const has = new Set(found.filter((r) => r.recordType === "DeveloperIDTicket").map((r) => r.recordName));
  return files.filter((f) => !has.has(`2/2/${hashes.get(f)}`));
}

let missing: string[] = files;
let error = "";
for (let tries = 0; tries < 12 && missing.length; tries++) {
  if (tries) await new Promise((r) => setTimeout(r, 10_000));
  try {
    missing = await unserved();
    error = "";
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
}
if (missing.length) {
  console.error(`notarized: Apple's ticket service has no ticket for ${missing.map(name).join(", ")}${error ? ` (${error})` : ""}: Gatekeeper wouldn't find one`);
  process.exit(1);
}
console.log(`Notarized: ${log ? `the ticket covers all ${files.length} executables, and ` : ""}Apple serves a ticket for each (Gatekeeper's online check).`);
