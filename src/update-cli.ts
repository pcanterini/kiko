// `kiko update` (src/cli.ts runs it): the newest version installed now, in the foreground, with
// its progress; or, `kiko update --rollback`, back to the one before. Either way the version
// running keeps running: the new one starts the next time Kiko does (Settings → Updates →
// Restart now, or quit and run kiko). Your sessions live in Kiko's tmux and never notice.
// A development checkout isn't updated (git pull is how). Like the rest of cli.ts, nothing here
// loads .env, and it writes to the log only when the network failed (the error itself, and how many
// tries: what's said is plain). The work is in core/updates/.
//
// `kiko update --token <token>`: keeps an invite's install token for this install (an install from
// before the invites, or one whose link was re-sent), then updates as above. The link or the whole
// install command work too: the token is taken out of them (core/updates/invite.ts).
import { COMMAND, NAME } from "./core/name.ts";
import { compareVersions, feedUrl, fetchRelease, type NetTiming, NetworkError, platformKey } from "./core/updates/feed.ts";
import { InviteError, releaseAuth, saveToken, tokenFile, tokenFrom } from "./core/updates/invite.ts";
import { type Copy, currentVersion, install, rollback, thisCopy } from "./core/updates/layout.ts";
import { failure, loadState, saveState } from "./core/updates/updater.ts";
import { SignatureError, type Verify } from "./core/updates/verify.ts";
import { version } from "./cli-args.ts";
import { columns, shortPath } from "./core/text.ts";
import { PLAIN, styleFor, type Style } from "./ui/cli-style.ts";

type UpdateDeps = {
  copy: Copy;
  url: string;
  /** Whether the Kiko app is running now (core/running.ts appRunning). */
  appRunning: () => Promise<boolean>;
  out: (line: string) => void;
  /** A progress line that replaces itself (a terminal), or nothing. */
  progress: ((line: string) => void) | null;
  platform?: string;
  /** The tests' stand-in for verifyRelease. */
  verify?: Verify;
  /** How lines are styled (ui/cli-style.ts): stdout's; PLAIN when not given. */
  style?: Style;
  /** The log (core/log.ts), for a failure's details: none in the tests. */
  log?: (event: string, fields: Record<string, unknown>) => void | Promise<void>;
  /** The tests' shorter waits between tries (core/updates/feed.ts NetTiming). */
  net?: NetTiming;
};

const USAGE = columns([
  [`${COMMAND} update`, `install the newest ${NAME} now (it starts the next time ${NAME} does)`],
  [`${COMMAND} update --rollback`, "go back to the version before"],
  [`${COMMAND} update --token <token>`, "keep your invite's install token (or its link), then update"],
]).join("\n");

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

/** How to start the version just installed (or rolled back to). */
async function startsWhen(d: UpdateDeps, v: string): Promise<string> {
  if (await d.appRunning()) return `Restart ${NAME} to use ${v}: Settings → Updates → Restart now, or quit it (q) and run ${COMMAND}. Your sessions keep running.`;
  return `It starts the next time you run ${COMMAND}.`;
}

