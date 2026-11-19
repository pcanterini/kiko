// Kiko's safety gate: the rules (hooks/guard.mjs: the shell parser, the commands that send, delete,
// pay or post, MCP tools by name) and the verdict (src/core/guard.ts: settings, the classifier for
// unclear calls, the mark on the prompt that follows). Real commands agents run, both ways: the ones
// that must ask, and the false alarms that mustn't.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { checkCommand, checkMcp, guardCheck, parseShell, safeToRemove, serverName, unwrap } from "../../../hooks/guard.mjs";
import type { Held } from "../../../src/agents/types.ts";
import {
  decideGuard,
  forgetClassified,
  forgetPending,
  guardCheckOf,
  guardLine,
  guardOf,
  guardOffOf,
  guardOn,
  guardReason,
  guardValue,
  guardWhat,
  noteGuard,
  type GuardCheck,
} from "../../../src/core/guard.ts";
import { config } from "../../../src/core/config.ts";
import { guardChoices } from "../../../src/core/settings-options.ts";

const PROJECT = "/Users/me/git/pixie";
/** The first sure kind of a command, "unclear" when it only looks risky, or null. */
function kindOf(command: string, cwd = PROJECT): string | null {
  const found = checkCommand(command, cwd);
  if (!found) return null;
  return found.hits[0]?.kind ?? "unclear";
}
const whatOf = (command: string, cwd = PROJECT) => {
  const f = checkCommand(command, cwd);
  return f?.hits[0]?.what ?? f?.unclear[0]?.what;
};

describe("the shell parser", () => {
  const names = (src: string) => parseShell(src).map((c) => unwrap(c.words)[0]);
  test("splits on && || ; | & and newlines", () => {
    assert.deepEqual(names("cd x && pnpm test || echo no; ls | wc -l & sleep 1\ngit status"), ["cd", "pnpm", "echo", "ls", "wc", "sleep", "git"]);
  });
  test("quotes make one word, never a command", () => {
    assert.deepEqual(parseShell(`echo "git push && rm -rf /" 'npm publish'`), [{ words: ["echo", "git push && rm -rf /", "npm publish"] }]);
  });
  test("$(…), backticks, <(…) and subshells are commands of their own, in double quotes too", () => {
    assert.deepEqual(names('echo "$(git push)" `npm publish` && diff <(ls) x && (cd y && wrangler deploy)'), ["git", "npm", "echo", "ls", "diff", "cd", "wrangler"]);
  });
  test("$((arithmetic)) and ${VAR} aren't commands", () => {
    assert.deepEqual(names("echo $((1 + 2)) ${HOME}"), ["echo"]);
  });
  test("redirections and their files are left out, fds too", () => {
    // The files written to are kept apart (`writes`), for the quick check's guard (read-only.mjs).
    assert.deepEqual(parseShell("pnpm test > out.log 2>&1 < in.txt"), [{ words: ["pnpm", "test"], writes: ["out.log"] }]);
    assert.deepEqual(parseShell("ls >/dev/null 2>&1 >>log.txt &>all.txt; cat <in.txt <<<word"), [{ words: ["ls"], writes: ["/dev/null", "log.txt", "all.txt"] }, { words: ["cat"] }]);
  });
  test("comments are skipped", () => {
    assert.deepEqual(names("# git push later\nls # then rm -rf /"), ["ls"]);
  });
  test("a heredoc's text is kept on its command, never run", () => {
    const cmds = parseShell("cat > notes.md <<'EOF'\ngit push --force\nrm -rf ~\nEOF\nls");
    assert.deepEqual(cmds, [{ words: ["cat"], writes: ["notes.md"], heredoc: "git push --force\nrm -rf ~" }, { words: ["ls"] }]);
  });
  test("prefixes that only run what follows are taken off", () => {
    for (const [line, rest] of [
      ["sudo -E -u deploy NODE_ENV=prod git push", ["git", "push"]],
      ["env -i A=1 B=2 npm publish", ["npm", "publish"]],
      ["FOO=1 BAR=2 vercel --prod", ["vercel", "--prod"]],
      ["nohup time nice -n 5 timeout 30 wrangler deploy", ["wrangler", "deploy"]],
      ["npx -y wrangler@3.2.1 deploy", ["wrangler", "deploy"]],
      ["pnpm dlx @cloudflare/wrangler deploy", ["wrangler", "deploy"]],
      ["pnpm exec vercel deploy", ["vercel", "deploy"]],
      ["bunx vercel", ["vercel"]],
      ["uv run --with x twine upload", ["twine", "upload"]],
      ["op run --env-file .env -- stripe charges create", ["stripe", "charges", "create"]],
      ["xargs -0 -n1 rm -rf", ["rm", "-rf"]],
      ["command git push", ["git", "push"]],
    ] as const) {
      const [cmd] = parseShell(line);
      assert.deepEqual(unwrap(cmd.words), rest, line);
    }
  });
});

