// Where a new session opens (src/core/projects.ts): the list of projects, matching the name said, the
// scratch folder's name, and the move off the old newSessionCwd setting. Folders are made in a
// temporary folder, never under the real home.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  commonRoots,
  freeFolder,
  listProjects,
  matchProject,
  newProjectRoot,
  projectFolderName,
  projectRoots,
  projectsRootShown,
  rootFolders,
  scratchName,
  startPlace,
  type Project,
} from "../../../src/core/projects.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "kiko-projects-")));
/** A fake home folder with these folders in it. */
function home(...folders: string[]) {
  const h = mkdtempSync(join(base, "home-"));
  for (const f of folders) mkdirSync(join(h, f), { recursive: true });
  return h;
}
const p = (cwd: string, names: string[] = [], lastUsed = 0): Project => ({ cwd, names: [cwd.split("/").pop()!, ...names], lastUsed });

describe("the projects root", () => {
  test("not set: the usual folders that exist", () => {
    const h = home("git", "Developer", "Documents");
    assert.deepEqual(commonRoots(h), [join(h, "git"), join(h, "Developer")]);
    assert.deepEqual(projectRoots("", h), [join(h, "git"), join(h, "Developer")]);
    assert.equal(newProjectRoot("", h), join(h, "git"));
  });
  test("set: only it", () => {
    const h = home("git", "work");
    assert.deepEqual(projectRoots(join(h, "work"), h), [join(h, "work")]);
    assert.equal(newProjectRoot(join(h, "work"), h), join(h, "work"));
  });
  test("none of them: nowhere for a new project", () => {
    assert.equal(newProjectRoot("", home("Documents")), null);
  });
  test("as the settings show it: the one set, else what was found and is used meanwhile (a fresh install: '~/git (found)', not 'Not set')", () => {
    const h = home("git", "Developer");
    assert.equal(projectsRootShown("", h), "~/git, ~/Developer (found)");
    assert.equal(projectsRootShown(join(h, "work"), h), "~/work");
    assert.equal(projectsRootShown("", home("Documents")), "Not set: no ~/git, ~/code or the like found");
  });
  test("its subfolders, not hidden ones nor files", () => {
    const h = home("git/pixie", "git/lacy-platform", "git/.cache");
    writeFileSync(join(h, "git", "notes.txt"), "");
    assert.deepEqual(
      rootFolders(join(h, "git"))
        .map((x) => x.cwd)
        .sort(),
      [join(h, "git", "lacy-platform"), join(h, "git", "pixie")],
    );
  });
});

describe("listProjects: one entry per folder, by every name", () => {
  test("a symlink and its folder are one project, by both names; the first path is kept", () => {
    const h = home("git/kiko");
    symlinkSync(join(h, "git", "kiko"), join(h, "git", "claude-code-speech"));
    const all = listProjects([
      { cwd: join(h, "git", "claude-code-speech"), names: ["Cloud Speech"], lastUsed: 5 },
      { cwd: join(h, "git", "kiko"), names: [], lastUsed: 9 },
    ]);
    assert.equal(all.length, 1);
    assert.equal(all[0].cwd, join(h, "git", "claude-code-speech"));
    assert.deepEqual(all[0].names, ["claude-code-speech", "Cloud Speech", "kiko"]);
    assert.equal(all[0].lastUsed, 9);
  });
  test("folders `skip` says no to are left out", () => {
    const h = home("git/pixie", "Kiko/scratch/2026-10-29-x");
    const all = listProjects(
      [
        { cwd: join(h, "git", "pixie"), names: [], lastUsed: 0 },
        { cwd: join(h, "Kiko", "scratch", "2026-10-29-x"), names: ["Clipkit"], lastUsed: 9 },
      ],
      (cwd) => cwd.startsWith(join(h, "Kiko", "scratch")),
    );
    assert.deepEqual(
      all.map((x) => x.cwd),
      [join(h, "git", "pixie")],
    );
  });
});

