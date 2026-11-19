// The safety gate's rules for what reaches another machine (../guard.mjs): git pushes (and to
// where, by the repo's remote), deleted branches, git clean, patches by email; gh by its first two
// words and `gh api` by its method and fields; HTTP clients (curl, wget, HTTPie) writing to a host
// that isn't this Mac; mail and message tools, AppleScript sending from an app, scp/rsync to a host.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterOptions } from "./parse.mjs";

// ── git and GitHub ───────────────────────────────────────────────────────────

/** Git's subcommand, after its own options (-C dir, -c k=v, --git-dir=…). */
function gitSub(args) {
  return afterOptions(args, new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"]));
}

/** "GitHub", "GitLab", "Bitbucket", or "its git remote": by the remote in the repo's .git/config (looked up only on a hit). */
function gitHost(ctx, remote) {
  ctx.gitHostCache ??= new Map();
  const key = remote || "";
  if (ctx.gitHostCache.has(key)) return ctx.gitHostCache.get(key);
  let found = "";
  try {
    let dir = resolve(ctx.cwd || ".");
    for (let hops = 0; hops < 40; hops++) {
      let text = "";
      try {
        text = readFileSync(join(dir, ".git", "config"), "utf8");
      } catch {
        try {
          // A worktree's .git is a file pointing at its gitdir; the shared config is two levels up.
          const pointer = readFileSync(join(dir, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m)?.[1];
          if (pointer) text = readFileSync(join(resolve(dir, pointer.trim()), "..", "..", "config"), "utf8");
        } catch {}
      }
      if (text) {
        const name = remote && !remote.includes("/") && !remote.includes(":") ? remote : "origin";
        const section = text.split(/^\[/m).find((s) => s.startsWith(`remote "${name}"]`)) ?? text;
        const url = section.match(/^\s*url\s*=\s*(.+)$/m)?.[1] ?? (remote && remote.includes(":") ? remote : "");
        found = /github\.com/i.test(url) ? "GitHub" : /gitlab/i.test(url) ? "GitLab" : /bitbucket/i.test(url) ? "Bitbucket" : /codeberg/i.test(url) ? "Codeberg" : "";
        break;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {}
  const words = found || "its git remote";
  ctx.gitHostCache.set(key, words);
  return words;
}

function gitRule(args, { hit, ctx }) {
  const rest = gitSub(args);
  const sub = rest[0];
  const opts = rest.slice(1);
  const flags = opts.filter((a) => a.startsWith("-"));
  const plain = opts.filter((a) => !a.startsWith("-"));
  const has = (...names) => flags.some((f) => names.includes(f) || names.some((n) => n.length === 2 && /^-[a-zA-Z]+$/.test(f) && f.includes(n[1])));
  switch (sub) {
    case "push": {
      // A dry run only asks the remote: nothing on it changes.
      if (flags.some((f) => f === "--dry-run" || f === "-n" || (/^-[a-zA-Z]+$/.test(f) && f.includes("n")))) return;
      const remote = plain[0];
      const where = gitHost(ctx, remote);
      if (flags.includes("--delete") || has("-d") || plain.slice(1).some((r) => r.startsWith(":"))) return hit("deletes", "git push --delete", `delete a branch on ${where}`);
      if (flags.some((f) => f.startsWith("--force") || f === "--mirror") || has("-f") || plain.slice(1).some((r) => r.startsWith("+")))
        return hit("posts", "git push --force", `force-push to ${where}`);
      return hit("posts", "git push", `push to ${where}`);
    }
    case "branch": {
      if (
        has("-D") ||
        (flags.some((f) => f === "--delete" || f === "-d") && flags.some((f) => f === "--force" || f === "-f")) ||
        flags.some((f) => /^-[a-zA-Z]*d[a-zA-Z]*f|^-[a-zA-Z]*f[a-zA-Z]*d/.test(f))
      ) {
        const branch = plain.find((p) => p !== "-r");
        return hit("deletes", "git branch -D", branch ? `delete the branch ${branch}` : "delete a branch");
      }
      return;
    }
    case "clean": {
      if (flags.some((f) => f === "--dry-run" || (/^-[a-zA-Z]+$/.test(f) && f.includes("n")))) return;
      if (flags.some((f) => f === "--force" || (/^-[a-zA-Z]+$/.test(f) && f.includes("f")))) return hit("deletes", "git clean -f", "delete untracked files");
      return;
    }
    case "send-email":
      return hit("sends", "git send-email", "send patches by email");
  }
}

/** gh: which of its commands change GitHub, by their first two words. */
const GH = {
  pr: {
    merge: ["posts", "merge a pull request on GitHub"],
    create: ["posts", "open a pull request on GitHub"],
    new: ["posts", "open a pull request on GitHub"],
    comment: ["sends", "comment on a pull request on GitHub"],
    review: ["sends", "review a pull request on GitHub"],
    close: ["posts", "close a pull request on GitHub"],
    reopen: ["posts", "reopen a pull request on GitHub"],
    ready: ["posts", "mark a pull request ready on GitHub"],
    edit: ["posts", "edit a pull request on GitHub"],
    lock: ["posts", "lock a pull request on GitHub"],
  },
  issue: {
    create: ["posts", "open an issue on GitHub"],
    new: ["posts", "open an issue on GitHub"],
    comment: ["sends", "comment on an issue on GitHub"],
    close: ["posts", "close an issue on GitHub"],
    reopen: ["posts", "reopen an issue on GitHub"],
    edit: ["posts", "edit an issue on GitHub"],
    transfer: ["posts", "transfer an issue on GitHub"],
    lock: ["posts", "lock an issue on GitHub"],
    delete: ["deletes", "delete an issue on GitHub"],
  },
  release: {
    create: ["posts", "publish a release on GitHub"],
    new: ["posts", "publish a release on GitHub"],
    upload: ["posts", "upload release files to GitHub"],
    edit: ["posts", "edit a release on GitHub"],
    delete: ["deletes", "delete a release on GitHub"],
    "delete-asset": ["deletes", "delete a release file on GitHub"],
  },
  repo: {
    create: ["posts", "create a repository on GitHub"],
    new: ["posts", "create a repository on GitHub"],
    fork: ["posts", "fork a repository on GitHub"],
    delete: ["deletes", "delete a repository on GitHub"],
    archive: ["posts", "archive a repository on GitHub"],
    rename: ["posts", "rename a repository on GitHub"],
    edit: ["posts", "change a repository's settings on GitHub"],
  },
  gist: { create: ["posts", "publish a gist"], new: ["posts", "publish a gist"], edit: ["posts", "edit a gist"], delete: ["deletes", "delete a gist"] },
  secret: { set: ["posts", "set a secret on GitHub"], delete: ["deletes", "delete a secret on GitHub"], remove: ["deletes", "delete a secret on GitHub"] },
  variable: { set: ["posts", "set a variable on GitHub"], delete: ["deletes", "delete a variable on GitHub"] },
  workflow: { run: ["posts", "start a GitHub workflow"], enable: ["posts", "enable a GitHub workflow"], disable: ["posts", "disable a GitHub workflow"] },
  run: { rerun: ["posts", "rerun a GitHub workflow"], cancel: ["posts", "cancel a GitHub workflow run"], delete: ["deletes", "delete a GitHub workflow run"] },
  label: { create: ["posts", "create a label on GitHub"], delete: ["deletes", "delete a label on GitHub"], edit: ["posts", "edit a label on GitHub"] },
  cache: { delete: ["deletes", "delete GitHub Actions caches"] },
};

function ghRule(args, { hit }) {
  const plain = args.filter((a) => !a.startsWith("-"));
  if (args.includes("--help") || args.includes("-h")) return;
  if (plain[0] === "api") return ghApi(args.slice(args.indexOf("api") + 1), hit);
  const entry = GH[plain[0]]?.[plain[1]];
  if (!entry) return;
  // A review only posts with a verdict or a comment (a bare `gh pr review` asks interactively).
  if (plain[0] === "pr" && plain[1] === "review" && !args.some((a) => /^(-a|--approve|-r|--request-changes|-c|--comment|-b|--body|-F|--body-file)$/.test(a))) return;
  hit(entry[0], `gh ${plain[0]} ${plain[1]}`, entry[1]);
}

function ghApi(args, hit) {
  let method = "";
  let fields = false;
  let mutation = false;
  let endpoint = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-X" || a === "--method") method = String(args[++i] ?? "").toUpperCase();
    else if (a.startsWith("--method=")) method = a.slice(9).toUpperCase();
    else if (/^-X\w+/.test(a)) method = a.slice(2).toUpperCase();
    else if (a === "-f" || a === "-F" || a === "--field" || a === "--raw-field" || a === "--input") {
      fields = true;
      if (/\bmutation\b/.test(String(args[i + 1] ?? ""))) mutation = true;
      i++;
    } else if (/^(-[fF]|--field=|--raw-field=)/.test(a)) {
      fields = true;
      if (/\bmutation\b/.test(a)) mutation = true;
    } else if (a === "-H" || a === "--header" || a === "-q" || a === "--jq" || a === "-t" || a === "--template" || a === "--hostname" || a === "--cache" || a === "-p" || a === "--preview") i++;
    else if (!a.startsWith("-") && !endpoint) endpoint = a;
  }
  if (endpoint === "graphql") {
    if (mutation) hit("sends", "gh api graphql mutation", "change something through GitHub's API");
    return;
  }
  if (!method) method = fields ? "POST" : "GET";
  if (method === "DELETE") return hit("deletes", "gh api DELETE", "delete through GitHub's API");
  if (/^(POST|PUT|PATCH)$/.test(method)) hit("sends", `gh api ${method}`, "send a GitHub API request");
}

export const GIT_RULES = { git: gitRule, gh: ghRule };

// ── Requests, mail and copies to other hosts ─────────────────────────────────

const LOCAL_HOST = /^(localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[?::1\]?|[\w.-]+\.localhost|host\.docker\.internal)$/i;
const PAYMENT_HOST =
  /(^|\.)(stripe\.com|paypal\.com|squareup\.com|squareupsandbox\.com|braintreegateway\.com|adyen\.com|checkout\.com|razorpay\.com|paddle\.com|lemonsqueezy\.com|mollie\.com|gocardless\.com|coinbase\.com)$/i;
/** What a POST to a known host is, in a few words. */
const HOST_WHAT = [
  [/(^|\.)slack\.com$/i, "send a Slack message"],
  [/(^|\.)discord(app)?\.com$/i, "send a Discord message"],
  [/(^|\.)twilio\.com$/i, "send a text message"],
  [/(^|\.)telegram\.org$/i, "send a Telegram message"],
  [/(^|\.)(sendgrid\.com|mailgun\.net|postmarkapp\.com|resend\.com|sparkpost\.com|mailchimp\.com|mandrillapp\.com|amazonaws\.com\.email)$/i, "send an email"],
  [/(^|\.)api\.github\.com$/i, "send a GitHub API request"],
];

/** A URL's host, or the host of a bare `host/path`; "" when it isn't one. */
function hostOf(arg) {
  const m = arg.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^/:?#]*)/i);
  if (m) return m[1];
  // http :3000/x (HTTPie's localhost), or a bare host.
  if (/^:\d/.test(arg)) return "localhost";
  const bare = arg.match(/^(?:[^@/\s]*@)?([a-z0-9-]+(?:\.[a-z0-9-]+)+|localhost)(?::\d+)?(?:[/?#]|$)/i);
  return bare ? bare[1] : "";
}

/** A request to `host` with `method`: its hit (pays, deletes or sends), or none for a local one. */
function requestHit(host, method, hit, rule) {
  if (host && LOCAL_HOST.test(host)) return;
  if (host && PAYMENT_HOST.test(host)) return hit("pays", rule, `make a payment request to ${host}`);
  if (method === "DELETE") return hit("deletes", rule, host ? `send a DELETE request to ${host}` : "send a DELETE request");
  const known = host && HOST_WHAT.find(([re]) => re.test(host));
  hit("sends", rule, known ? known[1] : host ? `send a ${method} request to ${host}` : `send a ${method} request`);
}

// Options of curl that take a value (so the value isn't read as its URL).
const CURL_VALUE = new Set(
  "-d --data --data-raw --data-binary --data-urlencode --data-ascii --json -F --form --form-string -T --upload-file -H --header -X --request -o --output -u --user -A --user-agent -e --referer -b --cookie -c --cookie-jar -w --write-out -m --max-time --connect-timeout --retry --retry-delay --retry-max-time -x --proxy -U --proxy-user --cacert --capath -E --cert --key --key-type --cert-type -K --config -r --range -C --continue-at --resolve --connect-to --url --unix-socket --abstract-unix-socket -D --dump-header --interface --local-port -Y -y --speed-limit --speed-time -z --time-cond --limit-rate --max-filesize --oauth2-bearer --aws-sigv4 --variable --expand-url --expand-data --trace --trace-ascii --stderr --output-dir -P --ftp-port -Q --quote --dns-servers --doh-url --proto --proto-redir --noproxy --pinnedpubkey --ciphers --tls-max --hostpubsha256 --mail-from --mail-rcpt --mail-auth".split(
    " ",
  ),
);
const CURL_DATA = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "-F", "--form", "--form-string"]);

function curlRule(args, { hit }) {
  let method = "";
  let data = false;
  let upload = false;
  let get = false;
  let head = false;
  let mail = false;
  const urls = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith("--") && a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    const value = a.startsWith("--") && a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
    const takesValue = CURL_VALUE.has(eq);
    if (eq === "-X" || eq === "--request") method = String(value ?? "").toUpperCase();
    else if (/^-X[A-Za-z]+$/.test(a)) method = a.slice(2).toUpperCase();
    else if (CURL_DATA.has(eq) || /^-[dF]./.test(a)) data = true;
    else if (eq === "-T" || eq === "--upload-file" || /^-T./.test(a)) upload = true;
    else if (eq === "-G" || eq === "--get") get = true;
    else if (eq === "-I" || eq === "--head") head = true;
    else if (eq === "--mail-rcpt") mail = true;
    else if (eq === "--url" && value) urls.push(value);
    else if (eq === "--unix-socket" || eq === "--abstract-unix-socket") urls.push("http://localhost");
    if (takesValue && !a.includes("=") && !/^-[A-Za-z]./.test(a)) {
      i++;
      continue;
    }
    if (!a.startsWith("-")) urls.push(a);
  }
  if (mail) return hit("sends", "curl:mail", "send an email");
  // Through a local socket: this Mac only.
  if (urls.includes("http://localhost") && args.some((a) => a.startsWith("--unix-socket") || a.startsWith("--abstract-unix-socket"))) return;
  if (!method) method = upload ? "PUT" : data && !get ? "POST" : head ? "HEAD" : "GET";
  if (!/^(POST|PUT|PATCH|DELETE)$/.test(method)) return;
  const hosts = urls.map(hostOf).filter(Boolean);
  const host = hosts.find((h) => !LOCAL_HOST.test(h)) ?? (hosts.length ? hosts[0] : "");
  requestHit(host, method, hit, `curl:${method}`);
}

function wgetRule(args, { hit }) {
  let method = "";
  for (const a of args) {
    if (/^--(post-data|post-file|body-data|body-file)/.test(a)) method ||= "POST";
    const m = a.match(/^--method=(\w+)/i);
    if (m) method = m[1].toUpperCase();
  }
  if (!/^(POST|PUT|PATCH|DELETE)$/.test(method)) return;
  const host =
    args
      .filter((a) => !a.startsWith("-"))
      .map(hostOf)
      .find(Boolean) ?? "";
  requestHit(host, method, hit, `wget:${method}`);
}

/** HTTPie and xh: `http POST url a=b`, or data items (a=b, a:=1, @file) that make it a POST. */
function httpieRule(args, { hit }) {
  const plain = args.filter((a) => !a.startsWith("-"));
  let method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(plain[0] ?? "") ? plain.shift() : "";
  const url = plain.shift() ?? "";
  // Data items (a=b, a:=1, a@file, a=@file) make it a POST; a==b (a query) and A:b (a header) don't.
  const items = plain.some((a) => /^[^=:@]+(:=@?|=@|=(?!=)|@)/.test(a));
  if (!method) method = items || args.some((a) => a === "--form" || a === "-f" || a === "--raw") ? "POST" : "GET";
  if (!/^(POST|PUT|PATCH|DELETE)$/.test(method)) return;
  requestHit(hostOf(url), method, hit, `httpie:${method}`);
}

function osascriptRule(args, { hit }) {
  const text = args.join(" ");
  if (/\bsend\b/i.test(text) && /\b(Mail|Messages|Outlook|Slack|Microsoft Teams|WhatsApp|Telegram|Discord)\b/.test(text)) hit("sends", "osascript send", "send a message from an app");
}

/** scp and rsync: copying to another machine (`host:path` last) posts there. */
function copyRule(args, { hit, name }) {
  const plain = args.filter((a) => !a.startsWith("-"));
  const dest = plain[plain.length - 1] ?? "";
  if (plain.length < 2 || args.includes("--dry-run") || args.includes("-n")) return;
  const m = dest.match(/^(?:[^@/:]+@)?([^/:]+):/);
  if (m && !/^[A-Za-z]$/.test(m[1]) && !LOCAL_HOST.test(m[1])) hit("posts", `${name} to a host`, `copy files to ${m[1]}`);
}

export const NETWORK_RULES = {
  curl: curlRule,
  wget: wgetRule,
  http: httpieRule,
  https: httpieRule,
  xh: httpieRule,
  xhs: httpieRule,
  twurl: (args, ctx) => curlRule(args, ctx),
  osascript: osascriptRule,
  scp: copyRule,
  rsync: copyRule,
  mail: (_args, { hit }) => hit("sends", "mail", "send an email"),
  mailx: (_args, { hit }) => hit("sends", "mail", "send an email"),
  sendmail: (_args, { hit }) => hit("sends", "sendmail", "send an email"),
  mutt: (args, { hit }) => args.length && hit("sends", "mutt", "send an email"),
  neomutt: (args, { hit }) => args.length && hit("sends", "mutt", "send an email"),
  msmtp: (_args, { hit }) => hit("sends", "msmtp", "send an email"),
  swaks: (_args, { hit }) => hit("sends", "swaks", "send an email"),
  twilio: (args, { hit }) => args.some((a) => /messages:create|calls:create/.test(a)) && hit("sends", "twilio send", "send a text message"),
  toot: (args, { hit }) => args[0] === "post" && hit("posts", "toot post", "post on Mastodon"),
};
