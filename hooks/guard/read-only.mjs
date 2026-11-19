// Kiko's quick checks only look (src/core/quick-task.ts): what a shell command does, read from the
// command itself in code, for the quick check's own PreToolUse hook (hooks/quick-guard.mjs) and the
// app's answer to its permission requests (src/core/quick-ask.ts deniedOutright). One of:
//   read     every command in it only looks (ls, find without -delete, docker ps, git status, a for
//            loop over them, …) and it writes no file: the run's permission mode decides (auto lets
//            it through; Manual runs what the allow rules cover and asks the rest, as before)
//   change   something in it changes things or reaches out (rm, a write to a file with >, git push,
//            docker rm or prune, curl -d, ssh, kill, an install, …): denied, never asked, whatever
//            the mode
//   unknown  code can't tell (python -c, a script, curl's plain GET, a command it doesn't know):
//            asked of you, never left to auto mode's classifier
// Commands are parsed (guard/parse.mjs), not grepped: `a && b; c | d`, $(…), backticks, subshells,
// `bash -c "…"`, `eval`, heredocs, for/while loops, and the prefixes that only run what follows
// (env, xargs, time, …). The safety gate's rules (../guard.mjs) are asked too: anything they find for
// sure (sends, deletes, pays, posts) is a change.
//
// Imports only node:path and the gate's own files: it runs in a hook on every quick check's command.
import { basename } from "node:path";
import { checkCommand } from "../guard.mjs";
import { afterOptions, MAX_DEPTH, parseShell, SHELLS, unwrap } from "./parse.mjs";

/** Where a redirection may write without changing anything. */
const SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "-"]);

// ── git ─────────────────────────────────────────────────────────────────────

// git's commands that only look. With a few, only some of their forms (gitReads).
const GIT_READS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "blame",
  "shortlog",
  "describe",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "cat-file",
  "rev-list",
  "grep",
  "name-rev",
  "merge-base",
  "diff-tree",
  "diff-index",
  "diff-files",
  "show-ref",
  "count-objects",
  "for-each-ref",
  "whatchanged",
  "check-ignore",
  "var",
  "version",
  "help",
]);
// git's options before its command, and those that take a value after them.
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** Whether a git command line (its words after `git`) only looks. */
export function gitReads(words) {
  if (words.some((w) => w.startsWith("--output"))) return false;
  let i = 0;
  while (i < words.length && words[i].startsWith("-")) i += GIT_GLOBAL_WITH_VALUE.has(words[i]) ? 2 : 1;
  const [sub, ...args] = words.slice(i);
  if (!sub) return true; // bare `git`: its help
  if (GIT_READS.has(sub)) return true;
  const flagsOnly = args.every((a) => a.startsWith("-"));
  switch (sub) {
    case "branch":
      // Listing; a name would make one, and these change them.
      return flagsOnly && !args.some((a) => /^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)/.test(a));
    case "remote":
      return args.length === 0 || args.every((a) => a === "-v" || a === "--verbose") || args[0] === "show" || args[0] === "get-url";
    case "stash":
      return args[0] === "list" || args[0] === "show";
    case "tag":
      return args.length === 0 || args.every((a) => a === "-l" || a === "--list" || a.startsWith("-n"));
    case "reflog":
      return args.length === 0 || args[0] === "show";
    case "config":
      return args.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a)) && !args.some((a) => /^--(add|unset|replace-all|rename-section|remove-section|edit)|^-e$/.test(a));
    default:
      return false;
  }
}

// ── The commands ────────────────────────────────────────────────────────────

const READ = "read";
const CHANGE = "change";
const UNKNOWN = "unknown";

/** Commands that only look, whatever their arguments (a write with > is caught on its own). */
const READS = new Set(
  `cat tac less more head tail wc nl cut tr paste join comm column fold fmt rev expand unexpand
  grep egrep fgrep zgrep rg ag ack locate mdfind mdls ls eza exa lsd tree du df stat file readlink
  realpath basename dirname pwd cd pushd popd dirs echo printf true false test [ [[ ]] : which whereis
  type hash alias unalias export unset local declare typeset readonly read shift sleep wait exit return
  break continue seq jot yes cal uptime whoami id groups who w last users logname finger uname sw_vers
  arch vm_stat iostat ps pgrep lsof netstat nettop top printenv locale tty md5 md5sum shasum sha1sum
  sha224sum sha256sum sha384sum sha512sum cksum sum hexdump od strings otool nm lipo jq json_pp
  diff cmp sdiff man apropos whatis help history jobs bc dc expr dig host nslookup whois traceroute ping
  ping6 system_profiler ioreg kextstat zcat bzcat xzcat gzcat zless look getconf nproc dmesg
  trap ulimit umask set getopts let pbpaste afinfo ffprobe mediainfo lsappinfo sw_vers
  for select done fi esac then else elif do in`.split(/\s+/),
);

