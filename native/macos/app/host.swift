// The helper app's own executable (ARCHITECTURE.md, "The helper app"): a background-only app
// (LSUIElement: no Dock icon, no menu bar) that holds the macOS permissions Kiko's helpers need,
// so they're the app's ("<NAME>" / "<NAME> Dev" in macOS's prompts and System Settings), not the
// terminal's. `kiko` starts it through Launch Services (`open -g -j`): started that way it is its
// own "responsible process", and so is every helper it starts, so their microphone, Speech
// Recognition and Input Monitoring checks are the app's. Started directly by a shell, the terminal
// stays responsible instead (the prototype proved both, 2026-11-02).
//
// It's a spawn broker: it runs nothing of its own. The helpers that need a permission (mic, hotkey,
// speech, permissions: native/macos/*.swift, unchanged) are in Contents/Helpers/; `kiko`
// (src/platform/macos/helper-app.ts) asks for one over a Unix socket and gets a child whose stdin,
// stdout and stderr are sockets `kiko` opened, so nothing is copied in between. One connection is
// the client's control channel, one JSON object per line each way:
//   → {"op":"hello","build":B}           ← {"op":"hello","pid","bundleId","bundlePath","build","version",
//                                           "responsible":{"pid","self"},"clients","told","quiet"}
//   → {"op":"spawn","token":T,"helper":H,"args":[…],"fds":[0,1,2]}
//                                         ← {"op":"spawned","token":T,"pid"} or {"op":"error","token":T,"message"}
//                                         ← {"op":"exit","token":T,"code":c|null,"signal":s|null} when it ends
//   → {"op":"kill","token":T,"signal":15}
//   → {"op":"osascript","token":T,"script":S,"args":[…],"timeout":secs}
//                                         ← {"op":"exit","token":T,"code":c|null,"signal":s|null,"stdout","stderr"}
//                                           once it's done, or {"op":"error","token":T,"message"}
//                                         An AppleScript run by /usr/bin/osascript as this app's child, so
//                                         the Apple Events it sends (to Ghostty, Terminal, iTerm) are the
//                                         app's: macOS asks "<NAME> wants access to control Ghostty" once
//                                         (Info.plist NSAppleEventsUsageDescription; the hardened runtime's
//                                         com.apple.security.automation.apple-events), whichever terminal
//                                         `kiko` runs in (src/platform/macos/apple-events.ts).
//   → {"op":"quit"}                       everything stopped, the socket gone, the app quits
//   → {"op":"relaunch"}                   the same, then a new instance through Launch Services: a
//                                         permission turned on since (Input Monitoring) takes effect
// Each of a child's stdio connections first sends one line, {"op":"stdio","token":T,"fd":0|1|2},
// read a byte at a time so nothing after it is taken; the socket then becomes that fd of the child.
// An fd not asked for is /dev/null. A client gone: its children are stopped. No client for --idle
// seconds (30: long enough for `kiko` restarting, or starting its helpers again after macOS's "Quit &
// Reopen", to find it; short enough that a quit `kiko` leaves nothing behind for long): it quits;
// so does one whose socket is no longer its own (nobody can reach it).
//
// One instance serves a socket: the one holding <socket>.lock (flock, let go as it quits or is
// killed). Another started meanwhile (macOS's "Reopen" after its "Quit & Reopen", beside `kiko`'s
// own restart of it; or `open -n` racing one) waits a moment for the lock, then quits quietly.
//
//   <exe> [--socket <path>] [--idle <seconds>]   the socket: ~/Library/Caches/<bundle id>/broker.sock
//   <exe> --whoami                                its pid and responsible process as JSON, then exits
//
// Brought to the front (double-clicked, or macOS's "Reopen", both with no arguments), it says it
// works from the terminal and which command to run, but only when no `kiko` of its flavour is about
// (whenActive): none connected, no helper of its running, nothing answering on `kiko`'s hooks socket
// (Info.plist BrokerAppSocket) and the last client's pid (client.pid beside the socket) gone, after
// a moment for one to connect. Otherwise it stays quiet: `kiko` starts its helpers again in it.
import AppKit
import Darwin
import Foundation

let me = getpid()
let bundle = Bundle.main
let bundleId = bundle.bundleIdentifier ?? "unknown"
let info = bundle.infoDictionary ?? [:]
let build = info["BrokerBuild"] as? String ?? ""
let version = info["CFBundleShortVersionString"] as? String ?? ""
let appName = info["CFBundleName"] as? String ?? "?"
let command = info["BrokerCommand"] as? String ?? ""
/// `kiko`'s hooks socket (core/name.ts flavourNames socket): something answering there is a `kiko` of this flavour running.
let appSocket = info["BrokerAppSocket"] as? String ?? (command.isEmpty ? "" : "/tmp/\(command).sock")
let helpers = bundle.bundleURL.appendingPathComponent("Contents/Helpers")

// ── Its decisions ───────────────────────────────────────────────────────────
// Pure, so tests/unit/platform/macos/helper-app-host.test.ts compiles this part (between the
// decide:begin and decide:end lines) on its own and checks each case.
// decide:begin

/// What an instance does: as it starts, `serve` or `quit`; brought to the front, `tell` (it works
/// from the terminal), `quiet`, or `wait` (a moment for a client first).
enum Decision: String {
    case serve, quit, tell, quiet, wait
}

/// As it starts. `locked`: the socket's lock is its own (no other instance serves: else this one
/// quits, quietly: macOS's "Reopen" beside `kiko`'s own restart of it, or the reverse).
/// `otherAnswers`: something answers on the socket already (a build from before the lock: it's the
/// one), unless `ownSocket` (--socket: a test's, its own).
func atStart(locked: Bool, otherAnswers: Bool, ownSocket: Bool) -> Decision {
    if !locked { return .quit }
    if otherAnswers && !ownSocket { return .quit }
    return .serve
}

/// Brought to the front: double-clicked, or macOS's "Reopen" after a permission was turned on (with
/// no arguments either way). It tells you it works from the terminal only when no `kiko` of its
/// flavour is about: no client connected, no helper of its running, and `kikoRunning` false (its
/// hooks socket silent, the last client's pid gone); and only once it has `waited` a moment for a
/// client (`kiko` starting its helpers again after the app was killed connects within a second or two).
func whenActive(clients: Int, children: Int, kikoRunning: Bool, waited: Bool) -> Decision {
    if clients > 0 || children > 0 || kikoRunning { return .quiet }
    return waited ? .tell : .wait
}

