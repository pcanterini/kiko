// Updates for an installed copy (ARCHITECTURE.md, "Updates"), the way Claude Code does them: a
// look at the release feed at most once a day (on start, and every day while running), the new
// version downloaded and checked (sha256) in the background, unpacked beside the one running, its
// signatures checked (Apple's, our team's: verifyRelease), and the links switched so the next start
// runs it. Nothing restarts under you: your sessions live in Kiko's tmux, and the app says once
// that the new one is ready (app.ts, Settings → Updates).
//
// The feed is ./feed.ts, the install's folders and links ./layout.ts, the signature checks
// ./verify.ts, the invite's token sent with each request ./invite.ts; here, what's been seen
// (update.json), what the app shows, and the app's updater.
//
// A development checkout (anything not in versions/) never updates itself: git pull does.
// KIKO_UPDATES=off: no look at the feed at all; =force: a checkout looks too, and only says.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMAND, envVar, NAME } from "../name.ts";
import { compareVersions, DAY_MS, describe, feedUrl, fetchRelease, isVersion, type NetTiming, NetworkError, platformKey, type Release, RETRY_MS } from "./feed.ts";
import { InviteError, inviteShort, releaseAuth } from "./invite.ts";
import { BusyError, type Copy, currentVersion, install, installedAs, type Layout } from "./layout.ts";
import { SignatureError, type Verify } from "./verify.ts";

/** How often a running app wakes to see whether a look is due, or `kiko update` installed one meanwhile. */
const TICK_MS = 10 * 60 * 1000;

/** KIKO_UPDATES: "off" (never look), "force" (a development checkout looks too, and only says), else on. */
export function updatesMode(raw = envVar("UPDATES")): "on" | "off" | "force" {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "no" ? "off" : v === "force" ? "force" : "on";
}

// ── What's been seen ────────────────────────────────────────────────────────

/**
 * Kept in ~/.local/state/kiko/update.json: when the feed was last read (and last failed to be),
 * what it said, a version you rolled back from (not installed again by itself), and the version
 * whose "ready" line the app has said.
 */
type UpdateState = {
  checkedAt?: number;
  failedAt?: number;
  latest?: { version: string; date?: string; notes?: string };
  skip?: string;
  announced?: string;
  /** The last install that failed: which version, and why. */
  failed?: { version: string; why: string };
  /**
   * The last download refused for its signature (SignatureError): which version and file, so the
   * same one isn't fetched again each day, and the header says so (updateWords).
   */
  refused?: { version: string; sha256: string };
  /**
   * kiko.sh refused the feed for the invite (./invite.ts InviteError: the link turned off, its Macs
   * used up, no token while the gate is on): its code and our words, until a look gets through.
   */
  link?: { code: string; why: string };
};

const stateFile = (l: Layout) => join(l.state, "update.json");