/** Commands that change things or reach another machine, whatever their arguments. */
const CHANGES = new Set(
  `rm rmdir mv cp ln link unlink mkdir mktemp mkfifo touch chmod chown chgrp chflags install ditto shred
  srm truncate dd split csplit patch rsync sponge pbcopy screencapture killall pkill shutdown reboot
  halt su passwd chsh chpass dseditgroup sysadminctl createhomedir fsck newfs_apfs newfs_hfs umount
  renice trash ssh scp sftp ftp tftp telnet socat mail mailx sendmail mutt open vim vi nvim nano emacs
  pico ed code cursor subl zip script ffmpeg convert magick shortcuts automator installer at batch atrm
  kextload kextunload kmutil sudo doas`.split(/\s+/),
);

/** Interpreters: code can't tell what their code does (asked), except saying their version. */
const INTERPRETERS = new Set(`python python2 python3 node ruby php deno lua luajit java javac swift swiftc Rscript julia tclsh irb jshell bun osascript`.split(/\s+/));

/** Its first word that isn't an option: a command's subcommand. */
const first = (args) => args.find((a) => !a.startsWith("-"));
/** Every short flag letter in `args` (`-sSLo` gives s, S, L, o) and every long one. */
const flagsOf = (args) => {
  const short = new Set();
  const long = new Set();
  for (const a of args) {
    if (a === "--") break;
    if (a.startsWith("--")) long.add(a.split("=")[0]);
    else if (a.startsWith("-") && a.length > 1) for (const ch of a.slice(1)) short.add(ch);
  }
  return { short, long, has: (s, ...l) => (s && [...s].some((ch) => short.has(ch))) || l.some((x) => long.has(x)) };
};
/** A subcommand table: `read` or `change` by its first word (`also` for its second), else `otherwise`. */
const bySub =
  (reads, changes, otherwise = UNKNOWN, takes = new Set()) =>
  (args) => {
    const rest = afterOptions(args, takes);
    const sub = rest[0];
    if (sub === undefined) return args.some((a) => /^(-v|-V|--version|-h|--help)$/.test(a)) || !args.length ? READ : otherwise;
    if (reads.has(sub) || reads.has(`${sub} ${rest[1] ?? ""}`.trim())) return READ;
    if (changes === "*" || changes.has(sub) || changes.has(`${sub} ${rest[1] ?? ""}`.trim())) return CHANGE;
    return otherwise;
  };
const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const NPM_READS = words("ls list ll la view v info show outdated why explain root prefix bin --version -v config get search find help doctor licenses whoami ping store");
const NPM_CHANGES = words(
  "install i add remove rm uninstall un unlink link ln update up upgrade publish unpublish deprecate dist-tag owner access login logout adduser pack ci init create dedupe prune rebuild set import patch patch-commit fetch approve-builds setup cache",
);
const npm = (args) => {
  const sub = first(args);
  if (sub === "version") return args.filter((a) => !a.startsWith("-")).length > 1 ? CHANGE : READ;
  if (sub === "config") return /^(get|list|ls)$/.test(args[args.indexOf("config") + 1] ?? "list") ? READ : CHANGE;
  if (sub === "audit") return args.includes("fix") ? CHANGE : READ;
  if (sub === "store") return /^(path|status)$/.test(args[args.indexOf("store") + 1] ?? "") ? READ : CHANGE;
  return bySub(NPM_READS, NPM_CHANGES)(args);
};

const DOCKER_READS = words("ps images inspect logs stats version info top port diff history events search df ls list show get-url");
const DOCKER_CHANGES = words(
  "rm rmi prune stop kill start restart run exec create pull push build tag commit cp rename update pause unpause attach login logout save load import export up down scale watch connect disconnect use wait",
);
/** docker, podman, docker-compose: their objects' reads (`network ls`, `compose ps`) and changes (`system prune`). */
const docker = (args) => {
  const rest = afterOptions(
    args,
    new Set(["-H", "--host", "-c", "--context", "--config", "-l", "--log-level", "-f", "--file", "-p", "--project-name", "--project-directory", "--env-file", "--profile"]),
  );
  if (!rest.length) return args.some((a) => /^(-v|--version|-h|--help)$/.test(a)) || !args.length ? READ : UNKNOWN;
  if (rest.includes("prune")) return CHANGE;
  for (const w of rest.slice(0, 3)) {
    if (DOCKER_CHANGES.has(w)) return CHANGE;
    if (DOCKER_READS.has(w)) return READ;
  }
  return UNKNOWN;
};