describe("posts", () => {
  test("git push, wherever it is in the line", () => {
    for (const c of [
      "git push",
      "git push origin main",
      "git -C ../app push",
      "cd app && git push -u origin feat",
      "git add . && git commit -m 'x' && git push",
      "sudo git push",
      'bash -c "git push"',
      "sh -lc 'cd x; git push'",
      "echo $(git push 2>&1)",
      "ssh build 'git push'",
    ])
      assert.equal(kindOf(c), "posts", c);
  });
  test("a force push says so; a delete is a delete", () => {
    assert.match(whatOf("git push --force-with-lease")!, /^force-push/);
    assert.match(whatOf("git push -f origin main")!, /^force-push/);
    assert.match(whatOf("git push origin +main")!, /^force-push/);
    assert.equal(kindOf("git push origin --delete old"), "deletes");
    assert.equal(kindOf("git push origin :old"), "deletes");
  });
  test("git push --dry-run doesn't ask: it only asks the remote, which doesn't change", () => {
    assert.equal(kindOf("git push --dry-run"), null);
    assert.equal(kindOf("git push -n origin main"), null);
  });
  test("names the remote's host from the repo's .git/config, found on a hit only", () => {
    const repo = mkdtempSync(join(tmpdir(), "guard-repo-"));
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:me/pixie.git\n[remote "lab"]\n\turl = https://gitlab.com/me/pixie.git\n');
    mkdirSync(join(repo, "src"));
    assert.equal(whatOf("git push", join(repo, "src")), "push to GitHub");
    assert.equal(whatOf("git push lab main", repo), "push to GitLab");
    assert.equal(whatOf("git push", "/nonexistent/x"), "push to its git remote");
  });
  test("deploys and publishes", () => {
    for (const c of [
      "wrangler deploy",
      "npx wrangler deploy --env production",
      "wrangler pages deploy dist",
      "wrangler versions upload",
      "vercel",
      "vercel --prod",
      "vercel deploy --prebuilt",
      "vercel ./dist",
      "fly deploy",
      "flyctl deploy --remote-only",
      "netlify deploy --prod",
      "firebase deploy --only hosting",
      "railway up",
      "npm publish",
      "pnpm publish --access public",
      "pnpm -r publish",
      "yarn npm publish",
      "bun publish",
      "twine upload dist/*",
      "python -m twine upload dist/*",
      "python3 -m twine upload dist/*",
      "uv publish",
      "poetry publish --build",
      "cargo publish",
      "gem push pixie-1.0.gem",
      "docker push me/pixie:latest",
      "kubectl apply -f k8s/",
      "helm upgrade pixie ./chart",
      "terraform apply -auto-approve",
      "pulumi up --yes",
      "cdk deploy",
      "gh pr merge 12 --squash",
      "gh pr create --fill",
      "gh release create v1.0.0",
      "gh workflow run deploy.yml",
      "aws s3 sync dist s3://pixie-site",
      "gcloud run deploy pixie --source .",
      "rsync -av dist/ me@web1:/var/www/pixie",
      "scp build.tgz web1:/tmp/",
      "vercel dns add pixie.dev @ A 1.2.3.4",
      "aws route53 change-resource-record-sets --hosted-zone-id Z --change-batch file://c.json",
      "eas update --branch production",
      "supabase functions deploy hello",
      "if git push; then echo ok; fi",
    ])
      assert.equal(kindOf(c), "posts", c);
  });
  test("their read-only cousins don't ask", () => {
    for (const c of [
      "wrangler dev",
      "wrangler tail",
      "wrangler deploy --dry-run",
      "vercel ls",
      "vercel logs x",
      "vercel env pull",
      "vercel --version",
      "vercel whoami",
      "npm publish --dry-run",
      "gh pr view 12",
      "gh pr list",
      "gh pr checks",
      "gh run view 1",
      "gh issue list",
      "kubectl get pods",
      "kubectl apply --dry-run=client -f x",
      "terraform plan",
      "docker build -t x .",
      "docker run x",
      "aws s3 ls",
      "aws s3 cp s3://b/x .",
      "gcloud run services list",
      "helm list",
      "scp web1:/var/log/x .",
      "rsync -av a/ b/",
    ])
      assert.equal(kindOf(c), null, c);
  });
});

