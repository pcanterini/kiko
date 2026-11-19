// The public snapshot: what `git archive` of this repo holds (the paths marked export-ignore in
// .gitattributes left out), checked for secrets and personal data, then installed and typechecked
// offline. The public repo is made from this folder as one fresh commit, never from the working
// folder (which also holds ignored files: .env, logs/, .claude/ …).
//
//   pnpm public:snapshot [dir] [--ref HEAD] [--no-install]
//
// dir: where the export goes (new or empty); a fresh temp folder by default.
//
// Checks, each failing the run on any hit, shown as file:line only (never the value):
//   - gitleaks (`gitleaks dir --redact`, with .gitleaks.toml), when gitleaks is installed;
//   - key shapes (Anthropic, OpenRouter, OpenAI, AWS, GitHub, Stripe, Slack, Google, ElevenLabs,
//     Cartesia, private keys, JWTs), test values aside;
//   - home folders: /Users/<name> other than the placeholders the tests use, and this Mac's own
//     home folder and user name;
//   - personal words: the git author's name and email (from git config), and the terms in the
//     private denylist (scripts/public-snapshot.deny, itself export-ignored: names, real project
//     names, real session ids);
//   - session ids of this Mac's own Claude Code and Codex sessions (~/.claude/projects,
//     ~/.codex/sessions), whole or as their 8-character prefix;
//   - none of the export-ignored paths made it in.
// Then `pnpm install --frozen-lockfile --offline && pnpm typecheck` in the export.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ref: { type: "string", default: "HEAD" },
    "no-install": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (flags.help) {
  console.log("pnpm public:snapshot [dir] [--ref HEAD] [--no-install]");
  process.exit(0);
}

// ── The export ───────────────────────────────────────────────────────────────────────────────
const out = positionals[0] ? resolve(positionals[0]) : mkdtempSync(join(tmpdir(), "kiko-public-snapshot-"));
if (existsSync(out) && readdirSync(out).length) {
  console.error(`${out} isn't empty: give a new or empty folder.`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const tar = execFileSync("git", ["-C", repo, "archive", "--format=tar", flags.ref!], { maxBuffer: 1 << 30 });
execFileSync("tar", ["-x", "-C", out], { input: tar });
console.log(`Exported ${flags.ref} to ${out}`);

type Hit = { check: string; file: string; line: number; what?: string };
const hits: Hit[] = [];

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, files);
    else if (s.isFile()) files.push(p);
  }
  return files;
}
const files = walk(out)
  .map((p) => ({ path: relative(out, p), buf: readFileSync(p) }))
  .filter((f) => !f.buf.subarray(0, 8000).includes(0)) // text only
  .map((f) => ({ path: f.path, lines: f.buf.toString("utf8").split("\n") }));
console.log(`${files.length} text files`);

function scan(check: string, re: RegExp, keep: (m: RegExpExecArray, file: string) => boolean = () => true, what?: (m: RegExpExecArray) => string) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const f of files) {
    f.lines.forEach((text, i) => {
      g.lastIndex = 0;
      for (let m = g.exec(text); m; m = g.exec(text)) {
        if (keep(m, f.path)) hits.push({ check, file: f.path, line: i + 1, what: what?.(m) });
      }
    });
  }
}

// ── Paths that must not be there ───────────────────────────────────────────────────────────────
const attributes = existsSync(join(repo, ".gitattributes")) ? readFileSync(join(repo, ".gitattributes"), "utf8") : "";
const ignored = attributes
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#") && /\sexport-ignore\b/.test(l))
  .map((l) => l.split(/\s+/)[0]);