const GH_READS = words("list view status checks diff watch get search help --version --help");
/** gh: looking at GitHub is a read; anything else changes it or posts there. `gh api` only with GET. */
const gh = (args) => {
  const rest = afterOptions(args, new Set(["-R", "--repo", "--hostname"]));
  if (!rest.length) return READ;
  if (rest[0] === "api") {
    const f = flagsOf(rest);
    const method = rest.find((_, i) => /^(-X|--method)$/.test(rest[i - 1] ?? "")) ?? rest.find((a) => a.startsWith("--method="))?.split("=")[1] ?? "GET";
    return f.has("fF", "--field", "--raw-field", "--input") || !/^(GET|HEAD)$/i.test(method) ? CHANGE : READ;
  }
  if (rest[0] === "auth") return rest[1] === "status" || rest[1] === "token" ? READ : CHANGE;
  if (GH_READS.has(rest[0]) || GH_READS.has(rest[1] ?? "")) return READ;
  return CHANGE;
};

/** curl's short options that take a value (`-o file`, `-XPOST`). */
const CURL_VALUE = new Set([..."XoDKHuAebrmwxyYzUEcCQtPk"]);
const CURL_SENDS = [
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "--data-ascii",
  "--form",
  "--form-string",
  "--upload-file",
  "--json",
  "--remote-name",
  "--remote-name-all",
  "--remote-header-name",
  "--cookie-jar",
  "--post301",
  "--post302",
  "--post303",
  "--create-dirs",
  "--trace",
  "--trace-ascii",
  "--libcurl",
  "--etag-save",
  "--hsts",
  "--alt-svc",
];
/** curl: a GET is asked (the web, as WebFetch is); sending data, another method or writing a file is a change. */
const curl = (args) => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [flag, attached] = a.split(/=(.*)/s);
      if (CURL_SENDS.includes(flag)) return CHANGE;
      if (!/^--(request|output|dump-header|stderr|config)$/.test(flag)) continue;
      const value = attached ?? args[++i] ?? "";
      if (flag === "--request" && !/^(GET|HEAD)$/i.test(value)) return CHANGE;
      if (/^--(output|dump-header|stderr)$/.test(flag) && !SINKS.has(value)) return CHANGE;
      continue;
    }
    if (!a.startsWith("-") || a === "-") continue;
    const cluster = a.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const ch = cluster[j];
      // -d, -F, -T send data; -O, -J write a file named after the URL.
      if ("dFTOJ".includes(ch)) return CHANGE;
      if (!CURL_VALUE.has(ch)) continue;
      const value = cluster.slice(j + 1) || args[++i] || "";
      if (ch === "X" && !/^(GET|HEAD)$/i.test(value)) return CHANGE;
      if ((ch === "o" || ch === "D" || ch === "c") && !SINKS.has(value)) return CHANGE;
      break;
    }
  }
  return UNKNOWN;
};

const wget = (args) => {
  const f = flagsOf(args);
  if (f.has("", "--post-data", "--post-file", "--method", "--body-data", "--body-file")) return CHANGE;
  if (f.has("", "--spider")) return UNKNOWN;
  const toStdout =
    args.some((a, i) => (a === "-O" || a === "--output-document" || /^-[a-zA-Z]*O$/.test(a)) && args[i + 1] === "-") || args.some((a) => a === "-O-" || a === "-qO-" || a === "--output-document=-");
  return toStdout ? UNKNOWN : CHANGE;
};

/** sed: -i edits in place; a script with w, W or e writes or runs something. */
const sed = (args) => {
  if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place") || /^-[a-zA-Z]*I$/.test(a))) return CHANGE;
  const scripts = args.filter((a, i) => !a.startsWith("-") || args[i - 1] === "-e");
  if (args.some((a) => a === "-f" || a.startsWith("--file"))) return UNKNOWN;
  return scripts.some((s) => /(^|[;}\n/]\s*|\d\s*|\$\s*)[wWe](\s|$)|\/[gpIi0-9]*w\s/.test(s)) ? UNKNOWN : READ;
};

