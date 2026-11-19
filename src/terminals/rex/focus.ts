// Whether Kiko's block is on screen in Rex, for the Mac overlay (app/overlay.ts): whether Kiko's own
// window (its tmux client, in a Rex block) is in the tab the Rex app shows, focused or not.
//
// tmux can't say it for Rex: Rex sends a block focus-in/out (mode 1004, which Kiko's tmux client
// asks for) as the Rex app comes to the front or goes, not as you change tabs or panes inside it.
// So tmux's `focused` flag on Kiko's client is whatever it was when the app last came to the front.
// Rex itself knows: each session's active window (the tab Rex.app shows), its blocks, which one is
// zoomed (then it alone is drawn) and which floating layers are minimized (not drawn).
//
// The rule is "visible" (the user's, 2026-11-05): Kiko's block drawn in the tab in front hides the
// overlay even while another block of that tab has the focus (four panes, Kiko's one of them): its
// window is right there. Another tab, another block zoomed over it, its floating layer minimized:
// the overlay shows.
//
// One `rex do` script a poll (rex.ts: never starting a server, REX_* taken out, read only: it
// looks at the sessions each Rex app on this Mac is attached to, their active window's blocks and
// each terminal block's process ids; it focuses, sends, zooms, resizes and closes nothing). Kiko's
// block is the one Kiko's tmux client runs under: its process, or one of its ancestors, is that
// block's (`ps -o pid=,ppid=`, once a client: pids only, never a command line).
// The answer: shown when Kiko's block is drawn in the active window of the session a Rex app shows;
// not shown when it isn't in that window (another tab), is behind another block's zoom, or is in a
// minimized layer; not known (null) when Rex can't tell: its server not running, Kiko's tmux client
// not in Rex (not under its server's process), no Rex app showing a session, an app attached to
// several sessions with Kiko's block drawn in one's active window (which session it shows isn't
// said), or two apps that disagree. Not known, the overlay goes by tmux's flag, as for every other
// terminal.
import { execFile } from "node:child_process";
import { isObject } from "../../core/is-object.ts";
import { rexReady, script } from "./rex.ts";

/**
 * The Rex apps on this Mac (clients of kind app over the server's Unix socket), the sessions each
 * is attached to, and for each session its active window (the tab shown): its focused and zoomed
 * blocks, and each of its blocks with its process ids (terminal blocks only: in front, its
 * ancestors, the one the block started) and why it isn't drawn, if it isn't (`hidden`: another
 * block zoomed, or its floating layer minimized); and the server's own pid.
 */
export const FOCUS = `
local attached = rex.call("session.attach_all", { event_scope = "session" })
local status = rex.call("server.status", {})
local listed = rex.call("client.list", { kinds = { "app" } })
local views = {}
local function terminal(x)
  return type(x.flavor) == "string" and string.sub(x.flavor, 1, 26) == "com.superlogical.terminal."
end
local function pids(s, x)
  local out = {}
  if not terminal(x) then return out end
  local p = rex.call("block.method", { session_id = s, block_id = x.block_id, method = "process" })
  if type(p) == "table" then
    if type(p.foreground) == "table" then out[#out + 1] = p.foreground.pid end
    if type(p.ancestors) == "table" then
      for _, a in ipairs(p.ancestors) do
        if type(a) == "table" then out[#out + 1] = a.pid end
      end
    end
    if type(p.child) == "table" then out[#out + 1] = p.child.pid end
  end
  return out
end
local function shown(s)
  if views[s] ~= nil then return views[s] end
  local row = { session = s, blocks = {} }
  local v = rex.call("session.view", { session_id = s })
  if type(v) == "table" and type(v.windows) == "table" then
    for _, w in ipairs(v.windows) do
      if w.window_id ~= nil and w.window_id == v.active_window_id then
        row.window = w.window_id
        row.focused = w.focused_block_id
        row.zoomed = w.zoomed_block_id
        for _, l in ipairs(w.layers or {}) do
          for _, x in ipairs((type(l) == "table" and l.blocks) or {}) do
            local hidden = nil
            if l.state == "minimized" then
              hidden = "minimized"
            elseif type(w.zoomed_block_id) == "string" and w.zoomed_block_id ~= x.block_id then
              hidden = "zoomed"
            end
            row.blocks[#row.blocks + 1] = { block = x.block_id, pids = pids(s, x), hidden = hidden }
          end
        end
      end
    end
  end
  views[s] = row
  return row
end
local clients = {}
for _, c in ipairs((listed and listed.clients) or {}) do
  local local_ = type(c.principal) == "table" and c.principal.transport == "unix"
  if local_ and c.connection_state ~= "lost" then
    local row = { client = c.client_id, sessions = {} }
    for _, s in ipairs(c.session_ids or {}) do row.sessions[#row.sessions + 1] = shown(s) end
    clients[#clients + 1] = row
  end
end
return { server = status and status.pid, clients = clients }
`;

