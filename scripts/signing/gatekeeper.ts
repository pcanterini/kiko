// Whether Gatekeeper on this Mac lets a downloaded copy of each of a release's executables run, the
// last check before packing (scripts/release.sh, after notarized.ts):
//   node scripts/signing/gatekeeper.ts <file>…
//
// Each file is copied into a throwaway folder, the copy marked as a browser download (the
// com.apple.quarantine attribute Safari gives it), and assessed as a quarantined launch is, without
// starting it: `spctl --assess --type open --context context:primary-signature`. For a bare
// executable that's the assessment that counts: it looks the ticket up online by the code's hash
// (the lookup a first launch makes) and says "accepted, source=Notarized Developer ID" once the
// ticket is found, "rejected, source=Unnotarized Developer ID" before. (`--type execute` says "does
// not seem to be an app" of any bare executable, notarized or not, and `syspolicy_check
// distribution` "Notary Ticket Missing", as a bare one can't have its ticket stapled: neither tells.)
//
// Apple's ticket service can answer differently for a few minutes after Accepted: on 2026-11-01
// notarized.ts was served the 0.2.0 tickets 33 s after the submission, while this Mac's Gatekeeper
// was still told "not found" for 3 more minutes (and refused a quarantined copy with "Apple could
// not verify 'kiko' is free of malware"). So it's asked again every KIKO_GATEKEEPER_INTERVAL seconds
// (10) until every copy is accepted, for up to KIKO_GATEKEEPER_TIMEOUT seconds (600).
//
// An app bundle (the helper app, `<NAME>.app`) is copied whole, every file in it quarantined, and
// assessed as the app it is: `spctl --assess --type execute` (its ticket is looked up online too:
// releases don't staple it, so the files published are the same whether notarized before or after).
//
// Never runs a copy: launching a quarantined executable that isn't accepted puts Gatekeeper's dialog
// in front of whoever is at the Mac and leaves the launch waiting on it.
// KIKO_SPCTL and KIKO_XATTR replace /usr/sbin/spctl and /usr/bin/xattr (the tests' stand-ins).
// Exit 0 when every file is accepted; 1 with each one that isn't and what spctl last said of it.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { SLUG } from "../../src/core/name.ts";

/** What spctl said of one copy: accepted as notarized, or not (yet). */
export type Assessment = { accepted: boolean; said: string };

/** spctl's verdict: accepted only as Notarized Developer ID (a plain "Developer ID" or anything rejected isn't). */
export function parseAssessment(status: number | null, said: string): Assessment {
  const text = said.trim();
  return { accepted: status === 0 && /: accepted$/m.test(text) && /^source=Notarized Developer ID$/m.test(text), said: text };
}

export type WaitOptions = {
  /** Each file's name in messages, and what `assess` is given. */
  files: string[];
  assess: (file: string) => Assessment;
  timeoutMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Told after each round that leaves some not accepted (the build's "still waiting" line). */
  waiting?: (pending: string[], elapsedMs: number) => void;
};

/** Asks about the files not yet accepted, round after round, until all are or the time is up. Returns those never accepted, with what spctl last said. */
export async function waitForGatekeeper(o: WaitOptions): Promise<Map<string, string>> {
  const start = o.now();
  const pending = new Map(o.files.map((f) => [f, ""]));
  for (;;) {
    for (const file of [...pending.keys()]) {
      const { accepted, said } = o.assess(file);
      if (accepted) pending.delete(file);
      else pending.set(file, said);
    }
    const elapsed = o.now() - start;
    if (!pending.size || elapsed + o.intervalMs > o.timeoutMs) return pending;
    o.waiting?.([...pending.keys()], elapsed);
    await o.sleep(o.intervalMs);
  }
}

/** The files' common folder's parent, so each is named from there: arm64/kiko-<version>/native/mic. */
function namer(files: string[]): (f: string) => string {
  const base = files.map(dirname).reduce((a, b) => {
    while (!`${b}/`.startsWith(`${a}/`)) a = dirname(a);
    return a;
  });
  return (f) => relative(dirname(base), f);
}

function seconds(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`gatekeeper: ${name} must be a number of seconds`);
  return value * 1000;
}

async function main(files: string[]): Promise<number> {
  if (!files.length) {
    console.error("usage: node scripts/signing/gatekeeper.ts <file>…");
    return 2;
  }
  const spctl = process.env.KIKO_SPCTL || "/usr/sbin/spctl";
  const xattr = process.env.KIKO_XATTR || "/usr/bin/xattr";
  const timeoutMs = seconds("KIKO_GATEKEEPER_TIMEOUT", 600);
  const intervalMs = seconds("KIKO_GATEKEEPER_INTERVAL", 10);
  const name = namer(files);
  const dir = mkdtempSync(join(tmpdir(), `${SLUG}-gatekeeper-`));
  try {
    // A quarantined copy of each, as a browser would leave it (flags 0083: downloaded, by Safari).
    const quarantine = `0083;${Math.floor(Date.now() / 1000).toString(16)};Safari;`;
    const copies = new Map<string, string>();
    for (const file of files) {
      const copy = join(dir, name(file));
      mkdirSync(dirname(copy), { recursive: true });
      const bundle = file.endsWith(".app");
      if (bundle) cpSync(file, copy, { recursive: true });
      else copyFileSync(file, copy);
      const marked = spawnSync(xattr, [...(bundle ? ["-r"] : []), "-w", "com.apple.quarantine", quarantine, copy], { encoding: "utf8" });
      if (marked.status !== 0) {
        console.error(`gatekeeper: couldn't quarantine the copy of ${name(file)}: ${(marked.stderr || marked.error?.message || "").trim()}`);
        return 1;
      }
      copies.set(name(file), copy);
    }
    const assess = (file: string): Assessment => {
      const how = file.endsWith(".app") ? ["--type", "execute"] : ["--type", "open", "--context", "context:primary-signature"];
      const said = spawnSync(spctl, ["--assess", "-vv", ...how, copies.get(file) ?? file], { encoding: "utf8", timeout: 60_000 });
      return parseAssessment(said.status, `${said.stdout ?? ""}${said.stderr ?? ""}` || (said.error?.message ?? ""));
    };
    const refused = await waitForGatekeeper({
      files: [...copies.keys()],
      assess,
      timeoutMs,
      intervalMs,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      waiting: (pending, elapsed) =>
        console.log(`Gatekeeper: waiting for Apple's ticket to reach this Mac's Gatekeeper (${pending.length} of ${files.length} not accepted yet, ${Math.round(elapsed / 1000)} s)…`),
    });
    if (refused.size) {
      console.error(
        `gatekeeper: after ${timeoutMs / 1000} s, Gatekeeper still refuses a downloaded copy of ${[...refused.keys()].join(", ")}; a quarantined launch would show "Apple could not verify … is free of malware". Nothing packed. spctl said:\n` +
          [...refused].map(([file, said]) => `  ${file}: ${said.replaceAll("\n", " | ")}`).join("\n") +
          "\nAsk again later with: node scripts/signing/gatekeeper.ts <the files>, or KIKO_GATEKEEPER_TIMEOUT=<seconds> for a longer wait.",
      );
      return 1;
    }
    console.log(`Gatekeeper: a downloaded (quarantined) copy of each of the ${files.length} executables is accepted as Notarized Developer ID.`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