/** awk: a program that prints to a file or a command, or runs one, can't be told safe. */
const awk = (args) => {
  if (args.some((a) => a === "-f" || a.startsWith("--file") || a === "-i" || a.startsWith("--include"))) return UNKNOWN;
  const program = args.find((a, i) => !a.startsWith("-") && !/^-[vF]$/.test(args[i - 1] ?? "")) ?? "";
  return /system\s*\(|\bprintf?\b[^;}]*[>|]|\|\s*getline|close\s*\(|fflush/.test(program) ? UNKNOWN : READ;
};

/** find: -delete and its -fprint family write; -exec and -ok run a command (classified like any). */
const find = (args, depth) => {
  if (args.some((a) => /^-(delete|fprint|fprint0|fprintf|fls)$/.test(a))) return CHANGE;
  let verdict = READ;
  for (let i = 0; i < args.length; i++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(args[i])) continue;
    let end = i + 1;
    while (end < args.length && args[end] !== ";" && args[end] !== "+") end++;
    verdict = worst(verdict, classifyWords(args.slice(i + 1, end), depth + 1).verdict);
    i = end;
  }
  return verdict;
};

/** fd's -x / -X run a command on what it finds. */
const fd = (args, depth) => {
  const at = args.findIndex((a) => /^(-x|--exec|-X|--exec-batch)$/.test(a));
  return at < 0 ? READ : classifyWords(args.slice(at + 1), depth + 1).verdict;
};

const tar = (args) => {
  const mode = args[0] ?? "";
  const f = flagsOf(args);
  const cluster = mode.startsWith("-") ? mode.slice(1) : mode;
  if (f.has("", "--list") || (/^[a-zA-Z]+$/.test(cluster) && cluster.includes("t") && !/[cxruA]/.test(cluster))) return READ;
  return CHANGE;
};

/** gzip and friends: listing, testing or writing to stdout only look. */
const zipper = (args) => (flagsOf(args).has("clt", "--list", "--test", "--stdout", "--to-stdout") ? READ : CHANGE);

const kill = (args) => (args.some((a) => a === "-0" || a === "-l" || a === "-L" || a === "-s0") ? READ : CHANGE);

