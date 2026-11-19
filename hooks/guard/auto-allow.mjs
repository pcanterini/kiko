// Kiko allows a permission prompt by itself when the call only reads (src/core/auto-allow.ts; the
// setting "Allow read-only commands", on by default). Why, 2026-11-12: one question about a release
// brought six spoken prompts in a minute, every one a read.
//
// It fails closed (since 2026-11-19, after a security review found the old parser could be fooled
// into allowing anything: `$'…'`, zsh's `=(…)` and glob qualifiers, `sed -e'w …'`, globs that turn
// into flags, git run on a repo's planted config). Decided here in code, never by a model:
//   - Its own small lexer (lex below), not the safety gate's parser: it reads plain words, '…' and
//     "…" without $ ` or \-escapes, and the operators ; && || | and newlines. Anything else either
//     shell (bash or zsh, the user's) gives a meaning to asks: $ expansions of any kind ($'…', $"…",
//     $(…), $VAR), backticks, ( ) and process substitution, every redirection but a last 2>/dev/null
//     or 2>&1 on a command (STDERR: never >/dev/null, &>, 1>, 2>file), [ ] globs and braces, #, !,
//     ^, a backslash outside double quotes, a ~ that isn't a path's start, a lone &, zsh's =cmd,
//     unclosed quotes, control characters. * and ? only as ls, cat, head or wc's files
//     (GLOB_READERS), each match checked (globProblem).
//   - Every command in it is a known reader (READERS), each with the flags it may take listed (an
//     allowlist, never a denylist); any other flag asks. No eval, source, exec, sh -c, xargs, env,
//     curl, awk, no VAR=x before a command, no alias or function.
//   - Every path in it is inside the session's own folder (its cwd) or ~/git (the user's other
//     projects), with no `..`, no link on the way and nothing but printable ASCII; with no cwd
//     known, no absolute or ~ path and no `..`. A session started in the home folder (or /) can
//     have only ~/git paths. A cd moves where relative paths start only when it surely ran and
//     only what runs if it did follows (&&); after any other, no path. Never a secret's path
//     (SECRET_*): keys, tokens, .env files, a .git/config with a credential; a recursive search
//     looks for one first, whatever file filter it has.
//   - git only from the session's own checkout: no -C, -c, --git-dir, --work-tree, no cd before it,
//     and never when the repo's own config names a program git runs on a read (core.fsmonitor,
//     diff.external, textconv, filters, gpg) or its hooks have post-index-change.
//   - Then the safety gate's rules (../guard.mjs), on or off: anything they flag asks.
// Read, Grep, Glob and LS prompts: the same path rules (the session's folder or ~/git, no secrets).
// Every other tool asks as before.
//
// Imports only node:fs, node:os, node:path and the gate's own files: the hooks may run it too, one day.
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkCommand } from "../guard.mjs";

/** The longest command looked at: the hooks cut longer fields (lib.mjs MAX_STRING), and a cut one can't be read for sure. */
const MAX_COMMAND = 2000;

// ── Secrets ─────────────────────────────────────────────────────────────────

/** A path segment that is, or holds, a secret: keys, tokens, credentials, shell history. */
const SECRET_SEGMENT = [
  /^\.env(?!\.(example|sample|template|dist|defaults)$)/i, // .env, .env.local, .env-prod, .envrc (not .env.example)
  /^\.dev\.vars/i, // Cloudflare's local secrets
  /^kubeconfig/i,
  /\.token$|^token\.json$|^firebase-adminsdk.*\.json$/i,
  /^\.(ssh|gnupg|aws|azure|kube|docker|password-store|secrets?|gcloud|terraform\.d|wrangler|m2|gradle|cargo|codex|oci|aspnet|vault|op|1password)$/i,
  /^\.(netrc|_netrc|npmrc|pypirc|git-credentials|pgpass|my\.cnf|vault-token|boto|s3cfg|dockercfg|htpasswd|yarnrc|yarnrc\.yml|gem|pgpass|claude\.json|credentials\.json)$/i,
  /_history$|^\.history$|^\.lesshst$|^\.viminfo$/i,
  // credentials, secrets.json, .credentials.json: not code or docs named so (secret.ts, credentials.md).
  /^\.?(credentials?|secrets?)(?!.*\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|rb|go|rs|swift|kt|java|c|h|cc|cpp|m|php|md|mdx|html|css|scss|sh)$)([._-].*)?$/i,
  /^auth\.json$/i, // ~/.codex/auth.json, composer's
  /^hosts\.yml$/i, // gh's tokens (~/.config/gh/hosts.yml)
  /^Keychains?$/,
  /^(Cookies|Login Data|Web Data|Local State)$/,
  /^id_(rsa|dsa|ecdsa|ed25519|xmss)/i,
  /\.(pem|key|p8|p12|pfx|jks|keystore|keychain|keychain-db|ppk|asc|gpg|kdbx|mobileprovision|tfvars|tfstate)$/i,
  /^service[-_]?account.*\.json$/i,
  /^[^.].*\.env$/i, // prod.env, local.env
  /^\.mcp\.json$|^settings\.local\.json$|^\.sentryclirc$|^(gradle|local)\.properties$|^database\.ya?ml$/i,
];
/** Folders under ~/.config that hold tokens (gh, gcloud, 1Password's CLI, …) or Kiko's own keys and settings. */
const SECRET_CONFIG = /^(gh|gcloud|op|hub|kiko|kiko-dev|stripe|vercel|netlify|fly|doctl|heroku|rclone|configstore|gh-copilot|github-copilot|sops|age)$/i;

/** What in a path (or a path-like word) names a secret, if anything ("~/.ssh/id_rsa"). */
export function secretIn(text) {
  if (typeof text !== "string") return null;
  // APFS takes K (the Kelvin sign) as k, ſ as s: their plain letters are what's checked.
  text = text.normalize("NFKC");
  // A path, a glob's alternatives (`src/{a,.env}`), git's `HEAD:path`: each part's segments.
  for (const token of text.split(/[{},:]+/)) {
    const segments = token.split("/");
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      // A hidden name globbed (`~/.s*`, `.*`), or a key's (`id_*`): it could be any of them.
      if (/^(\.|id_)[^/]*[*?[]/.test(s)) return token;
      if (SECRET_SEGMENT.some((re) => re.test(s))) return token;
      if (segments[i - 1] === ".config" && SECRET_CONFIG.test(s)) return token;
    }
  }
  return null;
}

/** Names a glob could pick that are secrets: a Grep glob that matches any of these asks. */
const SECRET_SAMPLES = [
  ".env",
  ".env.local",
  ".envrc",
  "id_rsa",
  "id_ed25519",
  "server.pem",
  "server.key",
  "credentials",
  "credentials.json",
  ".npmrc",
  ".netrc",
  "secrets.json",
  "cert.p12",
  "auth.json",
];