describe("deletes", () => {
  test("rm -r outside build output, in any spelling", () => {
    for (const c of [
      "rm -rf ~/Documents/old",
      "rm -r src",
      "rm -Rf ./",
      "rm -fr .",
      "rm --recursive --force docs",
      "rm -rf $DIR",
      "rm -rf *",
      "rm -rf ../other",
      "sudo rm -rf /var/lib/app",
      "rm -rf node_modules ~/x",
      "find . -name '*.log' -delete",
      "find . -type d -exec rm -rf {} +",
    ])
      assert.equal(kindOf(c), "deletes", c);
  });
  test("rm -rf of build output and caches inside the project, or of the temp folders, doesn't ask", () => {
    // A build or an install makes them again; agents clear them all day; asking would teach "yes" by reflex.
    for (const c of [
      "rm -rf node_modules",
      "rm -rf node_modules package-lock.json",
      "rm -rf dist build .next",
      "rm -rf ./dist/",
      "rm -rf packages/*/node_modules",
      "rm -rf apps/web/.next/cache",
      "rm -rf target",
      "rm -rf __pycache__ .pytest_cache",
      "rm -rf /tmp/pixie-test",
      "rm -rf $TMPDIR/x",
      `rm -rf ${PROJECT}/node_modules`,
      "rm file.txt",
      "rm -f a.log b.log",
    ])
      assert.equal(kindOf(c), null, c);
  });
  test("safeToRemove: what counts as build output", () => {
    assert.equal(safeToRemove("node_modules", PROJECT), true);
    assert.equal(safeToRemove("node_modules/../src", PROJECT), false);
    assert.equal(safeToRemove("*/dist", PROJECT), false);
    assert.equal(safeToRemove("/Users/me/git/other/dist", PROJECT), false);
    assert.equal(safeToRemove("~/dist", PROJECT), false);
    assert.equal(safeToRemove("/tmp/../etc", PROJECT), false);
  });
  test("branches, tables, clouds", () => {
    for (const c of [
      "git branch -D feature",
      "git branch --delete --force old",
      "git branch -df old",
      "git clean -fdx",
      'psql $DB -c "DROP TABLE users"',
      "sqlite3 app.db 'drop table sessions;'",
      'mysql -e "TRUNCATE TABLE logs"',
      'psql -c "DELETE FROM users;"',
      "psql <<SQL\nDROP DATABASE pixie;\nSQL",
      "wrangler d1 execute db --remote --command 'DROP TABLE x'",
      "wrangler kv namespace delete --namespace-id x",
      "wrangler r2 bucket delete assets",
      "wrangler delete",
      "dropdb pixie",
      "redis-cli FLUSHALL",
      "npx prisma migrate reset --force",
      "aws s3 rm s3://b --recursive",
      "aws ec2 terminate-instances --instance-ids i-1",
      "gcloud compute instances delete vm1",
      "kubectl delete deployment pixie",
      "terraform destroy",
      "gh repo delete me/old --yes",
      "vercel remove pixie-abc",
      "docker volume rm pgdata",
      "fly apps destroy pixie",
      "curl -X DELETE https://api.example.com/v1/items/3",
    ])
      assert.equal(kindOf(c), "deletes", c);
  });
  test("their safe cousins don't ask", () => {
    for (const c of [
      "git branch -d merged",
      "git branch -a",
      "git clean -n",
      "git clean -fdn",
      'psql -c "SELECT * FROM users"',
      'psql -c "DELETE FROM users WHERE id = 3"',
      "docker rm abc",
      "redis-cli GET x",
      "npx prisma migrate dev",
      "git stash drop",
    ])
      assert.equal(kindOf(c), null, c);
  });
});

