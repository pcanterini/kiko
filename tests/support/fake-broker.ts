// A stand-in for the helper app (native/macos/app/host.swift) speaking its protocol on a Unix
// socket of a test's own: hello, spawn (each stdio connection's first line read, then the socket
// handed to the child as that fd, as the app does), kill, quit, relaunch, and an exit message when a
// child ends; and osascript, answered by the test's `scripts` (never a real AppleScript). Its
// "helpers" are executables a test names (shell scripts). Nothing of the real app's.
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

export type FakeBrokerOptions = {
  socket: string;
  /** The build it says it is (Info.plist BrokerBuild). */
  build: string;
  bundlePath: string;
  /** helper name → its executable. */
  helpers: Record<string, string>;
  /** How many clients it says it has besides the one asking (another `kiko`). */
  otherClients?: number;
  /** Refuse every spawn (an error message, as the app says when a helper can't start). */
  refuse?: boolean;
  /**
   * How it answers an AppleScript (op osascript): how the script "ended"; "refuse": it couldn't
   * start osascript (an error); "vanish": the app goes away before it answers. Left out: printed nothing, exit 0.
   */
  scripts?: (m: { script: string; args: string[]; timeout: number }) => { code: number; stdout?: string; stderr?: string } | "refuse" | "vanish";
};

export class FakeBroker {
  readonly o: FakeBrokerOptions;
  private server: Server;
  private pendingFds = new Map<string, Map<number, Socket>>();
  private children = new Map<string, ChildProcess>();
  private controls = new Set<Socket>();
  /** Every op a client sent, in order (hello, spawn, kill…). */
  readonly ops: Array<Record<string, any>> = [];
  quits = 0;
  relaunches = 0;
  private onRelaunch: (() => void) | null = null;

  constructor(o: FakeBrokerOptions) {
    this.o = o;
    this.server = createServer((s) => this.accepted(s));
  }

  listen(): Promise<void> {
    rmSync(this.o.socket, { force: true });
    return new Promise((resolve) => this.server.listen(this.o.socket, resolve));
  }

  /** Called when a client asks for a relaunch (after it's stopped). */
  relaunched(fn: () => void) {
    this.onRelaunch = fn;
  }

  close(): Promise<void> {
    for (const c of this.children.values()) c.kill("SIGKILL");
    for (const s of this.controls) s.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private accepted(s: Socket) {
    let buf = Buffer.alloc(0);
    const first = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      s.off("data", first);
      s.pause();
      const line = JSON.parse(buf.subarray(0, nl).toString("utf8"));
      const rest = buf.subarray(nl + 1);
      if (line.op === "stdio") {
        if (!this.pendingFds.has(line.token)) this.pendingFds.set(line.token, new Map());
        this.pendingFds.get(line.token)!.set(line.fd, s);
        return;
      }
      this.control(s, line, rest);
    };
    s.on("data", first);
    s.on("error", () => {});
  }

  private control(s: Socket, firstOp: Record<string, any>, rest: Buffer) {
    this.controls.add(s);
    const send = (m: Record<string, unknown>) => !s.destroyed && s.write(`${JSON.stringify(m)}\n`);
    let buf = rest.toString("utf8");
    const handle = (m: Record<string, any>) => {
      this.ops.push(m);
      if (m.op === "hello")
        send({
          op: "hello",
          pid: process.pid,
          bundleId: "test",
          bundlePath: this.o.bundlePath,
          build: this.o.build,
          version: "0",
          responsible: { pid: process.pid, self: true },
          clients: this.controls.size + (this.o.otherClients ?? 0),
        });
      else if (m.op === "spawn") void this.spawn(m, send);
      else if (m.op === "kill") this.children.get(m.token)?.kill(m.signal);
      else if (m.op === "osascript") {
        const r = this.o.scripts?.({ script: m.script, args: m.args, timeout: m.timeout }) ?? { code: 0 };
        if (r === "vanish") void this.close();
        else if (r === "refuse") send({ op: "error", token: m.token, message: "osascript: refused" });
        else send({ op: "exit", token: m.token, code: r.code, signal: null, stdout: r.stdout ?? "", stderr: r.stderr ?? "" });
      } else if (m.op === "quit" || m.op === "relaunch") {
        if (m.op === "quit") this.quits++;
        else this.relaunches++;
        send({ op: "bye" });
        void this.close().then(() => {
          if (m.op === "relaunch") this.onRelaunch?.();
        });
      }
    };
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) handle(JSON.parse(line));
      }
    });
    s.on("close", () => {
      this.controls.delete(s);
      for (const c of this.children.values()) c.kill("SIGTERM");
    });
    s.resume();
    handle(firstOp);
    if (buf) s.emit("data", "");
  }

  private async spawn(m: Record<string, any>, send: (m: Record<string, unknown>) => void) {
    for (let i = 0; i < 100 && (m.fds as number[]).some((fd) => !this.pendingFds.get(m.token)?.has(fd)); i++) await new Promise((r) => setTimeout(r, 10));
    const fds = this.pendingFds.get(m.token) ?? new Map<number, Socket>();
    this.pendingFds.delete(m.token);
    const path = this.o.helpers[m.helper];
    if (this.o.refuse || !path) {
      for (const s of fds.values()) s.destroy();
      send({ op: "error", token: m.token, message: `${m.helper}: refused` });
      return;
    }
    const io = [0, 1, 2].map((fd) => fds.get(fd) ?? "ignore");
    const child = spawn(path, m.args, { stdio: io as any });
    for (const s of fds.values()) s.destroy();
    this.children.set(m.token, child);
    send({ op: "spawned", token: m.token, pid: child.pid });
    child.on("exit", (code, signal) => {
      this.children.delete(m.token);
      const n = signal ? ({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2 } as Record<string, number>)[signal] : null;
      send({ op: "exit", token: m.token, code, signal: n ?? null });
    });
  }
}
