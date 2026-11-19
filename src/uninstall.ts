// `kiko uninstall` with no agent, in an installed copy (install.sh): Kiko taken out whole,
// after asking once, so nothing is left behind:
//   - its hooks in each agent's file, only its own entries (agents/setup.ts, as `kiko uninstall
//     <agent>` does: each file backed up first)
//   - ~/.config/kiko/ (settings, the dictionary, session names, and phones.json: each paired phone
//     is said to be unpaired, accounts or not; it's paired again after a reinstall)
//   - ~/.local/share/kiko/ (every version, the `current` link, its tmux, and all of Pocket's: its
//     venv, the uv setup.sh fetched with uv's Python and cache, its model) and the ~/.local/bin/kiko link
//   - the PATH line install.sh added to your shell's startup file (only that line: PATH_MARK)
//   - the socket and the state file in /tmp
//   - its API keys in the Keychain (this flavour's service only: Kiko Dev's stay)
//   - while accounts are open (core/env.ts accountsLive), the Kiko account's sign-in: this Mac
//     signed out on the server first (POST /logout, best effort, a short wait: offline, a dim line
//     and on), then its token goes with the keys
//   - the helper app (Kiko.app, in each version's folder): quit first, and each copy unregistered
//     from Launch Services (lsregister -u) before its folder goes
//   - asked on its own right after "Uninstall Kiko?", and done then, before anything else: the
//     helper app's macOS permissions (`tccutil reset All sh.kiko.helper`: the microphone, Input
//     Monitoring, speech recognition; only its own, never Kiko Dev's). tccutil finds the app by its
//     bundle id through Launch Services, so only while it's still registered: after lsregister -u
//     it fails ("No such bundle identifier", -10814) and the grants stay
//   - last, asked on its own: the logs (~/.local/state/kiko/)
// Only paths of Kiko's own: a uv or Python of yours (on the PATH, brew's, ~/.local/share/uv) is
// never touched. Not touched either, and said: the scratch folder (your sessions' work), Pocket's
// model in Hugging Face's shared cache (~/.cache/huggingface, or where HF_* says) when one is there,
// put there by an older install or by another app (Kiko only ever reads it now, cloning it into its
// own folder: core/pocket-tts.ts adoptSharedModel), and any session still open in Kiko's tmux.
// While Kiko runs it stops first, and says to quit it. A checkout's `kiko uninstall` only
// takes the hooks out (src/cli.ts).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BIN_LINK, CURRENT_LINK, POCKET_SHARED_VENV, SHARE_DIR, STATE_DIR } from "./core/app-root.ts";
import { ACCOUNT_SITE, CONFIG_FOLDER, DOMAIN, envVar, NAME, OWN, SLUG, STATE_PATH } from "./core/name.ts";
import { andList } from "./core/text.ts";
import { appRunning, appSocket } from "./core/running.ts";
import { SETTINGS_FILE, scratchFolderOf, loadSettings } from "./core/settings.ts";
import { SETUPS, statusOf } from "./agents/setup.ts";
import { shortPath } from "./core/text.ts";
import { KEY_NAMES } from "./core/keys.ts";
import { DEVICE_KEY_NAME } from "./remote/relay-identity.ts";
import { SESSION_KEY, type Account } from "./core/account/account.ts";
import { pocketHfHome, pocketModelDirs, pocketUvHome, sharedHfHubs } from "./core/pocket-tts.ts";
import type { KeyStore } from "./platform/types.ts";
import { PLAIN, styleFor, type Style } from "./ui/cli-style.ts";

type UninstallDeps = {
  confirm: (question: string) => Promise<boolean>;
  out: (line: string) => void;
  /** The Keychain, when there is one (KIKO_KEYCHAIN=off: none). */
  keys: KeyStore | null;
  running: () => Promise<boolean>;
  /** How many sessions are still open in Kiko's tmux (they're yours: left running). */
  openSessions: () => Promise<number>;
  /** Its tmux server (terminals/tmux/tmux.ts SERVER). */
  server?: string;
  /**
   * The helper app (platform/macos/helper-app.ts): its name and bundle id, its copies (one per
   * version folder), and what's done to it. Absent: nothing of it is touched (KIKO_HELPER_APP=off, the tests).
   */
  helperApp?: { name: string; id: string; bundles(): string[]; quit(): Promise<boolean>; unregister(path: string): boolean; forgetPermissions(): boolean };
  /** How lines are styled (ui/cli-style.ts): stdout's; PLAIN when not given. */
  style?: Style;
  /**
   * This Mac's Kiko account, while accounts are open (its client with a short wait: accountSignOut).
   * Absent: the token, if any, just goes with the keys.
   */
  account?: { account: Account };
  /** The phones paired with this Mac, by name (phones.json, accounts open or not): unpaired as the config folder goes. */
  phones?: string[];
};