describe("matchProject: the name said", () => {
  const projects = [
    p("/u/git/pixie", [], 10),
    p("/u/git/pixie-sounds", [], 50),
    p("/u/git/legacy-pixie"),
    p("/u/git/lacy-platform", ["Lacy"], 100),
    p("/u/git/lacy"),
    p("/u/git/clipkit"),
    p("/u/git/claude-code-speech", ["kiko"]),
  ];
  const m = (said: string) => {
    const r = matchProject(said, projects);
    return r && [r.project.cwd.split("/").pop(), r.how, r.name];
  };
  test("exactly, as speech gives it: case, spaces, dashes and the words around it aside", () => {
    assert.deepEqual(m("Pixie"), ["pixie", "exact", "pixie"]);
    assert.deepEqual(m("clip kit"), ["clipkit", "exact", "clipkit"]);
    assert.deepEqual(m("the Lacy Platform project"), ["lacy-platform", "exact", "lacy-platform"]);
    assert.deepEqual(m("cloud code speech"), ["claude-code-speech", "exact", "claude-code-speech"]);
    assert.deepEqual(m("Kiko"), ["claude-code-speech", "exact", "kiko"]);
  });
  test("by a session's name there; two folders by the same name: the one used last", () => {
    assert.deepEqual(m("Lacy"), ["lacy-platform", "exact", "Lacy"]);
  });
  test("only close (speech-to-text's take on it): the closest", () => {
    assert.deepEqual(m("Pixy"), ["pixie", "close", "pixie"]);
    assert.deepEqual(m("clip kid"), ["clipkit", "close", "clipkit"]);
    assert.deepEqual(m("pixie sound"), ["pixie-sounds", "close", "pixie-sounds"]);
  });
  test("nothing close: null", () => {
    assert.equal(m("Pixel"), null);
    assert.equal(m("tideline"), null);
    assert.equal(m(""), null);
  });
});

