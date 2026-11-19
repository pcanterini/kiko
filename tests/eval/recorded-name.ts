// The routing eval's cases (cases.ts) say the app's name as "Kiko" (and speech-to-text's spellings
// of it, "Kiku", "Chiko"), and a session in the kiko folder stands for one named like the app. When
// you call the app something else (name.ts spokenName, the spokenName setting), run.ts maps them to
// that name as it loads them, so the cases ask the same of the app under any name.
import { misheard } from "../../src/core/name.ts";
import type { SessionSpec } from "../support/fixtures.ts";
import type { Case } from "./cases.ts";

/** The name the cases say. */
export const RECORDED = "Kiko";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const asForm = (f: string) => f.toLowerCase().split(/\s+/).map(escape).join("[\\s-]*");
// The name and its spellings, anywhere ("the status of Kiku").
const ANYWHERE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[RECORDED, ...misheard(RECORDED).heard].map(asForm).join("|")})(?![\\p{L}\\p{N}])`, "giu");
/** `text` as if said to an app called `name`: as it is when that's Kiko. The folder's name stays a folder's ("the kiko folder"). */
export function recordedName(text: string, name: string): string {
  if (name.toLowerCase() === RECORDED.toLowerCase()) return text;
  const as = (said: string) => (said === RECORDED.toLowerCase() ? folderFor(name) : name);
  return text.replace(ANYWHERE, as);
}

/** A folder named for the app ("kiko"), for `name` ("jarvis", "hey-jarvis"). */
const folderFor = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");

function session(spec: SessionSpec, name: string): SessionSpec {
  const map = (text: string | undefined) => (text === undefined ? undefined : recordedName(text, name));
  // The case's handle (`name`) stays: expectations point at it. Its folder, given name and words follow.
  const folder = spec.folder ?? (spec.desktop ? undefined : spec.name);
  return {
    ...spec,
    ...(folder?.toLowerCase() === RECORDED.toLowerCase() ? { folder: folderFor(name) } : {}),
    ...(spec.given !== undefined ? { given: map(spec.given) } : {}),
    ...(spec.title !== undefined ? { title: map(spec.title) } : {}),
    ...(spec.asked !== undefined ? { asked: map(spec.asked) } : {}),
    ...(spec.said !== undefined ? { said: map(spec.said) } : {}),
    ...(spec.earlier ? { earlier: spec.earlier.map((e) => ({ ...e, text: recordedName(e.text, name) })) } : {}),
  };
}

/** A case as if recorded with the app called `name`: what was said, the sessions and the recent lines. */
export function inSpokenName(c: Case, name: string): Case {
  if (name.toLowerCase() === RECORDED.toLowerCase()) return c;
  const map = (text: string) => recordedName(text, name);
  return {
    ...c,
    say: map(c.say),
    sessions: c.sessions.map((s) => session(s, name)),
    ...(c.recent ? { recent: c.recent.map(map) } : {}),
    ...(c.lastSent ? { lastSent: { ...c.lastSent, text: map(c.lastSent.text) } } : {}),
    ...(c.question ? { question: { ...c.question, text: map(c.question.text) } } : {}),
    ...(c.permission ? { permission: { ...c.permission, request: map(c.permission.request) } } : {}),
  };
}
