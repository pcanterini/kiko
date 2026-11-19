// A pretend tmux for the Kiko window's layout (src/terminals/tmux/window.ts): sessions, windows
// and panes in memory, and the commands the window uses, as tmux does them (command lists split on
// ";", targets by %pane, @window or =session[:], pane options falling back to window options).
// Every argv is kept (`calls`), so a test can check what was run, and that no secret was in it.
// The real tmux is in tests/live/terminals/window-live.test.ts.

// `pid` and `front` are what list-panes says of its first process and of what's in front (tmux's
// pane_pid and pane_current_command): without them the tmux adapter takes no pane for a live one
// (parsePanes), and a session opened in it for one that has ended. `front` is the program its command
// runs (claude, when its command line runs it), until a test sets it (the shell back, say).
// `floating`: a floating pane's place and size, its border included (tmux 3.8's new-pane, the
// classic look: src/terminals/tmux/classic.ts); `title`: its title (new-pane -T).
type Floating = { x: number; y: number; w: number; h: number };
type Pane = {
  id: string;
  pid: number;
  front: string;
  window: string;
  dead: boolean;
  command: string[];
  cwd: string;
  opts: Record<string, string>;
  width: number;
  height: number;
  starts: number;
  floating?: Floating;
  title?: string;
};
type Window = { id: string; session: string; opts: Record<string, string>; zoomed: boolean; width: number; height: number; panes: string[]; active: string };
type Session = { name: string; window: string; opts: Record<string, string>; clients: number };

export class FakeTmux {
  panes = new Map<string, Pane>();
  windows = new Map<string, Window>();
  sessions = new Map<string, Session>();
  hooks: string[][] = [];
  bindings: string[][] = [];
  unbound: string[][] = [];
  calls: string[][] = [];
  /** Menus shown (display-popup's argv), keys sent to panes (send-keys' argv), terminals detached. */
  menus: string[][] = [];
  sent: string[][] = [];
  detached: string[] = [];
  /** Shell commands run-shell was given (argv): kept, never run. */
  shells: string[][] = [];
  /** Terminals attached to a session (list-clients): its name → tty names, latest first. */
  clients = new Map<string, string[]>();
  private next = { pane: 0, window: 0 };

  /**
   * What `tmux -V` says ("tmux 3.8": floating panes, the classic look); unset, it's refused, as a
   * tmux that doesn't answer: the window keeps its tiled look, as every test before the classic look expects.
   */
  version: string | undefined = undefined;

  /** Global options (set-option -g), and the server's global environment (set-environment -g; -u unsets). */
  global: Record<string, string> = {};
  environment: Record<string, string> = {};

  /** What came in on stdin (source-file -, load-buffer -), with the call it came with. */
  inputs: Array<{ args: string[]; input: string }> = [];

  /** The runner window.ts takes. */
  run = async (args: string[], input?: string): Promise<string> => {
    this.calls.push(args);
    if (input !== undefined) this.inputs.push({ args, input });
    if (args[0] === "source-file" && args[1] === "-") {
      let out = "";
      for (const line of (input ?? "").split("\n").filter(Boolean)) out += this.one(FakeTmux.words(line));
      return out;
    }
    let out = "";
    // As tmux splits its argv: ";" alone or at the end of a word ends a command; "\;" at the end is a ";".
    const lists: string[][] = [[]];
    for (const a of args) {
      if (a.endsWith("\\;")) lists.at(-1)!.push(`${a.slice(0, -2)};`);
      else if (a.endsWith(";")) {
        if (a.length > 1) lists.at(-1)!.push(a.slice(0, -1));
        lists.push([]);
      } else lists.at(-1)!.push(a);
    }
    for (const command of lists) out += this.one(command);
    return out;
  };

