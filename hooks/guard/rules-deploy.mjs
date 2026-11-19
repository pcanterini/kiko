// The safety gate's rules for what deploys or publishes (../guard.mjs): hosting, cloud and payment
// CLIs (wrangler, vercel, netlify, fly, firebase, …: deploys, rollbacks, secrets and DNS),
// infrastructure tools (terraform, pulumi, kubectl, helm, …), the clouds' own CLIs, docker pushes and
// volume deletes, Stripe's writes; every package registry's publish (npm, JSR, PyPI, crates.io, …),
// app store uploads, and package scripts with a risky name (`pnpm run release`: unclear).
import { afterOptions, plainArgs } from "./parse.mjs";
import { SQL_DROP } from "./rules-local.mjs";
import { inlineRule, riskyHint } from "./rules-scripts.mjs";

// ── Hosting, cloud and payment CLIs ──────────────────────────────────────────

/** wrangler: deploys, and anything with "delete" in it. */
function wranglerRule(args, { hit, unsure, cmd }) {
  if (args.includes("--help") || args.includes("-h") || args.includes("--dry-run")) return;
  const plain = args.filter((a) => !a.startsWith("-"));
  const remote = args.includes("--remote");
  if (plain.includes("delete")) return hit("deletes", "wrangler delete", `delete with wrangler ${plain.slice(0, plain.indexOf("delete") + 1).join(" ")}`);
  const [a, b] = plain;
  if (a === "deploy" || a === "publish" || (a === "pages" && (b === "deploy" || b === "publish")) || (a === "versions" && (b === "deploy" || b === "upload")) || (a === "triggers" && b === "deploy"))
    return hit("posts", `wrangler ${a === "deploy" || a === "publish" ? a : `${a} ${b}`}`, "deploy with Wrangler");
  if (a === "rollback") return hit("posts", "wrangler rollback", "roll back a Worker");
  if (a === "secret" && (b === "put" || b === "bulk")) return hit("posts", "wrangler secret put", "set a Worker secret");
  if (a === "d1" && b === "migrations" && plain[2] === "apply" && remote) return hit("posts", "wrangler d1 migrations apply --remote", "apply database migrations to the live database");
  if (a === "d1" && b === "execute" && remote) {
    const sql = `${args.join(" ")}\n${cmd.heredoc ?? ""}`;
    if (SQL_DROP.test(sql)) return hit("deletes", "sql drop", "drop a database table");
    return unsure("wrangler d1 execute --remote", "run SQL on the live database", "deletes");
  }
  if ((a === "kv" || a === "r2") && plain.includes("put") && !args.includes("--local")) return unsure(`wrangler ${a} put`, `write to ${a === "kv" ? "a KV namespace" : "an R2 bucket"}`, "posts");
}

/** Vercel's own commands: any other first word is a folder to deploy (`vercel dist`). */
const VERCEL_COMMANDS = new Set(
  "dev env pull build link login logout ls list inspect logs whoami domains dns certs alias aliases project projects teams switch help init git integration integrations bisect blob secrets telemetry target install i open mcp curl httpstat flags microfrontends cache guidance api ai-gateway metrics agent upgrade webhooks routes firewall connect sandbox cron crons edge-config kms contract usage redirects activity skills update unlink remove rm".split(
    " ",
  ),
);
const VERCEL_DEPLOYS = new Set(["deploy", "redeploy", "promote", "rollback"]);
function vercelRule(args, { hit }) {
  if (args.some((a) => /^(--help|-h|--version|-v)$/.test(a))) return;
  const plain = plainArgs(
    args,
    new Set(["--token", "-t", "--scope", "-S", "--cwd", "--team", "-T", "-A", "--local-config", "-Q", "--global-config", "-e", "--env", "-b", "--build-env", "-m", "--meta", "--regions", "--target"]),
  );
  const [a, b] = plain;
  // `vercel` alone, or with a folder, deploys.
  if (a === undefined || VERCEL_DEPLOYS.has(a) || !VERCEL_COMMANDS.has(a)) {
    const what = a === "rollback" ? "roll back on Vercel" : args.includes("--prod") || a === "promote" ? "deploy to production on Vercel" : "deploy to Vercel";
    return hit("posts", VERCEL_DEPLOYS.has(a) ? `vercel ${a}` : "vercel", what);
  }
  if (a === "domains" && (b === "buy" || b === "transfer-in" || b === "renew")) return hit("pays", `vercel domains ${b}`, "buy a domain on Vercel");
  if (a === "remove" || a === "rm") return hit("deletes", "vercel remove", "delete a Vercel deployment");
  if ((a === "env" || a === "dns" || a === "domains" || a === "project" || a === "projects" || a === "alias" || a === "blob" || a === "certs") && (b === "rm" || b === "remove" || b === "del"))
    return hit("deletes", `vercel ${a} rm`, `delete a Vercel ${a === "env" ? "environment variable" : a === "dns" ? "DNS record" : a}`);
  if (a === "dns" && (b === "add" || b === "import")) return hit("posts", "vercel dns add", "change DNS on Vercel");
  if (a === "env" && (b === "add" || b === "update")) return hit("posts", "vercel env add", "set a Vercel environment variable");
  if (a === "alias" && b === "set") return hit("posts", "vercel alias set", "point a Vercel domain at a deployment");
  if (a === "domains" && b === "add") return hit("posts", "vercel domains add", "add a domain on Vercel");
}