/** Whether a glob's last part could pick a secret's file (`*`, `*.pem`, `.e*`): never for `*.ts`. */
function globPicksSecret(glob) {
  const last = glob.split("/").pop() ?? "";
  if (secretIn(last)) return true;
  let re = "";
  for (let i = 0; i < last.length; i++) {
    const c = last[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "{") re += "(";
    else if (c === "}") re += ")";
    else if (c === "," && re.includes("(")) re += "|";
    else if (c === "[") {
      const end = last.indexOf("]", i);
      if (end < 0) return true;
      re += last.slice(i, end + 1).replace(/\\/g, "\\\\");
      i = end;
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  try {
    const r = new RegExp(`^${re}$`, "i");
    return SECRET_SAMPLES.some((s) => r.test(s));
  } catch {
    return true;
  }
}

// ── Its words: a lexer that knows only what it can read for sure ─────────────

/** Unquoted characters that are only themselves in bash and zsh (`~` is checked on its own). */
const PLAIN = /[A-Za-z0-9_\-.,/:@%+=]/;

/** Why each other unquoted character asks. */
function unquotedProblem(c) {
  if (c === "$") return "a $ expansion";
  if (c === "`") return "a command substitution";
  if (c === "(" || c === ")") return "brackets (a subshell, substitution or glob qualifier)";
  if (c === "<" || c === ">") return "a redirection";
  if (c === "[" || c === "]") return "a glob";
  if (c === "{" || c === "}") return "braces";
  if (c === "#") return "a # (a comment, or a zsh glob)";
  if (c === "\\") return "a backslash";
  if (c === "!") return "a !";
  if (c === "^") return "a ^ (a zsh glob)";
  if (c === "&") return "a & (in the background)";
  if (c === "~") return "a ~ inside a word";
  if (c === "=") return "a word starting with = (zsh runs it)";
  return "a character it doesn't read";
}

/**
 * The only redirections read: stderr thrown away or sent where stdout goes, last on a simple command
 * (`ls x 2>/dev/null | head`, `git log 2>&1`). Matched only where a word would start, unquoted, and
 * only when an operator, a blank or the end follows: `2>/dev/nullx`, `12>&1`, `x2>&1` don't match,
 * and their `>` asks as any other redirection does.
 */
const STDERR = /^2>(?:&1|\/dev\/null|[ \t]+\/dev\/null)(?=$|[ \t\n;|&])/;

/**
 * `src` as simple commands, each a list of words (`{ text, tilde, quoted, glob }`: its value, quotes
 * off; whether it starts with an unquoted ~; has quotes; has an unquoted * or ?), or `{ bad }` with
 * why it can't be read for sure. A STDERR redirection is dropped from its command's words (nothing
 * may follow it in that command).
 */
export function lex(src) {
  const commands = [];
  const ops = []; // the operator after each command: ";" (or a newline), "&&", "||", "|", or null (the end)
  let words = [];
  let word = null; // { text, tilde, quoted, glob }
  let afterOp = false; // after | && ||: a command must follow
  let redirected = false; // this command's STDERR seen: only an operator or the end may follow
  let late = false; // a word started after it
  const finish = () => {
    if (word !== null) words.push(word);
    word = null;
    redirected = false;
    if (!words.length) return false;
    commands.push(words);
    words = [];
    return true;
  };
  const add = (text, quoted, glob = false) => {
    if (word === null && redirected) late = true;
    word = { text: (word?.text ?? "") + text, tilde: word?.tilde ?? false, quoted: (word?.quoted ?? false) || quoted, glob: (word?.glob ?? false) || glob };
    afterOp = false;
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    if (late) return { bad: "a word after a redirection" };
    const c = src[i];
    const code = c.charCodeAt(0);
    if (c === "2" && word === null) {
      const m = src.slice(i).match(STDERR);
      if (m) {
        if (!words.length) return { bad: "a redirection with no command" };
        if (redirected) return { bad: "a second redirection" };
        redirected = true;
        i += m[0].length;
        continue;
      }
    }
    if (c === " " || c === "\t") {
      if (word !== null) words.push(word);
      word = null;
      i++;
      continue;
    }
    if (c === "\n" || c === ";") {
      if (src[i + 1] === ";" && c === ";") return { bad: "a ;;" };
      // `ls |` then a newline (bash and zsh read on), `; ls`, `ls; ;`: asks.
      if (finish()) ops.push(";");
      else if (afterOp || c === ";") return { bad: "an operator with no command" };
      afterOp = false;
      i++;
      continue;
    }
    if (c === "|" || c === "&") {
      if (c === "&" && src[i + 1] !== "&") return { bad: unquotedProblem("&") };
      if (c === "|" && src[i + 1] === "&") return { bad: "a |&" };
      const op = c === "|" && src[i + 1] !== "|" ? 1 : 2;
      if (!finish()) return { bad: "an operator with no command" };
      ops.push(op === 1 ? "|" : c === "&" ? "&&" : "||");
      afterOp = true;
      i += op;
      continue;
    }
    if (code < 0x20 || code === 0x7f) return { bad: "a control character" };
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return { bad: "a quote isn't closed" };
      const text = src.slice(i + 1, end);
      if (/[\x00-\x1f\x7f]/.test(text)) return { bad: "a control character in quotes" };
      // zsh with RC_QUOTES reads '' inside quotes as a quote: 'a''b' is a'b there, ab in bash.
      if (src[end + 1] === "'") return { bad: "quotes back to back" };
      add(text, true);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let text = "";
      i++;
      while (i < n && src[i] !== '"') {
        const d = src[i];
        const dc = d.charCodeAt(0);
        if (d === "$") return { bad: "a $ expansion" };
        if (d === "`") return { bad: "a command substitution" };
        if (d === "!") return { bad: "a ! in quotes" };
        if (dc < 0x20 || dc === 0x7f) return { bad: "a control character in quotes" };
        // A backslash is special in double quotes only before $ ` " \ and a newline: there, ask.
        if (d === "\\" && '$`"\\\n'.includes(src[i + 1] ?? "$")) return { bad: "an escape in quotes" };
        text += d;
        i++;
      }
      if (i >= n) return { bad: "a quote isn't closed" };
      add(text, true);
      i++;
      continue;
    }
    if (c === "~") {
      // A path's start (~ or ~/…), or git's HEAD~3: anything else (~user, ~+, a=~/x) asks.
      if (word === null) {
        const next = src[i + 1] ?? "";
        if (next !== "/" && next !== "" && !/[ \t\n;|&]/.test(next)) return { bad: "a ~ that isn't the home folder" };
        add("~", false);
        word.tilde = true;
        i++;
        continue;
      }
      const m = src.slice(i).match(/^~\d*(?=$|[ \t\n;|&]|\.\.)/);
      if (!word.quoted && /[A-Za-z0-9_]$/.test(word.text) && m) {
        add(m[0], false);
        i += m[0].length;
        continue;
      }
      return { bad: unquotedProblem("~") };
    }
    if (code > 0x7f) return { bad: "a character it doesn't read" };
    // * and ? (never [ ]): only ls, cat, head and wc take a word with them, each match checked (globProblem).
    if (c === "*" || c === "?") {
      add(c, false, true);
      i++;
      continue;
    }
    if (!PLAIN.test(c)) return { bad: unquotedProblem(c) };
    if (c === "=" && word === null) return { bad: unquotedProblem("=") };
    add(c, false);
    i++;
  }
  if (late) return { bad: "a word after a redirection" };
  if (finish()) ops.push(null);
  else if (afterOp) return { bad: "an operator with no command" };
  if (!commands.length) return { bad: "nothing to run" };
  return { commands, ops };
}

// ── Paths: inside the session's folder (or ~/git), never a secret ────────────

/** A folder that holds the home folder (or is it): a session started there has no project to stay in. */
const wideFolder = (dir, home) => dir === "/" || dir === home || home.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** `p`, symlinks followed as far as it exists (a path not there yet: its nearest folder that is). Only the session's folder and ~/git: paths in them never follow a link (pathProblem). */
function realOf(p) {
  const tail = [];
  for (let at = p; ; ) {
    try {
      return join(realpathSync(at), ...tail.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return p;
      tail.push(basename(at));
      at = up;
    }
  }
}

const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The session's folder, as the checks use it: null when unknown (not an absolute path). */
function sessionOf(cwd, home) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
  const dir = resolve(cwd);
  const real = realOf(dir);
  return { dir, real, wide: wideFolder(dir, home) || wideFolder(real, home) || wideFolder(real, realOf(home)) };
}

/**
 * ~/git, where the user's other projects are: read there by the same rules as in the session's own
 * folder (no .., no link on the way, no secret's path; a recursive search looks for secrets first).
 * null when there's none, or it is (or is a link to) a folder that holds the home folder.
 */
function projectsOf(home) {
  if (typeof home !== "string" || !isAbsolute(home)) return null;
  const dir = join(resolve(home), "git");
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const real = realOf(dir);
  return wideFolder(dir, home) || wideFolder(real, home) || wideFolder(real, realOf(home)) ? null : { dir, real };
}

/** The checks' context: the session's folder, where relative paths start, ~ and ~/git. */
function contextOf(cwd, home = homedir()) {
  const session = sessionOf(cwd, home);
  return { session, at: session?.dir ?? "", moved: false, lost: false, home, projects: projectsOf(home) };
}

/** A word as the path the shell opens: a leading ~ is the home folder. */
const expand = (word, ctx) => (word.tilde ? ctx.home + word.text.slice(1) : word.text);

/** The first link on the way from `dir` down to `full` (a path inside it), or null; never followed. */
function linkOnTheWay(dir, full) {
  let at = dir;
  for (const part of relative(dir, full).split(sep).filter(Boolean)) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      return null; // not there (yet): nothing further to follow
    }
    if (st.isSymbolicLink()) return at;
  }
  return null;
}

/** `full` written with `root`'s real path (/private/var/… for /var/…): the same place under `root`'s own. */
const asWritten = (full, root) => (!inside(full, root.dir) && inside(full, root.real) ? join(root.dir, relative(root.real, full)) : full);

/**
 * Where `word` (a path an allowed command reads) is: `{ root, full }`, the folder it's allowed in
 * (the session's, or ~/git) and the path as written under it; or `{ bad }`. Why not: a `..` in it
 * (the kernel takes `link/..` as the link's target's parent, which no lexical check sees), outside
 * both folders, through a link (never followed, not even to check it: a link to /net mounts a
 * share), a secret's, or, with no folder known, absolute or ~. `ctx.at`: where it's relative to (the
 * session's folder, or where a cd before it surely went); after any other cd (bash's CDPATH, zsh's
 * `cd +1` could have gone anywhere), no path at all. `ctx.projects` null: the session's folder only.
 */
