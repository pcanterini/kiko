// Where a new session opens: "open a session in Pixie" finds the folder by the name said. The
// projects are the folders the coding agent has run in (its own history: agent.knownFolders()), the
// running sessions' folders, and the folders in the projects root (a setting; unset, the usual ones
// that exist: ~/git, ~/code, …). Each answers to its folder's name and to the names its sessions
// were given there. A name matched exactly opens that folder; one only close to a name (speech-to-text's
// "Pixy" for pixie) opens the closest and says so; none, or one nobody knows, opens a fresh scratch
// folder (~/Kiko/scratch/2026-10-29-login-bug), never a real project nor Kiko's own folder.
// Deciding is pure (decide.ts startPlace, on this list); making folders and opening the window is app.ts.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { heardWords, inScratch, type Session } from "./sessions.ts";
import { nearDistance } from "./words.ts";
import { shortPath } from "./text.ts";

/** A folder a new session can open in, and the names it answers to (its folder's name first). */
export type Project = { cwd: string; names: string[]; lastUsed: number };

/** A folder with names of its own: from the agent's history, or a running session's. */
export type Named = { cwd: string; names: string[]; lastUsed: number };

/** Where projects usually live, under the home folder: the projects root when none is set. */
const COMMON_ROOTS = ["git", "code", "src", "dev", "Developer", "Projects", "repos"];

/** The running sessions' folders, by the names given to them (not the desktop app's made-up folders). */
export function sessionFolders(sessions: Session[]): Named[] {
  return sessions.filter((s) => !inScratch(s.cwd)).map((s) => ({ cwd: s.cwd, names: s.givenName?.trim() ? [s.givenName.trim()] : [], lastUsed: s.lastActiveAt }));
}

/** The usual projects folders that exist in `home`. */
export function commonRoots(home: string): string[] {
  return COMMON_ROOTS.map((name) => join(home, name)).filter(isFolder);
}

/** The folders whose subfolders are projects: the projects root when it's set, else the usual ones that exist. */
export function projectRoots(projectsRoot: string, home: string): string[] {
  return projectsRoot ? [projectsRoot].filter(isFolder) : commonRoots(home);
}

/**
 * The projects root as the settings show it: the one set, or the usual folders found and used
 * meanwhile ("~/git (found)"). A fresh install works from those with nothing set; "Not set (~/git)",
 * as it was shown, read as if it didn't.
 */
export function projectsRootShown(projectsRoot: string, home: string): string {
  if (projectsRoot) return shortPath(projectsRoot, home);
  const usual = commonRoots(home);
  return usual.length ? `${usual.map((p) => shortPath(p, home)).join(", ")} (found)` : "Not set: no ~/git, ~/code or the like found";
}

/** Where "make a new project called Pixel" makes pixel/: the projects root, else the first usual one; null when there's none. */
export function newProjectRoot(projectsRoot: string, home: string): string | null {
  return projectsRoot || commonRoots(home)[0] || null;
}

/** A root's subfolders (not hidden ones), as projects nobody has opened a session in yet. */
export function rootFolders(root: string): Project[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith("."))
    .map((name) => join(root, name))
    .filter(isFolder)
    .map((cwd) => ({ cwd, names: [], lastUsed: 0 }));
}

/**
 * All of them as one list: one entry per folder (a symlink and the folder it points to are one, by
 * either name), its folder's name first, then the names given there. `folders` in order of
 * preference for the path kept (running sessions' first, so the path is the one they report).
 * Folders `skip` says no to are left out (the scratch folder, the home folder).
 */
export function listProjects(folders: Named[], skip: (cwd: string) => boolean = () => false): Project[] {
  const byKey = new Map<string, Project>();
  for (const f of folders) {
    if (skip(f.cwd)) continue;
    const key = realFolder(f.cwd);
    if (skip(key)) continue;
    const names = [baseName(f.cwd), ...f.names].filter(Boolean);
    const had = byKey.get(key);
    if (!had) {
      byKey.set(key, { cwd: f.cwd, names: unique(names), lastUsed: f.lastUsed });
      continue;
    }
    had.names = unique([...had.names, ...names]);
    had.lastUsed = Math.max(had.lastUsed, f.lastUsed);
  }
  return [...byKey.values()];
}

/** How a name said picked a project: exactly one of its names, or only close to one. */
type ProjectMatch = { project: Project; name: string; how: "exact" | "close"; said: string };

/**
 * The project a name said means ("Pixie", "the lacy platform project", "clip kit"): one of its names
 * exactly, as speech gives them (case, spaces and dashes aside, "cloud" for "claude"), else the one
 * it comes closest to as speech-to-text gets names wrong ("Pixy" for pixie: words.ts nearDistance).
 * Two equally good: the one used last. Null when none is close.
 */