describe("startPlace: where a new session opens", () => {
  const projects = [p("/u/git/pixie"), p("/u/git/clipkit")];
  const ask = (project: string | null, more: { newProject?: boolean; sessionName?: string } = {}) =>
    startPlace({ project, newProject: more.newProject ?? false, sessionName: more.sessionName ?? "" }, projects, "/u/git", "/u");
  test("a known project; one only close, saying which", () => {
    assert.deepEqual(ask("Pixie"), { kind: "project", cwd: "/u/git/pixie", how: "exact", name: "pixie", said: "Pixie" });
    assert.deepEqual(ask("Pixy"), { kind: "project", cwd: "/u/git/pixie", how: "close", name: "pixie", said: "Pixy" });
  });
  test("an unknown one, or none: a scratch folder", () => {
    assert.deepEqual(ask("Pixel"), { kind: "scratch", said: "Pixel" });
    assert.deepEqual(ask(null), { kind: "scratch", said: null });
    assert.deepEqual(ask("a scratch folder"), { kind: "scratch", said: null });
  });
  test("no project said, but the session's name is one exactly: there", () => {
    assert.deepEqual(ask(null, { sessionName: "Clipkit" }), { kind: "project", cwd: "/u/git/clipkit", how: "named", name: "clipkit", said: "Clipkit" });
    assert.deepEqual(ask(null, { sessionName: "Clipkid" }), { kind: "scratch", said: null });
  });
  // A request for a new session named for a project and more words came
  // from the router as project "Kiko", name "Kiko trust test", the folder only in the prompt; it
  // opened in ~/git/kiko, not the ~/git/kiko-trust-test made for the test, so no trust card showed.
  describe("a folder the session's name (or its prompt) names, when the project said is only the start of it", () => {
    const more = [p("/u/git/kiko"), p("/u/git/kiko-trust-test"), p("/u/git/pixie"), p("/u/git/clipkit")];
    const at = (project: string | null, sessionName: string, prompt = "") => startPlace({ project, newProject: false, sessionName, prompt }, more, "/u/git", "/u");
    const cwdOf = (where: ReturnType<typeof at>) => (where && "cwd" in where ? where.cwd : null);
    const PROMPT = "Work in the kiko-trust-test folder inside the projects folder, so the trust card can show up for this test.";
    test("the real case: there, by the session's name", () => {
      assert.deepEqual(at("Kiko", "Kiko trust test", PROMPT), { kind: "project", cwd: "/u/git/kiko-trust-test", how: "exact", name: "kiko-trust-test", said: "Kiko trust test" });
    });
    test("by the folder written in the prompt, when the name doesn't say it", () => {
      assert.deepEqual(at("Kiko", "Trust test", PROMPT), { kind: "project", cwd: "/u/git/kiko-trust-test", how: "exact", name: "kiko-trust-test", said: "kiko-trust-test" });
    });
    test("the project said matched nothing: still the folder it starts", () => {
      const without = [p("/u/git/kiko-trust-test")];
      assert.equal(cwdOf(startPlace({ project: "Kiko", newProject: false, sessionName: "Kiko trust test" }, without, "/u/git", "/u")), "/u/git/kiko-trust-test");
    });
    test("no such folder: the project said, as ever (a session named after its work)", () => {
      assert.equal(cwdOf(at("Kiko", "Kiko docs", "Write the docs.")), "/u/git/kiko");
      assert.equal(cwdOf(at("Kiko", "Kiko", "")), "/u/git/kiko");
    });
    test("a folder that isn't the project said and more: not taken", () => {
      assert.equal(cwdOf(at("Pixie", "Clipkit", "Look at the clipkit-api folder")), "/u/git/pixie");
      assert.equal(cwdOf(at("Kiko trust test", "Kiko", "")), "/u/git/kiko-trust-test", "the longer one said: it");
    });
  });
  test("home", () => {
    assert.deepEqual(ask("home"), { kind: "home", cwd: "/u" });
    assert.deepEqual(ask("my home folder"), { kind: "home", cwd: "/u" });
  });
  test("a new project: in the projects root; none there, nowhere", () => {
    assert.deepEqual(ask("Pixel", { newProject: true }), { kind: "new", cwd: "/u/git/pixel", said: "Pixel" });
    assert.deepEqual(ask("Cool App", { newProject: true }), { kind: "new", cwd: "/u/git/cool-app", said: "Cool App" });
    assert.equal(startPlace({ project: "Pixel", newProject: true, sessionName: "" }, projects, null, "/u"), null);
  });
});

describe("the scratch folder's name", () => {
  const at = new Date(2026, 9, 29, 23, 30);
  test("the day, and a few words of what it's for", () => {
    assert.equal(scratchName(at, "Fix the login bug."), "2026-10-29-fix-login-bug");
    assert.equal(scratchName(at, "Pixel"), "2026-10-29-pixel");
    assert.equal(scratchName(at, "Can you write a script that renames my screenshots by date?"), "2026-10-29-write-script-renames");
  });
  test("nothing to name it by: 'session'", () => {
    assert.equal(scratchName(at, ""), "2026-10-29-session");
    assert.equal(scratchName(at, "Uh, please, the."), "2026-10-29-session");
  });
  test("short, and only letters and digits", () => {
    const name = scratchName(at, "Déjà vu: supercalifragilisticexpialidocious-and-more words here");
    assert.match(name, /^2026-10-29-[a-z0-9-]+$/);
    assert.ok(name.length <= "2026-10-29-".length + 30, name);
  });
  test("taken: -2, -3", () => {
    const taken = new Set(["/s/2026-10-29-x", "/s/2026-10-29-x-2"]);
    assert.equal(
      freeFolder("/s", "2026-10-29-x", (path) => taken.has(path)),
      "/s/2026-10-29-x-3",
    );
    assert.equal(
      freeFolder("/s", "2026-10-29-y", (path) => taken.has(path)),
      "/s/2026-10-29-y",
    );
  });
  test("a new project's folder", () => {
    assert.equal(projectFolderName("Pixel"), "pixel");
    assert.equal(projectFolderName("the Cool App project"), "cool-app");
  });
});