const globRe = (glob: string) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, ".*")}(?:/.*)?$`,
  );
for (const p of walk(out).map((p) => relative(out, p))) {
  const glob = ignored.find((g) => globRe(g).test(p));
  if (glob) hits.push({ check: "export-ignored path present", file: p, line: 0, what: glob });
}

// ── gitleaks ─────────────────────────────────────────────────────────────────────────────────
const hasGitleaks = spawnSync("gitleaks", ["version"], { stdio: "ignore" }).status === 0;
if (hasGitleaks) {
  const report = join(mkdtempSync(join(tmpdir(), "kiko-gitleaks-")), "report.json");
  const config = join(out, ".gitleaks.toml");
  const args = ["dir", "--redact", "--no-banner", "--log-level", "error", "--report-format", "json", "--report-path", report, ...(existsSync(config) ? ["--config", config] : []), "."];
  // From inside the export, so the paths (and .gitleaks.toml's allowlist) are relative to it.
  spawnSync("gitleaks", args, { cwd: out, stdio: "inherit" });
  const found = existsSync(report) ? (JSON.parse(readFileSync(report, "utf8")) as Array<{ File: string; StartLine: number; RuleID: string }>) : [];
  for (const f of found) hits.push({ check: "gitleaks", file: relative(out, resolve(out, f.File)), line: f.StartLine, what: f.RuleID });
  console.log(`gitleaks: ${found.length} finding${found.length === 1 ? "" : "s"}`);
} else {
  console.log("gitleaks: not installed, skipped (brew install gitleaks)");
}

// ── Key shapes ───────────────────────────────────────────────────────────────────────────────
const PLACEHOLDER = /test|fake|example|dummy|placeholder|xxxx|0123456789|abcdef|not-?a-?real|redacted/i;
const KEYS: Array<[string, RegExp]> = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenRouter key", /sk-or-v1-[0-9a-f]{32,}/],
  ["OpenAI key", /sk-(?:proj-|svcacct-)[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{48}\b/],
  ["AWS key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}/],
  ["Stripe key", /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|\bwhsec_[A-Za-z0-9]{20,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}|hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}/],
  ["Google key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["ElevenLabs key", /\bsk_[0-9a-f]{48}\b/],
  ["Cartesia key", /\bsk_car_[A-Za-z0-9]{20,}/],
  ["private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];
for (const [check, re] of KEYS) scan(check, re, (m) => !PLACEHOLDER.test(m[0]));

// ── Home folders ─────────────────────────────────────────────────────────────────────────────
// The tests' and docs' placeholder homes; any other name under /Users is flagged.
const HOMES = new Set(["me", "me2", "you", "someone", "x", "p", "pc", "pc2", "other", "example", "alex", "test", "user", "shared", "name"]);
scan("home folder", /\/Users\/([A-Za-z0-9._-]+)/, (m) => !HOMES.has(m[1].toLowerCase()));

// ── Personal words ─────────────────────────────────────────────────────────────────────────────
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const terms = new Map<string, string>(); // term → where it came from
const git = (key: string) => spawnSync("git", ["-C", repo, "config", "--get", key], { encoding: "utf8" }).stdout.trim();
for (const word of git("user.name").split(/\s+/)) if (word.length >= 3) terms.set(word.toLowerCase(), "git user.name");
if (git("user.email")) terms.set(git("user.email").toLowerCase(), "git user.email");
const me = userInfo().username;
if (me && me.length >= 3) terms.set(me.toLowerCase(), "user name");
terms.set(homedir().toLowerCase(), "home folder");

const DENY = join(repo, "scripts", "public-snapshot.deny");
const hexIds = new Set<string>();
if (existsSync(DENY)) {
  for (const raw of readFileSync(DENY, "utf8").split("\n")) {
    const t = raw.replace(/#.*/, "").trim().toLowerCase();
    if (!t) continue;
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(t)) hexIds.add(t);
    else terms.set(t, "denylist");
  }
  console.log(`denylist: ${terms.size} words, ${hexIds.size} ids (scripts/public-snapshot.deny)`);
} else {
  console.log("denylist: none (scripts/public-snapshot.deny is private); only git's and this Mac's names checked");
}
// The public repo's own addresses (package.json's homepage, repository and bugs) are public by
// design: what they hold (the GitHub owner) isn't flagged there.
const own: string[] = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    const url = (x: unknown) => (typeof x === "string" ? x : (x as { url?: string } | undefined)?.url);
    return [url(pkg.homepage), url(pkg.repository), url(pkg.bugs)].filter((u): u is string => !!u).map((u) => u.replace(/^git\+/, "").replace(/\.git$/, ""));
  } catch {
    return [];
  }
})();
const ownAt = (m: RegExpExecArray) =>
  own.some((u) => {
    const at = m.input.indexOf(u);
    return at >= 0 && m.index >= at && m.index < at + u.length;
  });
for (const [term, from] of terms) {
  // Not right after a letter (so "art" isn't found in "start"); anything may follow ("Art's", "ART_SESSIONS").
  scan(`personal word (${from})`, new RegExp(`(?<![a-z])${escape(term)}`, "i"), (m) => !ownAt(m));
}

// ── Session ids ──────────────────────────────────────────────────────────────────────────────
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function idsUnder(dir: string, depth = 0): string[] {
  if (!existsSync(dir) || depth > 6) return [];
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    found.push(...(name.match(UUID) ?? []));
    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) found.push(...idsUnder(p, depth + 1));
    } catch {}
  }
  return found;
}
const local = [...new Set([...idsUnder(join(homedir(), ".claude", "projects")), ...idsUnder(join(homedir(), ".codex", "sessions"))])];
for (const id of local) {
  hexIds.add(id);
  hexIds.add(id.slice(0, 8));
}
console.log(`session ids: ${local.length} on this Mac, ${hexIds.size} ids and prefixes checked`);
scan("session id", /(?<![0-9a-f])[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?(?![0-9a-f])/i, (m) => {
  const v = m[0].toLowerCase();
  return hexIds.has(v) || hexIds.has(v.slice(0, 8));
});

// ── Results ──────────────────────────────────────────────────────────────────────────────────
const seen = new Set<string>();
const shown = hits.filter((h) => {
  const k = `${h.check} ${h.file}:${h.line}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
if (shown.length) {
  console.log(`\n${shown.length} hit${shown.length === 1 ? "" : "s"} (values not shown):`);
  for (const h of shown) console.log(`  ${h.check}: ${h.file}${h.line ? `:${h.line}` : ""}${h.what && !h.check.startsWith("personal") ? ` (${h.what})` : ""}`);
} else {
  console.log("\nNo secrets or personal data found.");
}

// ── Install and typecheck, offline ─────────────────────────────────────────────────────────────
let built = true;
if (!flags["no-install"]) {
  for (const cmd of [["install", "--frozen-lockfile", "--offline"], ["typecheck"]]) {
    console.log(`\n$ pnpm ${cmd.join(" ")}  (in ${basename(out)})`);
    const r = spawnSync("pnpm", cmd, { cwd: out, stdio: "inherit" });
    if (r.status !== 0) {
      built = false;
      console.log(`pnpm ${cmd[0]} failed`);
      break;
    }
  }
}

console.log(`\n${shown.length || !built ? "FAIL" : "OK"}: ${out}`);
process.exit(shown.length || !built ? 1 : 0);