describe("sends", () => {
  test("POSTs to other hosts, mail, comments", () => {
    for (const c of [
      'curl -X POST https://hooks.slack.com/services/T/B/x -d \'{"text":"hi"}\'',
      "curl -d @payload.json https://api.example.com/hook",
      "curl --data-raw x example.com/api",
      "curl -XPUT https://api.example.com/x",
      "curl -F file=@a.png https://upload.example.com",
      "curl --json '{}' https://api.example.com",
      "curl -X POST $WEBHOOK_URL",
      'wget --post-data "a=1" https://example.com/x',
      "http POST api.example.com/x name=me",
      "http api.example.com/x name=me",
      "gh pr comment 12 --body 'done'",
      "gh issue comment 3 -b 'fixed'",
      "gh pr review 12 --approve",
      "gh api repos/me/pixie/issues/3/comments -f body=hi",
      "gh api graphql -f query='mutation { addStar(input: {}) { clientMutationId } }'",
      "echo hi | mail -s test me@example.com",
      "sendmail me@example.com < msg.txt",
      "git send-email HEAD~1",
      `osascript -e 'tell application "Messages" to send "hi" to buddy "Ana"'`,
      "aws ses send-email --from a --to b",
      "aws sns publish --topic-arn x --message hi",
    ])
      assert.equal(kindOf(c), "sends", c);
  });
  test("the message says what it is, by the host", () => {
    assert.equal(whatOf("curl -X POST https://hooks.slack.com/x -d a"), "send a Slack message");
    assert.equal(whatOf("curl -d x https://api.sendgrid.com/v3/mail/send"), "send an email");
    assert.equal(whatOf("curl -d x https://api.example.com/hook"), "send a POST request to api.example.com");
  });
  test("GETs, local hosts, and reads through gh don't ask", () => {
    for (const c of [
      "curl https://example.com",
      "curl -fsSL https://get.example.com/install.sh -o i.sh",
      "curl -I https://example.com",
      "curl -G -d q=x https://api.example.com/search",
      "curl -X POST http://localhost:3000/api/x -d a",
      "curl -d a http://127.0.0.1:8787/",
      "curl --unix-socket /tmp/x.sock -X POST http://x/y",
      "http :3000/x name=me",
      "http GET api.example.com/x q==1",
      "gh api repos/me/pixie/pulls",
      "gh api graphql -f query='query { viewer { login } }'",
      "wget https://example.com/x.tgz",
    ])
      assert.equal(kindOf(c), null, c);
  });
});

describe("pays", () => {
  test("Stripe's CLI writes, payment APIs, purchases, domains", () => {
    for (const c of [
      "stripe customers create --email a@b.c",
      "stripe charges create --amount 100 --currency usd",
      "stripe subscriptions cancel sub_1",
      "stripe post /v1/refunds -d charge=ch_1",
      "stripe trigger payment_intent.succeeded",
      "curl https://api.stripe.com/v1/charges -u sk_test_x: -d amount=100",
      "curl -X POST https://api-m.paypal.com/v2/checkout/orders",
      "vercel domains buy pixie.dev",
      "aws route53domains register-domain --domain-name pixie.dev",
      "mas purchase 497799835",
    ])
      assert.equal(kindOf(c), "pays", c);
  });
  test("Stripe's reads don't ask", () => {
    for (const c of [
      "stripe customers list",
      "stripe charges retrieve ch_1",
      "stripe listen --forward-to localhost:3000",
      "stripe logs tail",
      "stripe login",
      "stripe get /v1/charges",
      "stripe --version",
      "curl https://api.stripe.com/v1/charges -u sk_test_x:",
    ])
      assert.equal(kindOf(c), null, c);
  });
});

describe("false alarms", () => {
  test("words in arguments of ordinary commands", () => {
    for (const c of [
      'echo "git push"',
      "echo git push",
      "grep deploy src",
      "grep -rn 'npm publish' .",
      "rg 'rm -rf' docs",
      "git log --grep=deploy",
      "git commit -m 'deploy: fix the push'",
      "cat deploy.sh",
      "ls deploy/",
      "less scripts/release.sh",
      "sed -n 1,20p send_email.py",
      "printf 'curl -X POST x\\n'",
      "code scripts/deploy.sh",
      "pnpm test",
      "pnpm check",
      "npm run build",
      "node --test 'tests/**/*.test.ts'",
      "python -m pytest -k deploy",
      "git status && git diff",
      "git fetch && git rebase origin/main",
      "make",
      "make test",
      "tmux -L x ls",
      "cat > deploy-notes.md <<'EOF'\ngit push --force\nEOF",
    ])
      assert.equal(kindOf(c), null, c);
  });
});