export function loadState(l: Layout): UpdateState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(l), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function saveState(l: Layout, state: UpdateState) {
  mkdirSync(l.state, { recursive: true });
  const file = stateFile(l);
  writeFileSync(`${file}.new-${process.pid}`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.new-${process.pid}`, file);
}

/** Whether a look at the feed is due: none yet, or a day since the last one; but not within an hour of one that failed. */
export function due(state: UpdateState, now = Date.now()): boolean {
  if (state.failedAt && now - state.failedAt < RETRY_MS && now >= state.failedAt) return false;
  if (!state.checkedAt) return true;
  // A clock set back: looked again rather than never.
  return now - state.checkedAt >= DAY_MS || now < state.checkedAt;
}

// ── What the app shows ──────────────────────────────────────────────────────

/**
 * What to show: the version running; `ready`, one installed that starts the next time Kiko does
 * (after a rollback, an older one); `available`, a newer one in the feed that isn't installed
 * (automatic updates off, a development checkout, or its install failed).
 */
export type UpdateView = {
  running: string;
  installed: boolean;
  auto: boolean;
  ready?: { version: string; notes?: string };
  /** `skipped`: one you rolled back from, offered in Settings but not in the header. `refused`: its download isn't signed by us. */
  available?: { version: string; notes?: string; skipped?: boolean; refused?: boolean };
  checkedAt?: number;
  failed?: string;
  /** Updates stopped: kiko.sh refused this install's invite (its code, and what to do, in words). */
  link?: { code: string; why: string };
};

export function viewOf(copy: Copy, state: UpdateState, auto: boolean): UpdateView {
  const view: UpdateView = { running: copy.version, installed: copy.installed, auto };
  if (state.checkedAt) view.checkedAt = state.checkedAt;
  if (state.link) view.link = { code: state.link.code, why: state.link.why };
  const notesFor = (v: string) => (state.latest?.version === v && state.latest.notes ? { notes: state.latest.notes } : {});
  const current = copy.installed ? currentVersion(copy.layout) : null;
  if (current && current !== copy.version) view.ready = { version: current, ...notesFor(current) };
  const newest = view.ready && compareVersions(view.ready.version, copy.version) > 0 ? view.ready.version : copy.version;
  const latest = state.latest?.version;
  if (latest && isVersion(latest) && compareVersions(latest, newest) > 0) {
    view.available = { version: latest, ...notesFor(latest), ...(state.skip === latest ? { skipped: true } : {}), ...(state.refused?.version === latest ? { refused: true } : {}) };
    if (state.failed?.version === latest) view.failed = state.failed.why;
  }
  return view;
}

/** The short words for the header and the window's line: null when there's nothing to say. */
export function updateWords(view: Pick<UpdateView, "ready" | "available" | "running" | "link">): string | null {
  if (view.ready && compareVersions(view.ready.version, view.running) > 0) return `Update ${view.ready.version} ready · restart to use it`;
  if (view.link) return `Updates stopped: ${inviteShort(view.link.code)}`;
  if (view.available?.refused) return `Update ${view.available.version} refused: not signed by ${NAME}'s developer`;
  if (view.available && !view.available.skipped) return `Update ${view.available.version} available · ${COMMAND} update`;
  if (view.ready) return `${NAME} ${view.ready.version} starts next time`;
  return null;
}

// ── In the running app ──────────────────────────────────────────────────────

/**
 * What a look came to: off (this copy doesn't look), not due, offline (the feed couldn't be read),
 * newest (nothing newer), available (newer, not installed: automatic updates off, skipped, or a
 * development copy), installed, busy (another install going on), failed (its install failed),
 * refused (its download isn't signed by Kiko's developer), link (kiko.sh refused this install's invite).
 */
type Outcome = "off" | "not due" | "offline" | "newest" | "available" | "installed" | "busy" | "failed" | "refused" | "link";

type UpdaterOptions = {
  copy: Copy;
  /** Whether automatic updates are on (the setting, read each time). */
  auto: () => boolean;
  /** Called with what to show whenever it may have changed. */
  changed: (view: UpdateView) => void;
  log: (event: string, fields?: Record<string, unknown>) => void;
  mode?: "on" | "off" | "force";
  url?: string;
  now?: () => number;
  platform?: string;
  /** The tests' stand-in for verifyRelease. */
  verify?: Verify;
  /** The tests' shorter waits between tries (./feed.ts NetTiming). */
  net?: NetTiming;
};

/** For the log: the error itself (a NetworkError's, not its plain words) and how many tries it took. */
export function failure(err: unknown): { why: string; tries?: number } {
  if (err instanceof NetworkError) return { why: err.detail, tries: err.tries };
  const tries = (err as { tries?: unknown } | null)?.tries;
  return { why: describe(err), ...(typeof tries === "number" ? { tries } : {}) };
}

/**
 * The app's updater: looks at the feed when it's due (start() and every TICK_MS), installs a newer
 * version in the background when automatic updates are on and this is an installed copy, and says
 * what changed. Never throws, never waits on the network before the app goes on; offline it says
 * nothing.
 */
export class Updater {
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<Outcome> | null = null;
  private last = "";
  private o: UpdaterOptions;
  constructor(o: UpdaterOptions) {
    this.o = o;
  }

  private get mode() {
    return this.o.mode ?? updatesMode();
  }

  /** Whether this copy looks at the feed at all. */
  get active() {
    return this.mode !== "off" && (this.o.copy.installed || this.mode === "force");
  }

  view(): UpdateView {
    return viewOf(this.o.copy, loadState(this.o.copy.layout), this.o.auto());
  }

  /** Looks now if it's due, and then every TICK_MS. */
  start() {
    if (!this.active || this.timer) return;
    void this.tick(false);
    this.timer = setInterval(() => void this.tick(false), TICK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Looks now, due or not (Settings → Updates), and installs what it finds as a tick would;
   * `install`: even with automatic updates off. What came of it (Outcome).
   */
  check(install = false): Promise<Outcome> {
    return this.tick(true, install);
  }

  private tick(force: boolean, install = false): Promise<Outcome> {
    if (!this.active && !force) return Promise.resolve("off");
    this.busy ??= this.look(force, install)
      .catch((err): Outcome => {
        this.o.log("error", { where: "update", message: err instanceof Error ? err.message : String(err) });
        return "failed";
      })
      .finally(() => {
        this.busy = null;
        this.emit();
      });
    return this.busy;
  }

  private emit() {
    const view = this.view();
    const key = JSON.stringify(view);
    if (key === this.last) return;
    this.last = key;
    this.o.changed(view);
  }

  private async look(force: boolean, installAnyway: boolean): Promise<Outcome> {
    const { copy } = this.o;
    const l = copy.layout;
    const now = this.o.now?.() ?? Date.now();
    let state = loadState(l);
    this.emit(); // `kiko update` may have switched current meanwhile
    if (!force && !due(state, now)) return "not due";
    const url = this.o.url ?? feedUrl();
    const auth = releaseAuth(l, url, copy.version);
    let release: Release;
    try {
      release = await fetchRelease(url, copy.version, undefined, auth, this.o.net);
    } catch (err) {
      if (err instanceof InviteError) {
        // Refused for the invite: said (the header, Settings), and looked at again tomorrow.
        const refused = { ...loadState(l), checkedAt: now, link: { code: err.code, why: err.message } };
        delete refused.failedAt;
        saveState(l, refused);
        this.o.log("update_link_refused", { code: err.code });
        return "link";
      }
      // Offline, or the feed down: quiet, and tried again in an hour.
      saveState(l, { ...loadState(l), failedAt: now });
      this.o.log("update_check_failed", failure(err));
      return "offline";
    }
    state = { ...loadState(l), checkedAt: now, latest: { version: release.version, ...(release.date ? { date: release.date } : {}), ...(release.notes ? { notes: release.notes } : {}) } };
    delete state.failedAt;
    delete state.link;
    saveState(l, state);
    const current = copy.installed ? currentVersion(l) : null;
    const newer = compareVersions(release.version, copy.version) > 0 && (!current || compareVersions(release.version, current) > 0);
    this.o.log("update_checked", { running: copy.version, latest: release.version, newer });
    // Older than what runs: a feed rolled back, or someone serving an old one. Never installed; only logged.
    if (compareVersions(release.version, copy.version) < 0) this.o.log("update_downgrade_refused", { running: copy.version, offered: release.version });
    if (!newer) return "newest";
    if (!copy.installed || (!installAnyway && (!this.o.auto() || state.skip === release.version))) return "available";
    const asset = release.assets[this.o.platform ?? platformKey()];
    // Refused already, the very same file: not fetched again (a new file for it is tried).
    if (asset && state.refused?.version === release.version && state.refused.sha256 === asset.sha256) return "refused";
    const started = Date.now();
    try {
      await install(l, release, { running: installedAs(copy.root, l), platform: this.o.platform, verify: this.o.verify, auth, net: this.o.net });
      const after = loadState(l);
      delete after.failed;
      delete after.refused;
      if (after.skip === release.version) delete after.skip;
      saveState(l, after);
      this.o.log("update_installed", { version: release.version, from: copy.version, ms: Date.now() - started });
      return "installed";
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (err instanceof SignatureError) {
        saveState(l, { ...loadState(l), failed: { version: release.version, why }, refused: { version: release.version, sha256: asset?.sha256 ?? "" } });
        this.o.log("update_rejected", { version: release.version, why });
        return "refused";
      }
      if (err instanceof InviteError) {
        saveState(l, { ...loadState(l), link: { code: err.code, why } });
        this.o.log("update_link_refused", { code: err.code, version: release.version });
        return "link";
      }
      // Cut off (NetworkError): Settings says it plainly; the error itself and the tries are in the log.
      if (!(err instanceof BusyError)) saveState(l, { ...loadState(l), failed: { version: release.version, why } });
      this.o.log("update_failed", { version: release.version, ...failure(err), busy: err instanceof BusyError });
      return err instanceof BusyError ? "busy" : "failed";
    }
  }
}