/** Commands that read with some flags and change with others. */
const RULES = {
  git: (args) => (gitReads(args) ? READ : CHANGE),
  gh,
  curl,
  wget,
  sed,
  gsed: sed,
  awk,
  gawk: awk,
  nawk: awk,
  mawk: awk,
  find,
  gfind: find,
  fd,
  tar,
  bsdtar: tar,
  gtar: tar,
  gzip: zipper,
  gunzip: zipper,
  bzip2: zipper,
  bunzip2: zipper,
  xz: zipper,
  unxz: zipper,
  zstd: zipper,
  unzip: (args) => (flagsOf(args).has("lvZtp") ? READ : CHANGE),
  "7z": bySub(words("l t i h"), "*", CHANGE),
  "7za": bySub(words("l t i h"), "*", CHANGE),
  kill,
  docker,
  podman: docker,
  "docker-compose": docker,
  brew: (args) => {
    const sub = first(args);
    if (sub === "services") return /^(list|info)$/.test(args[args.indexOf("services") + 1] ?? "list") ? READ : CHANGE;
    if (sub === "tap" || sub === "analytics") return args.filter((a) => !a.startsWith("-")).length > 1 ? CHANGE : READ;
    if (sub === "bundle") return /^(check|list)$/.test(args[args.indexOf("bundle") + 1] ?? "") ? READ : CHANGE;
    return bySub(
      words(
        "list ls info search outdated deps uses leaves config doctor desc missing commands shellenv log cat formulae casks which-formula --prefix --cellar --repository --caskroom --cache --env --version",
      ),
      "*",
      CHANGE,
    )(args);
  },
  npm,
  pnpm: npm,
  yarn: npm,
  bun: npm,
  pip: bySub(words("list show freeze check config index inspect debug help search"), words("install uninstall download wheel cache"), UNKNOWN),
  pip3: (args) => RULES.pip(args),
  gem: bySub(words("list info search query specification environment contents dependency outdated which help"), words("install uninstall update cleanup push build owner yank"), UNKNOWN),
  cargo: bySub(
    words("tree metadata search locate-project pkgid verify-project version help info"),
    words("install uninstall publish yank owner login logout new init add remove rm update clean fix fmt build b check c doc package vendor generate-lockfile"),
    UNKNOWN,
  ),
  go: (args) => {
    const sub = first(args);
    if (sub === "env") return args.some((a) => a === "-w" || a === "-u") ? CHANGE : READ;
    if (sub === "mod") return /^(graph|why|verify)$/.test(args[args.indexOf("mod") + 1] ?? "") ? READ : CHANGE;
    return bySub(words("version list doc help"), words("install get build clean generate fmt fix work"), UNKNOWN)(args);
  },
  tmux: bySub(
    words(
      "ls list-sessions lsw list-windows lsp list-panes lsc list-clients lsb list-buffers lsk list-keys lscm list-commands display-message display show-options show show-window-options showw show-environment showenv show-hooks capture-pane capturep has-session has info server-info show-buffer showb",
    ),
    "*",
    CHANGE,
    new Set(["-L", "-S", "-f", "-T"]),
  ),
  launchctl: bySub(
    words("list print print-cache print-disabled blame dumpstate dumpjpcategory resolveport examine managerpid manageruid managername procinfo hostinfo error variant version help getenv plist"),
    "*",
    CHANGE,
  ),
  defaults: (args) => {
    const sub = first(args);
    if (sub === "export") return args.at(-1) === "-" ? READ : CHANGE;
    return bySub(words("read read-type domains find help"), "*", CHANGE, new Set(["-host"]))(args);
  },
  diskutil: (args) => {
    const [sub, next] = args.filter((a) => !a.startsWith("-"));
    if (/^(list|info|information|activity|listFilesystems)$/.test(sub ?? "list")) return READ;
    if (/^(apfs|cs|coreStorage|appleRAID|ar)$/.test(sub) && /^(list|info|listCryptoUsers|listSnapshots|listVolumeGroups|listUsers)$/.test(next ?? "")) return READ;
    return CHANGE;
  },
  pmset: (args) => (args[0] === "-g" ? READ : CHANGE),
  networksetup: (args) => (/^-(get|list|print|version|help|isnetworkserviceenabled|showpppoestatus)/i.test(args[0] ?? "-help") ? READ : CHANGE),
  systemsetup: (args) => (/^-(get|print|help|version)/i.test(args[0] ?? "-help") ? READ : CHANGE),
  scutil: (args) => (args.some((a) => a === "--set") ? CHANGE : args.some((a) => /^(--get|--dns|--proxy|--nwi|-r|-w)$/.test(a)) ? READ : UNKNOWN),
  sysctl: (args) => (args.some((a) => a === "-w" || a.includes("=")) ? CHANGE : READ),
  hostname: (args) => (args.some((a) => !a.startsWith("-")) ? CHANGE : READ),
  date: (args) => (args.some((a) => a === "-s" || a === "--set" || /^\d{4,}/.test(a)) ? CHANGE : READ),
  ifconfig: (args) => (args.filter((a) => !a.startsWith("-")).length > 1 ? CHANGE : READ),
  ipconfig: (args) => (/^(getifaddr|getpacket|getoption|ifcount|getsummary|getiflist|getra|getv6packet)$/.test(args[0] ?? "") ? READ : CHANGE),
  route: (args) => (args.some((a) => /^(add|delete|change|flush)$/.test(a)) ? CHANGE : args.some((a) => a === "get") ? READ : UNKNOWN),
  arp: (args) => (args.some((a) => /^-[a-zA-Z]*[dsSf]/.test(a)) ? CHANGE : READ),
  nc: (args) => (flagsOf(args).has("z") ? READ : CHANGE),
  ncat: (args) => RULES.nc(args),
  netcat: (args) => RULES.nc(args),
  tmutil: bySub(words("status listbackups latestbackup destinationinfo isexcluded machinedirectory version listlocalsnapshots listlocalsnapshotdates compare uniquesize calculatedrift"), "*", CHANGE),
  softwareupdate: (args) =>
    args.length && args.every((a) => /^(-l|--list|--history|--list-full-installers|--dump-state|--no-scan|--all|-a)$/.test(a)) && !args.every((a) => /^(--all|-a|--no-scan)$/.test(a)) ? READ : CHANGE,
  spctl: (args) =>
    args.some((a) => /^(--status|-a|--assess|--list|--global-status)$/.test(a)) && !args.some((a) => /^--(add|remove|enable|disable|master-enable|master-disable|global-enable|global-disable)/.test(a))
      ? READ
      : CHANGE,
  codesign: (args) =>
    args.some((a) => /^(-s|--sign|--remove-signature|-f|--force)$/.test(a)) ? CHANGE : args.some((a) => /^(-d|-dv+|-v+|--display|--verify|--validate-constraint)$/.test(a)) ? READ : UNKNOWN,
  plutil: (args) => (args.some((a) => /^-(p|lint|help|type)$/.test(a)) ? READ : args.includes("-extract") ? (args.some((a, i) => a === "-o" && args[i + 1] === "-") ? READ : UNKNOWN) : CHANGE),
  xattr: (args) => (args.some((a) => /^-[a-zA-Z]*[wdc]/.test(a)) ? CHANGE : READ),
  security: (args) =>
    /^(add|delete|set|import|create|unlock|lock|export|default-keychain|login-keychain|authorizationdb|trust-settings-import|trust-settings-export|install|leaks)/.test(first(args) ?? "")
      ? CHANGE
      : UNKNOWN,
  mdutil: (args) => (args.some((a) => /^-[a-zA-Z]*[iEXLP]/.test(a)) ? CHANGE : args.some((a) => /^-[a-zA-Z]*s/.test(a)) ? READ : CHANGE),
  log: bySub(words("show stream stats help"), "*", CHANGE),
  crontab: (args) => (args.length === 1 && args[0] === "-l" ? READ : CHANGE),
  atq: () => READ,
  hdiutil: bySub(words("info imageinfo pmap verify checksum help"), "*", CHANGE),
  pkgutil: (args) => (args.some((a) => /^--(forget|expand|expand-full|flatten|learn|unlink)/.test(a)) ? CHANGE : READ),
  nvram: (args) => (args.every((a) => /^-[px]+$/.test(a)) ? READ : CHANGE),
  profiles: (args) => (/^(status|list|show|-P|-L|-C|help|version)$/.test(args[0] ?? "status") ? READ : CHANGE),
  fdesetup: bySub(words("status list isactive hasinstitutionalrecoverykey haspersonalrecoverykey supportsauthrestart showdeferralinfo usingrecoverykey help version"), "*", CHANGE),
  csrutil: bySub(words("status report"), "*", CHANGE),
  "xcode-select": (args) => (args.every((a) => /^(-p|--print-path|-v|--version|-h|--help)$/.test(a)) ? READ : CHANGE),
  xcodebuild: (args) =>
    args.length &&
    args.every(
      (a) => /^-(version|list|showsdks|showBuildSettings|showdestinations|help|checkFirstLaunchStatus|project|workspace|scheme|json|target|configuration|sdk)$/.test(a) || !a.startsWith("-"),
    ) &&
    args.some((a) => /^-(version|list|showsdks|showBuildSettings|showdestinations|help|checkFirstLaunchStatus)$/.test(a)) &&
    !args.some((a) => /^(build|test|archive|clean|install|analyze)$/.test(a))
      ? READ
      : CHANGE,
  simctl: bySub(words("list help getenv get_app_container appinfo listapps"), "*", CHANGE),
  dscl: (args) =>
    args.some((a) => /^-(read|readall|readpl|readpli|list|search|diff)$/.test(a)) &&
    !args.some((a) => /^-(create|createpl|createpli|append|appendpl|merge|delete|deletepl|change|changei|passwd|auth)$/.test(a))
      ? READ
      : CHANGE,
  sort: (args) => (args.some((a) => /^-[a-zA-Z]*o/.test(a) || a.startsWith("--output")) ? CHANGE : READ),
  uniq: (args) => (args.filter((a) => !a.startsWith("-")).length > 1 ? CHANGE : READ),
  tee: (args) => (args.filter((a) => !a.startsWith("-")).every((a) => SINKS.has(a)) ? READ : CHANGE),
  xxd: (args) => (args.filter((a) => !a.startsWith("-")).length > 1 ? CHANGE : READ),
  base64: (args) => (args.some((a) => /^(-o|--output)/.test(a)) ? CHANGE : READ),
  iconv: (args) => (args.some((a) => /^(-o|--output)/.test(a)) ? CHANGE : READ),
  sips: (args) =>
    args.some((a) => /^(-g|--getProperty|-1|--oneLine|--help|-h|-v|--version|--verify)$/.test(a)) &&
    !args.some((a) =>
      /^(-s|--setProperty|-o|--out|-r|--rotate|-z|--resampleHeightWidth|-Z|--resampleHeightWidthMax|-c|--cropToHeightWidth|-p|--padToHeightWidth|-f|--flip|-i|--addIcon|-d|--deleteProperty|-e|--embedProfile|-m|--matchTo|-M|--matchToWithIntent|--deleteColorManagementProperties|-j|--js)$/.test(
        a,
      ),
    )
      ? READ
      : CHANGE,
  textutil: (args) => (args.includes("-info") ? READ : CHANGE),
  exiftool: (args) => (args.some((a) => /^-[\w:-]+[+-]?=/.test(a) || /^-(overwrite_original|o|out|tagsFromFile|geotag|delete_original)/.test(a)) ? CHANGE : READ),
  systemctl: bySub(words("status list-units list-unit-files list-timers list-sockets list-dependencies show is-active is-enabled is-failed cat help"), "*", CHANGE),
  journalctl: (args) => (args.some((a) => /^--(vacuum|rotate|flush|sync|relinquish|setup-keys|update-catalog)/.test(a)) ? CHANGE : READ),
  screen: (args) => (args.some((a) => a === "-ls" || a === "-list") ? READ : UNKNOWN),
  mas: bySub(words("list outdated search info home version help account"), "*", CHANGE),
  systemextensionsctl: bySub(words("list help"), "*", CHANGE),
  bless: (args) => (args.every((a) => /^(--info|--getBoot|--plist|--verbose)$/.test(a) || !a.startsWith("-")) && args.some((a) => /^(--info|--getBoot)$/.test(a)) ? READ : CHANGE),
  perl: (args) => (args.some((a) => /^-[a-zA-Z]*i/.test(a)) ? CHANGE : interpreter(args)),
  mount: (args) => (args.some((a) => !a.startsWith("-")) ? CHANGE : READ),
  kubectl: (args) => {
    const rest = afterOptions(args, new Set(["-n", "--namespace", "--context", "--kubeconfig", "-l", "--cluster", "--user"]));
    if (rest[0] === "config") return /^(view|get-contexts|current-context|get-clusters|get-users)$/.test(rest[1] ?? "") ? READ : CHANGE;
    if (rest[0] === "auth") return /^(can-i|whoami)$/.test(rest[1] ?? "") ? READ : CHANGE;
    return bySub(words("get describe logs top version explain api-resources api-versions cluster-info events"), "*", CHANGE)(rest);
  },
};

