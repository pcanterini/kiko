// A stand-in for the Kiko app in the window's list, for the live tests (tests/live/terminals/
// nav-live.test.ts): the real list (src/ui/window-list.ts, through the real TUI and its input,
// src/ui/input.ts), the real window glue (src/ui/window-glue.ts) and Kiko's real page file and viewer,
// but no voice, no models, no hooks socket, no settings and no real Claude Code. Its sessions are
// the panes of the test's tmux server (each by its tmux session's name), plus one made-up outside
// session. What only the app would do (answer a prompt, repeat, quit) it writes to `acts.log` for the test,
// as it does what it would say out loud ({"said": …}). The menu key pressed twice is passed on to
// the session shown the way the app does it (the tmux adapter's checked key, real `ps`).
// `node window-app.ts <dir>`: <dir> holds config.json (the server, the projects for the picker, the
// fake claude), and control.jsonl, lines the test adds: {"permission": …}, {"you": "…"}, {"spoken": "…"}, {"set": {…}}.
// The unit tests' hermetic environment first: no .env, no saved settings, offline engines, a temp folder of its own.
import "../setup.ts";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
// Nothing of the user's: a folder of the test's own (its logs/ there), its own socket and settings; no .env (tests/setup.ts).
process.chdir(dir);
process.env.KIKO_LOG_DIR = join(dir, "logs");
process.env.KIKO_SOCKET = join(dir, "no-app.sock");
process.env.KIKO_SETTINGS = join(dir, "no-settings.json");
process.env.KIKO_CLAUDE_PROJECTS = join(dir, "claude-projects");
const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { server: string; projects: string[]; claude: string; outside: boolean };
process.env.KIKO_TMUX_SERVER = config.server;

const { ui } = await import("../../src/core/ui-store.ts");
const { keepPage } = await import("../../src/core/page.ts");
const { tmuxRunner, CONFIG, cleanEnv, processes } = await import("../../src/terminals/tmux/tmux.ts");
const { currentKey } = await import("../../src/terminals/tmux/keys.ts");
const { tmuxTerminal } = await import("../../src/terminals/tmux/index.ts");
const { describe } = await import("../../src/terminals/tmux/window.ts");
const { startWindow } = await import("../../src/ui/window-glue.ts");
const { startTui } = await import("../../src/ui/tui.ts");

type Session = import("../../src/core/sessions.ts").Session;
const tmux = tmuxRunner(config.server, CONFIG, cleanEnv());
const list = process.env.TMUX_PANE ?? null;
const log = (what: object) => appendFileSync(join(dir, "acts.log"), `${JSON.stringify(what)}\n`);
const outside = {
  sessionId: "notes-id",
  cwd: join(dir, "notes"),
  givenName: "notes",
  kind: "interactive",
  status: "idle",
  desktop: false,
  place: { via: "ghostty", id: "g1", keys: true },
  mapping: "title",
  nameSetBy: "user",
  titles: [],
  lastActiveAt: 0,
} as unknown as Session;

/** The sessions: the server's panes that are sessions (by tmux session name), and the outside one. */
async function sessions(): Promise<Session[]> {
  const layout = await describe(tmux);
  // Each one's process: its pane's first (the stand-in claude), as the agent would know it.
  const pids = new Map(
    (await tmux(["list-panes", "-a", "-F", "#{pane_id} #{pane_pid}"]))
      .split("\n")
      .map((l) => l.split(" "))
      .map(([id, pid]) => [id, Number(pid)]),
  );
  const inside = layout.panes
    .filter((p) => !p.role && !p.dead)
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))) // in the order they started, as the agent would list them
    .map((p) => {
      const name = p.name || p.session;
      return {
        sessionId: name,
        cwd: p.cwd,
        givenName: name,
        kind: "interactive",
        status: "idle",
        desktop: false,
        place: { via: "tmux", id: p.id, keys: true, pid: pids.get(p.id) ?? 1 },
        mapping: "process",
        nameSetBy: "user",
        titles: [],
        lastActiveAt: 0,
      } as unknown as Session;
    });
  return [...inside, ...(config.outside ? [outside] : [])];
}

