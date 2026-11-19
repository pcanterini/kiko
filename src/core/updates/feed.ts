// The release feed (./updater.ts has how updates go):
// ${KIKO_RELEASES_URL:-https://kiko.sh/releases}/latest.json, `{ version, date, notes, assets: {
// "darwin-arm64": { url, sha256 }, … } }`; https:// or file:// (the tests). Here: read and checked,
// versions compared, and an asset downloaded with its sha256 checked.
//
// The sha256 comes from the same server as the tarball, so it only catches a broken download. What
// stops a fake build is the signature (./verify.ts).
//
// The network may go while it's read (a VPN switched on mid-download, Wi-Fi changed): the feed is
// tried again twice, the download three times (from where it stopped when the server takes byte
// ranges; kiko.sh doesn't, so from the start), a download without a byte for 20 s counts as cut
// off, and what's said in the end is plain (NetworkError: "The download was cut off: …"); the error
// itself and the tries go to the log.
//
// Each request to kiko.sh carries the invite's token and this Mac's install id when this install has
// them (./invite.ts: ReleaseAuth, only to the feed's own origin); a refusal for the invite throws
// InviteError, in our own words.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from "node:fs";
import { type FileHandle, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { COMMAND, DOMAIN, envVar, RELEASES_URL, SLUG } from "../name.ts";
import { headersFor, inviteError, type ReleaseAuth } from "./invite.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** After a look that failed (offline), the next one waits this long, quietly. */
export const RETRY_MS = 60 * 60 * 1000;

/** The feed's URL: KIKO_RELEASES_URL's latest.json, else kiko.sh's. */
export const feedUrl = () => `${(envVar("RELEASES_URL") || RELEASES_URL).replace(/\/+$/, "")}/latest.json`;

// ── The feed ────────────────────────────────────────────────────────────────

type Asset = { url: string; sha256: string };
export type Release = { version: string; date?: string; notes?: string; assets: Record<string, Asset> };

/** A version as the feed and the folders write it: 1.2.3, maybe -beta.1. Nothing else can become a folder name. */
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.]{1,40})?$/;
export const isVersion = (v: unknown): v is string => typeof v === "string" && VERSION.test(v);

/** Text from the feed as one plain line: no escape sequences or other control characters, at most `max`. */
export const plain = (s: string, max: number) => {
  const flat = s
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The feed read: null when it isn't one (a missing or odd version, an asset without its sha256 or with a URL that isn't https://, file://, or http:// on this Mac). */
export function parseRelease(raw: unknown): Release | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isVersion(r.version) || !r.assets || typeof r.assets !== "object" || Array.isArray(r.assets)) return null;
  const assets: Record<string, Asset> = {};
  for (const [key, a] of Object.entries(r.assets as Record<string, unknown>)) {
    if (!a || typeof a !== "object") continue;
    const { url, sha256 } = a as Record<string, unknown>;
    // https://, file:// (the tests), or plain http:// on this Mac only (the site run locally, wrangler dev).
    if (typeof url !== "string" || !/^((https|file):\/\/|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/)/.test(url)) continue;
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)) continue;
    assets[key] = { url, sha256: sha256.toLowerCase() };
  }
  return {
    version: r.version,
    ...(typeof r.date === "string" && r.date.trim() ? { date: plain(r.date, 40) } : {}),
    ...(typeof r.notes === "string" && r.notes.trim() ? { notes: plain(r.notes, 400) } : {}),
    assets,
  };
}

/** Which asset this Mac takes: "darwin-arm64" or "darwin-x64". */
export const platformKey = (platform: string = process.platform, arch: string = process.arch) => `${platform}-${arch}`;