describe("unclear: the classifier's to decide", () => {
  test("scripts, package scripts and make targets whose names are risky", () => {
    for (const [c, hint] of [
      ["./deploy.sh", "posts"],
      ["bash scripts/release.sh", "posts"],
      ["sh ./scripts/publish-site", "posts"],
      ["python send_email.py", "sends"],
      ["node scripts/charge-customers.mjs", "pays"],
      ["npm run deploy", "posts"],
      ["pnpm deploy:prod", "posts"],
      ["pnpm --filter web run release", "posts"],
      ["yarn release", "posts"],
      ["bun run db:drop", "deletes"],
      ["make deploy", "posts"],
      ["just release", "posts"],
      ["acme-cli deploy prod", "posts"],
      ["python -c \"import requests; requests.post('https://x', json={})\"", "sends"],
      ["node -e \"fetch('https://x', { method: 'POST' })\"", "sends"],
    ] as const) {
      const f = checkCommand(c, PROJECT);
      assert.ok(f && !f.hits.length && f.unclear.length, c);
      assert.equal(f!.unclear[0].hint, hint, c);
    }
  });
  test("a sure hit beside an unclear one is a hit", () => {
    const f = checkCommand("pnpm build && ./deploy.sh && git push", PROJECT)!;
    assert.equal(f.hits[0].kind, "posts");
    assert.equal(f.unclear.length, 1);
  });
});

describe("MCP tools, by name", () => {
  const kind = (tool: string) => {
    const f = checkMcp(tool, { a: 1 });
    return f ? (f.hits[0]?.kind ?? "unclear") : null;
  };
  test("server names as said", () => {
    assert.equal(serverName("plugin_vercel_vercel"), "vercel");
    assert.equal(serverName("plugin_cloudflare_cloudflare-api"), "cloudflare-api");
    assert.equal(serverName("claude_ai_Gmail"), "Gmail");
    assert.equal(serverName("github"), "github");
  });
  test("each kind", () => {
    for (const [tool, k] of [
      ["mcp__claude_ai_Slack__slack_send_message", "sends"],
      ["mcp__slack__chat_post_message", "sends"],
      ["mcp__claude_ai_Gmail__send_email", "sends"],
      ["mcp__github__add_issue_comment", "sends"],
      ["mcp__plugin_vercel_vercel__reply_to_toolbar_thread", "sends"],
      ["mcp__stripe__create_payment_intent", "pays"],
      ["mcp__stripe__create_refund", "pays"],
      ["mcp__plugin_vercel_vercel__buy_domain", "pays"],
      ["mcp__plugin_vercel_vercel__create_or_transfer_domain", "pays"],
      ["mcp__github__delete_file", "deletes"],
      ["mcp__linear__remove_issue", "deletes"],
      ["mcp__plugin_vercel_vercel__create_deployment", "posts"],
      ["mcp__plugin_vercel_vercel__start_rolling_release", "posts"],
      ["mcp__plugin_vercel_vercel__create_record", "posts"],
      ["mcp__plugin_vercel_vercel__replace_domain_dns_records", "posts"],
      ["mcp__github__merge_pull_request", "posts"],
      ["mcp__github__create_pull_request", "posts"],
      ["mcp__github__push_files", "posts"],
      ["mcp__twitter__post_tweet", "posts"],
    ] as const)
      assert.equal(kind(tool), k, tool);
  });
  test("reads, local servers and plain tools don't ask; other writes are unclear", () => {
    for (const tool of [
      "mcp__plugin_vercel_vercel__get_deployment",
      "mcp__plugin_vercel_vercel__list_deployments",
      "mcp__plugin_vercel_vercel__get_domain_price",
      "mcp__plugin_vercel_vercel__record_events",
      "mcp__stripe__list_payment_intents",
      "mcp__github__search_code",
      "mcp__playwright__browser_click",
      "mcp__playwright__browser_navigate",
      "mcp__filesystem__write_file",
      "mcp__memory__create_entities",
      "mcp__claude_ai_Claude_Docs__batch",
      "mcp__claude_ai_Claude_Docs__update",
    ])
      assert.equal(kind(tool), null, tool);
    for (const tool of ["mcp__linear__create_issue", "mcp__plugin_vercel_vercel__update_firewall_config", "mcp__plugin_cloudflare_cloudflare-api__execute", "mcp__notion__update_page"])
      assert.equal(kind(tool), "unclear", tool);
  });
  test("an unclear MCP call carries its arguments, short, for the classifier", () => {
    const f = checkMcp("mcp__linear__create_issue", { title: "x".repeat(1000) })!;
    assert.ok(f.unclear[0].args!.length <= 601);
  });
});