function placeOf(word, ctx) {
  if (word.glob) return { bad: `a glob (${clip(word.text)})` };
  const text = expand(word, ctx);
  if (!text) return { bad: "an empty path" };
  // Quoted or a tool's: APFS takes some letters as others (K for k), and no check here reads them so.
  if (/[^\x20-\x7e]/.test(text)) return { bad: `a path with a character it doesn't read (${clip(word.text)})` };
  if (text.split("/").includes("..")) return { bad: `a path with .. in it (${clip(word.text)})` };
  if (ctx.lost) return { bad: "a path after a cd it can't follow for sure" };
  const s = ctx.session;
  if (!s) {
    if (word.tilde || isAbsolute(text)) return { bad: `a path outside the project (${clip(word.text)})` };
    const secret = secretIn(text);
    return secret ? { bad: `names a secret (${clip(secret)})` } : { root: null, full: text };
  }
  const resolved = resolve(ctx.at, text);
  let root = null;
  if (!s.wide && inside(asWritten(resolved, s), s.dir)) root = s;
  else if (ctx.projects && inside(asWritten(resolved, ctx.projects), ctx.projects.dir)) root = ctx.projects;
  if (!root) return { bad: s.wide ? "the session's folder is the home folder (or holds it)" : `a path outside the project (${clip(word.text)})` };
  const full = asWritten(resolved, root);
  if (linkOnTheWay(root.dir, full)) return { bad: `a path through a link (${clip(word.text)})` };
  const rel = relative(root.dir, full);
  const secret = secretIn(rel);
  if (secret) return { bad: `names a secret (${clip(secret)})` };
  // Any file named config (any case: APFS opens .GIT/CONFIG too): a bare repo's, a submodule's, a worktree's.
  if (CONFIG_FILE.test(basename(full)) && fileHasCredential(full)) return { bad: `names a secret (${clip(word.text)}: a credential in it)` };
  return { root, full };
}

/** A file git could read as a config (any case). */
const CONFIG_FILE = /^config(\.worktree)?$/i;