/** A CLI code doesn't know, asked only to list or say its state (`tart list`, `multipass list`, `orb status`). */
const LISTING = new Set(["list", "ls", "status", "version", "--version", "-v", "-V", "help", "--help", "-h"]);
function listing(args) {
  const plain = args.filter((a) => !a.startsWith("-"));
  return LISTING.has(args[0] ?? "") && plain.length <= 1 && args.every((a) => !a.startsWith("-") || /^(--version|-v|-V|--help|-h|--json|-q|--quiet|-a|--all|-l|--long)$/.test(a));
}

/** An interpreter saying its version or help only looks; running code, code can't tell. */
function interpreter(args) {
  return args.length > 0 && args.every((a) => /^(-v|-V|--version|-h|--help|-version)$/.test(a)) ? READ : UNKNOWN;
}

/** osascript: AppleScript that sends, deletes or sets is a change; anything else is asked. */
function osascript(args) {
  const script = args.join(" ");
  if (/\b(send|delete|make new|set|do shell script|keystroke|key code|click|quit|open location|move|duplicate|close|save|empty|restart|shut down|log out|sleep|eject|mount)\b/i.test(script))
    return CHANGE;
  return args.length > 0 && args.every((a) => /^(-v|-V|--version|-h|--help)$/.test(a)) ? READ : UNKNOWN;
}

