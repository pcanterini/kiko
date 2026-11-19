// A user's own dictionary, as their dictionary.json would hold it: the words one user added for
// their projects and tools (clipkit, Lacy, Jev). The app ships none of these: a new install's
// dictionary is empty, and the built-in words (src/core/dictionary.ts builtInEntries: the app's
// names, Claude Code, Ghostty…) apply on top of these, as in the app.
import type { DictEntry } from "../../src/core/dictionary.ts";

export const MINE: DictEntry[] = [
  // Longer than "code code speech", so "Claude code code speech" doesn't become "Claude Claude Code speech".
  { heard: "claude code code speech", write: "Claude Code speech" },
  { heard: "code code speech", write: "Claude Code speech" },
  { heard: "clawed speech", write: "Claude speech" },
  { heard: "con speech", write: "Claude speech" },
  { heard: "clip kit", write: "clipkit" },
  { heard: "clip kid", write: "clipkit" },
  { heard: "click kit", write: "clipkit" },
  { heard: "clickkit", write: "clipkit" },
  { heard: "lazy platform", write: "Lacy platform" },
  { heard: "laced platform", write: "Lacy platform" },
  { heard: "lazy instance", write: "Lacy instance" },
  { heard: "lazy session", write: "Lacy session" },
  { heard: "lazy project", write: "Lacy project" },
  { heard: "gev", write: "Jev" },
];