/** Whether a git config holds a credential: a URL with a user or token in it (https://x:token@…), an extraheader, a password or token. */
const configHasCredential = (text) => /\bhttps?:\/\/[^\s/@"]+@/i.test(text) || /^\s*(extraheader|password|token)\s*=/im.test(text);
/** A global git config that holds a credential, or includes another file (which this doesn't read). */
function globalConfigProblem(path) {
  try {
    const text = readFileSync(path, "utf8");
    return configHasCredential(text) || /^\s*\[\s*include/im.test(text);
  } catch {
    return false;
  }
}
function fileHasCredential(path) {
  try {
    return configHasCredential(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/** Why `word` can't be allowed as a path (placeOf), or null. */
const pathProblem = (word, ctx) => placeOf(word, ctx).bad ?? null;

/** Returned by secretInTree when it couldn't look at everything. */
const TOO_BIG = Symbol("too big");

/**
 * A secret's file in the folder a recursive search reads (`grep -r KEY .` reads .env), looked for
 * at most a few thousand entries deep (node_modules and git's objects left out; every file named
 * config read for a credential): best effort, not proof. TOO_BIG when it ran out before the end.
 * `picks(name)`: whether the search's file filter (--include, -g, Grep's glob) could read a file so
 * named; a secret's folder (.kube, .docker) asks whatever the filter.
 */
function secretInTree(root, hidden = true, picks = () => true, budget = { left: 5000 }, inGit = false) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (--budget.left < 0) return TOO_BIG;
    if (!hidden && e.name.startsWith(".")) continue; // rg leaves hidden files out unless --hidden
    const path = join(root, e.name);
    if (secretIn(e.name) && (e.isDirectory() || picks(e.name))) return path;
    if (e.isFile() && CONFIG_FILE.test(e.name) && picks(e.name) && fileHasCredential(path)) return path;
    const git = inGit || e.name.toLowerCase() === ".git" || e.name.toLowerCase().endsWith(".git");
    if (e.isDirectory() && e.name !== "node_modules" && !(git && /^(objects|lfs)$/i.test(e.name))) {
      const found = secretInTree(path, hidden, picks, budget, git);
      if (found) return found;
    }
  }
  return null;
}

/** A file filter's globs (--include, -g, Grep's glob) as what names they could pick: more than they do (any [ ] { } part, any ? is anything). None: every name. */
function picksOf(globs) {
  const wanted = globs.filter((g) => g && !g.startsWith("!"));
  if (!wanted.length) return () => true;
  const esc = (t) => t.replace(/[.+^$()|\\[\]{}*?]/g, "\\$&");
  const res = wanted.map((g) => {
    const last = g.split("/").pop() || "*";
    let body = "";
    for (let i = 0; i < last.length; i++) {
      const c = last[i];
      const end = c === "[" ? last.indexOf("]", i + 2) : c === "{" ? last.indexOf("}", i) : -1;
      const inner = end > 0 ? last.slice(i + 1, end) : "";
      if (c === "{" && end > 0 && !/[[{*?\\]/.test(inner)) {
        body += `(${inner.split(",").map(esc).join("|")})`; // {ts,tsx}: exactly these
        i = end;
      } else if (c === "*" || c === "?" || c === "[" || c === "{") {
        body += ".*";
        if (end > 0) i = end;
        else if (c !== "*" && c !== "?") break; // an open [ or {: anything from here
      } else body += esc(c);
    }
    return new RegExp(`^${body}$`, "is");
  });
  return (name) => res.some((re) => re.test(name.normalize("NFKC")));
}

/**
 * pathProblem, and for a folder a recursive search reads, no secret's file in it. In ~/git outside
 * the session's folder, a folder too big to look through all of asks too (in the session's own, as
 * before, it's best effort).
 */
function searchedProblem(word, ctx, hidden = true, picks = () => true) {
  const place = placeOf(word, ctx);
  if (place.bad || !place.root) return place.bad ?? null;
  let dir = false;
  try {
    dir = statSync(place.full).isDirectory();
  } catch {}
  const found = dir ? secretInTree(place.full, hidden, picks) : null;
  if (found === TOO_BIG) return place.root === ctx.session ? null : `searches a folder too big to check for secrets (${clip(word.text)})`;
  return found ? `searches a folder with a secret in it (${clip(relative(place.root.dir, found) || found)})` : null;
}

/**
 * Why a glob (`ls *.md`, `cat src/*.ts`) can't be allowed, or null. Only * and ? in its last part
 * (its folder written out, no **), no quotes in it; then it is matched here, against every name in
 * that folder (hidden ones and any case too: more than bash or zsh would pick), and each match must
 * be a path allowed on its own (no link, no secret) whose name doesn't start with - (it would be
 * read as a flag). No match: the shell passes it as written or stops; nothing is read.
 */
function globProblem(word, ctx) {
  if (word.quoted) return `a glob with quotes in it (${clip(word.text)})`;
  const slash = word.text.lastIndexOf("/");
  const folder = slash < 0 ? "" : word.text.slice(0, slash + 1);
  const last = word.text.slice(slash + 1);
  if (/[*?]/.test(folder)) return `a glob in a folder's name (${clip(word.text)})`;
  if (!/^[A-Za-z0-9_.,:@%+=*?-]+$/.test(last) || last.includes("**")) return `a glob it doesn't read (${clip(word.text)})`;
  if (last.startsWith("-")) return `a glob that could be a flag (${clip(word.text)})`;
  const dirWord = { text: folder.replace(/\/+$/, "") || (folder ? "/" : "."), tilde: word.tilde && folder !== "", quoted: false, glob: false };
  if (word.tilde && !folder) return `a glob it doesn't read (${clip(word.text)})`;
  const place = placeOf(dirWord, ctx);
  if (place.bad) return place.bad;
  if (!place.root) return `a glob with the session's folder unknown (${clip(word.text)})`;
  let names;
  try {
    names = readdirSync(place.full);
  } catch {
    return `a glob in a folder it can't read (${clip(word.text)})`;
  }
  if (names.length > 5000) return `a glob in a folder too big to check (${clip(word.text)})`;
  // ? is one character to the shell (or one byte): any run of them here. Never . or .. (bash 3.2's .? and .* pick them).
  const re = new RegExp(`^${last.replace(/[.+^$()|\\{}[\]]/g, "\\$&").replace(/[*?]+/g, ".*")}$`, "is");
  if (last.startsWith(".") && (re.test(".") || re.test(".."))) return `a glob that picks . or .. (${clip(word.text)})`;
  for (const name of names) {
    if (!re.test(name)) continue;
    if (name.startsWith("-")) return `a glob that picks a name starting with - (${clip(name)})`;
    const p = pathProblem({ text: folder + name, tilde: word.tilde, quoted: false, glob: false }, ctx);
    if (p) return p;
  }
  return null;
}

const clip = (s) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);

// ── Arguments: each reader's flags, allowed by name ─────────────────────────

const NUM = /^[+-]?\d+[kKmMgGbB]?$/;
/** Any value: a pattern, a format (never a path the tool opens). */
const TEXT = "text";
/** A value read both as a value and, where a shell's other version of the tool takes it as a file, as a path. */
const PATHISH = "pathish";
const PATH = "path";

/**
 * A reader's arguments by its spec, or why not:
 *   short     letters it may take alone or together (-la)
 *   value     letters that take a value (`-n 5`, `-n5`): letter → NUM, TEXT, a RegExp, PATH or PATHISH
 *   long      `--name` it may take: true (no value), or how its `=value` (or next word) is checked
 *   num       -NUM (head -20, git log -5)
 *   optionalLong, optionalShort   those whose value is only ever attached (--color, git status -uno)
 *   permutes  flags may follow its files (git, rg); else a free-text value after them asks
 * Returns `{ positionals, flags: Set, values: Map }`, or `{ bad }`.
 */
function parseArgs(args, spec, ctx) {
  const positionals = [];
  const flags = new Set();
  const values = new Map();
  const check = (name, how, value) => {
    if (value === undefined) return `${spec.name} ${name} with nothing after it`;
    if (how === PATH || how === PATHISH) {
      const p = pathProblem(value, ctx);
      if (p) return p;
    } else if (how !== TEXT && !how.test(value.text)) return `${spec.name} ${name} ${clip(value.text)}`;
    values.set(name, [...(values.get(name) ?? []), value.text]);
    return null;
  };
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const t = a.text;
    if (ended || !t.startsWith("-") || t === "-") {
      positionals.push(a);
      continue;
    }
    if (t === "--") {
      if (spec.noDashes) return { bad: "a --" };
      ended = true;
      continue;
    }
    // A value in the next word after the files: BSD's tools read it as a file, GNU's as the value.
    // Only a number can be both safely.
    const late = positionals.length > 0 && !spec.permutes;
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq < 0 ? t : t.slice(0, eq);
      const how = spec.long?.[name];
      if (how === undefined) return { bad: `${spec.name} ${clip(name)}` };
      if (how === true) {
        if (eq >= 0) return { bad: `${spec.name} ${clip(t)}` };
        flags.add(name);
        continue;
      }
      if (late && eq < 0 && how !== NUM && !spec.optionalLong?.has(name)) return { bad: `${spec.name} ${name} after its files` };
      flags.add(name);
      const value = eq >= 0 ? { text: t.slice(eq + 1), tilde: false } : spec.optionalLong?.has(name) ? null : args[++i];
      if (value === null) continue;
      const bad = check(name, how, value);
      if (bad) return { bad };
      continue;
    }
    if (spec.num && /^-\d+$/.test(t)) {
      flags.add("-NUM");
      continue;
    }
    const cluster = t.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const ch = cluster[j];
      if (spec.short?.includes(ch)) {
        flags.add(`-${ch}`);
        continue;
      }
      const how = spec.value?.[ch];
      if (how === undefined) return { bad: `${spec.name} -${ch}` };
      const rest = cluster.slice(j + 1);
      if (late && !rest && how !== NUM && !spec.optionalShort?.has(ch)) return { bad: `${spec.name} -${ch} after its files` };
      flags.add(`-${ch}`);
      if (!rest && spec.optionalShort?.has(ch)) break;
      const bad = check(`-${ch}`, how, rest ? { text: rest, tilde: false } : args[++i]);
      if (bad) return { bad };
      break;
    }
  }
  return { positionals, flags, values };
}

/** Every word in `words` as a path (null when all are fine); `globs`: a glob's matches each checked (globProblem), else a glob asks. */
function pathsProblem(words, ctx, globs = false) {
  for (const w of words) {
    if (w.text === "-") continue; // stdin
    const p = w.glob && globs ? globProblem(w, ctx) : pathProblem(w, ctx);
    if (p) return p;
  }
  return null;
}

/**
 * A reader that takes files (none: stdin), each one checked; `dot`: no file means "." (a recursive
 * one); `globs`: its files may be globs (GLOB_READERS: none of its flags writes or runs anything).
 */
const files =
  (spec, { dot = () => false, max = Infinity, onlyFiles = false, globs = false } = {}) =>
  (args, ctx) => {
    const r = parseArgs(args, spec, ctx);
    if (r.bad) return r.bad;
    if (r.positionals.length > max) return `${spec.name} with more than ${max} file${max === 1 ? "" : "s"}`;
    if (!r.positionals.length && dot(r)) return pathProblem({ text: ".", tilde: false }, ctx);
    const bad = pathsProblem(r.positionals, ctx, globs);
    if (bad || !onlyFiles) return bad;
    if (!ctx.session) return `${spec.name} with the session's folder unknown`;
    // diff of two folders reads every file in them, links followed: files only.
    for (const w of r.positionals) {
      if (w.text === "-") continue;
      try {
        if (!statSync(resolve(ctx.at, expand(w, ctx))).isFile()) return `${spec.name} of what isn't a file (${clip(w.text)})`;
      } catch {
        return `${spec.name} of a file that isn't there (${clip(w.text)})`;
      }
    }
    return null;
  };

/** A reader whose words are only text, never files (echo, basename): its flags still listed. */
const textOnly = (spec) => (args, ctx) => {
  const r = parseArgs(args, { ...spec, noDashes: spec.noDashes ?? true }, ctx);
  return r.bad ?? null;
};

/** A reader that takes nothing but its flags (pwd, whoami). */
const bare = (spec) => (args, ctx) => {
  const r = parseArgs(args, { ...spec, noDashes: true }, ctx);
  if (r.bad) return r.bad;
  return r.positionals.length ? `${spec.name} ${clip(r.positionals[0].text)}` : null;
};

const COLOR = /^(auto|always|never|tty|if-tty|yes|no|force)$/;

/** grep (and ugrep, which Claude Code's shell runs as `grep`): flags both read the same way. */
const GREP = {
  name: "grep",
  short: "rnilLcvwxEFGhHoqsIabU",
  value: { A: NUM, B: NUM, C: NUM, m: NUM, e: TEXT },
  long: {
    "--include": TEXT,
    "--exclude": TEXT,
    "--exclude-dir": TEXT,
    "--color": COLOR,
    "--colour": COLOR,
    "--line-number": true,
    "--ignore-case": true,
    "--recursive": true,
    "--count": true,
    "--files-with-matches": true,
    "--files-without-match": true,
    "--invert-match": true,
    "--word-regexp": true,
    "--line-regexp": true,
    "--extended-regexp": true,
    "--fixed-strings": true,
    "--no-filename": true,
    "--with-filename": true,
    "--only-matching": true,
    "--quiet": true,
    "--silent": true,
    "--no-messages": true,
    "--max-count": NUM,
    "--context": NUM,
    "--after-context": NUM,
    "--before-context": NUM,
    "--regexp": TEXT,
  },
  optionalLong: new Set(["--color", "--colour"]),
};

/** A search: its pattern first (unless -e gave it), then files; recursive with none: ".". */
function search(spec, { patternFlags, recursive, filesOnly = () => false, globs = [], hidden = () => true }) {
  return (args, ctx) => {
    const r = parseArgs(args, spec, ctx);
    if (r.bad) return r.bad;
    for (const g of globs) for (const v of r.values.get(g) ?? []) if (globPicksSecret(v.replace(/^!/, ""))) return `a glob that could pick a secret (${clip(v)})`;
    const given = patternFlags.some((f) => r.flags.has(f)) || filesOnly(r);
    const paths = given ? r.positionals : r.positionals.slice(1);
    if (!given && !r.positionals.length) return `${spec.name} with no pattern`;
    // A file filter narrows which secrets it reads, never skips the look for them.
    const picks = picksOf(globs.flatMap((g) => r.values.get(g) ?? []));
    const each = recursive(r) ? (w, c) => searchedProblem(w, c, hidden(r), picks) : pathProblem;
    if (!paths.length && recursive(r)) return each({ text: ".", tilde: false }, ctx);
    for (const w of paths) {
      const p = w.text === "-" ? null : each(w, ctx);
      if (p) return p;
    }
    return null;
  };
}

const grep = search(GREP, { patternFlags: ["-e", "--regexp"], recursive: (r) => r.flags.has("-r") || r.flags.has("--recursive"), globs: ["--include"] });

const RG = {
  name: "rg",
  permutes: true,
  short: "nNiSslcwxFvoUHqI",
  value: { A: NUM, B: NUM, C: NUM, m: NUM, M: NUM, d: NUM, e: TEXT, g: TEXT, t: /^[\w+-]+$/, T: /^[\w+-]+$/ },
  long: {
    "--hidden": true,
    "--files": true,
    "--files-with-matches": true,
    "--files-without-match": true,
    "--count": true,
    "--count-matches": true,
    "--line-number": true,
    "--no-line-number": true,
    "--ignore-case": true,
    "--smart-case": true,
    "--case-sensitive": true,
    "--fixed-strings": true,
    "--word-regexp": true,
    "--line-regexp": true,
    "--invert-match": true,
    "--only-matching": true,
    "--multiline": true,
    "--no-heading": true,
    "--heading": true,
    "--with-filename": true,
    "--no-filename": true,
    "--trim": true,
    "--vimgrep": true,
    "--json": true,
    "--stats": true,
    "--quiet": true,
    "--column": true,
    "--no-messages": true,
    "--color": COLOR,
    "--type": /^[\w+-]+$/,
    "--type-not": /^[\w+-]+$/,
    "--glob": TEXT,
    "--iglob": TEXT,
    "--max-count": NUM,
    "--max-depth": NUM,
    "--max-columns": NUM,
    "--context": NUM,
    "--after-context": NUM,
    "--before-context": NUM,
    "--regexp": TEXT,
    "--sort": /^(path|modified|accessed|created|none)$/,
    "--sortr": /^(path|modified|accessed|created|none)$/,
  },
};
const rg = search(RG, {
  patternFlags: ["-e", "--regexp"],
  recursive: () => true,
  filesOnly: (r) => r.flags.has("--files"),
  globs: ["-g", "--glob", "--iglob"],
  hidden: (r) => r.flags.has("--hidden"),
});

/** find: its folders, then only these tests (no -exec, -delete, -fprint, -L …), each with its value checked. */
const FIND_TESTS = {
  "-print": null,
  "-print0": null,
  "-prune": null,
  "-empty": null,
  "-depth": null,
  "-ls": null,
  "-xdev": null,
  "-mount": null,
  "-o": null,
  "-or": null,
  "-a": null,
  "-and": null,
  "-not": null,
  "-true": null,
  "-false": null,
  "-name": TEXT,
  "-iname": TEXT,
  "-path": TEXT,
  "-ipath": TEXT,
  "-wholename": TEXT,
  "-iwholename": TEXT,
  "-regex": TEXT,
  "-iregex": TEXT,
  "-type": /^[fdlpsbc](,[fdlpsbc])*$/,
  "-maxdepth": NUM,
  "-mindepth": NUM,
  "-size": /^[+-]?\d+[ckwbMGTP]?$/,
  "-mtime": /^[+-]?\d+[smhdw]?$/,
  "-mmin": /^[+-]?\d+$/,
  "-atime": /^[+-]?\d+[smhdw]?$/,
  "-amin": /^[+-]?\d+$/,
  "-ctime": /^[+-]?\d+[smhdw]?$/,
  "-cmin": /^[+-]?\d+$/,
  "-newer": PATH,
  "-perm": /^[-+/]?([0-7]{3,4}|[ugoa]*[+=-][rwxst]+)$/,
  "-user": /^[\w.-]+$/,
  "-group": /^[\w.-]+$/,
  "-links": /^[+-]?\d+$/,
};
function find(args, ctx) {
  let i = 0;
  // BSD find's options before its folders: only these (-L follows links out of the project).
  while (i < args.length && /^-[EHPxs]+$/.test(args[i].text)) i++;
  const roots = [];
  while (i < args.length && !args[i].text.startsWith("-")) roots.push(args[i++]);
  const bad = roots.length ? pathsProblem(roots, ctx) : pathProblem({ text: ".", tilde: false }, ctx);
  if (bad) return bad;
  for (; i < args.length; i++) {
    const t = args[i].text;
    if (!Object.hasOwn(FIND_TESTS, t)) return `find ${clip(t)}`;
    const how = FIND_TESTS[t];
    if (how === null) continue;
    const value = args[++i];
    if (!value) return `find ${t} with nothing after it`;
    if (how === PATH) {
      const p = pathProblem(value, ctx);
      if (p) return p;
    } else if (how !== TEXT && !how.test(value.text)) return `find ${t} ${clip(value.text)}`;
  }
  return null;
}

/** sed: only `sed -n 'Np'` or `sed -n 'N,Mp'` (a few lines printed); any other script asks. */
function sed(args, ctx) {
  if (args[0]?.text !== "-n" || !/^(\d+|\$)(,(\d+|\$))?p$/.test(args[1]?.text ?? "")) return "sed other than sed -n 'N,Mp'";
  const rest = args.slice(2);
  if (rest.some((a) => a.text.startsWith("-") && a.text !== "-")) return "sed with flags after its script";
  return pathsProblem(rest, ctx);
}

/** jq: its filter can't read the environment or load modules; then files. */
const JQ = {
  name: "jq",
  short: "rcesnSjaMC",
  long: {
    "--raw-output": true,
    "--compact-output": true,
    "--exit-status": true,
    "--slurp": true,
    "--null-input": true,
    "--sort-keys": true,
    "--join-output": true,
    "--ascii-output": true,
    "--monochrome-output": true,
    "--color-output": true,
    "--tab": true,
    "--indent": NUM,
  },
};
function jq(args, ctx) {
  const r = parseArgs(args, JQ, ctx);
  if (r.bad) return r.bad;
  const [filter, ...rest] = r.positionals;
  if (!filter) return "jq with no filter";
  if (/\benv\b|\$ENV|\$__|\bimport\b|\binclude\b|\binput_filename\b|\bget_search_list\b|\bmodulemeta\b/.test(filter.text)) return "jq reads the environment or loads a module";
  return pathsProblem(rest, ctx);
}

/** test: `test -d dist`, `test -n word` only. */
function testCmd(args, ctx) {
  if (args.length !== 2 || !/^-[edfrswxLhSnz]$/.test(args[0].text)) return "test other than test -X path";
  if (args[0].text === "-n" || args[0].text === "-z") return null;
  return pathProblem(args[1], ctx);
}

/**
 * cd: one folder in the project (or ~/git). Only `cd ./sub`, an absolute path and `~/…` are sure to
 * land there (bash's CDPATH is searched first for any other, and zsh reads `+1`/`-1` as its folder
 * stack): after any other, the commands that follow may take no path at all. git after any cd asks.
 */
function cd(args, ctx) {
  if (args.length !== 1 || /^[-+]/.test(args[0].text)) return "cd other than cd <folder>";
  if (!ctx.session) return "cd with the session's folder unknown";
  const p = pathProblem(args[0], ctx);
  if (p) return p;
  const to = resolve(ctx.at, expand(args[0], ctx));
  try {
    if (!statSync(to).isDirectory()) return "cd to what isn't a folder";
    // One cd can't enter fails, and after `;` the next command reads where it was, which wasn't checked.
    accessSync(to, constants.X_OK);
  } catch {
    return "cd to a folder that isn't there (or can't be entered)";
  }
  // Where it lands is sure only when it runs (every command before it joined by &&) and only what
  // runs if it did follows (&& after it, or nothing): `false && cd x; cat y`, `cd x | cat y` and
  // `cd x || cat y` read where the shell was. commandReadOnly loses the folder at a ; or || after it.
  const sure = /^\.\.?\//.test(args[0].text) || args[0].text === "." || args[0].tilde || args[0].text.startsWith("/");
  if (sure && ctx.sure && (ctx.next === "&&" || ctx.next === null)) ctx.at = to;
  else ctx.lost = true;
  ctx.moved = true;
  return null;
}

/** date: only `date`, `date -u` and `date +FORMAT` (no setting it, no file's date). */
function date(args) {
  for (const a of args) if (!(a.text === "-u" || a.text === "-R" || a.text.startsWith("+"))) return `date ${clip(a.text)}`;
  return null;
}

// ── git ─────────────────────────────────────────────────────────────────────

/** Flags of git log, show, whatchanged and diff that only shape what's shown. */
const LOG_FLAGS = {
  "--oneline": true,
  "--all": true,
  "--graph": true,
  "--decorate": true,
  "--no-decorate": true,
  "--stat": /^\d+(,\d+)*$/,
  "--shortstat": true,
  "--numstat": true,
  "--name-only": true,
  "--name-status": true,
  "--abbrev-commit": true,
  "--no-abbrev-commit": true,
  "--first-parent": true,
  "--no-merges": true,
  "--merges": true,
  "--reverse": true,
  "--patch": true,
  "--no-patch": true,
  "--follow": true,
  "--left-right": true,
  "--cherry-pick": true,
  "--topo-order": true,
  "--date-order": true,
  "--relative-date": true,
  "--no-color": true,
  "--full-history": true,
  "--simplify-by-decoration": true,
  "--summary": true,
  "--cached": true,
  "--staged": true,
  "--minimal": true,
  "--ignore-all-space": true,
  "--ignore-space-change": true,
  "--ignore-blank-lines": true,
  "--quiet": true,
  "--exit-code": true,
  "--no-ext-diff": true,
  "--no-textconv": true,
  "--raw": true,
  "--compact-summary": true,
  "--full-index": true,
  "--source": true,
  "--boundary": true,
  "--ancestry-path": true,
  "--word-diff": /^(color|plain|porcelain|none)$/,
  "--color": COLOR,
  "--format": TEXT,
  "--pretty": TEXT,
  "--date": TEXT,
  "--since": TEXT,
  "--after": TEXT,
  "--until": TEXT,
  "--before": TEXT,
  "--author": TEXT,
  "--committer": TEXT,
  "--grep": TEXT,
  "--max-count": NUM,
  "--skip": NUM,
  "--abbrev": NUM,
  "--unified": NUM,
  "--stat-width": NUM,
  "--diff-filter": /^[ACDMRTUXBacdmrtuxb*]+$/,
  "--branches": TEXT,
  "--tags": TEXT,
  "--remotes": TEXT,
  "--find-renames": NUM,
  "--dirstat": TEXT,
  "--check": true,
};
const LOG = {
  short: "pisuwbERFM",
  value: { n: NUM, U: NUM, S: TEXT, G: TEXT, L: TEXT },
  long: LOG_FLAGS,
  num: true,
  optionalLong: new Set(["--stat", "--pretty", "--decorate", "--color", "--word-diff", "--branches", "--tags", "--remotes", "--find-renames", "--dirstat", "--abbrev"]),
};

/** git's commands that only look, each with the flags it may take; their other words are revisions or paths, checked as paths. */
const GIT = {
  status: {
    short: "sbvz",
    value: { u: /^(no|normal|all)$/ },
    optionalShort: new Set(["u"]),
    long: {
      "--short": true,
      "--branch": true,
      "--porcelain": /^v?[12]$/,
      "--long": true,
      "--untracked-files": /^(no|normal|all)$/,
      "--ahead-behind": true,
      "--no-ahead-behind": true,
      "--show-stash": true,
      "--ignored": true,
    },
    optionalLong: new Set(["--porcelain", "--untracked-files"]),
  },
  log: LOG,
  show: LOG,
  diff: LOG,
  "rev-parse": {
    short: "q",
    long: {
      "--abbrev-ref": true,
      "--short": NUM,
      "--show-toplevel": true,
      "--git-dir": true,
      "--git-common-dir": true,
      "--absolute-git-dir": true,
      "--is-inside-work-tree": true,
      "--is-inside-git-dir": true,
      "--is-bare-repository": true,
      "--verify": true,
      "--quiet": true,
      "--symbolic-full-name": true,
      "--show-prefix": true,
      "--show-cdup": true,
      "--all": true,
      "--branches": true,
      "--tags": true,
    },
    optionalLong: new Set(["--short"]),
  },
  "ls-files": {
    short: "cdmostvz",
    long: {
      "--others": true,
      "--modified": true,
      "--deleted": true,
      "--cached": true,
      "--exclude-standard": true,
      "--stage": true,
      "--full-name": true,
      "--error-unmatch": true,
      "--directory": true,
      "--ignored": true,
      "--unmerged": true,
    },
  },
  "ls-tree": { short: "rdtlz", long: { "--name-only": true, "--name-status": true, "--full-name": true, "--full-tree": true, "--long": true, "--abbrev": NUM }, optionalLong: new Set(["--abbrev"]) },
  blame: {
    short: "wsletpbcfn",
    value: { L: TEXT },
    long: { "--porcelain": true, "--line-porcelain": true, "--date": TEXT, "--root": true, "--show-stats": true, "--show-email": true, "--show-name": true, "--show-number": true, "--abbrev": NUM },
    optionalLong: new Set(["--abbrev"]),
  },
  shortlog: { short: "sne", long: { "--summary": true, "--numbered": true, "--email": true, "--all": true, "--no-merges": true, "--since": TEXT, "--until": TEXT, "--author": TEXT } },
  describe: {
    long: { "--tags": true, "--always": true, "--long": true, "--exact-match": true, "--all": true, "--contains": true, "--abbrev": NUM, "--match": TEXT, "--exclude": TEXT, "--first-parent": true },
  },
  "merge-base": { long: { "--is-ancestor": true, "--all": true, "--fork-point": true, "--octopus": true, "--independent": true } },
  "rev-list": {
    value: { n: NUM },
    long: {
      "--count": true,
      "--all": true,
      "--max-count": NUM,
      "--since": TEXT,
      "--until": TEXT,
      "--left-right": true,
      "--first-parent": true,
      "--no-merges": true,
      "--merges": true,
      "--reverse": true,
      "--abbrev-commit": true,
      "--oneline": true,
      "--branches": true,
      "--tags": true,
      "--remotes": true,
    },
    num: true,
  },
  "show-ref": { short: "sq", long: { "--heads": true, "--tags": true, "--hash": true, "--verify": true, "--quiet": true, "--abbrev": NUM }, optionalLong: new Set(["--abbrev"]) },
  "for-each-ref": { long: { "--format": TEXT, "--sort": TEXT, "--count": NUM, "--points-at": TEXT, "--merged": TEXT, "--no-merged": TEXT, "--contains": TEXT, "--no-contains": TEXT } },
  "name-rev": { long: { "--name-only": true, "--tags": true, "--always": true, "--no-undefined": true, "--refs": TEXT } },
  "cat-file": { short: "tspe" },
  grep: {
    short: "nilLcwvEFhHI",
    value: { e: TEXT, A: NUM, B: NUM, C: NUM, m: NUM },
    long: {
      "--cached": true,
      "--count": true,
      "--name-only": true,
      "--files-with-matches": true,
      "--ignore-case": true,
      "--line-number": true,
      "--break": true,
      "--heading": true,
      "--max-depth": NUM,
      "--word-regexp": true,
      "--extended-regexp": true,
      "--fixed-strings": true,
    },
  },
  "check-ignore": { short: "vnq", long: { "--verbose": true, "--non-matching": true, "--quiet": true } },
  "count-objects": { short: "vH" },
  version: {},
};

/** git branch and git tag only list: these flags, and a name only as a pattern with --list (or a filter that lists). */
const BRANCH = {
  short: "arlvi",
  long: {
    "--all": true,
    "--remotes": true,
    "--list": true,
    "--verbose": true,
    "--ignore-case": true,
    "--show-current": true,
    "--no-color": true,
    "--color": COLOR,
    "--sort": TEXT,
    "--format": TEXT,
    "--points-at": TEXT,
    "--merged": TEXT,
    "--no-merged": TEXT,
    "--contains": TEXT,
    "--no-contains": TEXT,
    "--abbrev": NUM,
    "--no-abbrev": true,
  },
  optionalLong: new Set(["--color", "--merged", "--no-merged", "--contains", "--no-contains", "--abbrev"]),
};
const TAG = {
  short: "li",
  value: { n: /^\d+$/ },
  optionalShort: new Set(["n"]),
  long: {
    "--list": true,
    "--ignore-case": true,
    "--sort": TEXT,
    "--format": TEXT,
    "--points-at": TEXT,
    "--merged": TEXT,
    "--no-merged": TEXT,
    "--contains": TEXT,
    "--no-contains": TEXT,
    "--no-color": true,
    "--color": COLOR,
  },
  optionalLong: new Set(["--color", "--merged", "--no-merged", "--contains", "--no-contains"]),
};

/**
 * A config line as git reads it: its comment (`;` or `#` outside quotes) off, quotes and escapes in
 * its value read. null when it can't be read for sure (a line that goes on, an open quote).
 */
function configLine(raw) {
  let out = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      if (i + 1 >= raw.length) return null; // goes on to the next line
      out += raw[++i];
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      out += "\u0000"; // a quote's place: kept out of names, dropped from values
      continue;
    }
    if (!quoted && (c === ";" || c === "#")) break;
    out += c;
  }
  return quoted ? null : out.trim();
}

