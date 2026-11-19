// The helper app's own decisions (native/macos/app/host.swift, between its decide:begin and
// decide:end lines: pure functions), compiled on their own with swiftc beside a driver that prints
// each case: which instance serves, when brought to the front whether it tells you it works from
// the terminal (only with no `kiko` of its flavour about) or stays quiet, when a stray instance
// quits, and whether the frontmost app is the terminal Kiko's window is in (the overlay). Nothing is run but that driver: no app, no alert, nothing asked of macOS.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const has = (program: string) => spawnSync("/bin/sh", ["-c", `command -v ${program}`]).status === 0;
const skip = process.platform !== "darwin" ? "macOS only" : !has("swiftc") ? "needs swiftc" : false;
const dir = mkdtempSync(join(tmpdir(), "hah-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The pure part of host.swift. */
function decisions(): string {
  const host = readFileSync(join(REPO, "native/macos/app/host.swift"), "utf8");
  const m = /\/\/ decide:begin\n([\s\S]*?)\/\/ decide:end/.exec(host);
  assert.ok(m, "host.swift has its decide:begin / decide:end part");
  return m[1];
}

const DRIVER = `
import Foundation
var out: [String] = []
for locked in [true, false] { for other in [true, false] { for own in [true, false] {
    out.append("start \\(locked) \\(other) \\(own) \\(atStart(locked: locked, otherAnswers: other, ownSocket: own).rawValue)")
} } }
for clients in [0, 1] { for children in [0, 2] { for running in [true, false] { for waited in [true, false] {
    out.append("active \\(clients) \\(children) \\(running) \\(waited) \\(whenActive(clients: clients, children: children, kikoRunning: running, waited: waited).rawValue)")
} } } }
for clients in [0, 1] { for children in [0, 1] { for idle in [10.0, 400.0] { for ours in [true, false] {
    out.append("idle \\(clients) \\(children) \\(Int(idle)) \\(ours) \\(idleQuit(clients: clients, children: children, idleFor: idle, idleSeconds: 300, socketOurs: ours))")
} } } }
let rexServers = ["com.superlogical.rex.server": "com.superlogical.rex"]
let fronts: [(String, String?, Set<String>, [String], [String: String])] = [
    ("ghostty-host", "com.mitchellh.ghostty", ["com.mitchellh.ghostty"], [], [:]),
    ("ghostty-client", "com.mitchellh.ghostty", [], ["com.mitchellh.ghostty"], [:]),
    ("rex-host", "com.superlogical.rex", ["com.superlogical.rex"], ["com.superlogical.rex.server"], rexServers),
    ("rex-server", "com.superlogical.rex", [], ["com.superlogical.rex.server"], rexServers),
    ("rex-server-unknown", "com.superlogical.rex", [], ["com.superlogical.rex.server"], [:]),
    ("other-app", "com.apple.finder", ["com.superlogical.rex"], ["com.superlogical.rex.server"], rexServers),
    ("server-front", "com.superlogical.rex.server", [], [], rexServers),
    ("no-front", nil, ["com.superlogical.rex"], [], rexServers),
    ("empty-front", "", [""], [""], ["": ""]),
]
for (name, front, hosts, apps, servers) in fronts {
    out.append("front \\(name) \\(terminalMatches(front: front, hosts: hosts, clientApps: apps, servers: servers))")
}
func rect(_ r: CGRect?) -> String {
    guard let r else { return "-" }
    return [r.minX, r.minY, r.width, r.height].map { String(format: "%g", Double($0)) }.joined(separator: ",")
}
for state in ["listening", "deciding", "speaking", "needs", "sent"] {
    for width in [0.0, 40.0, 300.0, 2000.0] {
        let l = overlayLayout(state: state, words: CGSize(width: width, height: 19))
        out.append("layout \\(state) \\(Int(width)) size \\(rect(CGRect(origin: .zero, size: l.size))) mark \\(rect(l.mark)) wave \\(rect(l.waveform)) words \\(rect(l.words))")
    }
    guard let wave = overlayLayout(state: state, words: CGSize(width: 120, height: 19)).waveform else { continue }
    for level in [0.0, 0.1, 0.5, 1.0, 3.0] { for jitter in [0.55, 1.0] {
        let bars = (0..<overlayBarCount).map { rect(overlayBar($0, in: wave, height: overlayBarHeight(state: state, level: level, index: $0, jitter: jitter))) }
        out.append("bars \\(state) \\(level) \\(jitter) \\(bars.joined(separator: " "))")
    } }
}
print(out.joined(separator: "\\n"))
`;

describe("the helper app's decisions (host.swift)", { skip }, () => {
  let lines: string[] = [];
  const line = (prefix: string) => {
    const found = lines.find((l) => l.startsWith(`${prefix} `));
    assert.ok(found, prefix);
    return found.slice(prefix.length + 1);
  };

  test("compiled on their own", () => {
    const main = join(dir, "main.swift");
    // CoreGraphics first: the overlay's geometry (CGRect) is part of the decisions.
    writeFileSync(main, `import CoreGraphics\n${decisions()}\n${DRIVER}`);
    const built = spawnSync("swiftc", [main, "-o", join(dir, "decide")], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync(join(dir, "decide"), { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    lines = ran.stdout.trim().split("\n");
  });

  test("one instance serves: one without the lock quits quietly (macOS's Reopen beside kiko's own copy)", () => {
    assert.equal(line("start true false false"), "serve");
    assert.equal(line("start true false true"), "serve");
    for (const rest of ["true true", "true false", "false true", "false false"]) assert.equal(line(`start false ${rest}`), "quit", rest);
    // A build from before the lock answering at the default socket: it's the one.
    assert.equal(line("start true true false"), "quit");
    // A test's own socket (--socket): its own, served.
    assert.equal(line("start true true true"), "serve");
  });

  test("brought to the front: quiet whenever kiko is about; it tells you only with none, after waiting a moment", () => {
    for (const waited of [true, false]) {
      assert.equal(line(`active 1 0 false ${waited}`), "quiet", "a client connected");
      assert.equal(line(`active 0 2 false ${waited}`), "quiet", "its helpers running");
      assert.equal(line(`active 0 0 true ${waited}`), "quiet", "a kiko of its flavour running");
    }
    assert.equal(line("active 0 0 false false"), "wait", "first a moment for kiko to connect (it restarts its helpers)");
    assert.equal(line("active 0 0 false true"), "tell", "double-clicked with nothing running: it says it works from the terminal");
  });

  test("the overlay: the frontmost app is Kiko's terminal by its bundle id, its tmux client's app, or the app whose server that is (Rex)", () => {
    assert.equal(line("front ghostty-host"), "true", "named by kiko's environment");
    assert.equal(line("front ghostty-client"), "true", "the app responsible for Kiko's tmux client");
    assert.equal(line("front rex-host"), "true", "Rex named by kiko's environment (REX_SESSION)");
    assert.equal(line("front rex-server"), "true", "the client's app is Rex's server, whose terminals the Rex app shows");
    assert.equal(line("front rex-server-unknown"), "false", "a server no terminal app claims: not the front app");
    assert.equal(line("front other-app"), "false", "another app in front");
    assert.equal(line("front server-front"), "false", "never a server's bundle id itself, unless it's a client's app");
    assert.equal(line("front no-front"), "false");
    assert.equal(line("front empty-front"), "false", "nothing in front matches nothing");
  });

  // The overlay's pill: [x, y, width, height] of each part, for words 0, 40, 300 and 2000 wide.
  const rect = (s: string) => (s === "-" ? null : s.split(",").map(Number));
  const layout = (state: string, width: number) => {
    const m = /^size (\S+) mark (\S+) wave (\S+) words (\S+)$/.exec(line(`layout ${state} ${width}`));
    assert.ok(m, `layout ${state} ${width}`);
    return { size: rect(m[1]), mark: rect(m[2]), wave: rect(m[3]), words: rect(m[4]) };
  };
  const WIDTHS = [0, 40, 300, 2000];

  test("the overlay: the mark and the waveform sit where the state puts them, whatever the words; the words get the rest, cut short", () => {
    for (const state of ["listening", "deciding", "speaking", "needs"]) {
      const first = layout(state, 0);
      for (const width of WIDTHS) assert.deepEqual(layout(state, width), first, `${state}, words ${width} wide: nothing moves`);
      assert.deepEqual(first.size, [0, 0, 460, 44], state);
    }
    // The design's order: the mark, the bars, the words (OverlayStates.dc.html), 12 apart.
    assert.deepEqual(layout("listening", 0).mark, [16, 17, 10, 10]);
    assert.deepEqual(layout("listening", 0).wave, [38, 13, 23, 18]);
    assert.deepEqual(layout("listening", 0).words, [73, 12.5, 371, 19]);
    assert.deepEqual(layout("deciding", 0), layout("listening", 0), "listening to deciding: nothing moves");
    // Speaking: no mark, the bars first.
    assert.equal(layout("speaking", 0).mark, null);
    assert.deepEqual(layout("speaking", 0).wave, [16, 13, 23, 18]);
    assert.equal(layout("needs", 0).wave, null);
    assert.deepEqual(layout("needs", 0).mark, [16, 17, 10, 10]);
    // "Sent to …" fits its words, the mark where it was.
    for (const width of WIDTHS) {
      const sent = layout("sent", width);
      assert.deepEqual(sent.mark, [16, 14, 10, 10]);
      assert.equal(sent.wave, null);
      assert.deepEqual(sent.size, [0, 0, 36 + width + 16, 38]);
      assert.deepEqual(sent.words, [36, 9.5, width, 19]);
    }
    // The waveform never reaches the mark's halo (4 around it).
    const { mark, wave } = layout("listening", 2000);
    assert.ok(mark && wave && wave[0] >= mark[0] + mark[2] + 4 + 4, "a gap between the halo and the bars");
  });

  test("the overlay: the bars' x and width never depend on the level; only their heights do, centred in the waveform", () => {
    let seen = 0;
    for (const state of ["listening", "deciding", "speaking"]) {
      const wave = layout(state, 0).wave;
      assert.ok(wave);
      const heights = new Set<number>();
      for (const l of lines.filter((l) => l.startsWith(`bars ${state} `))) {
        const bars = l.split(" ").slice(4).map(rect);
        assert.equal(bars.length, 5, l);
        bars.forEach((b, i) => {
          assert.ok(b);
          assert.equal(b[0], wave[0] + i * 5, `${l}: bar ${i}'s x`);
          assert.equal(b[2], 3, `${l}: bar ${i}'s width`);
          assert.ok(b[3] >= 4 && b[3] <= 18, `${l}: bar ${i}'s height`);
          assert.ok(Math.abs(b[1] + b[3] / 2 - (wave[1] + wave[3] / 2)) < 0.001, `${l}: bar ${i} centred`);
          heights.add(b[3]);
        });
        seen++;
      }
      if (state !== "deciding") assert.ok(heights.size > 1, `${state}: the heights change`);
    }
    assert.equal(seen, 30);
  });

  test("the overlay: Kiko speaking moves the bars as your voice does, on the level of its sound (only where they are differs)", () => {
    // As the driver prints them (Swift's Doubles).
    const heights = (state: string, level: string, jitter: string) =>
      line(`bars ${state} ${level} ${jitter}`)
        .split(" ")
        .map((b) => rect(b)?.[3]);
    for (const level of ["0.0", "0.1", "0.5", "1.0", "3.0"])
      for (const jitter of ["0.55", "1.0"]) assert.deepEqual(heights("speaking", level, jitter), heights("listening", level, jitter), `${level} ${jitter}`);
    assert.notDeepEqual(heights("speaking", "0.0", "1.0"), heights("speaking", "0.5", "1.0"), "quiet and loud differ");
  });

  test("the overlay: Kiko's words cut at the head as yours are, so the newest stay in view; its bars stay white, yours the accent", () => {
    const host = readFileSync(join(REPO, "native/macos/app/host.swift"), "utf8");
    assert.match(host, /\(said, overlayInk, \.medium, 15\)\], head: true\)\n        \} else \{\n            words = attributed/);
    assert.match(host, /color: speaking \? overlayInk : overlayAccent/);
  });

  test("a stray instance doesn't stay: idle too long, or its socket no longer its own", () => {
    assert.equal(line("idle 0 0 10 true"), "false");
    assert.equal(line("idle 0 0 400 true"), "true");
    assert.equal(line("idle 0 0 10 false"), "true", "nobody can reach it: gone at once");
    for (const busy of ["1 0", "0 1", "1 1"]) {
      assert.equal(line(`idle ${busy} 400 true`), "false", busy);
      assert.equal(line(`idle ${busy} 10 false`), "false", `${busy}: serving someone still`);
    }
  });
});

// Not a decision, but what a stray or hidden instance does: read from the source.
describe("the helper app's defaults (host.swift)", () => {
  const host = readFileSync(join(REPO, "native/macos/app/host.swift"), "utf8");
  test("it quits 30 s after its last client goes (a quit `kiko` leaves nothing behind for long)", () => {
    assert.match(host, /let idleSeconds = Double\(arg\("--idle"\) \?\? ""\) \?\? 30\n/);
  });
  test("the overlay's panel doesn't hide with the app (started hidden, `open -j`): else it's never drawn", () => {
    assert.match(host, /panel\.canHide = false/);
    assert.match(host, /panel\.orderFrontRegardless\(\)/);
    assert.match(host, /\.canJoinAllSpaces, \.fullScreenAuxiliary/);
  });
  test("the overlay's bars: only their heights animate, and their timer draws the state now, never a box it kept from an earlier one", () => {
    // A timer that kept the speaking state's box drew the bars there between listening's updates: they slid over the mark and back.
    assert.match(host, /bar\.actions = \["position": NSNull\(\)/);
    assert.match(host, /Timer\.scheduledTimer\(withTimeInterval: 0\.12, repeats: true\) \{ \[weak self\] _ in MainActor\.assumeIsolated \{ self\?\.drawBars\(\) \} \}/);
    assert.match(host, /bar\.bounds = CGRect\(origin: \.zero, size: overlayBar\(/);
    // A level-only update moves nothing, the panel least of all.
    assert.match(host, /if key == laidOut && wanted && panel\.isVisible \{ return \}/);
    assert.match(host, /if wanted && panel\.isVisible && state == placedState && panel\.frame\.size == size \{ return \}/);
  });
});