describe("guardCheck: which tools", () => {
  test("shell tools by command (Claude Code's Bash and Monitor, Codex's argv), MCP by name, nothing else", () => {
    assert.equal(guardCheck("Bash", { command: "git push" }, PROJECT)?.hits[0].kind, "posts");
    assert.equal(guardCheck("Monitor", { command: "while true; do curl -d x https://h.example.com; sleep 5; done" }, PROJECT)?.hits[0].kind, "sends");
    assert.equal(guardCheck("Bash", { command: ["bash", "-lc", "npm publish"] }, PROJECT)?.hits[0].kind, "posts");
    assert.equal(guardCheck("Bash", { command: ["git", "push"] }, PROJECT)?.hits[0].kind, "posts");
    assert.equal(guardCheck("mcp__stripe__create_refund", {}, PROJECT)?.hits[0].kind, "pays");
    for (const [tool, input] of [
      ["Read", { file_path: "/x/deploy.sh" }],
      ["Edit", { file_path: "x", old_string: "a", new_string: "git push" }],
      ["Write", { file_path: "deploy.sh", content: "git push --force" }],
      ["WebFetch", { url: "https://x" }],
      ["apply_patch", { command: "*** Update File: x\n+git push" }],
      ["Bash", {}],
      [42, {}],
    ] as const)
      assert.equal(guardCheck(tool, input, PROJECT), null, String(tool));
  });
  test("a very long command (a heredoc writing a big file) is still quick", () => {
    const big = `cat > big.txt <<'EOF'\n${"git push --force\n".repeat(20000)}EOF\nls`;
    const start = performance.now();
    assert.equal(kindOf(big), null);
    assert.ok(performance.now() - start < 200);
  });
});

// ── The verdict ──

const check = (over: Partial<GuardCheck> = {}): GuardCheck => ({
  agent: "claude-code",
  sessionId: "s-1",
  cwd: PROJECT,
  tool: { name: "Bash", input: { command: "git push" } },
  hits: [{ kind: "posts", rule: "git push", what: "push to GitHub" }],
  unclear: [],
  ...over,
});

describe("decideGuard", () => {
  test("a sure hit asks at once, with no classifier", async () => {
    const v = await decideGuard(check(), { on: true, off: [], classify: () => assert.fail("not asked") });
    assert.deepEqual(v, { ask: true, kind: "posts", rule: "git push", what: "push to GitHub", by: "rule", reason: "Kiko asks first: this posts (push to GitHub)." });
  });
  test("off, or its kind off, it passes", async () => {
    assert.deepEqual(await decideGuard(check(), { on: false, off: [] }), { ask: false, why: "off" });
    assert.equal((await decideGuard(check(), { on: true, off: ["posts"] })).ask, false);
    // Another hit of a kind still on asks.
    const two = check({
      hits: [
        { kind: "deletes", rule: "rm -r", what: "delete x" },
        { kind: "posts", rule: "git push", what: "push" },
      ],
    });
    const v = await decideGuard(two, { on: true, off: ["deletes"] });
    assert.equal(v.ask && v.kind, "posts");
  });
  test("unclear: the classifier decides; none passes", async () => {
    forgetClassified();
    const u = check({ hits: [], unclear: [{ rule: "script:deploy.sh", what: "run deploy.sh", hint: "posts" }] });
    const posts = await decideGuard(u, { on: true, off: [], classify: async () => ({ kind: "posts" }) });
    assert.equal(posts.ask && posts.by, "classifier");
    forgetClassified();
    const none = await decideGuard(u, { on: true, off: [], classify: async () => ({ kind: null }) });
    assert.equal(none.ask, false);
  });
  test("unclear with no classifier, or one too slow or failing: risky words ask, plain writes pass", async () => {
    forgetClassified();
    const risky = check({ hits: [], unclear: [{ rule: "script:deploy.sh", what: "run deploy.sh", hint: "posts" }] });
    assert.equal((await decideGuard(risky, { on: true, off: [] })).ask, true);
    const slow = await decideGuard(risky, { on: true, off: [], budgetMs: 30, classify: () => new Promise((r) => setTimeout(() => r({ kind: null }), 500)) });
    assert.equal(slow.ask && slow.by, "unsure");
    const failing = await decideGuard(risky, { on: true, off: [], classify: async () => Promise.reject(new Error("503")) });
    assert.equal(failing.ask && failing.by, "unsure");
    const plain = check({ tool: { name: "mcp__linear__create_issue", input: {} }, hits: [], unclear: [{ rule: "mcp:create_issue", what: "use linear's create issue" }] });
    assert.equal((await decideGuard(plain, { on: true, off: [] })).ask, false);
  });
  test("the classifier's verdict is kept a while: the same script isn't asked of it twice", async () => {
    forgetClassified();
    let asked = 0;
    const u = check({ hits: [], unclear: [{ rule: "script:deploy.sh", what: "run deploy.sh", hint: "posts" }] });
    const classify = async () => {
      asked++;
      return { kind: "posts" as const };
    };
    await decideGuard(u, { on: true, off: [], classify });
    await decideGuard(u, { on: true, off: [], classify });
    assert.equal(asked, 1);
  });
});