/** The keys in a repo's own config that name a program git runs on a read (null: none). */
function riskyConfig(text) {
  let section = "";
  const bool = /^(true|false|yes|no|on|off|1|0)$/i;
  for (const raw of text.split("\n")) {
    const read = configLine(raw.replace(/\r$/, ""));
    if (read === null) return "the repo's config can't be read for sure";
    if (!read) continue;
    const head = read.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+\u0000([^\u0000]*)\u0000)?\s*\]$/);
    if (head) {
      section = head[1].toLowerCase();
      if (head[2] !== undefined) section += `."${head[2]}"`;
      if (/^include(if)?\b/.test(section)) return `the repo's config includes another (${section})`;
      continue;
    }
    const m = read.match(/^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/);
    if (!m || !section) return "the repo's config can't be read for sure";
    const key = `${section}.${m[1].toLowerCase()}`;
    const value = (m[2] ?? "true").replaceAll("\u0000", "").trim();
    const top = section.split(".")[0];
    if (key === "core.fsmonitor" && !bool.test(value)) return "the repo's config runs core.fsmonitor";
    if (key === "core.worktree") return "the repo's config moves its worktree (core.worktree)";
    if (key === "diff.external") return "the repo's config runs diff.external";
    if (top === "diff" && /\.(textconv|command)$/.test(key)) return `the repo's config runs ${key}`;
    if (top === "filter" && /\.(clean|smudge|process)$/.test(key) && !/^git-lfs (clean -- %f|smudge -- %f|filter-process)$/.test(value)) return `the repo's config runs ${key}`;
    if (top === "gpg") return `the repo's config sets ${key}`;
    if (key === "log.showsignature" && !/^(false|no|off|0)$/i.test(value)) return "the repo's config checks signatures";
    // A pager runs when git's output is a terminal (a tool that gives it one).
    if ((key === "core.pager" || top === "pager") && !bool.test(value)) return `the repo's config runs ${key}`;
    if (key === "core.hookspath") {
      if (!/^[\w./~-]+$/.test(value)) return "the repo's config names hooks it can't read for sure";
      return { hooksPath: value };
    }
  }
  return null;
}

