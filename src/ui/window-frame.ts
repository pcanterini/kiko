// The app's side of the classic look's frame and caption (src/terminals/tmux/frame-pane.ts): a socket the
// frame's programs connect to, each saying what it is (the frame, the caption), its pane and its
// size, and getting its lines from then on (src/ui/window-glue.ts renders them: src/ui/classic.ts). The
// waveform goes many times a second this way, never through tmux's options. The socket is in the
// app's run folder, only yours (0600 in the 0700 folder, as the page: core/page.ts); its path is
// kept on Kiko's tmux server (FRAME_SOCKET) for the frame to find. What's sent is only text to
// draw; what comes back is only a size, read as one.
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_FOLDER, ENV_PREFIX, envVar } from "../core/name.ts";
import { appSocket } from "../core/running.ts";

/** Where the socket is: ~/.config/kiko/run/frame.sock; next to the app's socket when KIKO_SOCKET sets one (the tests). */
export function framePath(socket = appSocket()): string {
  if (envVar("SOCKET")) {
    // Next to it when that fits in a socket's path; else in a folder of its own in /tmp, only yours
    // (the frame finds it by the path the app keeps on the server, whatever it is).
    const next = `${socket}.frame.sock`;
    return Buffer.byteLength(next) <= MAX_PATH ? next : join(mkdtempSync("/tmp/cbf-"), "frame.sock");
  }
  // A test never takes over the running app's socket (frameServer removes one left there).
  if (process.env.NODE_TEST_CONTEXT) throw new Error(`under the test runner with no ${ENV_PREFIX}SOCKET: not using the app's own frame socket`);
  return join(homedir(), ".config", CONFIG_FOLDER, "run", "frame.sock");
}

/** One of the frame's programs, connected: what it is, its pane, its size. */
type FrameClient = { role: "frame" | "caption"; pane: string; cols: number; rows: number };

export type FrameServer = {
  path: string;
  /** The programs connected now (that have said what they are). */
  clients(): FrameClient[];
  /** Sends each program of `role` what `make` gives it for its size; the same again isn't sent. null: nothing. */
  send(role: FrameClient["role"], make: (c: FrameClient) => object | null): void;
  close(): void;
};

/** Longest a program's hello can be: it's a size. */
const MAX_HELLO = 4096;

/** The longest path a Unix socket can have (macOS: 104 bytes with its end). */
const MAX_PATH = 103;

/**
 * Listens at `path` (a socket left from a run before is taken over: one app runs at a time,
 * core/running.ts). `changed`: a program came, went or resized (draw for it now). `failed`: it
 * can't listen (said once; the frame then says Kiko is starting, as with no app).
 */
export function frameServer(path: string, changed: () => void, failed: (why: string) => void = () => {}): FrameServer {
  if (Buffer.byteLength(path) > MAX_PATH) throw new Error(`the frame's socket path is too long for a socket: ${path}`);
  const clients = new Map<Socket, FrameClient & { sent: string }>();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    let rest = "";
    socket.on("data", (data: string) => {
      const lines = (rest + data).split("\n");
      rest = lines.pop() ?? "";
      if (rest.length > MAX_HELLO) return socket.destroy();
      for (const line of lines) {
        let m: Partial<FrameClient>;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        const cols = Math.floor(Number(m.cols));
        const rows = Math.floor(Number(m.rows));
        if ((m.role !== "frame" && m.role !== "caption") || !(cols > 0 && cols < 10_000 && rows > 0 && rows < 10_000)) continue;
        const pane = typeof m.pane === "string" && /^%\d+$/.test(m.pane) ? m.pane : "";
        clients.set(socket, { role: m.role, pane, cols, rows, sent: "" });
        changed();
      }
    });
    const gone = () => {
      if (clients.delete(socket)) changed();
    };
    socket.on("close", gone);
    socket.on("error", () => socket.destroy());
  });
  server.on("error", (err) => failed(err.message));
  server.listen(path, () => {
    try {
      chmodSync(path, 0o600);
    } catch {}
  });
  server.unref();
  return {
    path,
    clients: () => [...clients.values()].map(({ role, pane, cols, rows }) => ({ role, pane, cols, rows })),
    send(role, make) {
      for (const [socket, c] of clients) {
        if (c.role !== role) continue;
        const m = make(c);
        if (!m) continue;
        const text = JSON.stringify(m);
        if (text === c.sent) continue;
        c.sent = text;
        socket.write(`${text}\n`);
      }
    },
    close() {
      for (const socket of clients.keys()) socket.destroy();
      clients.clear();
      server.close();
      rmSync(path, { force: true });
    },
  };
}