/// Whether it quits now: nothing connected and no helper running, and either idle for `idleSeconds`
/// or its socket no longer its own (removed, or another instance's: nobody can reach this one).
func idleQuit(clients: Int, children: Int, idleFor: Double, idleSeconds: Double, socketOurs: Bool) -> Bool {
    if clients > 0 || children > 0 { return false }
    return !socketOurs || idleFor > idleSeconds
}

/// The overlay: whether the frontmost app (`front`, its bundle id) is the terminal Kiko's window is
/// in. One of `hosts` (the terminal `kiko`'s environment names), or the app responsible for one of
/// the tmux clients showing Kiko's window (`clientApps`, their bundle ids), or the app whose server
/// that is (`servers`: a server's bundle id to its app's, src/core/terminal-apps.ts APPS: Rex's
/// terminals are its background server's, never the frontmost app). Whether Kiko's window is the
/// one in front there is `kiko`'s to say (`kikoFocused`), not this.
func terminalMatches(front: String?, hosts: Set<String>, clientApps: [String], servers: [String: String]) -> Bool {
    guard let front, !front.isEmpty else { return false }
    if hosts.contains(front) { return true }
    return clientApps.contains { $0 == front || servers[$0] == front }
}

/// The overlay's waveform: 5 bars 3 wide, 2 apart, at most 18 high (.claude/kiko-design OverlayStates).
let overlayBarCount = 5
let overlayBarWidth: CGFloat = 3
let overlayBarGap: CGFloat = 2
let overlayBarMax: CGFloat = 18
let overlayWaveformWidth = CGFloat(overlayBarCount) * overlayBarWidth + CGFloat(overlayBarCount - 1) * overlayBarGap

/// The overlay's pill for a state: its size, the mark (the square: nil when it has none), the
/// waveform's box (nil: none) and where the words go. The mark and the waveform depend on the state
/// alone, never on the words (`words`: their measured size) or the mic's level, so they never move
/// while a state lasts: long words are cut short with an ellipsis in their own box. Only "sent" (no
/// waveform) fits its width to its words.
struct OverlayLayout {
    var size: CGSize
    var mark: CGRect?
    var waveform: CGRect?
    var words: CGRect
}

func overlayLayout(state: String, words: CGSize) -> OverlayLayout {
    let listening = state == "listening" || state == "deciding"
    let sent = state == "sent"
    let speaking = state == "speaking"
    let h: CGFloat = sent ? 38 : 44
    var x: CGFloat = 16
    var mark: CGRect?
    if !speaking {
        mark = CGRect(x: x, y: (h - 10) / 2, width: 10, height: 10)
        x += 10 + (sent ? 10 : 12)
    }
    var waveform: CGRect?
    if listening || speaking {
        waveform = CGRect(x: x, y: (h - overlayBarMax) / 2, width: overlayWaveformWidth, height: overlayBarMax)
        x += overlayWaveformWidth + 12
    }
    let w: CGFloat = sent ? x + ceil(words.width) + 16 : 460
    return OverlayLayout(
        size: CGSize(width: w, height: h), mark: mark, waveform: waveform,
        words: CGRect(x: x, y: (h - words.height) / 2, width: max(0, w - x - 16), height: words.height))
}

/// The height of bar `i`: listening, the mic's `level` with `jitter` (0.55…1: a little life of its
/// own); speaking, the same for the level of Kiko's sound as it plays; deciding, still and low.
func overlayBarHeight(state: String, level: Double, index i: Int, jitter: Double) -> CGFloat {
    let shape: [Double] = [0.45, 0.85, 0.6, 1.0, 0.5]
    let base = state == "listening" || state == "speaking" ? min(1, 0.25 + max(0, level) * 2.5) : 0.2
    let j = state == "deciding" ? 1 : jitter
    return min(overlayBarMax, max(4, CGFloat(overlayBarMax * base * shape[i % shape.count] * j)))
}

/// Bar `i` of `waveform` at `height`, centred: its x and width never depend on the height.
func overlayBar(_ i: Int, in waveform: CGRect, height: CGFloat) -> CGRect {
    let h = min(waveform.height, max(0, height))
    return CGRect(x: waveform.minX + CGFloat(i) * (overlayBarWidth + overlayBarGap), y: waveform.midY - h / 2, width: overlayBarWidth, height: h)
}

// decide:end

// ── Who's responsible ───────────────────────────────────────────────────────

/// libsystem's (private, exported) responsibility_get_pid_responsible_for_pid: the process TCC
/// attributes another's requests to.
typealias ResponsibleFn = @convention(c) (pid_t) -> pid_t
let responsibleFn: ResponsibleFn? = {
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return nil }
    return unsafeBitCast(sym, to: ResponsibleFn.self)
}()

func responsible(_ pid: pid_t) -> [String: Any] {
    guard let fn = responsibleFn else { return ["pid": -1, "self": false] }
    let r = fn(pid)
    return ["pid": Int(r), "self": r == pid]
}

