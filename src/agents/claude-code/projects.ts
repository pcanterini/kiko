// The folders Claude Code has run in, from its own history: ~/.claude/projects has a folder for each,
// named after it with every character but letters and digits as "-" (/Users/me/git/lacy-platform is
// -Users-me-git-lacy-platform). That can't be read back on its own (a "-" may have been "/", ".",
// "_", " " or "-"), so the folder comes from a `cwd` its transcripts recorded that encodes to the
// same name; failing that, from walking the disk for a path that does. Folders that are gone, and
// the throwaway ones (temporary folders, worktrees, the desktop app's scratch workspaces), are left out.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envVar } from "../../core/name.ts";
import type { Renames } from "../../core/renames.ts";
import type { KnownFolder } from "../types.ts";
import { inScratch } from "./sessions.ts";

/** ~/.claude/projects; KIKO_CLAUDE_PROJECTS points the harness at a fake one. */
export const projectsDir = () => envVar("CLAUDE_PROJECTS") ?? join(homedir(), ".claude", "projects");

/** The name Claude Code gives a folder's project. */
export const encodeFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

// How much of a transcript is read: its start for the folder, its end for a name given with /rename.
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
// Transcripts read per folder, newest first: for its folder, and for the names its sessions were given.
const FOR_CWD = 3;
const FOR_NAMES = 5;

/**
 * Every folder in Claude Code's history that's still there: its path, the names its sessions were
 * given, and when it was last used. `skip`: folders left out (the throwaway ones).
 */
export function historyFolders(dir = projectsDir(), renames: Renames = {}, skip: (cwd: string) => boolean = throwaway): KnownFolder[] {
  let projects: string[];
  try {
    projects = readdirSync(dir);
  } catch {
    return [];
  }
  const found: KnownFolder[] = [];
  for (const project of projects) {
    const path = join(dir, project);
    let transcripts: Array<{ file: string; id: string; at: number }>;
    try {
      transcripts = readdirSync(path)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ file: join(path, f), id: f.slice(0, -".jsonl".length), at: statSync(join(path, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
    } catch {
      continue; // not a folder
    }
    const cwd =
      recordedCwd(
        project,
        transcripts.slice(0, FOR_CWD).map((t) => t.file),
      ) ?? decodeFolder(project);
    if (!cwd || !isFolder(cwd) || skip(cwd)) continue;
    const names = new Set<string>();
    for (const t of transcripts.slice(0, FOR_NAMES)) {
      const title = lastField(readPart(t.file, "tail", TAIL_BYTES), "customTitle").trim();
      if (title) names.add(title);
    }
    for (const t of transcripts) {
      const given = renames[t.id]?.name?.trim();
      if (given) names.add(given);
    }
    found.push({ cwd, names: [...names], lastUsed: transcripts[0]?.at ?? 0 });
  }
  return found;
}

/** A `cwd` the transcripts recorded that is this project's folder (it encodes to its name). */
function recordedCwd(project: string, files: string[]): string | null {
  for (const file of files) {
    const head = readPart(file, "head", HEAD_BYTES);
    for (const m of head.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
      try {
        const cwd = JSON.parse(`"${m[1]}"`) as string;
        if (encodeFolder(cwd) === project) return cwd;
      } catch {
        // cut short: the next one
      }
    }
  }
  return null;
}

/**
 * The folder a project's name stands for, found on disk: from "/" down, the entry whose own name
 * encodes to the next part of it ("lacy-platform" may be one folder or "lacy/platform"). Null when
 * no path there encodes to it.
 */
export function decodeFolder(project: string, root = "/"): string | null {
  if (!project.startsWith("-")) return null;
  const walk = (dir: string, rest: string, depth: number): string | null => {
    if (depth > 30) return null;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const name = encodeFolder(entry);
      const path = join(dir, entry);
      if (rest === name) return isFolder(path) ? path : null;
      if (rest.startsWith(`${name}-`) && isFolder(path)) {
        const deeper = walk(path, rest.slice(name.length + 1), depth + 1);
        if (deeper) return deeper;
      }
    }
    return null;
  };
  return walk(root, project.slice(1), 0);
}

/** Folders nobody means by a project's name: temporary ones, worktrees, the desktop app's scratch workspaces. */
export function throwaway(cwd: string) {
  return /^\/(?:private\/)?(?:tmp|var\/folders)(?:\/|$)/.test(cwd) || /\/\.claude\/worktrees\/[^/]+\/?$/.test(cwd) || inScratch(cwd);
}

function isFolder(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readPart(path: string, part: "head" | "tail", bytes: number): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = statSync(path).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, part === "head" ? 0 : size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

function lastField(text: string, field: string): string {
  const matches = [...text.matchAll(new RegExp(`"${field}":"((?:[^"\\\\]|\\\\.)*)"`, "g"))];
  try {
    return matches.length ? JSON.parse(`"${matches[matches.length - 1][1]}"`) : "";
  } catch {
    return "";
  }
}