  /** A command line as tmux's parser reads it, for what source-file gets: words, and 'single quotes' (with \\' outside them). */
  static words(line: string): string[] {
    const words: string[] = [];
    let word: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "'") {
        const end = line.indexOf("'", i + 1);
        if (end < 0) throw new Error(`unterminated quote: ${line}`);
        word = (word ?? "") + line.slice(i + 1, end);
        i = end;
      } else if (c === "\\") word = (word ?? "") + line[++i];
      else if (c === " ") {
        if (word !== null) words.push(word);
        word = null;
      } else if (/[$~#;"]/.test(c) && word === null) throw new Error(`the fake doesn't parse ${c} outside quotes: ${line}`);
      else word = (word ?? "") + c;
    }
    if (word !== null) words.push(word);
    return words;
  }

  /** A program in `pane` ends (the window keeps it, dead, when remain-on-exit is on, as tmux does). */
  end(pane: string) {
    const p = this.pane(pane);
    const w = this.windows.get(p.window)!;
    if ((p.opts["remain-on-exit"] ?? w.opts["remain-on-exit"]) === "on") p.dead = true;
    else this.kill(pane);
  }

  /** The session pane `id` is in now. */
  where = (id: string) => this.windows.get(this.pane(id).window)!.session;
  panesOf = (session: string) => this.windows.get(this.sessions.get(session)!.window)!.panes;

  private pane(id: string) {
    const p = this.panes.get(id);
    if (!p) throw new Error(`can't find pane: ${id}`);
    return p;
  }

  /** A target to a pane: %N, @N (its active pane), =name or =name: (its window's active pane). */
  private target(t: string): Pane {
    if (t.startsWith("%")) return this.pane(t);
    if (t.startsWith("@")) {
      const w = this.windows.get(t);
      if (!w) throw new Error(`can't find window: ${t}`);
      return this.pane(w.active);
    }
    const name = t.replace(/^=/, "").replace(/:$/, "");
    const s = this.sessions.get(name);
    if (!s) throw new Error(`can't find session: ${name}`);
    return this.pane(this.windows.get(s.window)!.active);
  }

  private format(f: string, p: Pane): string {
    const w = this.windows.get(p.window)!;
    const s = this.sessions.get(w.session)!;
    const left = p.floating ? p.floating.x + 1 : w.panes.indexOf(p.id) > 0 ? this.pane(w.panes[0]).width + 1 : 0;
    const vars: Record<string, string> = {
      pane_id: p.id,
      pane_pid: String(p.pid),
      pane_tty: `/dev/ttys${p.id.slice(1).padStart(3, "0")}`,
      pane_current_command: p.dead ? "" : p.front,
      pane_in_mode: "0",
      bracket_paste_flag: "1",
      window_id: w.id,
      session_name: s.name,
      pane_dead: p.dead ? "1" : "0",
      window_zoomed_flag: w.zoomed ? "1" : "0",
      window_width: String(w.width),
      window_height: String(w.height),
      pane_width: String(p.width),
      pane_height: String(p.height),
      session_attached: String(s.clients),
      pane_active: w.active === p.id ? "1" : "0",
      pane_current_path: p.cwd,
      pane_left: String(left),
      pane_top: String(p.floating ? p.floating.y + 1 : 1),
      pane_floating_flag: p.floating ? "1" : "0",
      pane_title: p.title ?? "",
    };
    const value = (name: string) => (name.startsWith("@") ? (p.opts[name] ?? w.opts[name] ?? s.opts[name] ?? this.global[name] ?? "") : (vars[name] ?? ""));
    return FakeTmux.expand(f, value);
  }

  /**
   * A format, as tmux expands it, as far as the window's formats go: #{name} (an @option or a
   * variable), #{?cond,a,b}, #{==:a,b}, #{!=:a,b}, #{&&:a,b}, #{||:a,b} and #{E:name}; "##" is "#".
   */
  static expand(f: string, value: (name: string) => string): string {
    let out = "";
    for (let i = 0; i < f.length; i++) {
      if (f[i] !== "#" || i + 1 >= f.length) {
        out += f[i];
        continue;
      }
      if (f[i + 1] !== "{") {
        out += f[i + 1] === "#" ? "#" : f[i + 1] === "," ? "," : f[i] + f[i + 1];
        i++;
        continue;
      }
      const end = FakeTmux.closing(f, i + 1);
      out += FakeTmux.one(f.slice(i + 2, end), value);
      i = end;
    }
    return out;
  }