describe("the prompt that follows, marked", () => {
  const held = (over: Partial<Held> = {}): Held =>
    ({ sessionId: "s-1", cwd: PROJECT, isPermission: true, questions: null, tool: { name: "Bash", input: { command: "git push", description: "Push" } }, ...over }) as unknown as Held;
  test("an ask marks the next prompt for the same call, once", async () => {
    forgetPending();
    const c = check();
    const v = await decideGuard(c, { on: true, off: [] });
    noteGuard(c, v);
    const first = held();
    assert.deepEqual(guardOf(first), { kind: "posts", what: "push to GitHub", rule: "git push", by: "rule", agent: "claude-code" });
    assert.ok(guardOf(first), "the same prompt keeps its mark");
    assert.equal(guardOf(held()), null, "another prompt for it isn't the gate's");
  });
  test("another session, another command, or a finished turn isn't marked", async () => {
    forgetPending();
    const c = check();
    noteGuard(c, await decideGuard(c, { on: true, off: [] }));
    assert.equal(guardOf(held({ sessionId: "s-2" })), null);
    assert.equal(guardOf(held({ tool: { name: "Bash", input: { command: "git push --force" } } })), null);
    assert.equal(guardOf(held({ isPermission: false, tool: null })), null);
  });
  test("a pass marks nothing; an old ask expires", async () => {
    forgetPending();
    const c = check();
    noteGuard(c, { ask: false, why: "off" });
    assert.equal(guardOf(held()), null);
    noteGuard(c, await decideGuard(c, { on: true, off: [] }), Date.now() - 6 * 60_000);
    assert.equal(guardOf(held()), null);
  });
});