/** Every config under a repo's modules/ (its submodules', which git status runs git in). */
function modulesProblem(dir, depth = 0) {
  if (depth > 6) return "submodules nested too deep to read";
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isFile() && e.name === "config") {
      const r = riskyConfig(readFileSync(path, "utf8"));
      if (typeof r === "string") return `a submodule: ${r}`;
    } else if (e.isDirectory() && e.name !== "objects" && e.name !== "refs" && e.name !== "logs") {
      const r = modulesProblem(path, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/** Whether git takes `dir` as a repository itself (HEAD, and objects and refs or a commondir). */
const isGitDir = (dir) => existsSync(join(dir, "HEAD")) && ((existsSync(join(dir, "objects")) && existsSync(join(dir, "refs"))) || existsSync(join(dir, "commondir")));

/**
 * Why git run in `at` can't be allowed, or null: the repo it finds (as git does, walking up) must be
 * a plain checkout, whose own config runs nothing on a read and whose hooks have no
 * post-index-change (git status may write the index, which runs it).
 */
export function gitRepoProblem(at, { credentials = false } = {}) {
  for (let dir = at; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      try {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
          if (!m) return "a .git file it can't read";
          gitDir = resolve(dir, m[1]);
        }
        const cdFile = join(gitDir, "commondir");
        const common = existsSync(cdFile) ? resolve(gitDir, readFileSync(cdFile, "utf8").trim()) : gitDir;
        // One git wouldn't take (git then looks further up, at a repo this never read): asks.
        if (!existsSync(join(gitDir, "HEAD")) || !existsSync(join(common, "objects")) || !existsSync(join(common, "refs"))) return "a .git that isn't a repository it can read";
        let hooks = join(common, "hooks");
        for (const file of [join(common, "config"), join(gitDir, "config.worktree")]) {
          if (!existsSync(file)) continue;
          const text = readFileSync(file, "utf8");
          const r = riskyConfig(text);
          if (typeof r === "string") return r;
          if (credentials && configHasCredential(text)) return "the repo's config holds a credential";
          if (r?.hooksPath) hooks = resolve(dir, r.hooksPath.replace(/^~(?=\/|$)/, homedir()));
        }
        if (existsSync(join(hooks, "post-index-change"))) return "the repo has a post-index-change hook";
        return modulesProblem(join(common, "modules"));
      } catch {
        return "the repo's config can't be read";
      }
    }
    // A folder that is a repo itself: a bare repo shipped as files, maybe.
    if (isGitDir(dir)) return "a bare repository";
    if (dirname(dir) === dir) return null;
  }
}