/** A block of the window shown: its process ids, and why it isn't drawn ("zoomed": another block is; "minimized": its layer), if it isn't. */
export type ShownBlock = { block: string; pids: number[]; hidden?: string };
/** A session a Rex app is attached to: its active window (the tab shown), that window's focused and zoomed blocks, and its blocks. */
export type Shown = { session: string; window?: string; focused?: string; zoomed?: string; blocks: ShownBlock[] };
/** FOCUS's answer. */
export type FocusAnswer = { server?: number; clients: { client: string; sessions: Shown[] }[] };
/**
 * What Rex says of Kiko's window: on screen in the tab shown (`kikoFocused`: the overlay's name for
 * "Kiko's window counts as in front", app/overlay.ts), not, or not known (null); and why.
 */
export type RexFocus = { kikoFocused: boolean | null; why: string; block?: string };

const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
const ints = (v: unknown) => (Array.isArray(v) ? v.map(int).filter((p): p is number => p !== undefined) : []);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const list = (v: unknown) => (Array.isArray(v) ? v.filter(isObject) : []);

/** FOCUS's answer, whatever fields it has; null when it isn't one. */
export function parseFocus(out: string): FocusAnswer | null {
  let v: unknown;
  try {
    v = JSON.parse(out);
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  const clients = list(v.clients).map((c) => ({
    client: str(c.client) ?? "",
    sessions: list(c.sessions).map((s) => {
      const window = str(s.window);
      const focused = str(s.focused);
      const zoomed = str(s.zoomed);
      return {
        session: str(s.session) ?? "",
        ...(window ? { window } : {}),
        ...(focused ? { focused } : {}),
        ...(zoomed ? { zoomed } : {}),
        // Lua's empty table comes as {} (an object), not []: no blocks either way.
        blocks: list(s.blocks).flatMap((b) => {
          const block = str(b.block);
          const hidden = str(b.hidden);
          return block ? [{ block, pids: ints(b.pids), ...(hidden ? { hidden } : {}) }] : [];
        }),
      };
    }),
  }));
  const server = int(v.server);
  return { ...(server ? { server } : {}), clients };
}

/** Where Kiko's block is in a session's shown window: drawn (whichever block has the focus), behind another block's zoom, in a minimized layer, or not in it. */
type Where = { shown: boolean | null; why: string; block?: string };

function whereIn(s: Shown, mine: Set<number>): Where {
  const kiko = s.blocks.find((b) => b.pids.some((p) => mine.has(p)));
  if (!kiko) return { shown: false, why: "Kiko's block not in the shown window" };
  if (kiko.hidden === "zoomed") return { shown: false, why: "another block zoomed", block: kiko.block };
  if (kiko.hidden) return { shown: false, why: `Kiko's block ${kiko.hidden}`, block: kiko.block };
  const why = !s.focused || s.focused === kiko.block ? "Kiko's block shown, focused" : "Kiko's block shown, another block focused";
  return { shown: true, why, block: kiko.block };
}

/**
 * Whether Kiko's window is on screen in Rex, from FOCUS's answer and `chain`: Kiko's tmux client
 * pids and each one's ancestors, nearest first (ancestry). Kiko's block is a block one of whose
 * processes is in that chain below Rex's server; on screen when it's drawn in the active window of
 * the session the Rex app shows, whichever block of that window has the focus.
 */
export function focusFrom(answer: FocusAnswer | null, chain: readonly number[]): RexFocus {
  if (!answer) return { kikoFocused: null, why: "no answer from Rex" };
  const server = answer.server;
  if (!server || !chain.includes(server)) return { kikoFocused: null, why: "Kiko's tmux client isn't in Rex" };
  const mine = new Set(chain.filter((p) => p !== server && p > 1));
  const apps = answer.clients.filter((c) => c.sessions.length);
  if (!apps.length) return { kikoFocused: null, why: "no Rex app shows a session" };
  const said = apps.map((c): Where => {
    const where = c.sessions.map((s) => whereIn(s, mine));
    // One session: it's the one shown. Several: Kiko's block drawn in one's tab may not be the one in front.
    if (where.length === 1) return where[0];
    const drawn = where.find((w) => w.shown);
    if (drawn) return { shown: null, why: "a Rex app attached to several sessions, Kiko's block shown in one", block: drawn.block };
    return where.find((w) => w.block) ?? where[0];
  });
  const first = said[0];
  if (said.some((s) => s.shown !== first.shown)) return { kikoFocused: null, why: "Rex apps disagree" };
  return { kikoFocused: first.shown, why: first.why, ...(first.block ? { block: first.block } : {}) };
}

/** Each pid's parent, from `ps -A -o pid=,ppid=` (pids only: never a command line). */
export function parents(out: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of out.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && pid > 0) map.set(pid, ppid);
  }
  return map;
}