func json(_ value: Any) -> String {
    (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
}

let args = CommandLine.arguments
func arg(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

if args.dropFirst().first == "--whoami" {
    print(json(["pid": Int(me), "bundleId": bundleId, "responsible": responsible(me)]))
    exit(0)
}

/// The home folder from the user database, not $HOME: `kiko` finds the socket the same way.
func realHome() -> String {
    if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { return String(cString: dir) }
    return NSHomeDirectory()
}

let socketPath = arg("--socket") ?? "\(realHome())/Library/Caches/\(bundleId)/broker.sock"
let idleSeconds = Double(arg("--idle") ?? "") ?? 30
/// Held while this instance serves the socket (flock: let go when it quits, or is killed).
let lockPath = socketPath + ".lock"
/// The pid of the last `kiko` that connected (helper-app.ts writes it): alive, a `kiko` of this flavour is running.
let clientPidPath = ((socketPath as NSString).deletingLastPathComponent as NSString).appendingPathComponent("client.pid")

// ── State ───────────────────────────────────────────────────────────────────

final class Client: @unchecked Sendable {
    let fd: Int32
    private let lock = NSLock()
    private var closed = false
    init(fd: Int32) { self.fd = fd }

    /// Closed once, under the lock: a child's exit told after that writes nowhere (never to a reused fd).
    func close() {
        lock.lock()
        defer { lock.unlock() }
        if !closed { Darwin.close(fd) }
        closed = true
    }

    func send(_ fields: [String: Any]) {
        let line = Array((json(fields) + "\n").utf8)
        lock.lock()
        defer { lock.unlock() }
        if closed { return }
        var sent = 0
        while sent < line.count {
            let n = line[sent...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            if n <= 0 { return }
            sent += n
        }
    }
}

struct Child {
    let pid: pid_t
    let client: Client
    let token: String
}

let state = NSCondition()
nonisolated(unsafe) var clients: [ObjectIdentifier: Client] = [:]
nonisolated(unsafe) var children: [String: Child] = [:]  // by token
/// Stdio connections waiting for their spawn: token → fd number → socket.
nonisolated(unsafe) var pendingFds: [String: [Int: Int32]] = [:]
nonisolated(unsafe) var lastActivity = Date()
/// AppleScripts running now (op osascript): counted as children, so the app doesn't quit under one.
nonisolated(unsafe) var scripts = 0
/// How many times it said it works from the terminal (opened by hand): in hello, so a test can tell `open -g -j` never does.
nonisolated(unsafe) var told = 0
/// How many times it came to the front and said nothing, a `kiko` being about (whenActive): in hello too.
nonisolated(unsafe) var keptQuiet = 0
nonisolated(unsafe) var lockFd: Int32 = -1
nonisolated(unsafe) var listener: Int32 = -1
nonisolated(unsafe) var socketInode: ino_t = 0

func locked<T>(_ body: () -> T) -> T {
    state.lock()
    defer { state.unlock() }
    return body()
}

// ── Children ────────────────────────────────────────────────────────────────

/// Starts Contents/Helpers/<helper> with `fds` as its stdin, stdout and stderr (/dev/null for any
/// not given): its own process, every other descriptor of ours closed in it, signals as default.
func spawnHelper(_ helper: String, _ arguments: [String], _ fds: [Int: Int32]) -> Result<pid_t, Error> {
    let path = helpers.appendingPathComponent(helper).path
    var actions: posix_spawn_file_actions_t? = nil
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    for target in 0...2 {
        if let fd = fds[target] {
            posix_spawn_file_actions_adddup2(&actions, fd, Int32(target))
        } else {
            posix_spawn_file_actions_addopen(&actions, Int32(target), "/dev/null", target == 0 ? O_RDONLY : O_WRONLY, 0)
        }
    }
    var attr: posix_spawnattr_t? = nil
    posix_spawnattr_init(&attr)
    defer { posix_spawnattr_destroy(&attr) }
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
    var all = sigset_t()
    sigfillset(&all)
    posix_spawnattr_setsigdefault(&attr, &all)
    var none = sigset_t()
    sigemptyset(&none)
    posix_spawnattr_setsigmask(&attr, &none)
    let argv: [UnsafeMutablePointer<CChar>?] = ([path] + arguments).map { strdup($0) } + [nil]
    defer { for p in argv { free(p) } }
    var pid: pid_t = 0
    let rc = posix_spawn(&pid, path, &actions, &attr, argv, environ)
    if rc != 0 { return .failure(NSError(domain: NSPOSIXErrorDomain, code: Int(rc), userInfo: [NSLocalizedDescriptionKey: String(cString: strerror(rc))])) }
    return .success(pid)
}

/// Waits for the child in a thread of its own; tells its client how it ended.
func watch(_ child: Child) {
    Thread.detachNewThread {
        var status: Int32 = 0
        while waitpid(child.pid, &status, 0) < 0 && errno == EINTR {}
        locked {
            children.removeValue(forKey: child.token)
            lastActivity = Date()
        }
        // WIFEXITED / WTERMSIG by hand (macros Swift doesn't import).
        let signal = status & 0x7f
        let exited = signal == 0
        child.client.send([
            "op": "exit", "token": child.token,
            "code": exited ? Int((status >> 8) & 0xff) : NSNull(),
            "signal": exited ? NSNull() : Int(signal),
        ])
    }
}

/// Stops `pids`: SIGTERM, then SIGKILL for any still there after `grace` seconds.
func stop(_ pids: [pid_t], grace: Double = 2) {
    for pid in pids { kill(pid, SIGTERM) }
    guard !pids.isEmpty else { return }
    let deadline = Date().addingTimeInterval(grace)
    var left = pids
    while !left.isEmpty && Date() < deadline {
        usleep(50_000)
        left = left.filter { pid in locked { children.values.contains { $0.pid == pid } } }
    }
    for pid in left { kill(pid, SIGKILL) }
}

func spawn(_ c: Client, _ obj: [String: Any]) {
    guard let token = obj["token"] as? String, !token.isEmpty,
        let helper = obj["helper"] as? String,
        !helper.contains("/"), helper != "..", FileManager.default.isExecutableFile(atPath: helpers.appendingPathComponent(helper).path)
    else {
        c.send(["op": "error", "token": obj["token"] as? String ?? "", "message": "no such helper"])
        return
    }
    let arguments = (obj["args"] as? [Any] ?? []).compactMap { $0 as? String }
    let wanted = Set((obj["fds"] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.intValue }.filter { (0...2).contains($0) })
    // Its stdio connections, each made before the spawn was sent: waited for a little.
    let deadline = Date().addingTimeInterval(5)
    state.lock()
    while !wanted.isSubset(of: Set((pendingFds[token] ?? [:]).keys)) {
        if !state.wait(until: deadline) { break }
    }
    let fds = pendingFds.removeValue(forKey: token) ?? [:]
    state.unlock()
    guard wanted.isSubset(of: Set(fds.keys)) else {
        for fd in fds.values { close(fd) }
        c.send(["op": "error", "token": token, "message": "its stdio connections didn't arrive"])
        return
    }
    let result = spawnHelper(helper, arguments, fds)
    // Ours closed: the child holds its own copies, so its end is what the client sees.
    for fd in fds.values { close(fd) }
    switch result {
    case .success(let pid):
        let child = Child(pid: pid, client: c, token: token)
        locked {
            children[token] = child
            lastActivity = Date()
        }
        c.send(["op": "spawned", "token": token, "pid": Int(pid)])
        watch(child)
    case .failure(let err):
        c.send(["op": "error", "token": token, "message": "\(helper): \(err.localizedDescription)"])
    }
}

// ── AppleScript ─────────────────────────────────────────────────────────────

/// What a script printed, collected on a thread of its own.
final class Collected: @unchecked Sendable {
    var data = Data()
}

/// One AppleScript, `script` with `args` (its `on run argv`), run by /usr/bin/osascript as this
/// app's child: stopped after `timeout` seconds. Its own thread: the control channel reads on.
func runScript(_ c: Client, _ obj: [String: Any]) {
    guard let token = obj["token"] as? String, !token.isEmpty, let script = obj["script"] as? String else {
        c.send(["op": "error", "token": obj["token"] as? String ?? "", "message": "no script"])
        return
    }
    let arguments = (obj["args"] as? [Any] ?? []).compactMap { $0 as? String }
    let timeout = min(max((obj["timeout"] as? NSNumber)?.doubleValue ?? 30, 1), 600)
    Thread.detachNewThread {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script] + arguments
        let out = Pipe()
        let err = Pipe()
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = out
        p.standardError = err
        do {
            try p.run()
        } catch {
            c.send(["op": "error", "token": token, "message": "osascript: \(error.localizedDescription)"])
            return
        }
        locked {
            scripts += 1
            lastActivity = Date()
        }
        let stop = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: stop)
        // Both read at once: a full stderr pipe can't hold up stdout's end.
        let said = Collected()
        let reading = DispatchGroup()
        reading.enter()
        DispatchQueue.global().async {
            said.data = err.fileHandleForReading.readDataToEndOfFile()
            reading.leave()
        }
        let printed = out.fileHandleForReading.readDataToEndOfFile()
        reading.wait()
        p.waitUntilExit()
        stop.cancel()
        locked {
            scripts -= 1
            lastActivity = Date()
        }
        let exited = p.terminationReason == .exit
        c.send([
            "op": "exit", "token": token,
            "code": exited ? Int(p.terminationStatus) : NSNull(),
            "signal": exited ? NSNull() : Int(p.terminationStatus),
            "stdout": String(decoding: printed, as: UTF8.self),
            "stderr": String(decoding: said.data, as: UTF8.self),
        ])
    }
}

// ── Quitting ────────────────────────────────────────────────────────────────

/// Everything stopped, and the socket taken away if it's still ours (a new instance may have its own there).
func shutDown() {
    let pids = locked { children.values.map { $0.pid } }
    stop(pids)
    if listener >= 0 { close(listener) }
    if socketOurs() { unlink(socketPath) }
    // The lock let go last: a new instance (relaunch's) serves from here on.
    if lockFd >= 0 { close(lockFd) }
}

/// The socket file there is still the one this instance made.
func socketOurs() -> Bool {
    var st = stat()
    return stat(socketPath, &st) == 0 && st.st_ino == socketInode
}

func quit() -> Never {
    shutDown()
    exit(0)
}

/// Quits and starts again through Launch Services (a new instance: `open -n`), so a permission
/// turned on since it started (Input Monitoring, read once per launch) takes effect.
func relaunch() -> Never {
    shutDown()
    let open = Process()
    open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    open.arguments = ["-n", "-g", "-j", bundle.bundlePath]
    try? open.run()
    open.waitUntilExit()
    exit(0)
}

// ── Connections ─────────────────────────────────────────────────────────────

/// One line from `fd`, a byte at a time (nothing after the newline is read); nil at its end.
func firstLine(_ fd: Int32, max: Int = 4096) -> String? {
    var bytes: [UInt8] = []
    var b: UInt8 = 0
    while bytes.count < max {
        let n = read(fd, &b, 1)
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { return nil }
        if b == 10 { return String(decoding: bytes, as: UTF8.self) }
        bytes.append(b)
    }
    return nil
}

func setTimeout(_ fd: Int32, _ seconds: Int) {
    var tv = timeval(tv_sec: seconds, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
}

func handle(_ c: Client, _ obj: [String: Any]) {
    switch obj["op"] as? String {
    case "hello":
        let n = locked { clients.count }
        c.send([
            "op": "hello", "pid": Int(me), "bundleId": bundleId, "bundlePath": bundle.bundlePath, "build": build,
            "version": version, "name": appName, "responsible": responsible(me), "clients": n, "told": locked { told },
            "quiet": locked { keptQuiet },
        ])
    case "spawn": spawn(c, obj)
    case "osascript": runScript(c, obj)
    case "kill":
        let token = obj["token"] as? String ?? ""
        let sig = Int32((obj["signal"] as? NSNumber)?.intValue ?? Int(SIGTERM))
        if let child = locked({ children[token] }), sig > 0, sig < 32 { kill(child.pid, sig) }
    case "quit":
        c.send(["op": "bye"])
        quit()
    case "relaunch":
        c.send(["op": "bye"])
        relaunch()
    case "overlay": overlayUpdate(obj, from: c)
    default:
        c.send(["op": "error", "message": "unknown op"])
    }
}

/// A new connection: a child's stdio (kept for its spawn), or a client's control channel (served until it closes).
func accepted(_ fd: Int32) {
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    setTimeout(fd, 5)
    guard let line = firstLine(fd),
        let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
    else {
        close(fd)
        return
    }
    setTimeout(fd, 0)
    if obj["op"] as? String == "stdio" {
        guard let token = obj["token"] as? String, let n = (obj["fd"] as? NSNumber)?.intValue, (0...2).contains(n) else {
            close(fd)
            return
        }
        // The child's, not ours: SIGPIPE as any pipe would give it.
        var off: Int32 = 0
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &off, socklen_t(MemoryLayout<Int32>.size))
        state.lock()
        if let old = pendingFds[token]?[n] { close(old) }
        pendingFds[token, default: [:]][n] = fd
        state.broadcast()
        state.unlock()
        // Never claimed (no spawn came): closed after a while.
        DispatchQueue.global().asyncAfter(deadline: .now() + 30) {
            state.lock()
            if pendingFds[token]?[n] == fd {
                pendingFds[token]?.removeValue(forKey: n)
                if pendingFds[token]?.isEmpty == true { pendingFds.removeValue(forKey: token) }
                close(fd)
            }
            state.unlock()
        }
        return
    }
    let c = Client(fd: fd)
    locked {
        clients[ObjectIdentifier(c)] = c
        lastActivity = Date()
    }
    handle(c, obj)
    var pending = Data()
    var buf = [UInt8](repeating: 0, count: 4096)
    while true {
        let n = read(fd, &buf, buf.count)
        if n < 0 && errno == EINTR { continue }
        if n <= 0 { break }
        pending.append(contentsOf: buf[0..<n])
        while let nl = pending.firstIndex(of: 10) {
            let line = pending.subdata(in: pending.startIndex..<nl)
            pending.removeSubrange(pending.startIndex...nl)
            locked { lastActivity = Date() }
            if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { handle(c, obj) }
        }
    }
    // The client's gone (it quit, or crashed): its children with it.
    let mine = locked { () -> [pid_t] in
        clients.removeValue(forKey: ObjectIdentifier(c))
        lastActivity = Date()
        return children.values.filter { $0.client === c }.map { $0.pid }
    }
    stop(mine)
    overlayGone(c)
    c.close()
}

// ── The socket ──────────────────────────────────────────────────────────────

func address(_ path: String) -> sockaddr_un? {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
    withUnsafeMutablePointer(to: &addr.sun_path) { p in
        p.withMemoryRebound(to: UInt8.self, capacity: bytes.count + 1) { dst in
            for (i, b) in bytes.enumerated() { dst[i] = b }
            dst[bytes.count] = 0
        }
    }
    return addr
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("\(appName): \(message)\n".data(using: .utf8)!)
    exit(1)
}

guard var addr = address(socketPath) else { fail("the socket path is too long: \(socketPath)") }
let dir = (socketPath as NSString).deletingLastPathComponent
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
chmod(dir, 0o700)

/// Something answers on the Unix socket at `path`.
func answers(_ path: String) -> Bool {
    guard var a = address(path) else { return false }
    let probe = socket(AF_UNIX, SOCK_STREAM, 0)
    guard probe >= 0 else { return false }
    defer { close(probe) }
    var on: Int32 = 1
    setsockopt(probe, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    let rc = withUnsafePointer(to: &a) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    return rc == 0
}

/// The socket's lock, taken (waited for up to `seconds`: an instance quitting, as `kiko` replaces
/// another build or relaunches it, lets go of it a moment after its socket goes).
func takeLock(seconds: Double) -> Bool {
    let fd = open(lockPath, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return true }  // can't be made: served as before the lock
    let deadline = Date().addingTimeInterval(seconds)
    while flock(fd, LOCK_EX | LOCK_NB) != 0 {
        if Date() >= deadline {
            close(fd)
            return false
        }
        usleep(100_000)
    }
    lockFd = fd
    return true
}

/// A `kiko` of this flavour running: its hooks socket answers, or the last client's pid is alive.
func kikoRunning() -> Bool {
    if !appSocket.isEmpty && answers(appSocket) { return true }
    guard let text = try? String(contentsOfFile: clientPidPath, encoding: .utf8),
        let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 1
    else { return false }
    return kill(pid, 0) == 0 || errno == EPERM
}

// One instance serves: another quits quietly, before it could ever come to the front and say anything.
let haveLock = takeLock(seconds: 3)
if atStart(locked: haveLock, otherAnswers: haveLock && answers(socketPath), ownSocket: arg("--socket") != nil) == .quit { exit(0) }

signal(SIGPIPE, SIG_IGN)
listener = socket(AF_UNIX, SOCK_STREAM, 0)
guard listener >= 0 else { fail("socket: \(errno)") }
_ = fcntl(listener, F_SETFD, FD_CLOEXEC)
unlink(socketPath)
let bound = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
}
guard bound == 0 else { fail("bind \(socketPath): \(errno)") }
chmod(socketPath, 0o600)
var st = stat()
if stat(socketPath, &st) == 0 { socketInode = st.st_ino }
listen(listener, 32)

Thread.detachNewThread {
    while true {
        let fd = accept(listener, nil, nil)
        if fd < 0 {
            if errno == EINTR || errno == ECONNABORTED { continue }
            return
        }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        Thread.detachNewThread { accepted(fd) }
    }
}

// No client and no child for idleSeconds, or nobody can reach it: gone.
Thread.detachNewThread {
    while true {
        sleep(5)
        let ours = socketOurs()
        let idle = locked {
            idleQuit(clients: clients.count, children: children.count + scripts, idleFor: Date().timeIntervalSince(lastActivity), idleSeconds: idleSeconds, socketOurs: ours)
        }
        if idle { quit() }
    }
}

// ── The overlay (a Kiko Dev prototype) ──────────────────────────────────────
// A dark pill at the top centre of the screen with the mouse, under the notch, above everything
// (full-screen apps and other Spaces too), never taking focus or clicks: what Kiko is doing while
// you're in another app. `kiko` (src/app/overlay.ts, Kiko Dev only) sends, on its control channel:
//   → {"op":"overlay","state":"listening"|"deciding"|"sent"|"speaking"|"needs"|"idle",
//      "text","session","level","hosts":[bundle id…],"hostServers":{server bundle id: app bundle id},
//      "hostPids":[pid…],"kikoFocused":true|false|null}
// It answers with log lines only, {"op":"log","event","…"} (`kiko` writes them to its own log), and
// says the same in the unified log (`log stream --predicate 'process BEGINSWITH "Kiko"'`).
// Hidden only while Kiko's own window is in front: `kikoFocused` (`kiko`'s say, by its rule:
// in Rex, Kiko's block drawn in the tab shown, whichever block has the focus; elsewhere, its tmux
// client has the terminal's focus: src/app/overlay.ts FocusRule) and the frontmost app the terminal
// it's in (`hosts`, or the app responsible for one of `hostPids`: the tmux clients showing it; or
// the app whose server that is, `hostServers`: Rex's terminals are its background server's:
// terminalMatches). Another tab of that terminal (or, outside Rex, a Claude session in a Ghostty
// split beside Kiko's, with the focus) shows it; so does an unknown focus (null: not in tmux).
// "sent" fades by itself after a moment, "needs" after a few seconds; the client gone, it goes too.
// The app is started hidden (`open -g -j`): the panel can't hide with it (canHide false), else
// macOS never puts it on screen.

let overlayAccent = NSColor(srgbRed: 154 / 255, green: 168 / 255, blue: 1, alpha: 1)
let overlayInk = NSColor(srgbRed: 236 / 255, green: 236 / 255, blue: 239 / 255, alpha: 1)
let overlayQuiet = NSColor(srgbRed: 162 / 255, green: 162 / 255, blue: 172 / 255, alpha: 1)
let overlayDim = NSColor(srgbRed: 109 / 255, green: 109 / 255, blue: 120 / 255, alpha: 1)

final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class Overlay {
    let panel: OverlayPanel
    let pill = NSView()
    let halo = CALayer()
    let dot = CALayer()
    var bars: [CALayer] = []
    let label = NSTextField(labelWithString: "")
    var state = "idle"
    var text = ""
    var session = ""
    var level = 0.0
    var hosts: Set<String> = []
    /// A terminal's server's bundle id to its app's (Rex's): the app responsible for a tmux client may be one.
    var hostServers: [String: String] = [:]
    var hostPids: [Int32] = []
    /// The bundle id of the app responsible for each of `hostPids`, as found ("" for none); found again when they change.
    var clientAppOf: [Int32: String] = [:]
    /// Kiko's window counts as in front in its terminal (`kiko`'s rule: drawn in Rex's tab shown, else its tmux client focused); nil: not known.
    var kikoFocused: Bool?
    /// Who sent the last update: gone, the overlay goes too. Its log lines go to it.
    var owner: ObjectIdentifier?
    weak var ownerClient: Client?
    /// The last decision logged (shown or hidden, and why), so each is said once.
    var lastSaid = ""
    var expiry: DispatchWorkItem?
    var barTimer: Timer?
    /// The waveform's box for the state shown (overlayLayout): the bars' timer reads it, and the
    /// state and level, each time; it never keeps a box of its own.
    var waveform: CGRect = .zero
    /// The state, words and session last laid out, and the state the panel was last placed for: an
    /// update that changes neither (the mic's level only) moves nothing.
    var laidOut = ""
    var placedState = ""
    var wanted = false

    init() {
        panel = OverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 44), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        // Floating first: setting it puts the level back to .floating.
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        // The app runs hidden (`open -j`): a window that hides with it is never drawn.
        panel.canHide = false
        panel.alphaValue = 0
        pill.wantsLayer = true
        let layer = pill.layer!
        layer.backgroundColor = NSColor(srgbRed: 12 / 255, green: 12 / 255, blue: 16 / 255, alpha: 0.94).cgColor
        layer.borderWidth = 1
        layer.borderColor = NSColor(white: 1, alpha: 0.08).cgColor
        layer.masksToBounds = true
        panel.contentView = pill
        halo.backgroundColor = overlayAccent.withAlphaComponent(0.22).cgColor
        halo.cornerRadius = 7
        dot.backgroundColor = overlayAccent.cgColor
        dot.cornerRadius = 3
        layer.addSublayer(halo)
        layer.addSublayer(dot)
        for _ in 0..<overlayBarCount {
            let bar = CALayer()
            bar.cornerRadius = 1.5
            // Only a bar's height animates: never where it is, nor its colour or showing as the state changes.
            bar.actions = ["position": NSNull(), "backgroundColor": NSNull(), "hidden": NSNull()]
            layer.addSublayer(bar)
            bars.append(bar)
        }
        label.maximumNumberOfLines = 1
        label.drawsBackground = false
        label.isBezeled = false
        label.isEditable = false
        label.isSelectable = false
        pill.addSubview(label)
        // Another app to the front: shown or hidden by whether it's Kiko's terminal.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) {
            [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    /// A line for `kiko`'s log (to the client that sent the last update) and the unified log.
    func note(_ event: String, _ fields: [String: Any]) {
        NSLog("\(appName) overlay: \(event) \(json(fields))")
        var line = fields
        line["op"] = "log"
        line["event"] = event
        ownerClient?.send(line)
    }

    func update(_ obj: [String: Any], from c: Client) {
        owner = ObjectIdentifier(c)
        ownerClient = c
        let was = state
        state = obj["state"] as? String ?? "idle"
        text = obj["text"] as? String ?? ""
        session = obj["session"] as? String ?? ""
        level = (obj["level"] as? NSNumber)?.doubleValue ?? 0
        if let h = obj["hosts"] as? [Any] { hosts = Set(h.compactMap { $0 as? String }.filter { !$0.isEmpty }) }
        if let s = obj["hostServers"] as? [String: Any] { hostServers = s.compactMapValues { $0 as? String } }
        if let p = obj["hostPids"] as? [Any] {
            let pids = p.compactMap { ($0 as? NSNumber)?.int32Value }.filter { $0 > 1 }
            if pids != hostPids { clientAppOf = [:] }
            hostPids = pids
        }
        if obj.keys.contains("kikoFocused") { kikoFocused = obj["kikoFocused"] as? Bool }
        if state != was {
            note("overlay_app_got", ["state": state, "was": was, "mainThread": Thread.isMainThread, "appHidden": NSApp.isHidden])
        }
        expiry?.cancel()
        expiry = nil
        let lasts: Double? = state == "sent" ? 1.2 : state == "needs" ? 5 : nil
        if let seconds = lasts {
            let item = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.state = "idle"
                    self.refresh()
                }
            }
            expiry = item
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
        }
        refresh()
    }

    /// Its client gone (`kiko` quit or crashed): nothing it said stays up.
    func gone(_ c: Client) {
        guard owner == ObjectIdentifier(c) else { return }
        owner = nil
        ownerClient = nil
        state = "idle"
        refresh()
    }

    /// The bundle id of the app responsible for process `p` ("" when there's none): a registered app's
    /// own, else the innermost .app its executable is in (a background app macOS doesn't list as
    /// running, as Rex's server is).
    func appOf(_ p: Int32) -> String {
        if let known = clientAppOf[p] { return known }
        let r = responsibleFn?(p) ?? p
        var id = NSRunningApplication(processIdentifier: r)?.bundleIdentifier ?? ""
        if id.isEmpty {
            var buf = [CChar](repeating: 0, count: 4096)
            if proc_pidpath(r, &buf, UInt32(buf.count)) > 0 {
                var url = URL(fileURLWithPath: String(cString: buf))
                while url.path != "/" && id.isEmpty {
                    if url.pathExtension == "app" { id = Bundle(url: url)?.bundleIdentifier ?? "" }
                    url.deleteLastPathComponent()
                }
            }
        }
        clientAppOf[p] = id
        return id
    }

    /// The apps responsible for the tmux clients showing Kiko's window (`hostPids`), by bundle id.
    func clientApps() -> [String] { hostPids.map { appOf($0) }.filter { !$0.isEmpty } }

    /// Whether the frontmost app is the terminal Kiko's window is in (`terminalMatches`; or a client's own process, or the one responsible for it, is that app).
    func terminalInFront(_ front: NSRunningApplication?) -> Bool {
        guard let front else { return false }
        let pid = front.processIdentifier
        for p in hostPids where p == pid || (responsibleFn?(p) ?? p) == pid { return true }
        return terminalMatches(front: front.bundleIdentifier, hosts: hosts, clientApps: clientApps(), servers: hostServers)
    }

    /// Kiko's own window is in front (it shows what's happening itself): `kikoFocused` (drawn in the
    /// tab shown in Rex; its tmux client focused elsewhere) and its terminal is the frontmost app.
    func kikoInFront(_ front: NSRunningApplication?) -> Bool {
        kikoFocused == true && terminalInFront(front)
    }

    func refresh() {
        let front = NSWorkspace.shared.frontmostApplication
        let kikoFront = state != "idle" && kikoInFront(front)
        let show = state != "idle" && !kikoFront
        let why = state == "idle" ? "idle" : kikoFront ? "kiko in front" : "another window in front"
        let said = "\(show) \(why) \(front?.bundleIdentifier ?? "")"
        if said != lastSaid {
            lastSaid = said
            note(
                show ? "overlay_app_shown" : "overlay_app_hidden",
                [
                    "state": state, "why": why, "front": front?.bundleIdentifier ?? "", "frontPid": Int(front?.processIdentifier ?? 0),
                    "hosts": Array(hosts).sorted(), "hostPids": hostPids.map { Int($0) }, "kikoFocused": kikoFocused.map { $0 as Any } ?? NSNull(),
                    "clientApps": state == "idle" ? [] : clientApps(), "hostServers": hostServers,
                    "terminalInFront": state == "idle" ? false : terminalInFront(front), "appHidden": NSApp.isHidden,
                ])
        }
        if show {
            layout()
            if !wanted || !panel.isVisible {
                wanted = true
                panel.orderFrontRegardless()
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = 0.15
                    panel.animator().alphaValue = 1
                }
                // A moment later, as macOS has it: on screen or not.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                    MainActor.assumeIsolated {
                        guard let self, self.wanted else { return }
                        self.note(
                            "overlay_app_panel",
                            [
                                "visible": self.panel.isVisible, "onScreen": self.panel.occlusionState.contains(.visible),
                                "level": self.panel.level.rawValue, "windowNumber": self.panel.windowNumber, "frame": NSStringFromRect(self.panel.frame),
                            ])
                    }
                }
            }
        } else if wanted {
            wanted = false
            stopBars()
            NSAnimationContext.runAnimationGroup(
                { ctx in
                    ctx.duration = 0.35
                    panel.animator().alphaValue = 0
                },
                completionHandler: { [weak self] in
                    MainActor.assumeIsolated {
                        guard let self, !self.wanted else { return }
                        self.panel.orderOut(nil)
                    }
                })
        }
    }

    func attributed(_ parts: [(String, NSColor, NSFont.Weight, CGFloat)], head: Bool) -> NSAttributedString {
        let para = NSMutableParagraphStyle()
        para.lineBreakMode = head ? .byTruncatingHead : .byTruncatingTail
        let out = NSMutableAttributedString()
        for (s, color, weight, size) in parts {
            out.append(
                NSAttributedString(
                    string: s, attributes: [.foregroundColor: color, .font: NSFont.systemFont(ofSize: size, weight: weight), .paragraphStyle: para]))
        }
        return out
    }

    /// The pill drawn for `state` (overlayLayout: the mark and the waveform where the state puts
    /// them, whatever the words), placed on the screen with the mouse (place).
    func layout() {
        // A level-only update, the same words already on screen: the bars' timer reads the level; nothing else is touched.
        let key = "\(state)\u{1}\(text)\u{1}\(session)"
        if key == laidOut && wanted && panel.isVisible { return }
        laidOut = key
        let listening = state == "listening" || state == "deciding"
        let sent = state == "sent"
        let needs = state == "needs"
        let speaking = state == "speaking"
        let words: NSAttributedString
        if listening {
            let said = text.trimmingCharacters(in: .whitespaces)
            if said.isEmpty {
                words = attributed([("Listening…", overlayDim, .medium, 15)], head: true)
            } else if let space = said.lastIndex(of: " ") {
                // The newest word dimmer: it may still change.
                let last = state == "listening" ? overlayDim : overlayInk
                words = attributed([(String(said[..<space]), overlayInk, .medium, 15), (String(said[space...]), last, .medium, 15)], head: true)
            } else {
                words = attributed([(said, overlayInk, .medium, 15)], head: true)
            }
        } else if sent {
            words = attributed([("Sent to ", overlayQuiet, .regular, 14), (session, overlayInk, .semibold, 14)], head: false)
        } else if speaking {
            // As your own words are: what Kiko has said so far (`kiko` sends more as it's heard), cut
            // at the head, so the newest words stay in view; who's speaking first, until they push it out.
            let said = text.trimmingCharacters(in: .whitespaces)
            words = attributed(
                [(session, overlayInk, .semibold, 15), (said.isEmpty ? "" : " · ", overlayQuiet, .regular, 15), (said, overlayInk, .medium, 15)], head: true)
        } else {
            words = attributed(
                [(session, overlayInk, .semibold, 15), (" \(text)", overlayQuiet, .regular, 15), ("   say yes or no", overlayDim, .regular, 12)], head: false)
        }
        label.attributedStringValue = words
        let fit = label.fittingSize
        let l = overlayLayout(state: state, words: CGSize(width: ceil(fit.width), height: ceil(fit.height)))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        dot.isHidden = l.mark == nil
        halo.isHidden = !(l.mark != nil && (listening || needs))
        if let mark = l.mark {
            dot.frame = mark
            halo.frame = mark.insetBy(dx: -4, dy: -4)
        }
        for bar in bars { bar.isHidden = l.waveform == nil }
        // The words in their own box, cut short with an ellipsis: they never push the mark or the bars.
        label.frame = l.words
        pill.layer?.cornerRadius = min(22, l.size.height / 2)
        pill.layer?.borderColor = needs ? overlayAccent.withAlphaComponent(0.35).cgColor : NSColor(white: 1, alpha: 0.08).cgColor
        CATransaction.commit()
        if let box = l.waveform { startBars(in: box, color: speaking ? overlayInk : overlayAccent, still: state == "deciding") } else { stopBars() }
        if listening || needs {
            if halo.animation(forKey: "pulse") == nil {
                let pulse = CABasicAnimation(keyPath: "opacity")
                pulse.fromValue = 1
                pulse.toValue = 0.2
                pulse.duration = 0.7
                pulse.autoreverses = true
                pulse.repeatCount = .infinity
                halo.add(pulse, forKey: "pulse")
            }
        } else {
            halo.removeAnimation(forKey: "pulse")
        }
        place(l.size)
    }

    /// The panel on the screen with the mouse, at the top centre under the notch (or the menu bar):
    /// placed as it comes up, as its state changes or as its size does; never for new words or a new level.
    func place(_ size: CGSize) {
        if wanted && panel.isVisible && state == placedState && panel.frame.size == size { return }
        placedState = state
        let mouse = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main ?? NSScreen.screens.first else { return }
        let top = max(screen.safeAreaInsets.top, screen.frame.maxY - screen.visibleFrame.maxY)
        let frame = NSRect(x: screen.frame.midX - size.width / 2, y: screen.frame.maxY - top - 8 - size.height, width: size.width, height: size.height)
        if frame != panel.frame { panel.setFrame(frame, display: true) }
    }

    /// The bars in `box`, in `color`, at once (never sliding there from where the last state had
    /// them), then their heights every 0.12 s (none while `still`).
    func startBars(in box: CGRect, color: NSColor, still: Bool) {
        waveform = box
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (i, bar) in bars.enumerated() {
            bar.frame = overlayBar(i, in: box, height: bar.bounds.height)
            bar.backgroundColor = color.cgColor
        }
        CATransaction.commit()
        drawBars()
        if still {
            barTimer?.invalidate()
            barTimer = nil
        } else if barTimer == nil {
            // What it draws is read each time (drawBars): a timer started in one state draws the next one's bars, where they now are.
            barTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.drawBars() } }
        }
    }

    /// The bars' heights for the state and the level now (listening, the mic's; speaking, Kiko's
    /// sound's as it plays: the level, with a little life of its own; deciding: still), centred in
    /// the waveform's box: only the heights change, and only they animate.
    func drawBars() {
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.12)
        for (i, bar) in bars.enumerated() {
            let height = overlayBarHeight(state: state, level: level, index: i, jitter: Double.random(in: 0.55...1.0))
            bar.bounds = CGRect(origin: .zero, size: overlayBar(i, in: waveform, height: height).size)
        }
        CATransaction.commit()
    }

    func stopBars() {
        barTimer?.invalidate()
        barTimer = nil
    }
}