// ── The verdict ─────────────────────────────────────────────────────────────

const RANK = { [READ]: 0, [UNKNOWN]: 1, [CHANGE]: 2 };
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);

/** One simple command's verdict, as its words (after parseShell), with `what` when it isn't a read. */
function classifyWords(raw, depth = 0, cmd = { words: raw }) {
  const writes = (cmd.writes ?? []).filter((t) => !SINKS.has(t) && !/^&?\d*$/.test(t));
  if (writes.length) return { verdict: CHANGE, what: `writes ${writes[0]}` };
  const plain = raw.filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (!plain.length) return { verdict: READ };
  if (plain[0] === "case") return { verdict: UNKNOWN, what: "case" };
  // Run as another user: a quick check never needs it (and has nobody to type a password).
  const asOther = plain.some((w, i) => i < 3 && (w === "sudo" || w === "doas" || w === "su"));
  if (asOther) return { verdict: CHANGE, what: plain.slice(0, 3).join(" ") };
  if (plain[0] === "command" && plain.some((a) => a === "-v" || a === "-V")) return { verdict: READ };
  const w = unwrap(raw);
  if (!w.length) return { verdict: READ };
  const name = basename(w[0].replace(/^\\/, ""));
  const args = w.slice(1);
  const what = [name, ...args.filter((a) => !a.startsWith("-")).slice(0, 2)].join(" ").slice(0, 120);
  const out = (verdict) => (verdict === READ ? { verdict } : { verdict, what });
  if (name.includes("$(…)") || name.startsWith("$")) return { verdict: UNKNOWN, what: name };
  // A shell running a script: `bash -c "…"` and a heredoc fed to it are classified as the script.
  if (SHELLS.has(name)) {
    const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (c >= 0 && typeof args[c + 1] === "string") return depth < MAX_DEPTH ? commandVerdict(args[c + 1], depth + 1) : out(UNKNOWN);
    if (cmd.heredoc !== undefined && !args.some((a) => !a.startsWith("-"))) return depth < MAX_DEPTH ? commandVerdict(cmd.heredoc, depth + 1) : out(UNKNOWN);
    return out(UNKNOWN);
  }
  if (name === "eval") return depth < MAX_DEPTH ? commandVerdict(args.join(" "), depth + 1) : out(UNKNOWN);
  if (name === "osascript") return out(osascript(args));
  if (INTERPRETERS.has(name) && !RULES[name]) return out(interpreter(args));
  if (Object.hasOwn(RULES, name)) return out(RULES[name](args, depth));
  if (READS.has(name)) return out(READ);
  if (CHANGES.has(name)) return out(CHANGE);
  return out(listing(args) ? READ : UNKNOWN);
}