export function matchProject(said: string, projects: Project[]): ProjectMatch | null {
  const clean = cleanName(said);
  const want = key(clean);
  if (!want) return null;
  const latest = <T extends { project: Project }>(all: T[]) => all.sort((a, b) => b.project.lastUsed - a.project.lastUsed)[0];
  const exact = projects.flatMap((project) => project.names.filter((n) => key(n) === want).map((name) => ({ project, name })));
  if (exact.length) return { ...latest(exact), how: "exact", said: clean };
  if (want.length < 3) return null;
  const near = projects.flatMap((project) =>
    project.names.flatMap((name) => {
      const n = key(name);
      const d = n.length > 3 ? nearDistance(endSound(want), endSound(n), NEAR_SHARE) : null;
      return d === null ? [] : [{ project, name, d }];
    }),
  );
  if (!near.length) return null;
  const best = Math.min(...near.map((x) => x.d));
  const { project, name } = latest(near.filter((x) => x.d === best));
  return { project, name, how: "close", said: clean };
}

/**
 * Which of an app's own projects (T3 Code's: Agent.launches.projects) a new session asked for at
 * `where` goes in: one of its names said exactly, else the folder `where` found for the name (T3's
 * "Pixie App" in ~/git/pixie, asked for as "pixie"), else one close to the name said ("Pixy").
 * `unknown`: a project was named (or a folder found) that isn't one of them, `said` as it was said.
 * Nothing named: its only project, else `unnamed` (which one isn't guessed).
 */
export function projectAmong(where: StartPlace, projects: Project[]): ProjectMatch | { unknown: string } | "unnamed" {
  const said = "said" in where && where.said ? where.said : where.kind === "home" ? "your home folder" : "";
  const cwd = where.kind === "project" || where.kind === "home" ? where.cwd : null;
  const named = said && where.kind !== "home" ? matchProject(said, projects) : null;
  if (named?.how === "exact") return named;
  const there = cwd ? projects.find((p) => p.cwd === cwd || realFolder(p.cwd) === realFolder(cwd)) : undefined;
  if (there)
    return {
      project: there,
      name: where.kind === "project" ? where.name : there.names[0] || baseName(there.cwd),
      how: where.kind === "project" && where.how === "close" ? "close" : "exact",
      said: said || baseName(there.cwd),
    };
  if (named) return named;
  if (said || cwd) return { unknown: said || baseName(cwd!) };
  return projects.length === 1 ? { project: projects[0], name: projects[0].names[0] || baseName(projects[0].cwd), how: "exact", said: "" } : "unnamed";
}

/** "the pixie project" → "pixie": the name without the words around it. */
function cleanName(said: string) {
  return said
    .trim()
    .replace(/^["'“‘]+|["'”’.,!?]+$/g, "")
    .replace(/^(?:(?:the|my|our|a)\s+)+/i, "")
    .replace(/\s+(?:project|folder|repo|repository|directory|codebase)$/i, "")
    .trim();
}

// A name as compared: its words as speech gives them, run together ("Clip Kit", "clipkit", "clip-kit").
const key = (name: string) => heardWords(name).join("");

// Closer than a session's name in an answer to "which session?" (decide.ts nearOffered): any folder
// could be meant here, so "Pixel" is no project's take on pixie, while "Pixy" is.
const NEAR_SHARE = 0.3;
// "Pixy", "Pixie", "Pixey": the same ending said.
const endSound = (word: string) => word.replace(/(?:ie|ey|ee|i)$/, "y");

// Words that say nothing about what a session is for, left out of its scratch folder's name.
const NOT_IN_SLUG = new Set(
  "a an the and or but so to of in on at for with from by as it its it's is are be this that these those me my i you your we our us let lets let's please can could would should will just some about into up uh um okay ok hey new session claude can't don't".split(
    " ",
  ),
);

/**
 * A scratch folder's name: the day, and a few words of what it's for ("2026-10-29-login-bug").
 * `from`: its name, the project said that nobody knows, or its first message.
 */
export function scratchName(at: Date, from: string): string {
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  const words = slugWords(from).filter((w) => !NOT_IN_SLUG.has(w));
  let slug = "";
  for (const w of words.slice(0, 4)) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > 30) break;
    slug = next;
  }
  if (!slug && words.length) slug = words[0].slice(0, 30);
  return `${day}-${slug || "session"}`;
}

/** A new project's folder name: "Pixel" → pixel, "Cool App" → cool-app. */
export function projectFolderName(name: string): string {
  return slugWords(cleanName(name)).join("-").slice(0, 60) || "project";
}

/** `root/name`, or `root/name-2` and on when that's taken. */
export function freeFolder(root: string, name: string, taken: (path: string) => boolean = existsSync): string {
  let path = join(root, name);
  for (let i = 2; taken(path); i++) path = join(root, `${name}-${i}`);
  return path;
}