/** <0, 0 or >0 as `a` is older than, the same as or newer than `b` (1.2.3; a -pre release comes before its release). */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = a.split("-", 2) as [string, string | undefined];
  const [coreB, preB] = b.split("-", 2) as [string, string | undefined];
  const na = coreA.split(".").map(Number);
  const nb = coreB.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) - (nb[i] ?? 0);
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  const pa = preA.split(".");
  const pb = preB.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const [x, y] = [Number(pa[i]), Number(pb[i])];
    const c = Number.isInteger(x) && Number.isInteger(y) ? x - y : pa[i].localeCompare(pb[i]);
    if (c) return c;
  }
  return 0;
}

/** Reads a URL: https:// with fetch (tried again on a network error: `waits`), file:// from disk. A refusal for the invite throws InviteError. */
async function readUrl(url: string, timeoutMs: number, userAgent: string, headers: Record<string, string>, waits: readonly number[]): Promise<string> {
  if (url.startsWith("file://")) return readFile(fileURLToPath(url), "utf8");
  for (let tries = 1; ; tries++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { ...headers, "user-agent": userAgent, accept: "application/json" } });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw inviteError(res) ?? new HttpError(res.status, `${res.status} ${res.statusText}`.trim());
      }
      return await res.text();
    } catch (err) {
      if (!retryable(err)) throw err;
      if (tries > waits.length) throw gaveUp(err, tries, unreachable(url));
      await sleep(waits[tries - 1]);
    }
  }
}

/** The feed, read and checked: throws when it can't be reached (NetworkError, after trying again) or isn't one (InviteError: refused for the invite). */
export async function fetchRelease(url = feedUrl(), running = "0.0.0", timeoutMs = 15_000, auth?: ReleaseAuth, timing: NetTiming = {}): Promise<Release> {
  const text = await readUrl(url, timeoutMs, `${SLUG}/${running}`, headersFor(auth, url), timing.feedWaits ?? FEED_WAITS);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("the release feed isn't JSON");
  }
  const release = parseRelease(raw);
  if (!release) throw new Error("the release feed doesn't say which version, or how to get it");
  return release;
}

// ── Download, check ─────────────────────────────────────────────────────────

export type Progress = (done: number, total: number | null) => void;

/** Thrown when the download isn't what the feed said (its sha256): nothing of it is kept. */
export class ChecksumError extends Error {}

/**
 * An asset downloaded to `to`, its sha256 checked as it comes; a mismatch removes it and throws
 * ChecksumError. Over the network, an attempt that gets no bytes for `stallMs` (20 s) is given up on
 * (a socket left half open when the network changed: a VPN switched on), and one cut off is tried
 * again, up to 3 more times (after 2, 5 and 10 s), within the overall `timeoutMs`: from where it
 * stopped (a `Range` request) when the server said it takes them, else from the start. Still cut
 * off: NetworkError, in plain words. Nothing is kept of a download that failed.
 */
export async function download(asset: Asset, to: string, progress?: Progress, timeoutMs = 10 * 60 * 1000, auth?: ReleaseAuth, timing: NetTiming = {}): Promise<void> {
  mkdirSync(dirname(to), { recursive: true });
  let got: string;
  try {
    got = asset.url.startsWith("file://") ? await fromFile(fileURLToPath(asset.url), to, progress) : await fromNetwork(asset, to, progress, timeoutMs, auth, timing);
  } catch (err) {
    rmSync(to, { force: true });
    throw err;
  }
  if (got !== asset.sha256.toLowerCase()) {
    rmSync(to, { force: true });
    throw new ChecksumError(`the download isn't the one the release lists (sha256 ${got.slice(0, 12)}…, expected ${asset.sha256.slice(0, 12)}…), so it wasn't installed`);
  }
}

/** A file:// asset copied to `to`: its sha256. */
async function fromFile(path: string, to: string, progress?: Progress): Promise<string> {
  const total = statSync(path).size;
  const hash = createHash("sha256");
  let done = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, next) {
      hash.update(chunk);
      done += chunk.length;
      progress?.(done, total);
      next(null, chunk);
    },
  });
  await pipeline(createReadStream(path), count, createWriteStream(to));
  return hash.digest("hex");
}