// Dollars on the line as on your own keys (src/app/status.ts costShown): the store has none until the
// app says (null, as on the subscription: core/dollars.ts), and the live tests check where they go.
ui.set({ window: { shown: null, note: "" }, about: { ...ui.state.about, hotkey: "right_option", pttMode: "hold" }, sessionsLoaded: true, cost: 0 });
const page = join(dir, "page.jsonl");
keepPage(page);
const glue = startWindow(tmux, list, page, undefined, (line) => log({ said: line }));
const terminal = tmuxTerminal({ tmux, ps: processes, show: async () => {}, wait: (ms) => new Promise((r) => setTimeout(r, ms)), installed: () => true, shell: "/bin/sh" });
const refresh = async () => {
  ui.set({ sessions: await sessions(), sessionsLoaded: true });
  await glue.refresh();
};

ui.on("action", async (a: any) => {
  log({
    action: a.type,
    ...(a.page !== undefined ? { page: a.page } : {}),
    ...(a.sessionId !== undefined ? { sessionId: a.sessionId } : {}),
    ...(a.option ? { option: a.option } : {}),
    ...(a.pick ? { pick: a.pick } : {}),
    ...(a.at ? { at: a.at } : {}),
    ...(a.focus === false ? { focus: false } : {}),
  });
  switch (a.type) {
    case "show":
      return glue.show(a.page, a.focus ?? true);
    case "step":
      return glue.step(a.by);
    case "last":
      return glue.last(a.focus ?? true);
    case "focusStage":
      return glue.focusStage();
    case "rowMenu":
      return glue.rowMenu(a.sessionId, a.x, a.y);
    case "detach":
      return glue.detach();
    case "close":
      await glue.close(a.sessionId);
      return refresh();
    case "newSession":
      ui.set({ window: { ...ui.state.window!, picker: { projects: config.projects.map((cwd) => ({ cwd, name: cwd.split("/").pop()!, detail: "~/projects" })), root: dir } } });
      return glue.focusList();
    case "renaming": {
      // The list's r or a session menu's Rename…: the name to edit in the list, the keyboard there.
      const was = a.sessionId ? ui.state.sessions.find((x) => x.sessionId === a.sessionId) : undefined;
      ui.set({ window: { ...ui.state.window!, renaming: was ? { sessionId: was.sessionId, name: was.givenName ?? was.sessionId } : null } });
      return was ? glue.focusList() : undefined;
    }
    case "closePicker":
      return ui.set({ window: { ...ui.state.window!, picker: null } });
    case "start":
      ui.set({ window: { ...ui.state.window!, picker: null } });
      if (a.pick.project) await terminal.open!(a.pick.project, { program: config.claude, args: [] });
      return refresh();
    case "settings":
      return ui.set({ screen: "settings", settingsAt: a.at ?? null });
    case "closeSettings":
      return ui.set({ screen: "main" });
    case "allow":
    case "deny":
    case "answer":
      return ui.set({ permission: null });
    case "passKey": {
      const session = ui.state.sessions.find((x) => x.sessionId === a.sessionId);
      if (session?.place) log({ passed: await terminal.key!(session.place, currentKey()), key: currentKey() });
      return;
    }
    case "quit":
      setTimeout(() => process.exit(0), 50);
      return;
  }
});

// What the test says happens: a prompt held, words said, Kiko's lines.
let read = 0;
setInterval(() => {
  const file = join(dir, "control.jsonl");
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (const line of lines.slice(read)) {
    const c = JSON.parse(line);
    if ("permission" in c) ui.set({ permission: c.permission });
    if (c.you) ui.you(c.you);
    if (c.spoken) ui.spoken(c.spoken);
    if (c.info) ui.info(c.info);
    // The app's state as it would be (listening, your words as they're heard, the mic's level): {"set": {…}}.
    if (c.set) ui.set(c.set);
  }
  read = lines.length;
}, 100);

// What the list's stdin gets, as it comes (raw.log, one chunk a line): what a key really sent.
process.stdin.on("data", (d: Buffer | string) => appendFileSync(join(dir, "raw.log"), `${JSON.stringify(String(d))}\n`));
startTui();
await refresh();
setInterval(() => void refresh(), 1000);
log({ started: true });
const { windowEvents } = await import("../../src/ui/input.ts");
windowEvents.on("pointer", (p: object) => log({ pointer: p }));