describe("words", () => {
  test("said, shown, and in Claude Code's prompt", () => {
    assert.equal(guardLine("Kiko project", "push to GitHub"), "Kiko project wants to push to GitHub: allow it?");
    assert.equal(guardWhat("run: git push", "posts"), "run: git push (Kiko asks first: posts)");
    assert.equal(guardReason("deletes", "delete ~/x and everything in it"), "Kiko asks first: this deletes (delete ~/x and everything in it).");
  });
  test("the settings row", () => {
    assert.equal(guardValue(true, []), "On");
    assert.equal(guardValue(false, []), "Off");
    assert.equal(guardValue(true, ["deletes", "pays"]), "On, except deletes and pays");
    assert.deepEqual(guardOffOf(["pays", "nonsense", "pays", 3]), ["pays"]);
    assert.deepEqual(guardOffOf("pays"), []);
  });
  test("off by default: fresh settings don't ask; a value saved stays", () => {
    // tests/setup.ts: no settings file, so config has the defaults.
    assert.equal(config.guard, false);
    assert.equal(guardOn({}), false);
    assert.equal(guardOn(null), false);
    assert.equal(guardOn({ voiceCan: "everything" }), false);
    assert.equal(guardOn({ guard: true }), true);
    assert.equal(guardOn({ guard: false }), false);
    // Kinds turned off by hand while it was on by default (2026-11-02): it was on for them, and stays so.
    assert.equal(guardOn({ guardOff: ["pays"] }), true);
    assert.equal(guardOn({ guardOff: [] }), false);
    assert.equal(guardOn({ guard: false, guardOff: ["pays"] }), false);
    // The row's choices: Off is the default, On says what it does.
    const [on, off] = guardChoices({ on: false, off: [] });
    assert.deepEqual([on.value, off.value, off.hint?.startsWith("the default")], ["on", "off", true]);
  });
  test("a hook's event read safely", () => {
    const c = guardCheckOf(
      {
        session_id: "s",
        cwd: "/x",
        tool_name: "Bash",
        tool_input: { command: "git push" },
        permission_mode: "bypassPermissions",
        guard: { hits: [{ kind: "posts", rule: "r", what: "w" }, { kind: "nope", rule: "r", what: "w" }, "x"], unclear: [{ rule: "u", what: "w", hint: "zzz" }] },
      },
      "claude-code",
    );
    assert.deepEqual(c, {
      agent: "claude-code",
      sessionId: "s",
      cwd: "/x",
      tool: { name: "Bash", input: { command: "git push" } },
      hits: [{ kind: "posts", rule: "r", what: "w" }],
      unclear: [{ rule: "u", what: "w" }],
      mode: "bypassPermissions",
    });
    assert.equal(guardCheckOf({ session_id: "s", cwd: "/x", tool_name: "Bash" }, "claude-code"), null);
  });
});

// The 2026-11-19 security review (C1, C2, M4): syntax that desynced the parser, and commands it missed.
describe("not blinded by what fooled the old parser", () => {
  const gate = (command: string) => {
    const f = checkCommand(command, PROJECT);
    return f ? [...f.hits.map((h: { kind: string; what: string }) => `${h.kind}: ${h.what}`), ...f.unclear.map((u: { what: string }) => `unclear: ${u.what}`)] : [];
  };

  test("C1, C2: the command after $'…' and inside zsh's =(…) is seen; a glob qualifier is unclear", () => {
    assert.match(gate("echo $'\\'' ; git push --force origin main ; echo '\\'''").join(), /posts: force-push/);
    assert.match(gate("cat =(git push origin main)").join(), /posts: push/);
    assert.match(gate("ls *(e:'git push --force':)").join(), /unclear: run shell syntax the gate can't read for sure/);
    assert.match(gate("echo 'unclosed ; git push").join(), /unclear: run shell syntax the gate can't read for sure/);
  });

  test("M4: an alias on the command line, xargs, a command from an expansion, code that shells out, curl -K", () => {
    assert.match(gate("git -c alias.p=push p origin main").join(), /unclear: run a git alias/);
    assert.match(gate("echo push | xargs git").join(), /unclear: run git with words from xargs/);
    assert.match(gate("git $(echo push)").join(), /unclear: run git with its command from an expansion/);
    assert.match(gate("g=git; $g push origin main").join(), /unclear: run a command named by an expansion/);
    assert.match(gate("perl -e 'system(\"git push\")'").join(), /posts: push/);
    assert.match(gate("ruby -e '`git push`'").join(), /posts: push/);
    assert.match(gate("python3 -c 'import os; os.system(\"ls\")'").join(), /unclear: run python3 code that runs other commands/);
    assert.match(gate("curl -K cfg https://example.com").join(), /unclear: run curl with options from a file/);
  });

  test("an MCP tool that runs a shell command: the command's own verdict", () => {
    assert.equal(guardCheck("mcp__x__run_shell", { cmd: "git push origin main" }, PROJECT)?.hits[0]?.kind, "posts");
    assert.equal(guardCheck("mcp__x__run_shell", { command: "ls" }, PROJECT), null);
  });

  test("and normal work is still nothing", () => {
    for (const command of [
      'git commit -m "$(cat msg.txt)"',
      "find . -name '*.log' | xargs rm",
      "find . -name '*.ts' | xargs wc -l",
      `node -e 'console.log(/x/.exec("x"))'`,
      "python3 -c 'import json; print(1)'",
      "pnpm test 2>&1 | tail -5",
      'for f in *.md; do wc -l "$f"; done',
      "echo $'a\\tb'",
      "git log $(git merge-base main HEAD)..HEAD",
    ])
      assert.deepEqual(gate(command), [], command);
  });
});