/** `buf` written whole at `at`. */
async function writeAt(file: FileHandle, buf: Uint8Array, at: number) {
  for (let off = 0; off < buf.length; ) off += (await file.write(buf, off, buf.length - off, at + off)).bytesWritten;
}

/** An https:// asset fetched to `to`, tried again when it's cut off (download): its sha256. */
async function fromNetwork(asset: Asset, to: string, progress: Progress | undefined, timeoutMs: number, auth: ReleaseAuth | undefined, timing: NetTiming): Promise<string> {
  const waits = timing.downloadWaits ?? DOWNLOAD_WAITS;
  const stallMs = timing.stallMs ?? STALL_MS;
  const overall = AbortSignal.timeout(timeoutMs);
  const file = await open(to, "w", 0o600);
  let hash = createHash("sha256");
  let done = 0;
  let total: number | null = null;
  // What the first full answer said: whether it takes byte ranges, and its ETag (If-Range: a file changed since comes whole).
  let ranges = false;
  let etag: string | null = null;
  const restart = async () => {
    hash = createHash("sha256");
    done = 0;
    await file.truncate(0);
  };
  try {
    for (let tries = 1; ; tries++) {
      // Everything came, and then the connection went: nothing left to fetch.
      if (tries > 1 && total !== null && done === total) return hash.digest("hex");
      const stall = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const poke = () => {
        clearTimeout(timer);
        timer = setTimeout(() => stall.abort(new StallError(`no bytes came for ${stallMs / 1000} s`)), stallMs);
      };
      try {
        poke();
        const resume = ranges && done > 0;
        const headers: Record<string, string> = { ...headersFor(auth, asset.url) };
        if (resume) {
          headers.range = `bytes=${done}-`;
          if (etag) headers["if-range"] = etag;
        }
        const res = await fetch(asset.url, { signal: AbortSignal.any([overall, stall.signal]), headers });
        if (resume && res.status === 206) {
          // The rest, from where it stopped; anything else is fetched again from the start.
          const range = /^bytes (\d+)-\d+\/(\d+|\*)$/i.exec(res.headers.get("content-range")?.trim() ?? "");
          if (!range || Number(range[1]) !== done || (total !== null && range[2] !== "*" && Number(range[2]) !== total)) {
            await res.body?.cancel().catch(() => {});
            ranges = false;
            throw new OddRangeError(`asked for bytes ${done}- and got ${res.headers.get("content-range") ?? "no Content-Range"}`);
          }
        } else if (res.status === 200) {
          // The whole file: from the start (a server that ignored the Range, or the first try).
          if (done > 0) await restart();
          const length = Number(res.headers.get("content-length"));
          total = Number.isFinite(length) && length > 0 ? length : null;
          ranges = /\bbytes\b/i.test(res.headers.get("accept-ranges") ?? "");
          const tag = res.headers.get("etag");
          etag = tag && !tag.startsWith("W/") ? tag : null;
        } else {
          await res.body?.cancel().catch(() => {});
          throw inviteError(res) ?? new HttpError(res.status, `the download failed (${res.status} ${res.statusText})`.replace(" )", ")"));
        }
        if (!res.body) throw new HttpError(res.status, "the download came without a body");
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          poke();
          await writeAt(file, chunk, done);
          hash.update(chunk);
          done += chunk.length;
          progress?.(done, total);
        }
        if (total !== null && done !== total) throw new CutShortError(`the connection closed after ${done} of ${total} bytes`);
        return hash.digest("hex");
      } catch (err) {
        const cause = stall.signal.aborted ? stall.signal.reason : err;
        if (overall.aborted) throw new NetworkError(cutOff(), `not done after ${Math.round(timeoutMs / 1000)} s (${describe(err)})`, tries);
        if (!(stall.signal.aborted || retryable(err))) throw err;
        if (tries > waits.length) throw gaveUp(cause, tries, cutOff());
        await sleep(waits[tries - 1]);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await file.close();
  }
}

// ── The network ─────────────────────────────────────────────────────────────

/** The download: how long to wait before each try again (3 more), and how long without a byte is a stall. */
const DOWNLOAD_WAITS = [2_000, 5_000, 10_000];
const STALL_MS = 20_000;
/** The feed: before each try again (2 more). */
const FEED_WAITS = [1_000, 3_000];

/** How long the network gets (the tests shorten them): the waits before each try again, and the stall limit. */
export type NetTiming = { downloadWaits?: readonly number[]; stallMs?: number; feedWaits?: readonly number[] };

/** The words for a download cut off for good. */
export const cutOff = () => `The download was cut off: the network changed or dropped. Nothing was installed; run ${COMMAND} update to try again.`;

/** The words for a feed that can't be reached (its host: no path, nothing else of the URL). */
export function unreachable(url: string): string {
  let host = DOMAIN;
  try {
    host = new URL(url).host || DOMAIN;
  } catch {
    // not a URL: kiko.sh
  }
  return `${host} couldn't be reached: the network changed or dropped. Nothing was installed; run ${COMMAND} update to try again.`;
}

/**
 * The network failed, and kept failing after trying again: the message is in plain words (cutOff,
 * unreachable); `detail`, the error itself, and `tries` are for the log.
 */
export class NetworkError extends Error {
  readonly detail: string;
  readonly tries: number;
  constructor(message: string, detail: string, tries: number) {
    super(message);
    this.detail = detail;
    this.tries = tries;
  }
}

/** An answer that isn't the file (a 404, a 503): tried again only for 5xx, 408 and 429. `tries`, once given up. */
export class HttpError extends Error {
  readonly status: number;
  tries = 1;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** No bytes for the stall limit. */
class StallError extends Error {}
/** The body ended before its Content-Length. */
class CutShortError extends Error {}
/** A 206 that isn't the rest of the file. */
class OddRangeError extends Error {}

/** The error codes of a connection that failed or went (Node's, undici's, Bun's). */
const NET_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENOTCONN",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ConnectionRefused",
  "ConnectionClosed",
  "ConnectionReset",
  "FailedToOpenSocket",
  "UnableToConnect",
  "ConnectionTimedOut",
  "Timeout",
]);

