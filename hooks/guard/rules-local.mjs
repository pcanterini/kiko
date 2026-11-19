// The safety gate's rules for files, disks and databases (../guard.mjs): rm -r (but not build
// output, caches or the temp folders), find -delete, shred, tools that erase a disk; SQL drops and
// unqualified DELETE FROM in the SQL shells (heredocs included), Mongo and Redis wipes, and
// frameworks' resets and migrations.
import { basename } from "node:path";
import { inlineRule, targets } from "./rules-scripts.mjs";

// ── Files and disks ──────────────────────────────────────────────────────────

/** rm -r: what's safe to take out without asking. Build output and caches a build or install makes again. */
const REGENERATED = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  ".astro",
  ".output",
  ".expo",
  ".angular",
  ".docusaurus",
  "storybook-static",
  "coverage",
  ".nyc_output",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "venv",
  "DerivedData",
  ".build",
  ".gradle",
  "Pods",
  ".eggs",
  "tmp",
  ".tmp",
  "temp",
]);
const REGENERATED_FILE = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json|.*\.tsbuildinfo|\.DS_Store|.*\.log)$/;
const TEMP = /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/|\$TMPDIR\/?|\$\{TMPDIR[^}]*\}\/?)/;

/**
 * Whether `rm -r path` is safe to run without asking: under the temp folders, or build output or a
 * cache inside the project (node_modules, dist, .next, target, __pycache__, …: a build or an
 * install makes them again, and agents clear them all day). Anything else, an unknown variable or a
 * glob at the top, `..`, your home, the project itself: not safe.
 */
export function safeToRemove(path, cwd = "") {
  if (!path) return false;
  if (TEMP.test(path) && !path.includes("..")) return true;
  let rel = path;
  if (path.startsWith("/")) {
    if (!cwd || !path.startsWith(`${cwd.replace(/\/+$/, "")}/`)) return false;
    rel = path.slice(cwd.replace(/\/+$/, "").length + 1);
  }
  if (/^[~$]/.test(rel) || rel.includes("$")) return false;
  const parts = rel.split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.includes("..")) return false;
  // A lock file or a log, made again by an install or a run.
  if (parts.length === 1 && REGENERATED_FILE.test(parts[0])) return true;
  // A folder that's build output or a cache somewhere in it (packages/*/node_modules), but never a
  // glob at the top (*/dist could be anything).
  if (/[*?[]/.test(parts[0])) return false;
  return parts.some((p) => REGENERATED.has(p));
}

function rmRule(args, { hit, ctx }) {
  let recursive = false;
  const paths = [];
  let opts = true;
  for (const a of args) {
    if (opts && a === "--") opts = false;
    else if (opts && a.startsWith("--")) recursive ||= a === "--recursive";
    else if (opts && /^-[a-zA-Z]+$/.test(a)) recursive ||= /[rR]/.test(a);
    else paths.push(a);
  }
  if (!recursive || !paths.length) return;
  const risky = paths.filter((p) => !safeToRemove(p, ctx.cwd));
  if (!risky.length) return;
  const shown = risky.length === 1 ? risky[0] : `${risky[0]} and ${risky.length - 1} more`;
  hit("deletes", "rm -r", `delete ${shown} and everything in it`);
}

function findRule(args, { hit }) {
  if (args.includes("-delete")) return hit("deletes", "find -delete", "delete files found by find");
  const exec = args.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok");
  if (exec >= 0 && basename(args[exec + 1] ?? "") === "rm" && args.slice(exec + 2).some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive"))
    hit("deletes", "find -exec rm -r", "delete folders found by find");
}

export const FILE_RULES = {
  rm: rmRule,
  find: findRule,
  shred: (_args, { hit }) => hit("deletes", "shred", "destroy files"),
  srm: (_args, { hit }) => hit("deletes", "srm", "destroy files"),
  dd: (args, { hit }) => args.some((a) => /^of=\/dev\//.test(a)) && hit("deletes", "dd to a disk", "write over a disk"),
  diskutil: (args, { hit }) => args.some((a) => /^(erase|partition|zero|secureErase|reformat)/i.test(a)) && hit("deletes", "diskutil erase", "erase a disk"),
  mkfs: (_args, { hit }) => hit("deletes", "mkfs", "format a disk"),
};

// ── Databases ────────────────────────────────────────────────────────────────

export const SQL_DROP = /\b(drop\s+(table|database|schema|view|materialized\s+view|collection|keyspace)|truncate\s+(table\s+)?[\w"`[]|delete\s+from\s+[\w."`[\]]+\s*(;|$|\)|'|"))/i;
function sqlRule(args, { hit, cmd }) {
  const text = `${args.join(" ")}\n${cmd.heredoc ?? ""}`;
  if (SQL_DROP.test(text)) hit("deletes", "sql drop", /delete\s+from/i.test(text) && !/\bdrop\b|\btruncate\b/i.test(text) ? "delete every row of a table" : "drop a database table");
}

export const DATA_RULES = {
  psql: sqlRule,
  mysql: sqlRule,
  mariadb: sqlRule,
  sqlite3: sqlRule,
  sqlite: sqlRule,
  duckdb: sqlRule,
  "clickhouse-client": sqlRule,
  clickhouse: sqlRule,
  cockroach: sqlRule,
  turso: sqlRule,
  mongosh: (args, { hit, cmd }) => /dropDatabase\(|\.drop\(\)|deleteMany\(\s*\{\s*\}\s*\)/.test(`${args.join(" ")} ${cmd.heredoc ?? ""}`) && hit("deletes", "mongo drop", "drop a database collection"),
  mongo: (args, ctx) => DATA_RULES.mongosh(args, ctx),
  "redis-cli": (args, { hit }) => args.some((a) => /^(flushall|flushdb)$/i.test(a)) && hit("deletes", "redis flush", "wipe a Redis database"),
  dropdb: (_args, { hit }) => hit("deletes", "dropdb", "drop a database"),
  prisma: (args, { hit }) => {
    const line = args.join(" ");
    if (/\bmigrate reset\b/.test(line) || /\bdb push\b.*--(force-reset|accept-data-loss)/.test(line)) hit("deletes", "prisma reset", "reset the database and lose its data");
    else if (/\bmigrate deploy\b/.test(line)) hit("posts", "prisma migrate deploy", "apply database migrations");
  },
  rails: (args, { hit }) => args.some((a) => /^db:(drop|reset|schema:load|purge)$/.test(a)) && hit("deletes", "rails db:drop", "drop the database"),
  rake: (args, ctx) => (args.some((a) => /^db:(drop|reset|schema:load|purge)$/.test(a)) ? ctx.hit("deletes", "rake db:drop", "drop the database") : targets("rake")(args, ctx)),
  php: (args, ctx) => (args[0] === "artisan" && args.some((a) => /^(migrate:fresh|migrate:reset|db:wipe)$/.test(a)) ? ctx.hit("deletes", "artisan wipe", "wipe the database") : inlineRule(args, ctx)),
};