  /** Where the brace opened at `at` closes (nested #{…} skipped). */
  private static closing(f: string, at: number): number {
    let depth = 0;
    for (let i = at; i < f.length; i++) {
      if (f[i] === "{") depth++;
      else if (f[i] === "}" && --depth === 0) return i;
    }
    throw new Error(`the fake can't read this format: ${f}`);
  }

  /** `body` split at its top-level commas (none inside a nested #{…}; "#," is a comma kept). */
  private static parts(body: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let at = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "#" && body[i + 1] === ",") i++;
      else if (body[i] === "{") depth++;
      else if (body[i] === "}") depth--;
      else if (body[i] === "," && depth === 0) {
        out.push(body.slice(at, i));
        at = i + 1;
      }
    }
    out.push(body.slice(at));
    return out;
  }

  private static one(body: string, value: (name: string) => string): string {
    const truthy = (v: string) => v !== "" && v !== "0";
    const sub = (x: string) => FakeTmux.expand(x, value);
    if (body.startsWith("?")) {
      const [cond, a = "", b = ""] = FakeTmux.parts(body.slice(1));
      const c = cond.startsWith("#{") ? sub(cond) : value(cond);
      return sub(truthy(c) ? a : b);
    }
    const op = /^(==|!=|&&|\|\|):/.exec(body);
    if (op) {
      const [a = "", b = ""] = FakeTmux.parts(body.slice(op[0].length)).map(sub);
      return op[1] === "==" ? (a === b ? "1" : "0") : op[1] === "!=" ? (a !== b ? "1" : "0") : op[1] === "&&" ? (truthy(a) && truthy(b) ? "1" : "0") : truthy(a) || truthy(b) ? "1" : "0";
    }
    if (body.startsWith("E:")) return FakeTmux.expand(value(body.slice(2)), value);
    return value(body);
  }

  private flags(args: string[]) {
    const flags = new Set<string>();
    const values: Record<string, string> = {};
    const rest: string[] = [];
    let command: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === "--") {
        command = args.slice(i + 1);
        break;
      }
      if (/^-[a-zA-Z]+$/.test(a) && rest.length === 0) {
        const letters = a.slice(1);
        const valued = "sntcxyFlTBXYSR".includes(letters.at(-1)!) && !(args[0] === "set-option" && "Fs".includes(letters.at(-1)!));
        for (const l of valued ? letters.slice(0, -1) : letters) flags.add(l);
        if (valued) values[letters.at(-1)!] = args[++i];
        // A start folder is a format to tmux: "#S" in it would be the session's name. "##" is a "#".
        if (valued && letters.at(-1) === "c" && args[0] !== "display-popup") {
          if (/#(?!#)/.test(values.c.replace(/##/g, ""))) throw new Error(`a format in -c: ${values.c}`);
          values.c = values.c.replace(/##/g, "#");
        }
      } else rest.push(a);
    }
    return { flags, values, rest, command };
  }

  /** What's in front in a pane running `command`: claude when its command line runs it, else its program. */
  static front(command: string[]) {
    if (command.some((a) => /(^|[\s;&|/])claude(\s|;|$)/.test(a))) return "claude";
    return (command[0] ?? "zsh").split("/").at(-1)!;
  }

  private newPane(window: string, command: string[], cwd: string, width: number, height: number): Pane {
    const n = this.next.pane++;
    const p: Pane = { id: `%${n}`, pid: 50_000 + n, front: FakeTmux.front(command), window, dead: false, command, cwd, opts: {}, width, height, starts: 1 };
    this.panes.set(p.id, p);
    return p;
  }

  private kill(id: string) {
    const p = this.pane(id);
    const w = this.windows.get(p.window)!;
    this.panes.delete(id);
    w.panes = w.panes.filter((x) => x !== id);
    if (w.active === id) w.active = w.panes[0] ?? "";
    if (!w.panes.length) {
      this.windows.delete(w.id);
      this.sessions.delete(w.session);
    }
  }

  private one(args: string[]): string {
    if (args[0] === "-V") {
      if (!this.version) throw new Error("the fake tmux says no version");
      return `${this.version}\n`;
    }
    const { flags, values, rest, command } = this.flags(args);
    switch (args[0]) {
      case "list-panes":
        return [...this.panes.values()].map((p) => `${this.format(values.F, p)}\n`).join("");
      case "list-sessions":
        return [...this.sessions.keys()].map((n) => `${n}\n`).join("");
      case "display":
        return `${this.format(rest[0], this.target(values.t))}\n`;
      case "new-session": {
        const name = values.s;
        if (this.sessions.has(name)) throw new Error(`duplicate session: ${name}`);
        const w: Window = { id: `@${this.next.window++}`, session: name, opts: {}, zoomed: false, width: Number(values.x ?? 80), height: Number(values.y ?? 24), panes: [], active: "" };
        this.windows.set(w.id, w);
        this.sessions.set(name, { name, window: w.id, opts: {}, clients: 0 });
        const p = this.newPane(w.id, command, values.c ?? "/", w.width, w.height);
        w.panes.push(p.id);
        w.active = p.id;
        return flags.has("P") ? `${this.format(values.F ?? "#{session_name}:", p)}\n` : "";
      }
      case "new-pane": {
        // A floating pane (tmux 3.8): its box as given (-x -y the size, its border included; -X -Y its corner), active unless -d.
        const at = this.target(values.t);
        const w = this.windows.get(at.window)!;
        const floating = { x: Number(values.X ?? 0), y: Number(values.Y ?? 0), w: Number(values.x ?? 40), h: Number(values.y ?? 10) };
        const p = this.newPane(w.id, command, values.c ?? at.cwd, floating.w - 2, floating.h - 2);
        p.floating = floating;
        if (values.T !== undefined) p.title = values.T;
        if (values.S !== undefined) p.opts["pane-active-border-style"] = values.S;
        if (values.R !== undefined) p.opts["pane-border-style"] = values.R;
        w.panes.push(p.id);
        if (!flags.has("d")) w.active = p.id;
        return flags.has("P") ? `${this.format(values.F, p)}\n` : "";
      }
      case "move-pane": {
        const p = this.target(values.t);
        if (!p.floating) throw new Error(`pane ${p.id} isn't floating`);
        if (values.X !== undefined) p.floating.x = Number(values.X);
        if (values.Y !== undefined) p.floating.y = Number(values.Y);
        return "";
      }
      case "break-pane": {
        // Only -W (lifted out of the tiling, floating where it was) as the window uses it.
        if (!flags.has("W")) throw new Error("the fake tmux breaks panes out with -W only");
        const p = this.target(values.s);
        p.floating = { x: 0, y: 0, w: p.width + 2, h: p.height + 2 };
        return "";
      }
      case "split-window": {
        const at = this.target(values.t);
        const w = this.windows.get(at.window)!;
        const width = Number(values.l ?? Math.floor(at.width / 2));
        const p = this.newPane(w.id, command, values.c ?? at.cwd, width, at.height);
        at.width -= width + 1;
        const i = w.panes.indexOf(at.id);
        w.panes.splice(flags.has("b") ? i : i + 1, 0, p.id);
        if (!flags.has("d")) w.active = p.id;
        return flags.has("P") ? `${this.format(values.F, p)}\n` : "";
      }
      case "set-option": {
        const [option, value] = rest;
        // The server's options (-s) kept with the global ones: no option is both.
        if ((flags.has("g") || flags.has("s")) && !values.t) {
          if (flags.has("u")) delete this.global[option];
          else this.global[option] = value;
          return "";
        }
        const p = this.target(values.t);
        const w = this.windows.get(p.window)!;
        const bag = flags.has("p") ? p.opts : flags.has("w") ? w.opts : this.sessions.get(w.session)!.opts;
        if (flags.has("u")) delete bag[option];
        else bag[option] = value;
        return "";
      }
      case "show-options": {
        if (!flags.has("g")) throw new Error("the fake tmux shows global options only");
        const value = this.global[rest[0]];
        return value === undefined ? "" : flags.has("v") ? `${value}\n` : `${rest[0]} ${value}\n`;
      }
      case "set-environment":
        if (flags.has("u")) delete this.environment[rest[0]];
        else this.environment[rest[0]] = rest[1];
        return "";
      case "set-hook":
        this.target(values.t);
        this.hooks.push(rest);
        return "";
      case "bind-key":
        this.bindings.push(rest);
        return "";
      case "unbind-key":
        this.unbound.push(args.slice(1));
        return "";
      case "list-clients": {
        const name = (values.t ?? "").replace(/^=/, "").replace(/:$/, "");
        return (this.clients.get(name) ?? []).map((c, i) => `${100 - i}\t${c}\n`).join("");
      }
      case "display-menu":
      case "display-popup":
        this.menus.push(args);
        return "";
      case "send-keys":
        this.target(values.t);
        this.sent.push(args);
        return "";
      case "run-shell":
        this.shells.push(args);
        return "";
      case "detach-client":
        this.detached.push(values.t ?? "");
        return "";
      case "swap-pane": {
        const a = this.target(values.s);
        const b = this.target(values.t);
        const wa = this.windows.get(a.window)!;
        const wb = this.windows.get(b.window)!;
        const [ia, ib] = [wa.panes.indexOf(a.id), wb.panes.indexOf(b.id)];
        wa.panes[ia] = b.id;
        wb.panes[ib] = a.id;
        [a.window, b.window] = [b.window, a.window];
        [a.width, b.width, a.height, b.height] = [b.width, a.width, b.height, a.height];
        [a.floating, b.floating] = [b.floating, a.floating]; // a floating spot keeps its place: the pane swapped in takes it
        if (wa.active === a.id) wa.active = b.id;
        if (wb.active === b.id) wb.active = a.id;
        return "";
      }
      case "respawn-pane": {
        const p = this.target(values.t);
        if (!p.dead && !flags.has("k")) throw new Error(`pane ${p.id} still active`);
        p.dead = false;
        p.starts++;
        p.pid = 60_000 + p.starts * 1000 + Number(p.id.slice(1)); // a new first process
        if (command.length) p.command = command;
        p.front = FakeTmux.front(p.command);
        return "";
      }
      case "kill-pane":
        this.kill(this.target(values.t).id);
        return "";
      case "kill-session": {
        const s = this.sessions.get(values.t.replace(/^=/, ""));
        if (!s) throw new Error(`can't find session: ${values.t}`);
        for (const id of [...this.windows.get(s.window)!.panes]) this.kill(id);
        return "";
      }
      case "select-pane": {
        const p = this.target(values.t);
        const w = this.windows.get(p.window)!;
        w.active = p.id;
        w.zoomed = false;
        return "";
      }
      case "resize-pane": {
        const p = this.target(values.t);
        const w = this.windows.get(p.window)!;
        if (flags.has("Z")) w.zoomed = !w.zoomed;
        // A floating pane's size is its box's, its border included.
        if (values.x) p.width = Number(values.x) - (p.floating ? 2 : 0);
        if (values.y) p.height = Number(values.y) - (p.floating ? 2 : 0);
        if (p.floating && values.x) p.floating.w = Number(values.x);
        if (p.floating && values.y) p.floating.h = Number(values.y);
        return "";
      }
      default:
        throw new Error(`the fake tmux doesn't know ${args[0]}`);
    }
  }
}
