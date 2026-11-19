// The invite (Kiko's beta is invite-only; the site's RELEASES.md, "Invites and the gate"): each
// invite is one person's install link, https://kiko.sh/i/<token>. install.sh keeps its token, and a
// random id for this Mac, beside the install (the same files, the same rules: install.sh):
//   ~/.local/share/kiko/install-token   the invite's token (readable by you only)
//   ~/.local/share/kiko/install-id      this Mac's install id, made once (readable by you only)
// The updater sends both with every request for the feed and the download (Kiko-Install-Token,
// Kiko-Install-Id), and its own name and version (Kiko-Client: app/<version>), so kiko.sh can tell
// which invite an install came from and refuse a link that was turned off or used on too many Macs.
// They go only to the feed's own origin, never to a file the feed names elsewhere. An install
// without a token (from before the invites, or a development copy) adds one with `kiko update
// --token <token>`, or by running its install link again.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMAND, DOMAIN } from "../name.ts";
import type { Layout } from "./layout.ts";

export const TOKEN_HEADER = "Kiko-Install-Token";
export const INSTALL_ID_HEADER = "Kiko-Install-Id";
export const CLIENT_HEADER = "Kiko-Client";
/** kiko.sh's answer when it refuses: which refusal (InviteRefusal). */
export const ERROR_HEADER = "Kiko-Install-Error";

const SUPPORT = `support@${DOMAIN}`;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const INSTALL_ID = /^[A-Za-z0-9-]{8,64}$/;

export const tokenFile = (l: Layout) => join(l.share, "install-token");
export const installIdFile = (l: Layout) => join(l.share, "install-id");

function readLine(file: string): string | null {
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** A file written whole (beside it, then renamed over it), readable by you only. */
function keep(file: string, value: string) {
  mkdirSync(join(file, ".."), { recursive: true });
  const fresh = `${file}.new-${process.pid}`;
  rmSync(fresh, { force: true });
  writeFileSync(fresh, `${value}\n`, { mode: 0o600 });
  renameSync(fresh, file);
}

/** The invite's token kept for this install, or null (none, or not one). */
export function readToken(l: Layout): string | null {
  const t = readLine(tokenFile(l));
  return t && TOKEN.test(t) ? t : null;
}

/** Keeps `token` as this install's (validated: tokenFrom first). */
export function saveToken(l: Layout, token: string) {
  if (!TOKEN.test(token)) throw new Error("that isn't an install token");
  keep(tokenFile(l), token);
}

/** This Mac's install id: the one kept, else (`make`) a new one, kept. */
export function installId(l: Layout, make = true): string | null {
  const have = readLine(installIdFile(l));
  if (have && INSTALL_ID.test(have)) return have.toLowerCase();
  if (!make) return null;
  const id = randomUUID();
  try {
    keep(installIdFile(l), id);
  } catch {
    return null; // not kept, so not sent: a new one each time would count as another Mac
  }
  return id;
}

/**
 * The token in what was pasted: the token itself, the link (https://kiko.sh/i/<token>), or the
 * whole install command. Null when there's none.
 */
export function tokenFrom(text: string): string | null {
  const s = text.trim();
  if (TOKEN.test(s)) return s;
  const m = /\/i\/([A-Za-z0-9_-]{16,64})(?=$|[/\s?#'"|])/.exec(s);
  return m ? m[1] : null;
}

/** What the updater sends with its requests for the release, and to which origin. */
export type ReleaseAuth = { origin: string | null; headers: Record<string, string> };

/**
 * The headers for the feed at `feed` and its files: always Kiko-Client (app/<running>), and the
 * invite's token with this Mac's install id when this install has a token (the id made if missing).
 */
export function releaseAuth(l: Layout, feed: string, running: string): ReleaseAuth {
  let origin: string | null = null;
  try {
    const u = new URL(feed);
    if (u.protocol === "https:" || u.protocol === "http:") origin = u.origin;
  } catch {
    // not a URL: no origin, nothing sent
  }
  const headers: Record<string, string> = { [CLIENT_HEADER]: `app/${running}` };
  const token = readToken(l);
  if (token) {
    headers[TOKEN_HEADER] = token;
    const id = installId(l);
    if (id) headers[INSTALL_ID_HEADER] = id;
  }
  return { origin, headers };
}

/** The headers for `url`: `auth`'s when it's on the feed's own origin, else none. */
export function headersFor(auth: ReleaseAuth | undefined, url: string): Record<string, string> {
  if (!auth?.origin) return {};
  try {
    return new URL(url).origin === auth.origin ? auth.headers : {};
  } catch {
    return {};
  }
}

// ── Refused ─────────────────────────────────────────────────────────────────

export type InviteRefusal = "missing" | "unknown" | "revoked" | "limit" | "install_id";

const WORDS: Record<InviteRefusal, { why: string; short: string }> = {
  missing: {
    why: `Updates need your invite's install link now. Run the command from your invite email again, or: ${COMMAND} update --token <token>`,
    short: `they need your install link (${COMMAND} update --token)`,
  },
  unknown: {
    why: `This install link isn't valid. Run the command from your invite email again, or ask for a new invite: ${SUPPORT}`,
    short: "this install link isn't valid",
  },
  revoked: { why: `This install link was turned off. Ask for a new invite: ${SUPPORT}`, short: "this install link was turned off" },
  limit: {
    why: `This install link has been used on as many Macs as it allows. Ask the person who invited you, or write to ${SUPPORT}`,
    short: "this install link's Macs are used up",
  },
  install_id: { why: `kiko.sh didn't get this Mac's install id. Run the command from your invite email again, or write to ${SUPPORT}`, short: "run your install link again" },
};

/** Thrown when kiko.sh refuses the feed or a download for the invite: the words are ours, by its code. */
export class InviteError extends Error {
  readonly code: InviteRefusal;
  constructor(code: InviteRefusal) {
    super(WORDS[code].why);
    this.code = code;
  }
}

/** The header's words for a refusal (Updates stopped: …). */
export const inviteShort = (code: string) => (WORDS as Record<string, { short: string }>)[code]?.short ?? "the install link was refused";

/** The InviteError for a refused answer from kiko.sh, or null (another failure, or one that passes: "unavailable"). */
export function inviteError(res: Response): InviteError | null {
  const code = res.headers.get(ERROR_HEADER)?.trim() ?? "";
  return Object.hasOwn(WORDS, code) ? new InviteError(code as InviteRefusal) : null;
}