/** How long `kiko uninstall` waits for the account server to sign this Mac out. */
export const SIGN_OUT_MS = 3000;

/**
 * The line for the account in the list of what goes: who's signed in here, signed out on the server
 * too. None when nobody's signed in.
 */
export function accountLines(a: { account: Account }, hasToken: boolean, s: Style = PLAIN): string[] {
  const view = a.account.view();
  if (view.state !== "signed-in" && !hasToken) return [];
  const who = view.state === "signed-in" && view.email ? `, ${s.bold(view.email)}` : "";
  return [`  this Mac's sign-in to your ${NAME} account${who} ${s.dim(`(signed out on ${DOMAIN} too; the account stays)`)}`];
}

/**
 * The line under the config folder in the list of what goes, for the phones paired with this Mac:
 * phones.json goes with it, so each is unpaired and is paired again after a reinstall. Accounts
 * open or not. None when no phone is paired.
 */
export function phoneLines(phones: readonly string[], s: Style = PLAIN): string[] {
  if (!phones.length) return [];
  const one = phones.length === 1;
  return [`    ${andList(phones.map((p) => s.bold(p)))} ${one ? "is" : "are"} unpaired: pair ${one ? "it" : "them"} again after you reinstall`];
}

/**
 * This Mac signed out of its account on the server, then its token out of the Keychain (core/account
 * signOut), best effort: not reached in time (offline, the server down), one dim line and on. Returns
 * the lines to say, and whether the token is out of the Keychain already.
 */
export async function accountSignOut(a: { account: Account }, s: Style = PLAIN): Promise<{ lines: string[]; removed: boolean }> {
  const r = await a.account.signOut().catch((err: unknown) => ({ server: "unreachable" as const, why: err instanceof Error ? err.message : String(err), kept: "it failed" }));
  const lines: string[] = [];
  if (r.server === "done") lines.push(s.ok(`This Mac is signed out of your ${NAME} account.`));
  else if (r.server === "unreachable")
    lines.push(s.dim(`Couldn't reach ${DOMAIN} to sign this Mac out there (${r.why ?? "offline?"}): its session ends by itself, or sign it out on ${ACCOUNT_SITE}/account.`));
  return { lines, removed: !r.kept };
}

/**
 * Said when tccutil couldn't reset the helper app's permissions: what still works once the app is
 * gone (tccutil itself won't, without the app registered), System Settings.
 */
export function permissionsKeptWords(app: string): string {
  return `macOS's permissions for ${app} weren't reset. To remove them, open System Settings → Privacy & Security and turn ${app} off (or remove it) under Microphone, Input Monitoring and Speech Recognition.`;
}

/** What's left, said at the end: each there only when it is. `model`: the shared Hugging Face cache(s) Pocket's model is in (an older install's, or another app's). */
export function leftWords(o: { logs?: string; scratch?: string; model?: string; sessions?: number; server?: string }): string {
  const left = [
    o.logs ? `the logs (${o.logs})` : "",
    o.scratch ? `your scratch folder (${o.scratch})` : "",
    o.model ? `Pocket's voice model in ${o.model} (Hugging Face's cache, shared with other apps; an older install or another app put it there)` : "",
    o.sessions
      ? `${o.sessions === 1 ? "a session" : `${o.sessions} sessions`} still open in ${NAME}'s tmux (${o.sessions === 1 ? "it ends" : "each ends"} when you quit it, or when the Mac restarts; a tmux of your own reaches ${o.sessions === 1 ? "it" : "them"}: tmux -L ${o.server ?? OWN.tmuxServer} attach)`
      : "",
  ].filter(Boolean);
  return `Left as they are: ${left.join("; ") || "nothing"}.`;
}