/**
 * One simple command's verdict, as its words (parseShell's `words`): "read", "change" or "unknown".
 * For ./auto-allow.mjs, which asks it of the readers whose flags decide (sed -i, sort -o, date -s).
 */
export const wordsVerdict = (words) => classifyWords(words).verdict;

/**
 * A shell command's verdict: `read` (it only looks), `change` (it would change something or reach
 * out: denied), or `unknown` (asked). `what`: the first simple command that made it so ("rm -rf x",
 * "writes notes.txt"). The gate's sure finds (sends, deletes, pays, posts) are changes too.
 */
export function commandVerdict(command, depth = 0) {
  if (typeof command !== "string") return { verdict: UNKNOWN, what: "" };
  let result = { verdict: READ };
  for (const cmd of parseShell(command.slice(0, 200_000), depth)) {
    const v = classifyWords(cmd.words, depth, cmd);
    if (RANK[v.verdict] > RANK[result.verdict]) result = v;
    if (result.verdict === CHANGE) return result;
  }
  if (depth === 0) {
    const gate = checkCommand(command);
    const hit = gate?.hits?.[0];
    if (hit) return { verdict: CHANGE, what: `${hit.what} (${hit.kind})` };
  }
  return result;
}

/**
 * What a quick check's tool call gets before anyone is asked: `deny` (it would change things),
 * `ask` (code can't tell, or the web: asked every time), or `pass` (it only looks: the permission
 * mode and the allow rules decide). `why` for a deny or an ask, in the check's own words.
 */
export function quickToolVerdict(toolName, toolInput) {
  const name = typeof toolName === "string" ? toolName : "";
  if (/^(Read|Grep|Glob|LS)$/.test(name)) return { decision: "pass" };
  if (name === "WebFetch" || name === "WebSearch") return { decision: "ask", why: "The web is asked for every time." };
  if (name === "Bash") {
    const command = typeof toolInput?.command === "string" ? toolInput.command : "";
    const v = commandVerdict(command);
    if (v.verdict === CHANGE) return { decision: "deny", why: `A quick check only looks, and this would change something${v.what ? ` (${v.what})` : ""}.` };
    if (v.verdict === UNKNOWN) return { decision: "ask", why: `Kiko can't tell that this only looks${v.what ? ` (${v.what})` : ""}.` };
    return { decision: "pass" };
  }
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return { decision: "deny", why: "A quick check can't change files." };
  return { decision: "deny", why: "A quick check has no other tools." };
}