/** git: no global options but these, a command that only looks with its own flags, run in the session's checkout. */
function git(args, ctx) {
  let i = 0;
  while (i < args.length && /^(--no-pager|-P|--no-optional-locks)$/.test(args[i].text)) i++;
  const subWord = args[i];
  if (!subWord) return "git with nothing to do";
  const sub = subWord.text;
  if (sub === "--version") return i + 1 === args.length ? null : "git --version with more";
  if (sub.startsWith("-")) return `git ${clip(sub)}`;
  const rest = args.slice(i + 1);
  // %G… and %(signature…) in a format check signatures: gpg runs.
  if (rest.some((a) => /%G|%\(signature/.test(a.text))) return "git checking signatures (%G)";
  let problem;
  if (Object.hasOwn(GIT, sub)) {
    const r = parseArgs(rest, { name: `git ${sub}`, permutes: true, ...GIT[sub] }, ctx);
    if (r.bad) return r.bad;
    if (sub === "cat-file" && r.flags.size !== 1) return "git cat-file other than -t, -s, -p or -e";
    // Revisions and paths alike: a revision resolves inside the project; a path outside asks (~/git too).
    const skipPattern = sub === "grep" && !r.flags.has("-e") ? 1 : 0;
    problem = pathsProblem(r.positionals.slice(skipPattern), { ...ctx, projects: null });
  } else if (sub === "branch" || sub === "tag") {
    const r = parseArgs(rest, { name: `git ${sub}`, permutes: true, ...(sub === "branch" ? BRANCH : TAG) }, ctx);
    if (r.bad) return r.bad;
    const lists = [...r.flags].some((f) => /^(-l|--list|--merged|--no-merged|--contains|--no-contains|--points-at)$/.test(f));
    if (r.positionals.length && !lists) return `git ${sub} ${clip(r.positionals[0].text)}`;
  } else if (sub === "remote") {
    const ok = rest.every((a) => a.text === "-v" || a.text === "--verbose") || (rest[0]?.text === "get-url" && rest.length === 2 && !rest[1].text.startsWith("-"));
    if (!ok) return `git remote ${clip(rest[0]?.text ?? "")}`.trim();
  } else if (sub === "config") {
    // One value by its name: never --list or --get-regexp (the global config can hold tokens).
    const flags = rest.filter((a) => a.text.startsWith("-")).map((a) => a.text);
    const names = rest.filter((a) => !a.text.startsWith("-")).map((a) => a.text);
    const ok =
      flags.some((f) => f === "--get" || f === "--get-all") &&
      flags.every((f) => /^(--get|--get-all|--local|--show-origin|--show-scope)$/.test(f)) &&
      names.length === 1 &&
      /^[A-Za-z][\w-]*(\.[\w.-]+)+$/.test(names[0]);
    if (!ok) return "git config other than --get <name>";
    if (/token|pass|secret|key|auth|cred|header|cookie/i.test(names[0])) return `git config --get ${clip(names[0])} (it could be a secret)`;
  } else if (sub === "stash") {
    const what = rest[0]?.text;
    if (what !== "list" && what !== "show") return `git stash ${clip(what ?? "")}`.trim();
    const r = parseArgs(rest.slice(1), { name: `git stash ${what}`, permutes: true, ...LOG }, ctx);
    if (r.bad) return r.bad;
    if (r.positionals.some((p) => !/^stash@\{\d+\}$|^\d+$/.test(p.text))) return `git stash ${what} ${clip(r.positionals[0].text)}`;
  } else if (sub === "reflog") {
    const words = rest[0]?.text === "show" ? rest.slice(1) : rest;
    if (rest.length && rest[0].text !== "show" && !rest[0].text.startsWith("-")) return `git reflog ${clip(rest[0].text)}`;
    const r = parseArgs(words, { name: "git reflog", permutes: true, ...LOG }, ctx);
    if (r.bad) return r.bad;
    // `git reflog -n1 expire`: its subcommand after a flag.
    if (r.positionals.some((p) => /^(expire|delete|exists|drop|write|list|show)$/.test(p.text))) return `git reflog ${clip(r.positionals[0].text)}`;
    problem = pathsProblem(r.positionals, { ...ctx, projects: null });
  } else if (sub === "worktree") {
    if (rest[0]?.text !== "list" || !rest.slice(1).every((a) => a.text === "--porcelain" || a.text === "-v" || a.text === "--verbose")) return `git worktree ${clip(rest[0]?.text ?? "")}`.trim();
  } else return `git ${clip(sub)}`;
  if (problem) return problem;
  // Run where? Only in the session's own folder, as a session started it.
  if (!ctx.session) return "git with the session's folder unknown";
  if (ctx.moved) return "git after a cd";
  // A remote's URL (git remote -v, get-url, config --get remote.x.url) shows a token in it as written.
  const credentials = sub === "remote" || sub === "config";
  if (credentials && [join(ctx.home, ".gitconfig"), join(ctx.home, ".config/git/config")].some(globalConfigProblem)) return "the global git config holds a credential (or includes another)";
  return gitRepoProblem(ctx.at, { credentials });
}

// ── The readers ─────────────────────────────────────────────────────────────

/**
 * The commands that only read, each with its flags allowed by name (BSD's and GNU's versions read
 * alike: a flag that takes a value in one and not the other is left out) and its files checked.
 * Not here, so never allowed: awk (a language: system(), pipes), curl and wget (the network), xargs,
 * env, eval, source, exec, sh -c, less (runs LESSOPEN), xxd (writes its second file), nl, tee.
 */
const READERS = {
  ls: files(
    {
      name: "ls",
      short: "1AaBbCcdFfGghiklmnopqRrSstuUvx",
      long: { "--all": true, "--almost-all": true, "--human-readable": true, "--recursive": true, "--reverse": true, "--directory": true, "--classify": true, "--color": COLOR },
      optionalLong: new Set(["--color"]),
    },
    { dot: (r) => r.flags.has("-R") || r.flags.has("--recursive"), globs: true },
  ),
  cat: files({ name: "cat", short: "benstuvAETl", long: { "--number": true, "--number-nonblank": true, "--squeeze-blank": true, "--show-all": true } }, { globs: true }),
  head: files({ name: "head", short: "qv", value: { n: NUM, c: NUM }, long: { "--lines": NUM, "--bytes": NUM, "--quiet": true, "--verbose": true }, num: true }, { globs: true }),
  tail: files({ name: "tail", short: "qvr", value: { n: NUM, c: NUM }, long: { "--lines": NUM, "--bytes": NUM, "--quiet": true, "--verbose": true }, num: true }),
  wc: files({ name: "wc", short: "lwcmL", long: { "--lines": true, "--words": true, "--bytes": true, "--chars": true, "--max-line-length": true } }, { globs: true }),
  cut: files({
    name: "cut",
    short: "sn",
    value: { d: /^[\s\S]{1}$/, f: /^[\d,-]+$/, c: /^[\d,-]+$/, b: /^[\d,-]+$/ },
    long: { "--delimiter": /^[\s\S]{1}$/, "--fields": /^[\d,-]+$/, "--characters": /^[\d,-]+$/, "--bytes": /^[\d,-]+$/, "--only-delimited": true, "--complement": true },
  }),
  tr: (args, ctx) => {
    const r = parseArgs(args, { name: "tr", short: "cdsCu", noDashes: true }, ctx);
    if (r.bad) return r.bad;
    return r.positionals.length > 2 ? "tr with more than two sets" : null;
  },
  sort: files({
    name: "sort",
    short: "bdfgiMnRrsuVhcCm",
    value: { k: /^[\w.,]+$/, t: /^[\s\S]{1}$/ },
    long: {
      "--numeric-sort": true,
      "--reverse": true,
      "--unique": true,
      "--human-numeric-sort": true,
      "--version-sort": true,
      "--ignore-case": true,
      "--stable": true,
      "--general-numeric-sort": true,
      "--month-sort": true,
      "--check": true,
      "--key": /^[\w.,]+$/,
      "--field-separator": /^[\s\S]{1}$/,
    },
  }),
  // A second file would be written.
  uniq: files({ name: "uniq", short: "cdui", value: { f: NUM, s: NUM }, long: { "--count": true, "--repeated": true, "--unique": true, "--ignore-case": true } }, { max: 1 }),
  column: files({ name: "column", short: "tx", value: { s: TEXT, c: NUM } }),
  comm: files({ name: "comm", short: "123i" }),
  cmp: files({ name: "cmp", short: "ls" }, { max: 2 }),
  diff: files(
    {
      name: "diff",
      short: "uqsiwbBayc",
      value: { U: NUM, C: NUM },
      long: {
        "--brief": true,
        "--unified": NUM,
        "--report-identical-files": true,
        "--ignore-case": true,
        "--ignore-all-space": true,
        "--ignore-space-change": true,
        "--ignore-blank-lines": true,
        "--text": true,
        "--side-by-side": true,
        "--color": COLOR,
      },
      optionalLong: new Set(["--unified", "--color"]),
    },
    { onlyFiles: true },
  ),
  file: files({ name: "file", short: "bIiLhk", long: { "--mime-type": true, "--mime": true, "--brief": true } }),
  stat: files({ name: "stat", short: "LnqrsxlF", value: { f: PATHISH, t: PATHISH, c: PATHISH }, long: { "--format": TEXT, "--printf": TEXT } }),
  du: files({ name: "du", short: "achksmx", value: { d: NUM }, long: { "--summarize": true, "--human-readable": true, "--max-depth": NUM, "--all": true, "--total": true } }, { dot: () => true }),
  df: files({ name: "df", short: "hHkilP" }),
  tree: files(
    { name: "tree", short: "adfiFCnDsphAN", value: { L: NUM, I: TEXT, P: TEXT }, long: { "--noreport": true, "--dirsfirst": true, "--gitignore": true, "--du": true, "--prune": true } },
    { dot: () => true },
  ),
  realpath: files({ name: "realpath", short: "qems" }),
  readlink: files({ name: "readlink", short: "fnem" }),
  grep,
  egrep: grep,
  fgrep: grep,
  rg,
  find,
  sed,
  jq,
  git,
  cd,
  test: testCmd,
  date,
  // echo reads no file and takes no flag but -n -e -E: every word is only text (echo ---).
  echo: () => null,
  // printf's first word is its format: a flag there (-v VAR) asks.
  printf: (args) => (args[0]?.text.startsWith("-") ? `printf ${clip(args[0].text)}` : args.length ? null : "printf with no format"),
  basename: textOnly({ name: "basename", short: "a", value: { s: TEXT } }),
  dirname: textOnly({ name: "dirname" }),
  which: textOnly({ name: "which", short: "as" }),
  pwd: bare({ name: "pwd", short: "LP" }),
  whoami: bare({ name: "whoami" }),
  uname: bare({ name: "uname", short: "amnoprsv" }),
  true: bare({ name: "true" }),
  false: bare({ name: "false" }),
};

/** A command's name as a reader's: a plain word (not ./ls, /bin/ls, "l"s with quotes changing nothing is fine). */
const NAME = /^[a-z][a-z0-9-]*$/;

/**
 * The readers whose files may be globs (each match checked: globProblem). In none of them, BSD's or
 * GNU's, does a flag write a file or run a program, so a name a glob turns into a flag (a file named
 * `-x` made after the check) can't either. Not file (-C writes a compiled magic file, -z runs
 * decompressors), nor rg, grep, find, git, sed or any other (rg's --pre runs a program).
 */
const GLOB_READERS = new Set(["ls", "cat", "head", "wc"]);

/**
 * Whether a shell command only reads: `{ readOnly: true, why }` (`why`: its readers, "ls, git log"),
 * or `{ readOnly: false, why }` with the first thing that made it ask. `cwd`: the session's folder,
 * which every path in it must stay inside, or ~/git (unknown: no absolute, ~ or .. path at all).
 * `home`: the home folder (tests: a fake one).
 */
export function commandReadOnly(command, cwd, { home } = {}) {
  if (typeof command !== "string" || !command.trim()) return { readOnly: false, why: "no command" };
  if (command.length > MAX_COMMAND) return { readOnly: false, why: "too long to read for sure" };
  const lexed = lex(command);
  if (lexed.bad) return { readOnly: false, why: lexed.bad };
  const ctx = contextOf(cwd, home);
  const readers = [];
  ctx.sure = true; // every command so far joined by &&: this one runs only if they all did
  for (const [k, words] of lexed.commands.entries()) {
    ctx.next = lexed.ops[k];
    const [first, ...args] = words;
    const name = first.text;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return { readOnly: false, why: `sets ${name.split("=")[0]}` };
    if (!NAME.test(name) || first.tilde || first.glob || !Object.hasOwn(READERS, name)) return { readOnly: false, why: `${clip(name)} isn't a known reader` };
    // A glob only as one of these readers' files: never a flag, a flag's value, or another's word.
    const globbed = args.find((a) => a.glob && (!GLOB_READERS.has(name) || a.text.startsWith("-")));
    if (globbed) return { readOnly: false, why: `a glob (${clip(globbed.text)})` };
    const problem = READERS[name](args, ctx);
    if (problem) return { readOnly: false, why: problem };
    const label = name === "git" ? `git ${args.find((a) => !a.text.startsWith("-"))?.text ?? args[0]?.text ?? ""}`.trim() : name;
    if (!readers.includes(label)) readers.push(label);
    if (ctx.next !== "&&") ctx.sure = false;
    // After a cd, what follows a ; or || may run where the shell was before it (the cd failed).
    if ((ctx.next === ";" || ctx.next === "||") && ctx.moved) ctx.lost = true;
  }
  // The gate's rules, on or off: anything they flag asks (a belt to the braces above).
  const gate = checkCommand(command, cwd ?? "");
  if (gate?.hits?.length || gate?.unclear?.length) {
    const f = gate.hits[0] ?? gate.unclear[0];
    return { readOnly: false, why: `the safety gate: ${f.what}` };
  }
  return { readOnly: true, why: readers.join(", ") };
}

/** A tool's path field, when it's a string. */
const pathOf = (input, key) => (typeof input?.[key] === "string" ? input[key] : "");

/** A tool's path as a word: absolute, or relative to the session's folder (never with a ~ expanded, never a glob). */
const toolPath = (p) => ({ text: p, tilde: p === "~" || p.startsWith("~/"), quoted: true, glob: false });

/**
 * Whether a tool call only reads, as a permission prompt asks it: Bash (a command, as above), Read,
 * Grep, Glob and LS (inside the session's folder or ~/git, no secret's path, no glob that picks
 * one). Any other tool: false. `cwd`: the session's folder.
 */
export function readOnlyCall(toolName, toolInput, cwd, { home } = {}) {
  const name = typeof toolName === "string" ? toolName : "";
  if (name === "Bash") return commandReadOnly(toolInput?.command, cwd, { home });
  if (name === "Read" || name === "Grep" || name === "Glob" || name === "LS") {
    const ctx = contextOf(cwd, home);
    if (!ctx.session) return { readOnly: false, why: "the session's folder is unknown" };
    const main = name === "Read" ? pathOf(toolInput, "file_path") : pathOf(toolInput, "path") || ".";
    if (!main) return { readOnly: false, why: "no file" };
    // Claude Code trims a path before it reads it (and its ~): one with spaces around it asks.
    if (main !== main.trim() || /^~[^/]/.test(main)) return { readOnly: false, why: `a path outside the project (${clip(main)})` };
    // Grep with no glob searches every file under its path: none of them a secret's.
    const bad = name === "Grep" ? searchedProblem(toolPath(main), ctx, true, picksOf([pathOf(toolInput, "glob")])) : pathProblem(toolPath(main), ctx);
    if (bad) return { readOnly: false, why: bad };
    // Globs: Glob's pattern (names only) and Grep's file filter (whose files it reads).
    const pattern = name === "Glob" ? pathOf(toolInput, "pattern") : "";
    const glob = name === "Grep" ? pathOf(toolInput, "glob") : "";
    for (const g of [pattern, glob].filter(Boolean)) {
      if (g !== g.trim() || isAbsolute(g.trim()) || g.trim().startsWith("~") || g.split("/").includes("..")) return { readOnly: false, why: `a glob outside the project (${clip(g)})` };
      const secret = secretIn(g);
      if (secret) return { readOnly: false, why: `names a secret (${clip(secret)})` };
    }
    if (glob && globPicksSecret(glob)) return { readOnly: false, why: `a glob that could pick a secret (${clip(glob)})` };
    return { readOnly: true, why: name.toLowerCase() };
  }
  return { readOnly: false, why: `${name || "a tool"} isn't only a read` };
}