/** The files and folders that go without asking (those there now): the config folder, the install, the link, the socket. */
function installedPaths(home = homedir()): string[] {
  const config = SETTINGS_FILE === join(home, ".config", CONFIG_FOLDER, "settings.json") ? dirname(SETTINGS_FILE) : join(home, ".config", CONFIG_FOLDER);
  // The PATH link only when it's ours (to the install), not a checkout's bin/kiko.
  const links = [BIN_LINK].filter((link) => linkTarget(link)?.startsWith(SHARE_DIR));
  return [config, SHARE_DIR, ...links, appSocket(), envVar("STATE") ?? STATE_PATH].filter((p) => existsSync(p) || linkTarget(p) !== null);
}

/** What marks the line install.sh adds to a shell's startup file to put ~/.local/bin on the PATH: uninstall takes out that line, no other. */
export const PATH_MARK = `# added by the ${NAME} installer (${SLUG} uninstall removes this line)`;

/** The startup files install.sh may have added that line to: zsh's, bash's (the first a login shell reads), fish's (a file of Kiko's own in conf.d). */
function startupFiles(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    join(env.ZDOTDIR || home, ".zshrc"),
    ...[".bash_profile", ".bash_login", ".profile"].map((f) => join(home, f)),
    join(env.XDG_CONFIG_HOME || join(home, ".config"), "fish", "conf.d", `${SLUG}.fish`),
  ];
}

/** `text` without install.sh's PATH line (PATH_MARK), the rest exactly as it was; null when it has none. */
export function withoutPathLine(text: string): string | null {
  const lines = text.split("\n");
  const kept = lines.filter((line) => !line.includes(PATH_MARK));
  return kept.length === lines.length ? null : kept.join("\n");
}

/** The startup files holding install.sh's PATH line. */
function pathLineFiles(files = startupFiles()): string[] {
  return files.filter((file) => {
    try {
      const text = readFileSync(file, "utf8");
      return text.includes(PATH_MARK);
    } catch {
      return false;
    }
  });
}

/** Takes the PATH line out of `file` (written in place: a linked file stays a link); fish's file of Kiko's own goes when nothing else is left in it. */
function removePathLine(file: string): void {
  const rest = withoutPathLine(readFileSync(file, "utf8"));
  if (rest === null) return;
  if (file.endsWith(`/${SLUG}.fish`) && !rest.trim()) rmSync(file, { force: true });
  else writeFileSync(file, rest);
}

/** What Kiko's folder in ~/.local/share holds of Pocket's, said beside it in the list of what goes ("" when nothing). */
export function pocketWords(venv = POCKET_SHARED_VENV): string {
  const parts = [existsSync(venv) ? "Python" : "", existsSync(pocketUvHome(venv)) ? "uv" : "", existsSync(pocketHfHome(venv)) ? "model" : ""].filter(Boolean);
  if (!parts.length) return "";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return ` (with the Pocket voice's ${list})`;
}

/** Pocket's model in Hugging Face's shared cache (put there by an install from before it had its own, pocket-tts.ts pocketHfHome, or by another app; never removed): where, else undefined. */
function sharedModel(): string | undefined {
  const hubs = sharedHfHubs().filter((hub) => pocketModelDirs(hub).length);
  return hubs.length ? hubs.map((hub) => shortPath(hub)).join(" and ") : undefined;
}