export async function updateCommand(args: string[], d: UpdateDeps): Promise<number> {
  const [arg, ...rest] = args;
  const s = d.style ?? PLAIN;
  if (arg === "-h" || arg === "--help" || arg === "help") return (d.out(USAGE), 0);
  const back = arg === "--rollback" || arg === "rollback";
  const tokenArg = arg === "--token" ? rest.join(" ") : arg?.startsWith("--token=") ? [arg.slice("--token=".length), ...rest].join(" ") : null;
  if (arg !== undefined && !back && tokenArg === null) {
    d.out(`${s.error(`${COMMAND}: update takes --rollback, --token <token> or nothing`)}\n${USAGE}`);
    return 2;
  }
  const { copy } = d;
  if (tokenArg !== null) {
    const token = tokenFrom(tokenArg);
    if (!token) {
      d.out(s.error(`${COMMAND}: that isn't an install token. Give the token, or the link from your invite (https://kiko.sh/i/…).`));
      return 2;
    }
    saveToken(copy.layout, token);
    const state = loadState(copy.layout);
    delete state.link;
    saveState(copy.layout, state);
    d.out(s.ok(`Kept your install token in ${shortPath(tokenFile(copy.layout))} (readable by you only); updates send it.`));
    if (!copy.installed) {
      d.out(`This ${NAME} is a development copy, so it doesn't update itself (git pull does); the ${NAME} installed on this Mac uses the token.`);
      return 0;
    }
  }
  if (!copy.installed) {
    d.out(s.error(`This ${NAME} is a development copy (it runs from ${copy.root}), so it doesn't update itself: git pull updates it.`));
    return 1;
  }
  const l = copy.layout;
  if (back) {
    let moved: { from: string; to: string };
    try {
      moved = rollback(l);
    } catch (err) {
      d.out(s.error(`${COMMAND}: ${err instanceof Error ? err.message : String(err)}`));
      return 1;
    }
    // Not installed again by itself: automatic updates skip it until a newer one, or kiko update.
    saveState(l, { ...loadState(l), skip: moved.from });
    d.out(s.ok(`Back to ${NAME} ${s.bold(moved.to)} (${moved.from} is kept; automatic updates leave it alone, and ${COMMAND} update installs it again).`));
    if (moved.to !== copy.version) d.out(await startsWhen(d, moved.to));
    return 0;
  }
  d.out(`Looking for a new version ${s.dim(`(${d.url})`)}…`);
  // The invite's token and this Mac's install id, when this install has a token (core/updates/invite.ts).
  const auth = releaseAuth(l, d.url, copy.version);
  let release: Awaited<ReturnType<typeof fetchRelease>>;
  try {
    release = await fetchRelease(d.url, copy.version, undefined, auth, d.net);
  } catch (err) {
    if (err instanceof InviteError) {
      // kiko.sh refused the invite: its words, plainly (the app's header says so too).
      saveState(l, { ...loadState(l), link: { code: err.code, why: err.message } });
      d.out(s.error(err.message));
      return 1;
    }
    await d.log?.("update_check_failed", failure(err));
    // Unreachable (the network): said plainly; the error itself is in the log.
    if (err instanceof NetworkError) d.out(s.error(err.message));
    else d.out(s.error(`${COMMAND}: couldn't read the release feed: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }
  const seen = { ...loadState(l), checkedAt: Date.now(), latest: { version: release.version, ...(release.date ? { date: release.date } : {}), ...(release.notes ? { notes: release.notes } : {}) } };
  delete seen.link;
  saveState(l, seen);
  const current = currentVersion(l);
  const newest = current && compareVersions(current, copy.version) > 0 ? current : copy.version;
  if (compareVersions(release.version, newest) <= 0) {
    if (current && current !== copy.version) {
      d.out(s.ok(`${NAME} ${s.bold(current)} is installed already (${copy.version} is running).`));
      d.out(await startsWhen(d, current));
    } else d.out(s.ok(`${NAME} ${s.bold(copy.version)} is the newest.`));
    return 0;
  }
  const key = d.platform ?? platformKey();
  if (!release.assets[key]) {
    d.out(s.error(`${COMMAND}: ${NAME} ${release.version} has no download for this Mac (${key}).`));
    return 1;
  }
  let shown = -1;
  const progress = (done: number, total: number | null) => {
    if (!d.progress) return;
    const pct = total ? Math.floor((done / total) * 100) : -1;
    if (pct === shown && total) return;
    shown = pct;
    d.progress(total ? `Downloading ${NAME} ${release.version}… ${pct}% (${mb(done)} of ${mb(total)} MB)` : `Downloading ${NAME} ${release.version}… ${mb(done)} MB`);
  };
  try {
    await install(l, release, { running: copy.version, progress, platform: d.platform, verify: d.verify, auth, net: d.net });
  } catch (err) {
    d.progress?.("");
    const why = err instanceof Error ? err.message : String(err);
    if (err instanceof InviteError) {
      saveState(l, { ...loadState(l), link: { code: err.code, why } });
      d.out(s.error(why));
      return 1;
    }
    const state = { ...loadState(l), failed: { version: release.version, why } };
    await d.log?.("update_failed", { version: release.version, ...failure(err) });
    if (err instanceof NetworkError) d.out(s.error(why));
    else if (err instanceof SignatureError) {
      // The app's header says so too (updateWords), and doesn't fetch the same file again.
      state.refused = { version: release.version, sha256: release.assets[key].sha256 };
      d.out(s.error(`${COMMAND}: ${NAME} ${release.version} was refused, as it isn't signed by ${NAME}'s developer: ${why}. Nothing was installed.`));
    } else d.out(s.error(`${COMMAND}: ${NAME} ${release.version} wasn't installed: ${why}`));
    saveState(l, state);
    return 1;
  }
  d.progress?.("");
  const state = loadState(l);
  delete state.failed;
  delete state.refused;
  if (state.skip) delete state.skip; // asked for by hand: automatic updates go on from here
  saveState(l, state);
  d.out(s.ok(`${NAME} ${s.bold(release.version)} is installed (checked, ${copy.version} kept for ${COMMAND} update --rollback).${release.notes ? `\n${s.bold("What's new:")} ${release.notes}` : ""}`));
  d.out(await startsWhen(d, release.version));
  return 0;
}

export async function realDeps(): Promise<UpdateDeps> {
  const { appRunning } = await import("./core/running.ts");
  const tty = process.stdout.isTTY;
  return {
    copy: thisCopy(version()),
    url: feedUrl(),
    appRunning,
    out: (line) => console.log(line),
    style: styleFor(process.stdout),
    progress: tty ? (line) => process.stdout.write(`\r\x1b[2K${line}`) : null,
    // Loaded only for a failure: an update that goes well writes no log.
    log: async (event, fields) => {
      try {
        (await import("./core/log.ts")).log(event, fields);
      } catch {
        // no log: what's said is enough
      }
    },
  };
}