/// Made on the main thread the first time `kiko` sends an update: never for a client that doesn't.
nonisolated(unsafe) var overlay: Overlay?

func overlayUpdate(_ obj: [String: Any], from c: Client) {
    DispatchQueue.main.async {
        if overlay == nil { overlay = Overlay() }
        overlay?.update(obj, from: c)
    }
}

func overlayGone(_ c: Client) {
    DispatchQueue.main.async { overlay?.gone(c) }
}

// ── The app ─────────────────────────────────────────────────────────────────

/// Brought to the front (Finder, Spotlight, macOS's "Reopen": the app comes to the front, which
/// `open -g -j` never makes it do): says it works from the terminal, but only when no `kiko` of its
/// flavour is about (whenActive), after a moment for one to connect; then goes on as before.
final class Delegate: NSObject, NSApplicationDelegate {
    var deciding = false
    func applicationDidBecomeActive(_ notification: Notification) {
        guard !deciding else { return }
        deciding = true
        DispatchQueue.global().async {
            let now = { (waited: Bool) -> Decision in
                let running = kikoRunning()
                return locked { whenActive(clients: clients.count, children: children.count, kikoRunning: running, waited: waited) }
            }
            var decision = now(false)
            // A moment for `kiko` to connect: it starts its helpers again within a second or two of the app going away.
            let until = Date().addingTimeInterval(3)
            while decision == .wait && Date() < until {
                usleep(250_000)
                decision = now(false)
            }
            if decision == .wait { decision = now(true) }
            DispatchQueue.main.async {
                defer { self.deciding = false }
                guard decision == .tell else {
                    locked { keptQuiet += 1 }
                    NSApp.hide(nil)
                    return
                }
                locked { told += 1 }
                let alert = NSAlert()
                alert.messageText = "\(appName) works from the terminal"
                alert.informativeText =
                    "Open a terminal and run \(command.isEmpty ? "it" : "“\(command)”"). This app holds \(appName)'s permissions (the microphone and the talk key's Input Monitoring) and runs in the background while \(appName) does."
                alert.addButton(withTitle: "OK")
                alert.runModal()
                NSApp.hide(nil)
            }
        }
    }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