function linkTarget(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/**
 * The agents whose files hold this copy's hooks, to take out: connected or needing repair, readable.
 * Only this flavour's entries count (agents/hooks-file.ts isOurs): Kiko Dev's beside them stay.
 */
export const hookedSetups = (setups = SETUPS) =>
  setups
    .filter((s) => s.disconnect && !s.linkWords)
    .filter((s) => {
      const status = statusOf(s);
      return !status.unreadable && (status.state === "connected" || status.state === "needs repair");
    });

/** `kiko uninstall`, an installed copy's: 0 when it's all gone (or nothing was changed because you said no). */
export async function uninstallAll(d: UninstallDeps): Promise<number> {
  const s = d.style ?? PLAIN;
  if (await d.running()) {
    d.out(s.error(`${NAME} is running: quit it first (q in its window, or the menu's Quit), then run ${OWN.command} uninstall again.`));
    return 1;
  }
  const hooked = hookedSetups();
  const paths = installedPaths();
  const pathLines = pathLineFiles();
  // The API keys, the relay's device key (remote/relay-identity.ts) if the relay was ever on, and the
  // account's session token (core/account/): this Mac signed out here; its session on the server
  // ends by itself, or from the account page.
  const ownKey = (name: string) => KEY_NAMES.includes(name) || name === DEVICE_KEY_NAME || name === SESSION_KEY;
  let keys = d.keys ? (await d.keys.list().catch(() => [] as string[])).filter(ownKey) : [];
  const signIn = d.account ? accountLines(d.account, keys.includes(SESSION_KEY), s) : [];
  // Said as the account's sign-in, not as a key.
  const shownKeys = signIn.length ? keys.filter((k) => k !== SESSION_KEY) : keys;
  d.out(s.warn(`This takes ${NAME} off this Mac:`));
  for (const h of hooked) d.out(`  ${NAME}'s hooks in ${s.bold(shortPath(h.file()))} ${s.dim("(yours stay; the file is backed up first)")}`);
  for (const p of paths) {
    d.out(`  ${s.bold(shortPath(p))}${p === SHARE_DIR ? s.dim(pocketWords()) : ""}`);
    // phones.json is in the settings' folder: said only when that folder is the one going.
    if (p === dirname(SETTINGS_FILE)) for (const line of phoneLines(d.phones ?? [], s)) d.out(line);
  }
  for (const f of pathLines) d.out(`  the PATH line it added to ${s.bold(shortPath(f))} ${s.dim("(that line only)")}`);
  if (shownKeys.length) d.out(`  your API keys in the Keychain ${s.dim(`(${shownKeys.join(", ")})`)}`);
  for (const line of signIn) d.out(line);
  const bundles = d.helperApp?.bundles() ?? [];
  if (d.helperApp && bundles.length) d.out(`  ${s.bold(`${d.helperApp.name}.app`)}, the helper app that holds ${NAME}'s permissions ${s.dim("(quit, and forgotten by Launch Services)")}`);
  if (!(await d.confirm(`Uninstall ${NAME}?`))) {
    d.out("Nothing changed.");
    return 0;
  }
  let failed = false;
  // Its permissions: macOS keeps them by the bundle id after the app's gone (a reinstall finds them).
  // Asked and reset first, while Launch Services still knows the bundle id: tccutil can't find it
  // once the app is unregistered (below), so then it fails and the grants stay.
  if (d.helperApp && (await d.confirm(`Forget ${d.helperApp.name}'s macOS permissions too (the microphone, Input Monitoring, speech recognition: tccutil reset All ${d.helperApp.id})?`))) {
    if (d.helperApp.forgetPermissions()) d.out(s.ok(`${d.helperApp.name}'s permissions are forgotten: a new install asks again.`));
    else {
      failed = true;
      d.out(s.error(permissionsKeptWords(d.helperApp.name)));
    }
  }
  // Counted before the install goes: its tmux goes with it.
  const sessions = await d.openSessions().catch(() => 0);
  for (const h of hooked) {
    try {
      const changed = h.disconnect!();
      d.out(s.ok(`${NAME}'s hooks are out of ${shortPath(changed.file)}${changed.backup ? ` (the old one is ${changed.backup})` : ""}.`));
    } catch (err) {
      failed = true;
      d.out(s.error(`${h.name} wasn't changed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  // Signed out on the server before its token goes (the session there would otherwise stay until it
  // ends by itself); then the token's out already, unless the Keychain wouldn't (tried again below).
  if (d.account && signIn.length) {
    const out = await accountSignOut(d.account, s);
    for (const line of out.lines) d.out(line);
    if (out.removed) keys = keys.filter((k) => k !== SESSION_KEY);
  }
  // The keys before the files: the Keychain helper that removes them is in the install folder.
  for (const name of keys) {
    try {
      await d.keys!.remove(name);
    } catch (err) {
      failed = true;
      d.out(s.error(`${name} is still in the Keychain: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  // The helper app quit and unregistered while its bundles are still there to name.
  if (d.helperApp) {
    await d.helperApp.quit().catch(() => false);
    for (const b of bundles) d.helperApp.unregister(b);
  }
  for (const p of paths) rmSync(p, { recursive: true, force: true });
  for (const f of pathLines) {
    try {
      removePathLine(f);
    } catch (err) {
      failed = true;
      d.out(s.error(`The PATH line is still in ${shortPath(f)}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  // The `current` link, should the folder above have been a link itself.
  rmSync(CURRENT_LINK, { force: true });

  // The logs.
  if (existsSync(STATE_DIR) && (await d.confirm(`Delete the logs too (${shortPath(STATE_DIR)})?`))) rmSync(STATE_DIR, { recursive: true, force: true });

  const scratch = scratchFolderOf(loadSettings());
  d.out(failed ? s.warn(`${NAME} is uninstalled. (Not all of it: see above.)`) : s.ok(`${NAME} is uninstalled.`));
  d.out(
    s.dim(
      leftWords({
        logs: existsSync(STATE_DIR) ? shortPath(STATE_DIR) : undefined,
        scratch: existsSync(scratch) ? shortPath(scratch) : undefined,
        model: sharedModel(),
        sessions,
        server: d.server,
      }),
    ),
  );
  return failed ? 1 : 0;
}

/**
 * The real ones: this terminal's y/N, stdout, the Keychain, whether the app runs, Kiko's tmux, the
 * account (accounts open) and the paired phones (always; `o.phones`: the tests' own, for phones.json).
 */
export async function realUninstallDeps(confirm: (question: string) => Promise<boolean>, o: { phones?: () => Promise<string[]> } = {}): Promise<UninstallDeps> {
  const { keyStore } = await import("./platform/keys.ts");
  const { SERVER, tmuxPath, tmuxRunner, WINDOW } = await import("./terminals/tmux/tmux.ts");
  const openSessions = async () => {
    if (!tmuxPath()) return 0;
    const names = await tmuxRunner()(["list-sessions", "-F", "#{session_name}"]).catch(() => "");
    return names.split("\n").filter((n) => n && n !== WINDOW).length;
  };
  const { helperAppWanted, quitHelperApp, unregisterApp } = await import("./platform/macos/helper-app.ts");
  // This flavour's (an installed copy: the release's, sh.kiko.helper); never under the tests' KIKO_HELPER_APP=off.
  const helperApp: UninstallDeps["helperApp"] = helperAppWanted()
    ? {
        name: OWN.helperApp,
        id: OWN.helperAppId,
        bundles: () => helperAppBundles(),
        quit: quitHelperApp,
        unregister: unregisterApp,
        forgetPermissions: () => spawnSync("/usr/bin/tccutil", ["reset", "All", OWN.helperAppId], { stdio: "ignore", timeout: 20_000 }).status === 0,
      }
    : undefined;
  // The account (accounts open): its client waits SIGN_OUT_MS at most, so an offline Mac isn't held up.
  const { accountsLive, accountUrl } = await import("./core/env.ts");
  let account: UninstallDeps["account"];
  if (accountsLive()) {
    const [{ Account }, { accountClient }] = await Promise.all([import("./core/account/account.ts"), import("./core/account/client.ts")]);
    account = { account: new Account({ store: keyStore, client: accountClient(accountUrl(), { callMs: SIGN_OUT_MS }) }) };
  }
  // The paired phones, accounts or not: phones.json goes with the config folder either way.
  const readPhones = o.phones ?? (async () => (await import("./account-cli.ts")).pairedPhones());
  const phones = await readPhones().catch(() => [] as string[]);
  return { confirm, out: (line) => console.log(line), style: styleFor(process.stdout), keys: keyStore, running: appRunning, openSessions, server: SERVER, helperApp, account, phones };
}

/** The helper app's copies in the install: one in each version's folder (`share`: the tests' own). */
export function helperAppBundles(share = SHARE_DIR, name = OWN.helperApp): string[] {
  let versions: string[] = [];
  try {
    versions = readdirSync(join(share, "versions")).sort();
  } catch {
    return [];
  }
  return versions.map((v) => join(share, "versions", v, `${name}.app`)).filter((p) => existsSync(p));
}