/** Whether `err` is the network's (worth trying again): a connection reset, refused, timed out, cut short; a 5xx, 408 or 429. Never a refusal for the invite, a 404, a full disk. */
export function retryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500 || err.status === 408 || err.status === 429;
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) {
    if (e instanceof StallError || e instanceof CutShortError || e instanceof OddRangeError) return true;
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NET_CODES.has(code)) return true;
    if (e.name === "TimeoutError") return true;
    if (e instanceof TypeError && /^(fetch failed|terminated|network)/i.test(e.message)) return true;
    if (/socket connection was closed|unable to connect|connection (reset|refused|closed)/i.test(e.message)) return true;
  }
  return false;
}

/** What to throw once the tries are used up: a status as itself, with its tries; the network's as NetworkError, in `words`. */
function gaveUp(err: unknown, tries: number, words: string): Error {
  if (err instanceof HttpError) {
    err.tries = tries;
    return err;
  }
  return new NetworkError(words, describe(err), tries);
}

/** An error in one line for the log: its code and message, and its cause's; a URL's query cut off. */
export function describe(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 3; e = e instanceof Error ? e.cause : undefined, depth++) {
    if (!(e instanceof Error)) {
      parts.push(String(e));
      break;
    }
    const code = (e as { code?: unknown }).code;
    parts.push(`${typeof code === "string" && !e.message.includes(code) ? `${code}: ` : ""}${e.message}`);
  }
  return plain(parts.join(" / ").replace(/(https?:\/\/[^\s?#'"]+)[?#][^\s'"]*/g, "$1"), 400);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