/** A CLI's verb, by a table: first plain word (or first two) → [kind, what]. */
function table(rows, label) {
  return (args, { hit }) => {
    if (args.includes("--help") || args.includes("-h")) return;
    const plain = args.filter((a) => !a.startsWith("-"));
    for (let take = Math.min(3, plain.length); take >= 1; take--) {
      const key = plain.slice(0, take).join(" ");
      if (rows[key]) return hit(rows[key][0], `${label} ${key}`, rows[key][1]);
    }
    if (rows["*delete"] && plain.some((p) => /^(delete|destroy|remove|rm)$/.test(p))) return hit("deletes", `${label} delete`, `delete with ${label}`);
  };
}

function stripeRule(args, { hit }) {
  if (args.some((a) => /^(--help|-h|--version|-v)$/.test(a))) return;
  const plain = args.filter((a) => !a.startsWith("-"));
  const [a, b] = plain;
  if (!a || /^(get|listen|logs|login|logout|config|status|version|help|open|samples|completion|feedback|serve|whoami|plugin|apps|terminal|preview)$/.test(a)) return;
  if (/^(list|retrieve|search|get)$/.test(b ?? "")) return;
  hit("pays", `stripe ${a}${b ? ` ${b}` : ""}`, a === "post" || a === "delete" ? "make a Stripe API change" : `change Stripe: ${plain.slice(0, 2).join(" ")}`);
}

