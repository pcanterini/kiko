// The safety gate's shell parser (../guard.mjs): a command as the simple commands in it, and each
// with what only runs what follows taken off the front (sudo, env and VAR=x, npx, xargs, …).
// Imports only node:path: it runs inside the hook, on every shell command.
import { basename } from "node:path";

/** How deep nested scripts are followed (bash -c inside $(…) inside ssh …). */
export const MAX_DEPTH = 6;

// ── The shell, parsed ───────────────────────────────────────────────────────

export const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

/**
 * Every simple command in `src`, each `{ words, heredoc? }`: what `a && b`, `a; b`, `a | b`, `a &`
 * and newlines separate, with the commands inside $(…), backticks, <(…) and (subshells) as their own.
 * Quotes are taken off (a quoted word is one word, never a command), redirections and their files
 * left out, comments skipped, and a heredoc's text kept on its command (`heredoc`), never run as
 * commands of its own (unless it's fed to a shell: classify does that).
 *
 * What it can't read for sure is listed on the result, `rough` (not enumerable): a quote, bracket or
 * backtick never closed, a ( inside a word (zsh's glob qualifiers, `*(e:'cmd':)`, run code). The
 * gate takes those as unclear (../guard.mjs checkCommand), never as nothing.
 */
export function parseShell(src, depth = 0) {
  const out = [];
  const rough = [];
  Object.defineProperty(out, "rough", { value: rough, enumerable: false });
  if (depth > MAX_DEPTH || typeof src !== "string") return out;
  let words = [];
  let word = null;
  let skipNext = false; // the next word is a redirection's file
  let writeNext = false; // and that file is written to (`> f`, `>> f`, `&> f`): kept on the command (`writes`)
  let pending = []; // heredocs whose text starts on the next line: { delim, strip, cmd }
  let cmd = { words };
  const endWord = () => {
    if (word === null) return;
    if (skipNext) {
      skipNext = false;
      if (writeNext) cmd.writes = [...(cmd.writes ?? []), word];
      writeNext = false;
    } else words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    skipNext = false;
    writeNext = false;
    const ws = words.filter((w) => w !== "{" && w !== "}" && w !== "!");
    // The object itself: a heredoc read after this line is put on it.
    cmd.words = ws;
    if (ws.length || cmd.heredoc !== undefined) out.push(cmd);
    words = [];
    cmd = { words };
  };
  const nested = (inner) => {
    const cmds = parseShell(inner, depth + 1);
    for (const c of cmds) out.push(c);
    rough.push(...cmds.rough);
  };
  /** Where the bracket at `open` closes; noted as rough when it never does. */
  const closing = (open) => {
    const end = matching(src, open);
    if (end >= src.length) rough.push("a bracket isn't closed");
    return end;
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      const owners = pending;
      pending = [];
      endCommand();
      i++;
      for (const h of owners) {
        // The heredoc's lines, up to its delimiter on a line of its own (tabs off for <<-).
        const lines = [];
        while (i < n) {
          let end = src.indexOf("\n", i);
          if (end < 0) end = n;
          const line = src.slice(i, end);
          i = end + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          lines.push(line);
        }
        h.cmd.heredoc = (h.cmd.heredoc ? `${h.cmd.heredoc}\n` : "") + lines.join("\n");
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    if (c === "#" && word === null) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\\") {
      if (src[i + 1] === "\n") i += 2;
      else {
        word = (word ?? "") + (src[i + 1] ?? "");
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) rough.push("a quote isn't closed");
      const stop = end < 0 ? n : end;
      word = (word ?? "") + src.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "'") {
      // $'…' (ANSI-C quoting, bash and zsh): \' inside it is a quote, not its end.
      const r = ansiC(src, i + 2);
      if (r.end >= n) rough.push("a quote isn't closed");
      word = (word ?? "") + r.text;
      i = r.end + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === '"') {
      // $"…" (a locale's translation): read as "…".
      i++;
      continue;
    }
    if (c === '"') {
      let text = "";
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < n) {
          text += src[i + 1];
          i += 2;
        } else if (src[i] === "$" && src[i + 1] === "(" && src[i + 2] !== "(") {
          const end = closing(i + 1);
          nested(src.slice(i + 2, end));
          text += "$(…)";
          i = end + 1;
        } else if (src[i] === "`") {
          const end = backtickEnd(src, i);
          if (end >= n) rough.push("a backtick isn't closed");
          nested(src.slice(i + 1, end).replace(/\\`/g, "`"));
          text += "$(…)";
          i = end + 1;
        } else {
          text += src[i];
          i++;
        }
      }
      if (i >= n) rough.push("a quote isn't closed");
      word = (word ?? "") + text;
      i++;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      if (src[i + 2] === "(") {
        // $((arithmetic)): no command in it.
        const end = matching(src, i + 1);
        word = `${word ?? ""}0`;
        i = end + 1;
        continue;
      }
      const end = closing(i + 1);
      nested(src.slice(i + 2, end));
      word = `${word ?? ""}$(…)`;
      i = end + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "{") {
      const end = src.indexOf("}", i + 2);
      const stop = end < 0 ? n : end;
      word = (word ?? "") + src.slice(i, stop + 1);
      i = stop + 1;
      continue;
    }
    if (c === "`") {
      const end = backtickEnd(src, i);
      if (end >= n) rough.push("a backtick isn't closed");
      nested(src.slice(i + 1, end).replace(/\\`/g, "`"));
      word = `${word ?? ""}$(…)`;
      i = end + 1;
      continue;
    }
    if (c === "(" && word === null) {
      // A subshell, or a function body: its commands are commands.
      const end = closing(i);
      endCommand();
      nested(src.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === "=" && word === null && src[i + 1] === "(") {
      // zsh's =(cmd): process substitution, as <(cmd).
      const end = closing(i + 1);
      nested(src.slice(i + 2, end));
      word = "$(…)";
      i = end + 1;
      continue;
    }
    if (c === "(") {
      // Inside a word: a zsh glob qualifier (`*(e:'cmd':)` runs cmd) or a bash extglob. Not read.
      rough.push("a ( inside a word");
      const end = closing(i);
      word = `${word}${src.slice(i, end + 1)}`;
      i = end + 1;
      continue;
    }
    if (c === ")") {
      i++;
      continue;
    }
    if (c === ";" || c === "|" || (c === "&" && src[i + 1] !== ">")) {
      endCommand();
      i++;
      while (i < n && (src[i] === "&" || src[i] === "|" || src[i] === ";")) i++;
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && src[i + 1] === ">")) {
      // A file descriptor right before it (2>&1) isn't a word.
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      if ((c === "<" || c === ">") && src[i + 1] === "(") {
        // Process substitution: <(cmd) runs cmd.
        const end = closing(i + 1);
        nested(src.slice(i + 2, end));
        i = end + 1;
        continue;
      }
      if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
        // A heredoc: its delimiter next, its text from the next line.
        i += 2;
        const strip = src[i] === "-";
        if (strip) i++;
        while (src[i] === " " || src[i] === "\t") i++;
        let delim = "";
        while (i < n && !/[\s;&|<>()]/.test(src[i])) {
          if (src[i] === "'" || src[i] === '"') {
            const q = src[i];
            const end = src.indexOf(q, i + 1);
            const stop = end < 0 ? n : end;
            delim += src.slice(i + 1, stop);
            i = stop + 1;
          } else if (src[i] === "\\") {
            delim += src[i + 1] ?? "";
            i += 2;
          } else delim += src[i++];
        }
        pending.push({ delim, strip, cmd });
        continue;
      }
      // <<< word, > file, >> file, >& 2, &> file, >| file: the word after is the operand.
      const from = i;
      while (i < n && /[<>&|]/.test(src[i])) i++;
      if (/^\d/.test(src[i] ?? "") && src[i - 1] === "&") {
        while (i < n && /\d/.test(src[i])) i++;
        if (src[i] === "-") i++;
        continue;
      }
      if (src[i - 1] === "&" && src[i] === "-") {
        i++; // >&- closes a descriptor
        continue;
      }
      skipNext = true;
      // Anything with a > in it writes its file (<> opens it to write too); < and <<< only read.
      writeNext = src.slice(from, i).includes(">");
      continue;
    }
    word = (word ?? "") + c;
    i++;
  }
  endCommand();
  // A heredoc whose text never started (no newline after it): nothing more to read.
  return out;
}

/** $'…' from just inside it: its text (escapes read) and where its closing quote is (src.length: none). */
function ansiC(src, from) {
  const ESC = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };
  let text = "";
  let i = from;
  while (i < src.length && src[i] !== "'") {
    if (src[i] === "\\" && i + 1 < src.length) {
      text += ESC[src[i + 1]] ?? src[i + 1];
      i += 2;
    } else text += src[i++];
  }
  return { text, end: i };
}

