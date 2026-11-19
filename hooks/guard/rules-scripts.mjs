// The safety gate's rules by name (../guard.mjs): scripts, package scripts and make targets with a
// risky word in their name, an unknown CLI whose first words are a risky verb, and inline code
// (`python -c`, `node -e`) that sends, pays or deletes. All unclear: the classifier decides.
import { basename } from "node:path";
import { afterOptions } from "./parse.mjs";

/** Words of a name, split on - _ : . / and case changes: "deployProd.sh" → deploy, prod, sh. */
export const wordsOf = (s) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Risky words in names (scripts, package scripts, make targets), with the kind each suggests. */
const RISKY_WORDS = {
  deploy: "posts",
  deploys: "posts",
  deployment: "posts",
  publish: "posts",
  release: "posts",
  ship: "posts",
  push: "posts",
  upload: "posts",
  promote: "posts",
  rollout: "posts",
  rollback: "posts",
  tweet: "posts",
  toot: "posts",
  post: "posts",
  dns: "posts",
  send: "sends",
  email: "sends",
  emails: "sends",
  mail: "sends",
  mailer: "sends",
  notify: "sends",
  broadcast: "sends",
  sms: "sends",
  slack: "sends",
  webhook: "sends",
  drop: "deletes",
  destroy: "deletes",
  delete: "deletes",
  purge: "deletes",
  wipe: "deletes",
  nuke: "deletes",
  teardown: "deletes",
  pay: "pays",
  payment: "pays",
  payments: "pays",
  charge: "pays",
  refund: "pays",
  invoice: "pays",
  purchase: "pays",
  buy: "pays",
  payout: "pays",
  billing: "pays",
};

/** The kind a name's words suggest (the first risky word's), or null. */
export function riskyHint(name) {
  for (const w of wordsOf(name)) if (RISKY_WORDS[w]) return RISKY_WORDS[w];
  return null;
}

export const SCRIPT = /\.(sh|bash|zsh|py|rb|js|mjs|cjs|ts|mts|pl|php)$/;

/** A script run by its path (./deploy.sh, python scripts/send_email.py): unclear when its name is risky. */
export function scriptRule(path, unsure) {
  const file = basename(path);
  const hint = riskyHint(file.replace(SCRIPT, ""));
  if (hint) unsure(`script:${file}`, `run ${file}`, hint);
}

/** An unknown command whose first words are a risky verb ("supabase functions deploy", "doctl apps delete"). */
const RISKY_VERBS = new Set([
  "deploy",
  "publish",
  "release",
  "push",
  "send",
  "delete",
  "destroy",
  "drop",
  "purge",
  "post",
  "upload",
  "promote",
  "rollback",
  "pay",
  "charge",
  "refund",
  "purchase",
  "buy",
  "tweet",
  "merge",
]);
export function genericRule(name, args, unsure) {
  const verbs = args.filter((a) => !a.startsWith("-")).slice(0, 3);
  const verb = verbs.find((a) => RISKY_VERBS.has(a.toLowerCase()));
  if (verb) unsure(`cli:${name} ${verb}`, `run ${name} ${verbs.slice(0, verbs.indexOf(verb) + 1).join(" ")}`, riskyHint(verb));
}

/** Commands that only read or change local files: never looked at by name (their arguments are data). */
export const READ_ONLY = new Set(
  (
    "echo printf cat bat less more head tail grep egrep fgrep rg ag ack ls tree fd wc sort uniq cut tr sed awk gawk jq yq diff cmp file stat du df which whereis type man help pwd cd pushd popd test [ [[ true false sleep date " +
    "for case select function in done fi esac basename dirname realpath readlink export set unset source . alias history tee touch mkdir cp mv ln chmod chown open code cursor vim vi nvim nano emacs column xxd hexdump od strings base64 shasum sha256sum md5 md5sum " +
    "tmux ps pgrep top htop lsof kill killall pkill say afplay wait read declare local return exit shift trap getopts printenv id whoami hostname uname sw_vers defaults mdfind mdls plutil " +
    "tsc biome eslint prettier jest vitest mocha pytest ruff black mypy go swift xcodebuild"
  ).split(" "),
);

const INLINE_RISK = [
  [/\b(requests|httpx|session|client)\.(post|put|patch|delete)\(/i, "sends"],
  [/method\s*[:=]\s*['"](POST|PUT|PATCH|DELETE)['"]/i, "sends"],
  [/\bsmtplib\b|\bsendmail\b|nodemailer|\.send_message\(|chat[._]post_?message|chat\.postMessage/i, "sends"],
  [/\bstripe\.|paymentIntents|payment_intents/i, "pays"],
  [/shutil\.rmtree|rmSync\([^)]*recursive|rimraf/i, "deletes"],
];
/** `python -c "…"`, `node -e "…"` and friends: unclear when the code sends, pays or deletes. */
export function inlineRule(args, ctx) {
  const { unsure, cmd, name, rules } = ctx;
  // python -m twine upload: the module's own rule.
  const module = args.indexOf("-m");
  if (module >= 0 && args[module + 1]) {
    const rule = rules[args[module + 1]];
    if (rule) rule(args.slice(module + 2), { ...ctx, name: args[module + 1] });
    return;
  }
  const flag = args.findIndex((a) => /^(-c|-e|--eval|-p|--print|-r)$/.test(a));
  const code = flag >= 0 ? (args[flag + 1] ?? "") : (cmd.heredoc ?? "");
  if (flag < 0) {
    const script = args.find((a) => !a.startsWith("-"));
    if (script && (SCRIPT.test(script) || script.includes("/"))) scriptRule(script, unsure);
    if (!code) return;
  }
  for (const [re, kind] of INLINE_RISK)
    if (re.test(code)) return unsure(`inline:${name}`, `run ${name} code that ${kind === "pays" ? "makes payments" : kind === "deletes" ? "deletes files" : "sends requests"}`, kind);
}

/** make, just, task, …: a target whose name is risky is unclear. */
export const targets =
  (label) =>
  (args, { unsure }) => {
    for (const t of afterOptions(args, new Set(["-C", "-f", "--file", "-j", "--directory", "-d", "-t", "--taskfile"])).filter((a) => !a.startsWith("-") && !a.includes("="))) {
      const hint = riskyHint(t);
      if (hint) return unsure(`${label} ${t}`, `run ${label} ${t}`, hint);
    }
  };

export const SCRIPT_RULES = {
  python: inlineRule,
  python3: inlineRule,
  node: inlineRule,
  ruby: inlineRule,
  perl: inlineRule,
  tsx: inlineRule,
  "ts-node": inlineRule,
  make: targets("make"),
  just: targets("just"),
  task: targets("task"),
  invoke: targets("invoke"),
  fab: targets("fab"),
  cap: targets("cap"),
  fastlane: targets("fastlane"),
  turbo: (args, ctx) => targets("turbo")(args[0] === "run" ? args.slice(1) : args, ctx),
  nx: (args, ctx) =>
    targets("nx")(
      args.flatMap((a) => a.split(":")),
      ctx,
    ),
  mise: (args, ctx) => (args[0] === "run" || args[0] === "r" ? targets("mise")(args.slice(1), ctx) : undefined),
};