function awsRule(args, { hit, unsure }) {
  const plain = afterOptions(args, new Set(["--profile", "--region", "--output", "--endpoint-url", "--query", "--cli-read-timeout", "--cli-connect-timeout"])).filter((a) => !a.startsWith("-"));
  const [service, op] = plain;
  if (!service || !op) return;
  if (service === "s3") {
    if (op === "rm" || op === "rb") return hit("deletes", `aws s3 ${op}`, "delete from S3");
    if ((op === "cp" || op === "sync" || op === "mv") && /^s3:\/\//.test(plain[plain.length - 1] ?? "") && !args.includes("--dryrun")) return hit("posts", `aws s3 ${op}`, "upload to S3");
    return;
  }
  if (service === "route53domains" && /^(register-domain|transfer-domain|renew-domain)$/.test(op)) return hit("pays", `aws ${service} ${op}`, "register a domain");
  if (service === "route53" && op === "change-resource-record-sets") return hit("posts", "aws route53 change-resource-record-sets", "change DNS records");
  if (/^(delete|terminate|remove|deregister|purge)/.test(op)) return hit("deletes", `aws ${service} ${op}`, `delete with aws ${service} ${op}`);
  if (/^(send|publish)/.test(op)) return hit("sends", `aws ${service} ${op}`, `send with aws ${service} ${op}`);
  if (/deploy/.test(op) || (service === "lambda" && op.startsWith("update-function")) || (service === "ecs" && op === "update-service"))
    return hit("posts", `aws ${service} ${op}`, `deploy with aws ${service} ${op}`);
  if (/^(create|put|update|modify|change|attach|run|start|stop|reboot|invoke)/.test(op)) unsure(`aws ${service} ${op}`, `change AWS: ${service} ${op}`, "posts");
}

function gcloudRule(args, { hit }) {
  const plain = args.filter((a) => !a.startsWith("-"));
  const line = plain.join(" ");
  if (/\bdomains registrations (register|transfer|renew)/.test(line)) return hit("pays", "gcloud domains register", "register a domain");
  if (plain.includes("delete")) return hit("deletes", "gcloud delete", `delete with gcloud ${plain.slice(0, plain.indexOf("delete")).join(" ")}`);
  if (plain.includes("deploy")) return hit("posts", "gcloud deploy", `deploy with gcloud ${plain.slice(0, plain.indexOf("deploy")).join(" ")}`);
  if (/\bdns record-sets (create|update|transaction execute)/.test(line)) return hit("posts", "gcloud dns", "change DNS records");
  if (/\bpubsub topics publish/.test(line)) return hit("sends", "gcloud pubsub publish", "publish a Pub/Sub message");
}

function kubectlRule(args, { hit }) {
  const plain = afterOptions(args, new Set(["-n", "--namespace", "--context", "--cluster", "--kubeconfig", "-s", "--server", "--user"])).filter((a) => !a.startsWith("-"));
  const [a, b] = plain;
  if (args.some((x) => x === "--dry-run" || x.startsWith("--dry-run="))) return;
  if (a === "delete" || a === "drain") return hit("deletes", `kubectl ${a}`, `delete with kubectl ${plain.slice(0, 2).join(" ")}`);
  if (/^(apply|create|replace|patch|scale|set|edit|annotate|label|expose|run|autoscale|cordon|taint)$/.test(a ?? "") || (a === "rollout" && /^(restart|undo|resume)$/.test(b ?? "")))
    return hit("posts", `kubectl ${a}`, `change the cluster: kubectl ${plain.slice(0, 2).join(" ")}`);
}

function dockerRule(args, { hit }) {
  const plain = args.filter((a) => !a.startsWith("-"));
  const [a, b] = plain;
  if (a === "push" || (a === "image" && b === "push") || (a === "buildx" && b === "build" && args.includes("--push"))) return hit("posts", "docker push", "push an image to a registry");
  if ((a === "volume" && (b === "rm" || b === "prune")) || (a === "system" && b === "prune" && args.includes("--volumes")))
    return hit("deletes", `docker ${a} ${b}`, "delete Docker volumes and their data");
  if (a === "compose" && b === "down" && args.some((x) => x === "-v" || x === "--volumes")) return hit("deletes", "docker compose down -v", "delete Docker volumes and their data");
}

export const CLOUD_RULES = {
  wrangler: wranglerRule,
  vercel: vercelRule,
  vc: vercelRule,
  stripe: stripeRule,
  aws: awsRule,
  gcloud: gcloudRule,
  kubectl: kubectlRule,
  docker: dockerRule,
  podman: dockerRule,
  supabase: (args, { hit, unsure }) => {
    const line = args.filter((a) => !a.startsWith("-")).join(" ");
    if (/^db reset/.test(line) && args.includes("--linked")) return hit("deletes", "supabase db reset --linked", "reset the live database");
    if (/^(db push|functions deploy|secrets set)/.test(line)) return hit("posts", `supabase ${line.split(" ").slice(0, 2).join(" ")}`, `deploy with supabase ${line.split(" ").slice(0, 2).join(" ")}`);
    if (/\bdelete\b/.test(line)) return hit("deletes", "supabase delete", "delete with supabase");
    if (/^projects create/.test(line)) unsure("supabase projects create", "create a Supabase project", "pays");
  },
  netlify: table(
    {
      deploy: ["posts", "deploy to Netlify"],
      "sites:delete": ["deletes", "delete a Netlify site"],
      "env:set": ["posts", "set a Netlify environment variable"],
      "env:unset": ["deletes", "delete a Netlify environment variable"],
    },
    "netlify",
  ),
  fly: table(
    {
      deploy: ["posts", "deploy to Fly"],
      launch: ["posts", "launch an app on Fly"],
      "secrets set": ["posts", "set a Fly secret"],
      "secrets import": ["posts", "set Fly secrets"],
      "secrets unset": ["posts", "remove a Fly secret"],
      "scale count": ["posts", "scale a Fly app"],
      "certs add": ["posts", "add a certificate on Fly"],
      destroy: ["deletes", "destroy a Fly app"],
      "apps destroy": ["deletes", "destroy a Fly app"],
      "apps create": ["posts", "create a Fly app"],
      "*delete": ["deletes", ""],
    },
    "fly",
  ),
  flyctl: (args, ctx) => CLOUD_RULES.fly(args, ctx),
  firebase: table(
    {
      deploy: ["posts", "deploy to Firebase"],
      "hosting:disable": ["posts", "turn off Firebase hosting"],
      "hosting:channel:deploy": ["posts", "deploy a Firebase preview"],
      "*delete": ["deletes", ""],
    },
    "firebase",
  ),
  heroku: table(
    {
      "releases:rollback": ["posts", "roll back a Heroku app"],
      "config:set": ["posts", "set Heroku config"],
      "apps:destroy": ["deletes", "destroy a Heroku app"],
      "apps:create": ["posts", "create a Heroku app"],
    },
    "heroku",
  ),
  railway: table(
    {
      up: ["posts", "deploy to Railway"],
      deploy: ["posts", "deploy to Railway"],
      redeploy: ["posts", "redeploy on Railway"],
      down: ["deletes", "remove a Railway deployment"],
      delete: ["deletes", "delete a Railway project"],
    },
    "railway",
  ),
  terraform: table({ apply: ["posts", "apply infrastructure changes"], destroy: ["deletes", "destroy infrastructure"], import: ["posts", "import infrastructure"] }, "terraform"),
  tofu: (args, ctx) => CLOUD_RULES.terraform(args, ctx),
  pulumi: table({ up: ["posts", "apply infrastructure changes"], update: ["posts", "apply infrastructure changes"], destroy: ["deletes", "destroy infrastructure"] }, "pulumi"),
  cdk: table({ deploy: ["posts", "deploy with CDK"], destroy: ["deletes", "destroy a CDK stack"] }, "cdk"),
  serverless: table({ deploy: ["posts", "deploy with Serverless"], remove: ["deletes", "remove a Serverless service"] }, "serverless"),
  sls: (args, ctx) => CLOUD_RULES.serverless(args, ctx),
  helm: table(
    {
      install: ["posts", "install a Helm chart"],
      upgrade: ["posts", "upgrade a Helm release"],
      rollback: ["posts", "roll back a Helm release"],
      uninstall: ["deletes", "uninstall a Helm release"],
      delete: ["deletes", "uninstall a Helm release"],
    },
    "helm",
  ),
  az: (args, { hit }) => {
    const plain = args.filter((a) => !a.startsWith("-"));
    if (plain.includes("delete")) return hit("deletes", "az delete", `delete with az ${plain.slice(0, plain.indexOf("delete")).join(" ")}`);
    if (plain.some((p) => p === "deploy" || p === "up")) hit("posts", "az deploy", "deploy to Azure");
  },
  doctl: (args, { hit }) => {
    const plain = args.filter((a) => !a.startsWith("-"));
    if (plain.includes("delete")) return hit("deletes", "doctl delete", `delete with doctl ${plain.slice(0, plain.indexOf("delete")).join(" ")}`);
    if (plain.includes("create-deployment")) return hit("posts", "doctl deploy", "deploy on DigitalOcean");
    if (plain[0] === "compute" && plain[1] === "domain" && plain[2] === "records") hit("posts", "doctl dns", "change DNS records");
  },
  eas: table({ submit: ["posts", "submit an app to the stores"], update: ["posts", "publish an over-the-air update"] }, "eas"),
  expo: table({ publish: ["posts", "publish an Expo update"] }, "expo"),
};

// ── Package managers and registries ──────────────────────────────────────────

/** Package managers' options that take a value (pnpm --filter app run deploy). */
const PM_VALUE = new Set(["--filter", "-F", "-C", "--dir", "--prefix", "--workspace", "--cwd", "--tag", "--access", "--otp", "--registry", "--reporter", "--loglevel"]);

const publish =
  (where) =>
  (args, { hit, name }) => {
    const plain = plainArgs(args, PM_VALUE);
    if (args.includes("--dry-run") || args.includes("--help")) return;
    if (plain[0] === "publish") return hit("posts", `${name} publish`, `publish to ${where}`);
    if (plain[0] === "unpublish") return hit("deletes", `${name} unpublish`, `unpublish from ${where}`);
    if (plain[0] === "deprecate" || (plain[0] === "dist-tag" && /^(add|rm)$/.test(plain[1] ?? ""))) return hit("posts", `${name} ${plain[0]}`, `change a package on ${where}`);
  };

// npm run X, pnpm X / pnpm run X, yarn X / yarn run X, bun run X: unclear when X is risky.
const PM_BUILTINS = new Set([
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "up",
  "upgrade",
  "ci",
  "test",
  "t",
  "start",
  "build",
  "outdated",
  "ls",
  "list",
  "why",
  "audit",
  "init",
  "create",
  "link",
  "unlink",
  "pack",
  "info",
  "view",
  "config",
  "store",
  "prune",
  "dedupe",
  "rebuild",
  "env",
  "help",
  "version",
  "login",
  "logout",
  "whoami",
  "cache",
  "exec",
  "dlx",
  "x",
  "fund",
  "doctor",
  "explain",
  "query",
  "search",
  "setup",
  "import",
  "patch",
  "patch-commit",
  "licenses",
  "lint",
  "format",
  "check",
  "typecheck",
  "dev",
  "serve",
  "preview",
  "watch",
  "clean",
]);
/** npm run X, pnpm X, yarn X, bun run X: the script, and the kind its name suggests, when it's risky. */
function packageScript(name, plain) {
  let script = "";
  if (plain[0] === "run" || plain[0] === "run-script") script = plain[1] ?? "";
  else if (name !== "npm" && plain[0] && !PM_BUILTINS.has(plain[0])) script = plain[0];
  if (!script) return;
  const hint = riskyHint(script);
  if (hint) return { script, hint };
}

/** A package manager's rule (`base`), then any other subcommand (not one of `own`) as a package script: unclear when it's risky. */
const withScripts = (pm, base, own) => (args, ctx) => {
  base(args, ctx);
  const plain = plainArgs(args, PM_VALUE);
  if (own.includes(plain[0])) return;
  const s = packageScript(pm, plain);
  if (s) ctx.unsure(`${pm} run ${s.script}`, `run ${pm} ${s.script}`, s.hint);
};

export const PACKAGE_RULES = {
  npm: withScripts("npm", publish("npm"), ["publish", "unpublish"]),
  pnpm: withScripts("pnpm", publish("npm"), ["publish", "unpublish"]),
  yarn: withScripts("yarn", (args, ctx) => (args[0] === "npm" && args[1] === "publish" ? ctx.hit("posts", "yarn npm publish", "publish to npm") : publish("npm")(args, ctx)), ["publish", "npm"]),
  bun: withScripts("bun", publish("npm"), ["publish", "unpublish"]),
  jsr: publish("JSR"),
  deno: (args, ctx) => (args[0] === "publish" ? publish("JSR")(args, ctx) : inlineRule(args, ctx)),
  twine: (args, { hit }) => args.includes("upload") && hit("posts", "twine upload", "publish to PyPI"),
  poetry: (args, { hit }) => args[0] === "publish" && !args.includes("--dry-run") && hit("posts", "poetry publish", "publish to PyPI"),
  uv: (args, { hit }) => args[0] === "publish" && hit("posts", "uv publish", "publish to PyPI"),
  flit: (args, { hit }) => args[0] === "publish" && hit("posts", "flit publish", "publish to PyPI"),
  hatch: (args, { hit }) => args[0] === "publish" && hit("posts", "hatch publish", "publish to PyPI"),
  pdm: (args, { hit }) => args[0] === "publish" && hit("posts", "pdm publish", "publish to PyPI"),
  cargo: (args, { hit }) =>
    args[0] === "publish" && !args.includes("--dry-run") ? hit("posts", "cargo publish", "publish to crates.io") : args[0] === "yank" ? hit("posts", "cargo yank", "yank a crate version") : undefined,
  gem: (args, { hit }) => (args[0] === "push" ? hit("posts", "gem push", "publish to RubyGems") : args[0] === "yank" ? hit("posts", "gem yank", "yank a gem version") : undefined),
  pod: (args, { hit }) => args[0] === "trunk" && args[1] === "push" && hit("posts", "pod trunk push", "publish to CocoaPods"),
  dotnet: (args, { hit }) => args[0] === "nuget" && args[1] === "push" && hit("posts", "dotnet nuget push", "publish to NuGet"),
  mvn: (args, { hit }) => args.includes("deploy") && hit("posts", "mvn deploy", "publish with Maven"),
  gradle: (args, { hit }) => args.some((a) => /^publish/.test(a)) && hit("posts", "gradle publish", "publish with Gradle"),
  gradlew: (args, ctx) => PACKAGE_RULES.gradle(args, ctx),
  vsce: (args, { hit }) => args[0] === "publish" && hit("posts", "vsce publish", "publish a VS Code extension"),
  ovsx: (args, { hit }) => args[0] === "publish" && hit("posts", "ovsx publish", "publish a VS Code extension"),
  changeset: (args, { hit }) => args[0] === "publish" && hit("posts", "changeset publish", "publish packages"),
  lerna: (args, { hit }) => args[0] === "publish" && hit("posts", "lerna publish", "publish packages"),
  "semantic-release": (args, { hit }) => !args.includes("--dry-run") && hit("posts", "semantic-release", "publish a release"),
  goreleaser: (args, { hit }) => args[0] === "release" && !args.includes("--snapshot") && hit("posts", "goreleaser release", "publish a release"),
  "gh-pages": (_args, { hit }) => hit("posts", "gh-pages", "publish to GitHub Pages"),
  surge: (_args, { hit }) => hit("posts", "surge", "publish a site with Surge"),
  altool: (args, { hit }) => args.some((a) => /^--upload-(app|package)$/.test(a)) && hit("posts", "altool upload", "upload a build to App Store Connect"),
  mas: (args, { hit }) => args[0] === "purchase" && hit("pays", "mas purchase", "buy an app"),
};