/** Where the bracket opened at `open` closes (quotes and nesting respected); the end when it doesn't. */
function matching(src, open) {
  const pair = { "(": ")", "{": "}" };
  const close = pair[src[open]] ?? ")";
  const start = src[open];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "$" && src[i + 1] === "'") {
      i = ansiC(src, i + 2).end;
      if (i >= src.length) return src.length;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return src.length;
      i = end;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === start) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return src.length;
}

function backtickEnd(src, open) {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "`") return i;
  }
  return src.length;
}

// ── Prefixes that only run what follows ─────────────────────────────────────

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** The shell's own words before a command (`if git push; then`, `while …; do curl …`). */
const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{", "time"]);

/**
 * A command with what only runs it taken off the front: `VAR=x`, `sudo -u me`, `env -i A=b`,
 * `command`, `exec`, `nohup`, `time`, `nice -n 5`, `timeout 30`, `xargs -0 -n1`, `npx -y`, `pnpm dlx`,
 * `pnpm exec`, `bunx`, `uvx`, `uv run`, `poetry run`, `bundle exec`, `op run --`, `dotenv --`. The
 * words left: the command itself, then its arguments; `[]` when nothing is left (`sudo -v`).
 */
export function unwrap(words) {
  let w = [...words];
  for (let guard = 0; guard < 12 && w.length; guard++) {
    while (w.length && (ASSIGNMENT.test(w[0]) || KEYWORDS.has(w[0]))) w.shift();
    if (!w.length) return w;
    const name = basename(w[0]);
    const next = PREFIXES[name]?.(w);
    if (!next) return w;
    w = next;
  }
  return w;
}

/** Drops leading options, those in `takes` with their value; stops at `--` (dropped) or the first non-option. */
export function afterOptions(rest, takes = new Set(), alsoAssignments = false) {
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a === "--") return rest.slice(i + 1);
    if (alsoAssignments && ASSIGNMENT.test(a)) {
      i++;
      continue;
    }
    if (!a.startsWith("-") || a === "-") break;
    if (takes.has(a)) i += 2;
    else i++;
  }
  return rest.slice(i);
}