/** `pids` and each one's ancestors (nearest first, to launchd), from `parent`. */
export function ancestry(pids: readonly number[], parent: Map<number, number>): number[] {
  const out: number[] = [];
  for (const pid of pids) {
    let p: number | undefined = pid;
    for (let i = 0; p && p > 1 && i < 64 && !out.includes(p); i++) {
      out.push(p);
      p = parent.get(p);
    }
  }
  return out;
}

const ps = (): Promise<string> =>
  new Promise((resolve, reject) => execFile("/bin/ps", ["-A", "-o", "pid=,ppid="], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out)))));

export type RexFocusDeps = {
  /** Whether Rex can be asked at all (its server running, `rex` installed): a stat, no process. */
  ready: () => boolean;
  /** FOCUS, run: one `rex do`. */
  ask: () => Promise<string>;
  /** `ps -A -o pid=,ppid=`'s output. */
  ps: () => Promise<string>;
};

/**
 * Rex's answer for Kiko's tmux clients `hostPids`: one `rex do` a call (none when Rex isn't
 * running, or once Kiko's clients are known not to be in it); their ancestry asked of `ps` once
 * for each set of clients. Never throws: a failure is not known (null), with why.
 */
export function rexFocuser(deps: RexFocusDeps = { ready: rexReady, ask: () => script(FOCUS), ps }) {
  let key = "";
  let chain: number[] = [];
  let notInRex = false;
  return async (hostPids: readonly number[]): Promise<RexFocus> => {
    if (!hostPids.length) return { kikoFocused: null, why: "no tmux client" };
    if (!deps.ready()) return { kikoFocused: null, why: "Rex isn't running" };
    const k = [...hostPids].sort((a, b) => a - b).join(",");
    try {
      if (k !== key) {
        chain = ancestry(hostPids, parents(await deps.ps()));
        key = k;
        notInRex = false;
      }
      if (notInRex) return { kikoFocused: null, why: "Kiko's tmux client isn't in Rex" };
      const f = focusFrom(parseFocus(await deps.ask()), chain);
      if (f.why === "Kiko's tmux client isn't in Rex") notInRex = true;
      return f;
    } catch (err) {
      return { kikoFocused: null, why: `Rex: ${(err as Error).message.split("\n")[0]}` };
    }
  };
}

/** The one the app uses. */
export const rexFocus = rexFocuser();