/** "~/git" as the full path; anything else as it is. */
export function expandHome(path: string, home: string): string {
  return path.trim().replace(/^~(?=$|\/)/, home);
}

/** Whether `cwd` is `folder` or inside it. */
export function within(cwd: string, folder: string): boolean {
  const f = folder.replace(/\/+$/, "");
  return Boolean(f) && (cwd === f || cwd.startsWith(`${f}/`));
}

const slugWords = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const unique = (names: string[]) => {
  const seen = new Set<string>();
  return names.filter((n) => {
    const k = key(n);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const baseName = (cwd: string) => cwd.split("/").filter(Boolean).pop() ?? "";

function realFolder(cwd: string) {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function isFolder(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Where a new session opens. */
export type StartPlace =
  /**
   * A known project: the name said matched `name`, one of its names, exactly or only closely; or no
   * project was said and the session's own name is one of its names exactly ("named").
   */
  | { kind: "project"; cwd: string; how: "exact" | "close" | "named"; name: string; said: string }
  | { kind: "home"; cwd: string }
  /** "Make a new project called Pixel": its folder in the projects root, made unless it's there. */
  | { kind: "new"; cwd: string; said: string }
  /** A fresh scratch folder, made for it: `said` is the name nobody knows, null when none was said. */
  | { kind: "scratch"; said: string | null };

// "home", "my home folder": the home folder, not a project called home.
const HOME_WORDS = /^(?:(?:my|the)\s+)?home(?:\s+(?:folder|directory|dir))?$/i;

/**
 * A folder the session's name, or a folder's name written in its first words ("Work in the
 * kiko-trust-test folder…"), names exactly, when the project said is only part of it: the router
 * took the first word of a folder's name for the project. A new session asked for in a folder like
 * kiko-trust-test came as project "Kiko", name "Kiko trust test", and opened in ~/git/kiko, not the
 * ~/git/kiko-trust-test made for it. Only a folder
 * whose name starts with the project said (as matched, or as said when nothing matched), and is
 * longer: a session named after its work ("Kiko docs") opens in Kiko as ever when no
 * kiko-docs folder is there.
 */
function namedFolder(ask: { sessionName: string; prompt?: string }, projects: Project[], matched: Project | null, said: string): ProjectMatch | null {
  const stems = [...(matched?.names ?? []), cleanName(said)].map(key).filter(Boolean);
  // Folder-like words in the prompt: a name with a dash, dot or underscore in it ("kiko-trust-test").
  const written = (ask.prompt ?? "").match(/[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)+/gu) ?? [];
  for (const candidate of [ask.sessionName, ...written]) {
    if (!candidate.trim()) continue;
    const m = matchProject(candidate, projects);
    if (m?.how !== "exact" || m.project === matched) continue;
    const k = key(m.name);
    if (stems.some((stem) => k.length > stem.length && k.startsWith(stem))) return m;
  }
  return null;
}

/** "home", "my home folder": the home folder meant as the project. */
export const isHome = (project: string) => HOME_WORDS.test(project.trim().replace(/[.!?]+$/, ""));
// "a scratch folder", "default": no project in particular.
const SCRATCH_WORDS = /^(?:(?:a|the|my)\s+)?(?:new\s+)?(?:scratch|temp|temporary|default|throwaway)(?:\s+(?:folder|directory|dir|space|workspace|one))?$/i;

/**
 * Where a new session asked for opens: a new project in `root`; the home folder; the project the name
 * said picks (or a folder the session's name or its first words name exactly, when that's the said
 * project's name and more: namedFolder); with no project said, the one the session's name is
 * exactly; else a scratch folder. Null for a new project with no `root` to make it in.
 */
export function startPlace(ask: { project: string | null; newProject: boolean; sessionName: string; prompt?: string }, projects: Project[], root: string | null, home: string): StartPlace | null {
  const project = ask.project?.trim() ?? "";
  if (ask.newProject && project) return root ? { kind: "new", cwd: join(root, projectFolderName(project)), said: cleanName(project) } : null;
  if (project && isHome(project)) return { kind: "home", cwd: home };
  if (project && !SCRATCH_WORDS.test(project.replace(/[.!?]+$/, ""))) {
    const m = matchProject(project, projects);
    const named = namedFolder(ask, projects, m?.project ?? null, project);
    if (named) return { kind: "project", cwd: named.project.cwd, how: "exact", name: named.name, said: named.said };
    return m ? { kind: "project", cwd: m.project.cwd, how: m.how, name: m.name, said: m.said } : { kind: "scratch", said: cleanName(project) };
  }
  const named = ask.sessionName ? matchProject(ask.sessionName, projects) : null;
  if (named?.how === "exact") return { kind: "project", cwd: named.project.cwd, how: "named", name: named.name, said: named.said };
  return { kind: "scratch", said: null };
}