/** The plain words of `args`: options left out, with the values of those in `takes`. */
export function plainArgs(args, takes = new Set()) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      if (takes.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Runs `--`'s right-hand side: `op run --env-file x -- cmd`. Nothing after `--`: nothing run (`op run` alone). */
const afterDashes = (w) => {
  const at = w.indexOf("--");
  return at < 0 ? null : w.slice(at + 1);
};

/** A package runner's binary, without its version or scope: `@cloudflare/wrangler@3` → wrangler. */
function binaryOf(spec) {
  const noScope = spec.startsWith("@") ? spec.slice(spec.indexOf("/") + 1) : spec;
  return noScope.replace(/@.*$/, "");
}

const npxLike = (w) => {
  const rest = afterOptions(w.slice(1), new Set(["-p", "--package", "-c", "--call", "--node-options"]));
  if (!rest.length) return null;
  return [binaryOf(rest[0]), ...rest.slice(1)];
};

const PREFIXES = {
  sudo: (w) => afterOptions(w.slice(1), new Set(["-u", "-g", "-h", "-p", "-C", "-U", "-r", "-t", "-T", "-D", "-R"]), true),
  doas: (w) => afterOptions(w.slice(1), new Set(["-u", "-C"])),
  env: (w) => afterOptions(w.slice(1), new Set(["-u", "--unset", "-C", "--chdir", "-P", "-S", "--split-string"]), true),
  command: (w) => afterOptions(w.slice(1)),
  builtin: (w) => w.slice(1),
  exec: (w) => afterOptions(w.slice(1), new Set(["-a"])),
  nohup: (w) => w.slice(1),
  time: (w) => afterOptions(w.slice(1), new Set(["-o", "-f", "--format", "--output"])),
  nice: (w) => afterOptions(w.slice(1), new Set(["-n", "--adjustment"])),
  ionice: (w) => afterOptions(w.slice(1), new Set(["-c", "-n", "-p"])),
  stdbuf: (w) => afterOptions(w.slice(1), new Set(["-i", "-o", "-e"])),
  unbuffer: (w) => w.slice(1),
  chronic: (w) => w.slice(1),
  caffeinate: (w) => afterOptions(w.slice(1), new Set(["-t", "-w"])),
  timeout: (w) => {
    const rest = afterOptions(w.slice(1), new Set(["-s", "--signal", "-k", "--kill-after"]));
    return rest.slice(1);
  },
  gtimeout: (w) => PREFIXES.timeout(w),
  watch: (w) => afterOptions(w.slice(1), new Set(["-n", "--interval", "-d"])),
  xargs: (w) => afterOptions(w.slice(1), new Set(["-I", "-J", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "-R", "-S", "--max-args", "--max-procs", "--delimiter", "--arg-file"])),
  npx: npxLike,
  pnpx: npxLike,
  bunx: npxLike,
  uvx: (w) => npxLike(w),
  pipx: (w) => (w[1] === "run" ? npxLike(w.slice(1)) : null),
  pnpm: (w) => (w[1] === "dlx" || w[1] === "exec" ? npxLike(w.slice(1)) : null),
  yarn: (w) => (w[1] === "dlx" || w[1] === "exec" ? npxLike(w.slice(1)) : null),
  npm: (w) => (w[1] === "exec" || w[1] === "x" ? npxLike(w.slice(1)) : null),
  bun: (w) => (w[1] === "x" ? npxLike(w.slice(1)) : null),
  uv: (w) =>
    w[1] === "run"
      ? afterOptions(w.slice(2), new Set(["--with", "--python", "-p", "--project", "--directory", "--env-file", "--group", "--extra", "--package"]))
      : w[1] === "tool" && w[2] === "run"
        ? npxLike(w.slice(2))
        : null,
  poetry: (w) => (w[1] === "run" ? w.slice(2) : null),
  pdm: (w) => (w[1] === "run" ? w.slice(2) : null),
  hatch: (w) => (w[1] === "run" ? w.slice(2) : null),
  pipenv: (w) => (w[1] === "run" ? w.slice(2) : null),
  bundle: (w) => (w[1] === "exec" ? w.slice(2) : null),
  dotenv: afterDashes,
  op: (w) => (w[1] === "run" ? afterDashes(w) : null),
  doppler: (w) => (w[1] === "run" ? afterDashes(w) : null),
  infisical: (w) => (w[1] === "run" ? afterDashes(w) : null),
  "aws-vault": (w) => (w[1] === "exec" ? afterDashes(w) : null),
  "with-contenv": (w) => w.slice(1),
  xcrun: (w) => afterOptions(w.slice(1), new Set(["-sdk", "--sdk", "-toolchain", "--toolchain"])),
};
