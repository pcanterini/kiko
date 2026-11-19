// Push-to-talk microphone for macOS (a Core Audio HAL input unit: Capture below).
// stdin lines: "start" opens the mic, "stop" closes it, so the menu-bar mic indicator
// only shows while the key is held. "device <uid>\t<name>" picks the input device from the next
// start on (by its Core Audio UID, else by name: a USB mic's UID can change with the port);
// "device" alone goes back to the system default. Open meanwhile, it moves to it at once.
// "device" is sent as the app starts too, whatever the choice: nothing is held before it.
// A Bluetooth mic in use, chosen or the system default, is held open while it's the one in use (the
// hold, below): "start" and "stop" then only say what's sent on, and the mic indicator stays on.
// stdout: raw 16-bit little-endian mono PCM at 16 kHz while open.
// stderr: status lines: "ready", "started <ms from the start command to the first audio>" (for a
// Bluetooth mic, to its first sound that isn't exact zeros: Press below), "stopped", or errors. Also
// "devices <json>": the input devices, at startup and whenever they
// change; and "using <json>" as it opens a device: which one, and whether it fell back to the system
// default because the chosen one isn't there ("switched" when it moved while open; "fresh" and
// "setupMs" when it set the device up anew rather than reusing the last press's: fresh below; "held"
// when it's the mic held open, with "live": its link is up; "noLink" when the mic that would be used
// is listed but gave no link, and another stands in). And for the hold: "hold <json>" as it
// begins ({"on": true, uid, name, why; "default" when it's held as the system default, not as a mic
// you chose; "retry" when it's tried again after giving no link}), as its link comes up ({…, "live": true, "ms": how long that
// took, "outRate": the headset's output rate then}) and as it ends ({"on": false, …, why: "another
// mic chosen" | "default changed" | "chosen mic back" | "disconnected" | "no link" (it gave no sound:
// another mic stands in until something changes) | "cannot open" | "quit"}); and "hold_lost <json>"
// when something changed under it ({what: "format" | "output format" | "silent" | "stalled", uid, name, wasLive, …}).
// `mic --list` prints the input devices as JSON on stdout and exits, without opening anything.
// `mic --choose <json>` (tests) prints which device choose would take, given the devices and the
// choice as JSON ({"devices": [{uid, name, transport, isDefault}], "wanted": {uid, name} | null}),
// without asking Core Audio anything, and which one it would hold open ("hold": its UID, or null;
// "away": true in what's given when the one it would use is listed but gave no link).
// `mic --fresh <json>` (tests) likewise prints why fresh would set a device up anew ({"had":
// {device, rate, channels} | null, "now": {device, rate, channels}}), and `mic --started <json>`
// (tests) which of a press's buffers "started" is said at and which are sent on ({"waits": true for a
// Bluetooth mic, "buffers": [[samples]]}). `mic --link <json>` (tests) prints what's done about a held
// mic whose link isn't up ({"waitedMs", "kicked", "lost", "retry", "gaveUps"}: linkStep, pressWaits
// and retryAfterMs).
import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation
import os

let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
let stdout = FileHandle.standardOutput

func status(_ line: String) {
    FileHandle.standardError.write("\(line)\n".data(using: .utf8)!)
}

func json(_ value: Any) -> String {
    String(decoding: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
}

// ── Input devices (Core Audio) ──────────────────────────────────────────────

struct Device {
    let id: AudioDeviceID
    let uid: String
    let name: String
    /// How it's connected, as transportName says it: "built-in", "bluetooth", "usb"…
    let transport: String
}

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var where_ = address(selector)
    var value: Unmanaged<CFString>? = nil
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &where_, 0, nil, &size, &value) == noErr, let value else { return nil }
    return value.takeRetainedValue() as String
}

/// A device's channels on one side (`scope`: its input or its output).
func channels(_ id: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Int {
    var where_ = address(kAudioDevicePropertyStreamConfiguration, scope)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &where_, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &where_, 0, nil, &size, raw) == noErr else { return 0 }
    let buffers = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return buffers.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func inputChannels(_ id: AudioDeviceID) -> Int {
    channels(id, kAudioDevicePropertyScopeInput)
}

/// How a device is connected, by its Core Audio transport type: "built-in" and "bluetooth" (Classic and
/// LE alike) are the ones choose acts on; the rest are named for the log.
func transportName(_ id: AudioDeviceID) -> String {
    var where_ = address(kAudioDevicePropertyTransportType)
    var type: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyData(id, &where_, 0, nil, &size, &type) == noErr else { return "unknown" }
    switch type {
    case kAudioDeviceTransportTypeBuiltIn: return "built-in"
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
    case kAudioDeviceTransportTypeUSB: return "usb"
    case kAudioDeviceTransportTypeVirtual: return "virtual"
    case kAudioDeviceTransportTypeAggregate, kAudioDeviceTransportTypeAutoAggregate: return "aggregate"
    default: return "other"
    }
}

func isHidden(_ id: AudioDeviceID) -> Bool {
    var where_ = address(kAudioDevicePropertyIsHidden)
    var hidden: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(id, &where_, 0, nil, &size, &hidden) == noErr && hidden != 0
}

/// Every device Core Audio has, by its id.
func allDevices() -> [AudioDeviceID] {
    let system = AudioObjectID(kAudioObjectSystemObject)
    var where_ = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &where_, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(system, &where_, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

/// Every device with input channels that macOS shows, in its order.
func inputDevices() -> [Device] {
    allDevices().compactMap { id in
        guard inputChannels(id) > 0, !isHidden(id), let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) else { return nil }
        return Device(id: id, uid: uid, name: stringProperty(id, kAudioObjectPropertyName) ?? uid, transport: transportName(id))
    }
}

func defaultInput() -> AudioDeviceID {
    var where_ = address(kAudioHardwarePropertyDefaultInputDevice)
    var id: AudioDeviceID = 0
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &where_, 0, nil, &size, &id)
    return id
}

func describe(_ devices: [Device]) -> [[String: Any]] {
    let fallback = defaultInput()
    return devices.map { ["uid": $0.uid, "name": $0.name, "isDefault": $0.id == fallback, "transport": $0.transport] }
}

/// The chosen device (`wanted`), by UID then name, if it's there.
func find(_ devices: [Device], _ wanted: (uid: String, name: String)?) -> Device? {
    guard let wanted else { return nil }
    return devices.first(where: { $0.uid == wanted.uid }) ?? devices.first(where: { !wanted.name.isEmpty && $0.name == wanted.name })
}

/**
 * Which device to open: the chosen one (`wanted`, by UID then name) if it's there, else the system
 * default (`fallback` when one was chosen): whatever macOS has as its default input, a Bluetooth
 * headset's mic included, followed as macOS moves it (since 2026-11-14: macOS's default, with
 * nothing custom; from 2026-11-12 until then the built-in mic stood in for a Bluetooth default). Opening a Bluetooth headset's mic moves
 * it from A2DP to HFP, the call profile: one to several seconds before any audio, and what it plays
 * drops to low-quality mono (2026-11-12: six presses of seven on AirPods heard nothing, a video
 * playing on them), which is what the hold is for (held): the link is up before the press. A mic
 * that's listed but gave no link (`away`: out of your ears, or with the iPhone, which leaves it
 * listed here) counts as not there, chosen or the default: the system default stands in if that's
 * another device, else the built-in mic; with no other mic, it's opened all the same. Pure, for
 * `--choose`; src/core/mic-device.ts resolveMic decides the same way for the settings and the log
 * (told `away` by the hold's lines).
 */
func choose(_ devices: [Device], defaultID: AudioDeviceID, wanted: (uid: String, name: String)?, away: AudioDeviceID? = nil) -> (device: Device?, fallback: Bool) {
    let chosen = find(devices, wanted)
    let fallback = devices.first { $0.id == defaultID }
    let builtIn = away == nil ? nil : devices.first { $0.transport == "built-in" }
    let device = [chosen, fallback, builtIn].compactMap { $0 }.first { $0.id != away } ?? chosen ?? fallback
    return (device, wanted != nil && (chosen == nil || device?.id != chosen?.id))
}

/**
 * The mic to hold open between presses, or nil: the one in use (choose), while it's a Bluetooth one
 * (2026-11-13 for one you chose; 2026-11-14 for the system default too, now that it's used as macOS
 * has it: without the hold a cold open drops presses). Its unit then runs all along, so the headset
 * stays in its call profile and a press switches nothing. Measured on AirPods Pro 2: a cold open
 * took 1.6 to 3 s to give any sound (two of twelve gave none in 2.6 s), and what they played changed
 * profile at every press and again ~2 s after it; held open for 60 s, no gap and no switch, and a
 * press was heard in the next buffer. What they play stays call-quality meanwhile: the price of
 * using their mic, said in the setting (the Mac's own mic can be picked instead). Never a mic that
 * isn't Bluetooth (it opens in ~50 ms). Decided here, not by the app: the helper sees the device and
 * the default come and go first, and one started again holds as soon as it's told the choice. Not
 * one that gave no link (`away`): holding it open does nothing for you, and keeps a mic open on a
 * headset that's elsewhere. Pure, for `--choose`; src/core/mic-device.ts heldMic says the same for
 * the settings.
 */
func held(_ devices: [Device], defaultID: AudioDeviceID, wanted: (uid: String, name: String)?, away: AudioDeviceID? = nil) -> Device? {
    guard let device = choose(devices, defaultID: defaultID, wanted: wanted, away: away).device, device.transport == "bluetooth", device.id != away else { return nil }
    return device
}

/**
 * What's done about a held mic whose link isn't up, `waitedMs` after it was last asked for (the
 * unit started, started again, or the link lost): wait; past linkWaitMs, ask once more (the unit
 * stopped and started: `kicked` says that's been done); past it again, give up: the hold ends and the
 * mic counts as away. A cold open took 1.6 to 3 s on AirPods Pro 2, so 5 s is no link, not a slow one.
 * Giving up is what keeps a press working when the AirPods are listed but not here (2026-11-13: held
 * while they were out of the ears, the link never came, macOS moved its default devices to the
 * built-in ones 1.6 s later, and every press would have waited on zeros). Pure, for `--link`.
 */
let linkWaitMs: UInt64 = 5000
func linkStep(waitedMs: UInt64, kicked: Bool) -> String {
    if waitedMs < linkWaitMs { return "wait" }
    return kicked ? "give up" : "kick"
}

/**
 * Whether a press on a held mic whose link isn't up waits for it ("connecting to AirPods…", then
 * heard from its first sound): only while it's coming up for the first time since it was chosen or
 * connected. One that was up and went (`lost`), or that's being tried again after it gave no link
 * (`retry`), isn't waited for: the press takes another mic at once (choose). Pure, for `--link`.
 */
func pressWaits(lost: Bool, retry: Bool) -> Bool {
    !lost && !retry
}

/**
 * How long after a mic was given up on before it may be tried again: 30 s, doubled for each time in
 * a row it gave no link (up to 8 min). Trying means opening its mic, which a headset in someone's
 * ears on another device may hear as a switch; and should opening it ever move the Mac's defaults,
 * and closing it move them back, the tries can't feed themselves. Pure, for `--link`.
 */
func retryAfterMs(gaveUps: Int) -> UInt64 {
    30000 << UInt64(min(max(gaveUps, 1), 5) - 1)
}

/// What a capture unit was set up for: its device, and that device's input rate and channels then.
struct Setup {
    let device: AudioDeviceID
    let rate: Double
    let channels: Int
}

/**
 * Why the unit set up for `had` can't take a press on `now` and is made again ("first", "device",
 * "format"), or nil: it's kept, warm (2026-11-13). Only its own device counts: before, any device
 * listed again or any engine change (AirPods switching profile among them) marked it stale, and the
 * next press built it anew, which opened the AirPods again: a loop. Pure, for `--fresh`.
 */
func fresh(had: Setup?, now: Setup) -> String? {
    guard let had else { return "first" }
    if had.device != now.device { return "device" }
    if had.rate != now.rate || had.channels != now.channels { return "format" }
    return nil
}

/// Whether any sample is something other than an exact zero.
func sounds(_ samples: UnsafeBufferPointer<Float>) -> Bool {
    samples.contains { $0 != 0 }
}

/**
 * A press's first sound (2026-11-13). A Bluetooth mic's unit gives buffers from its first cycle, but
 * they're exact zeros until the headset's call link is up (measured: buffers from 60 to 95 ms, sound
 * from 1.6 to 3 s). So for one (`waits`), "started" is said at the first buffer with a sample that
 * isn't zero, and the zeros before it aren't sent on: the app takes any audio for a live mic, and its
 * "connecting to …" and "didn't start in time" go by that. Any other mic starts at its first buffer,
 * zeros or not (a mic muted at its own switch gives zeros for good, and isn't "connecting"). Pure,
 * for `--started`.
 */
struct Press {
    let waits: Bool
    var started = false

    /// One buffer heard (`sound`: not all zeros): whether "started" is said at it, and whether it's sent on.
    mutating func take(sound: Bool) -> (first: Bool, send: Bool) {
        if started { return (false, true) }
        if waits && !sound { return (false, false) }
        started = true
        return (true, true)
    }
}

if let at = CommandLine.arguments.firstIndex(of: "--fresh") {
    let given = at + 1 < CommandLine.arguments.count ? CommandLine.arguments[at + 1] : "{}"
    let root = (try? JSONSerialization.jsonObject(with: Data(given.utf8))) as? [String: Any] ?? [:]
    let setup = { (d: [String: Any]?) in
        d.map { Setup(device: AudioDeviceID(($0["device"] as? Int) ?? 0), rate: ($0["rate"] as? Double) ?? 0, channels: ($0["channels"] as? Int) ?? 0) }
    }
    let why = fresh(had: setup(root["had"] as? [String: Any]), now: setup(root["now"] as? [String: Any]) ?? Setup(device: 0, rate: 0, channels: 0))
    print(json(["fresh": why.map { $0 as Any } ?? NSNull()]))
    exit(0)
}

if let at = CommandLine.arguments.firstIndex(of: "--choose") {
    let given = at + 1 < CommandLine.arguments.count ? CommandLine.arguments[at + 1] : "{}"
    let root = (try? JSONSerialization.jsonObject(with: Data(given.utf8))) as? [String: Any] ?? [:]
    let listed = root["devices"] as? [[String: Any]] ?? []
    // Their ids: their place in the list, from 1 (0 is no device).
    let devices = listed.enumerated().map { i, d in
        Device(id: AudioDeviceID(i + 1), uid: d["uid"] as? String ?? "", name: d["name"] as? String ?? "", transport: d["transport"] as? String ?? "")
    }
    let defaultID = listed.firstIndex { $0["isDefault"] as? Bool == true }.map { AudioDeviceID($0 + 1) } ?? 0
    let wanted = (root["wanted"] as? [String: Any]).map { (uid: $0["uid"] as? String ?? "", name: $0["name"] as? String ?? "") }
    // "away": the one it would use (the chosen one, else the default), listed, gave no link.
    let away = root["away"] as? Bool == true ? choose(devices, defaultID: defaultID, wanted: wanted).device?.id : nil
    let (device, fallback) = choose(devices, defaultID: defaultID, wanted: wanted, away: away)
    var out: [String: Any] = ["uid": device?.uid ?? "", "fallback": fallback]
    out["hold"] = held(devices, defaultID: defaultID, wanted: wanted, away: away).map { $0.uid as Any } ?? NSNull()
    print(json(out))
    exit(0)
}

if let at = CommandLine.arguments.firstIndex(of: "--link") {
    let given = at + 1 < CommandLine.arguments.count ? CommandLine.arguments[at + 1] : "{}"
    let root = (try? JSONSerialization.jsonObject(with: Data(given.utf8))) as? [String: Any] ?? [:]
    let step = linkStep(waitedMs: UInt64((root["waitedMs"] as? Int) ?? 0), kicked: root["kicked"] as? Bool == true)
    let wait = retryAfterMs(gaveUps: (root["gaveUps"] as? Int) ?? 1)
    print(json(["step": step, "pressWaits": pressWaits(lost: root["lost"] as? Bool == true, retry: root["retry"] as? Bool == true), "retryAfterMs": wait]))
    exit(0)
}

if let at = CommandLine.arguments.firstIndex(of: "--started") {
    let given = at + 1 < CommandLine.arguments.count ? CommandLine.arguments[at + 1] : "{}"
    let root = (try? JSONSerialization.jsonObject(with: Data(given.utf8))) as? [String: Any] ?? [:]
    let buffers = (root["buffers"] as? [[Any]] ?? []).map { $0.map { Float(($0 as? NSNumber)?.doubleValue ?? 0) } }
    var press = Press(waits: root["waits"] as? Bool == true)
    var started: Int? = nil
    var sent: [Int] = []
    for (i, samples) in buffers.enumerated() {
        let (first, send) = press.take(sound: samples.withUnsafeBufferPointer(sounds))
        if first { started = i }
        if send { sent.append(i) }
    }
    print(json(["started": started.map { $0 as Any } ?? NSNull(), "sent": sent]))
    exit(0)
}

if CommandLine.arguments.contains("--list") {
    print(json(describe(inputDevices())))
    exit(0)
}

// ── Capture ─────────────────────────────────────────────────────────────────
// A HAL input unit (AUHAL) made by hand: input on, output off, set to its device before it's
// initialized, so no other device is ever opened (2026-11-13). AVAudioEngine's input node opened the
// system default input first and was moved to the chosen device after: with AirPods the default,
// that woke their mic, switching them to the call profile and back at every press, 1.4 to 2 s before
// the built-in mic gave any sound (measured: their input went 24 → 48 kHz, their volume read the
// other profile's), and ducking then took the other profile's volume for yours. The unit is kept,
// stopped, between presses and made again only when its device or that device's format changed.
//
// The hold (2026-11-13): for a Bluetooth mic in use (held, above: one you chose, or the system
// default since 2026-11-14) the unit isn't stopped between presses. It runs from when it becomes the
// mic in use (chosen, connected, made the default) until it no longer is (another chosen, the
// default moved, disconnected) or the helper ends, so the headset stays in its call profile and
// "start" finds its link up. One
// that gives no link (listed, but out of your ears or with the iPhone) is given up on after a few
// seconds (linkStep) and counts as away: presses take another mic (choose), and it's tried again when
// the devices or the defaults change, after a sleep, or after a press, never sooner than
// retryAfterMs, and never in a loop of its own.
//
// PRIVACY, not to be loosened: while held, what the mic hears outside a press goes nowhere. The
// I/O callback (heard) renders it into the unit's one scratch buffer, looks only at whether it's all
// exact zeros (the link's state), and zeroes that buffer before it returns: it's never handed to the
// mic queue, never converted, never written to stdout, never kept for the next press (no pre-roll),
// never logged. A press gets what's heard from its "start" (the first buffer rendered after it) to
// its "stop", and nothing from before or after.

// All mic state is touched on this queue only (but Shared, and a Capture's I/O side).
let queue = DispatchQueue(label: "mic")
/// A press is on ("start" until "stop"): what the mic hears is sent on.
nonisolated(unsafe) var open = false
/// A press was asked for ("start") and not ended ("stop"), open or not: one whose mic couldn't be
/// opened (it went as it was asked for) is opened where it should be at the next change (follow).
nonisolated(unsafe) var pressed = false
/// The unit is running: for a press, or for the hold.
nonisolated(unsafe) var unitOn = false
/// When the "start" being answered was read: "started <ms>" counts from there, setup included.
nonisolated(unsafe) var openedAt = DispatchTime.now()
nonisolated(unsafe) var press = Press(waits: false)
/// The chosen device ("device"), by UID then name; nil: the system default.
nonisolated(unsafe) var wanted: (uid: String, name: String)? = nil
/// The unit, set up on the last device opened; nil before the first start or after it failed.
nonisolated(unsafe) var capture: Capture? = nil

/// What the I/O thread reads at each cycle, and the mic queue sets.
struct Shared {
    /// A press is on: the cycle's audio is handed on. Off: it's dropped where it was rendered (PRIVACY, above).
    var open = false
    /// The I/O thread is to tell the link's state again from scratch (the hold began, or was lost).
    var again = false
    /// Cycles so far: standing still, the device isn't calling (the pulse, below).
    var beats: UInt64 = 0
}
let shared = OSAllocatedUnfairLock(initialState: Shared())

/// The mic held open (held): since when its link was asked for, and how it's doing.
struct Hold {
    let device: Device
    let began: DispatchTime
    /// When its link was last asked for: the unit started, or started again.
    var since: DispatchTime
    /// How long the link took to give sound; nil while it hasn't (yet, or since it was lost).
    var liveMs: UInt64? = nil
    /// The headset's output side and its rate once the link was up: going back to its music rate says the link is gone.
    var output: AudioDeviceID = 0
    var outRate: Double = 0
    /// What was lost ("silent", "stalled", "format"), until it's live again.
    var lost: String? = nil
    /// The unit was started again since its link was last up, once (linkStep): the next step is giving up.
    var kicked = false
    /// It's being tried again after it gave no link: a press doesn't wait for it (pressWaits).
    var retry = false
    /// Held as the system default, not as a mic you chose: said in its lines ("default").
    var asDefault = false
}
nonisolated(unsafe) var hold: Hold? = nil
/// The Bluetooth mic that would be used (chosen, or the system default), listed, that gave no link
/// (linkStep) or couldn't be opened: not held and not opened for a press (another stands in: choose)
/// until it's tried again (tryAgain), and since when.
nonisolated(unsafe) var away: (device: AudioDeviceID, at: DispatchTime)? = nil
/// Times in a row it was given up on, since its link was last up or it was chosen (retryAfterMs).
nonisolated(unsafe) var gaveUps = 0
/// A try is due once retryAfterMs is up (a change came sooner).
nonisolated(unsafe) var retryDue = false

/// The device to open now (choose), decided afresh at each start: AirPods come and go. `noLink`: the
/// one it would be gave no link (away), and this one stands in.
func pick() -> (device: Device?, fallback: Bool, noLink: Bool) {
    let devices = inputDevices()
    let defaultID = defaultInput()
    let (device, fallback) = choose(devices, defaultID: defaultID, wanted: wanted, away: away?.device)
    guard let a = away, device?.id != a.device else { return (device, fallback, false) }
    return (device, fallback, choose(devices, defaultID: defaultID, wanted: wanted).device?.id == a.device)
}

func nominalRate(_ id: AudioDeviceID) -> Double {
    var where_ = address(kAudioDevicePropertyNominalSampleRate)
    var rate: Float64 = 0
    var size = UInt32(MemoryLayout<Float64>.size)
    return AudioObjectGetPropertyData(id, &where_, 0, nil, &size, &rate) == noErr ? rate : 0
}

/// `id` as it is now, to set up or to compare with what the unit was set up for.
func setupOf(_ id: AudioDeviceID) -> Setup {
    Setup(device: id, rate: nominalRate(id), channels: inputChannels(id))
}

func since(_ t: DispatchTime) -> UInt64 {
    (DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1_000_000
}

struct MicError: Error, CustomStringConvertible {
    let what: String
    let status: OSStatus
    var description: String { "\(what) (\(status))" }
}

func check(_ status: OSStatus, _ what: String) throws {
    if status != noErr { throw MicError(what: what, status: status) }
}

/// The device's input, pulled on its I/O thread: in a press, handed to the mic queue to convert and
/// send; outside one (the hold), looked at for sound and dropped here (PRIVACY, above).
let heard: AURenderCallback = { refCon, flags, timeStamp, bus, frames, _ in
    let capture = Unmanaged<Capture>.fromOpaque(refCon).takeUnretainedValue()
    let (pressed, again) = shared.withLock { s -> (Bool, Bool) in
        s.beats &+= 1
        let again = s.again
        s.again = false
        return (s.open, again)
    }
    if again { capture.linkUp = false }
    guard pressed else { return capture.discard(flags, timeStamp, bus, frames) }
    guard let buffer = AVAudioPCMBuffer(pcmFormat: capture.inFormat, frameCapacity: frames) else { return noErr }
    buffer.frameLength = frames
    let err = AudioUnitRender(capture.unit, flags, timeStamp, bus, frames, buffer.mutableAudioBufferList)
    guard err == noErr else { return err }
    let sound = capture.hasSound(buffer)
    capture.linkSeen(sound, frames)
    queue.async { capture.take(buffer, sound: sound) }
    return noErr
}

/// A HAL input unit on one device, what it hears converted to outFormat and written to stdout.
final class Capture: @unchecked Sendable {
    let unit: AudioUnit
    let setup: Setup
    let inFormat: AVAudioFormat
    let converter: AVAudioConverter
    /// Whether exact zeros mean its link isn't up yet (Press): a Bluetooth mic.
    let waits: Bool
    /// Where a cycle outside a press is rendered, and zeroed at once (discard). The I/O thread's only.
    private let scratch: AVAudioPCMBuffer
    /// The I/O thread's own: the link gives sound, and the frames of exact zeros since it last did.
    var linkUp = false
    private var quiet: UInt32 = 0

    private init(unit: AudioUnit, setup: Setup, inFormat: AVAudioFormat, converter: AVAudioConverter, scratch: AVAudioPCMBuffer) {
        self.unit = unit
        self.setup = setup
        self.inFormat = inFormat
        self.converter = converter
        self.scratch = scratch
        self.waits = transportName(setup.device) == "bluetooth"
    }

    /// Set up on `setup.device`, stopped. Its device is set before anything opens: the default input is never touched.
    static func make(_ setup: Setup) throws -> Capture {
        var description = AudioComponentDescription(componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_HALOutput, componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
        guard let component = AudioComponentFindNext(nil, &description) else { throw MicError(what: "no HAL unit", status: kAudioUnitErr_InvalidElement) }
        var made: AudioUnit?
        try check(AudioComponentInstanceNew(component, &made), "new unit")
        guard let unit = made else { throw MicError(what: "new unit", status: kAudioUnitErr_Uninitialized) }
        do {
            var on: UInt32 = 1
            var off: UInt32 = 0
            let flag = UInt32(MemoryLayout<UInt32>.size)
            try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &on, flag), "input on")
            try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &off, flag), "output off")
            var device = setup.device
            try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size)), "device")
            // The device's side of the input; the unit converts to our side's layout but not its rate.
            var hardware = AudioStreamBasicDescription()
            var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            try check(AudioUnitGetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &hardware, &size), "format")
            guard hardware.mSampleRate > 0, hardware.mChannelsPerFrame > 0 else { throw MicError(what: "no input format", status: kAudioUnitErr_FormatNotSupported) }
            // At most two channels taken (the first two of a many-channel interface), as a stereo mic gives.
            let channels = min(hardware.mChannelsPerFrame, 2)
            if hardware.mChannelsPerFrame > channels {
                var map = (0..<Int32(channels)).map { $0 }
                try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_ChannelMap, kAudioUnitScope_Output, 1, &map, UInt32(map.count * MemoryLayout<Int32>.size)), "channel map")
            }
            guard let inFormat = AVAudioFormat(standardFormatWithSampleRate: hardware.mSampleRate, channels: channels),
                  let converter = AVAudioConverter(from: inFormat, to: outFormat),
                  let scratch = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: 8192)
            else { throw MicError(what: "no converter", status: kAudioUnitErr_FormatNotSupported) }
            var client = inFormat.streamDescription.pointee
            try check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &client, size), "client format")
            let capture = Capture(unit: unit, setup: setup, inFormat: inFormat, converter: converter, scratch: scratch)
            // Unretained: `capture` (the global) holds it until drop, which stops the unit first.
            var callback = AURenderCallbackStruct(inputProc: heard, inputProcRefCon: Unmanaged.passUnretained(capture).toOpaque())
            try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &callback, UInt32(MemoryLayout<AURenderCallbackStruct>.size)), "callback")
            try check(AudioUnitInitialize(unit), "initialize")
            return capture
        } catch {
            AudioComponentInstanceDispose(unit)
            throw error
        }
    }

    /// Whether `buffer` has any sample that isn't an exact zero.
    func hasSound(_ buffer: AVAudioPCMBuffer) -> Bool {
        guard let data = buffer.floatChannelData else { return false }
        let frames = Int(buffer.frameLength)
        for channel in 0..<Int(buffer.format.channelCount) where sounds(UnsafeBufferPointer(start: data[channel], count: frames)) { return true }
        return false
    }

    /**
     * A cycle outside a press (the hold), on the I/O thread: PRIVACY (above). Rendered into the scratch
     * buffer, since the unit's input has to be pulled to know whether the link is up; looked at for
     * anything but exact zeros; zeroed before returning. Only that one yes or no leaves here.
     */
    func discard(_ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>, _ timeStamp: UnsafePointer<AudioTimeStamp>, _ bus: UInt32, _ frames: UInt32) -> OSStatus {
        guard frames <= scratch.frameCapacity else { return noErr }
        scratch.frameLength = frames
        let err = AudioUnitRender(unit, flags, timeStamp, bus, frames, scratch.mutableAudioBufferList)
        guard err == noErr else { return err }
        let sound = hasSound(scratch)
        if let data = scratch.floatChannelData {
            for channel in 0..<Int(scratch.format.channelCount) { memset(data[channel], 0, Int(frames) * MemoryLayout<Float>.size) }
        }
        linkSeen(sound, frames)
        return noErr
    }

    /// On the I/O thread: the link's state as this cycle shows it, told to the mic queue when it
    /// changes: sound after none, or half a second of exact zeros after sound. Never the audio.
    func linkSeen(_ sound: Bool, _ frames: UInt32) {
        if sound {
            quiet = 0
            if !linkUp {
                linkUp = true
                queue.async { link(self, up: true) }
            }
        } else if linkUp {
            quiet += frames
            if Double(quiet) >= inFormat.sampleRate * 0.5 {
                linkUp = false
                quiet = 0
                queue.async { link(self, up: false) }
            }
        }
    }

    /// One buffer of a press: converted and sent on, while open on this unit.
    func take(_ buffer: AVAudioPCMBuffer, sound: Bool) {
        guard open, capture === self else { return }
        let (first, send) = press.take(sound: sound)
        guard send else { return }
        if first { status("started \(since(openedAt))") }
        let ratio = outFormat.sampleRate / inFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, inputStatus in
            if fed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0 else { return }
        stdout.write(Data(bytes: out.int16ChannelData![0], count: Int(out.frameLength) * 2))
    }

    func dispose() {
        AudioOutputUnitStop(unit)
        AudioUnitUninitialize(unit)
        AudioComponentInstanceDispose(unit)
    }
}

// The unit's own device, watched: its rate or channels changing, or it going away. The rest of the
// system's devices aren't the unit's business (AirPods switching profile, say).
typealias Watched = (device: AudioDeviceID, address: AudioObjectPropertyAddress, block: AudioObjectPropertyListenerBlock)
nonisolated(unsafe) var watched: [Watched] = []
// The held headset's output side, watched for its rate (Hold.outRate).
nonisolated(unsafe) var watchedOutput: [Watched] = []

func listen(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, _ block: @escaping AudioObjectPropertyListenerBlock) -> Watched? {
    var where_ = address(selector, scope)
    return AudioObjectAddPropertyListenerBlock(device, &where_, queue, block) == noErr ? (device, where_, block) : nil
}

func unlisten(_ list: [Watched]) {
    for w in list {
        var where_ = w.address
        AudioObjectRemovePropertyListenerBlock(w.device, &where_, queue, w.block)
    }
}

func watch(_ device: AudioDeviceID) {
    let what = [(kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal), (kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeInput), (kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal)]
    for (selector, scope) in what {
        if let w = listen(device, selector, scope, { _, _ in deviceChanged() }) { watched.append(w) }
    }
}

func unwatch() {
    unlisten(watched)
    watched = []
}

/// The unit taken down: the next start makes another.
func drop() {
    guard let old = capture else { return }
    unwatch()
    old.dispose()
    capture = nil
    unitOn = false
}

/**
 * The unit set up on `device` as it is now: made anew when fresh says so (why, and how long it
 * took), else kept (nil). One that can't be made: said, and for a press (`orDefault`) another is
 * set up instead: the system default, or the built-in mic when the default is the one that can't be.
 */
func prepare(_ device: Device, orDefault: Bool) -> (why: String, ms: UInt64)? {
    let now = setupOf(device.id)
    guard let why = fresh(had: capture?.setup, now: now) else { return nil }
    let began = DispatchTime.now()
    if why == "format", let had = capture?.setup, hold?.device.id == device.id {
        lost("format", ["from": "\(Int(had.rate)) Hz, \(had.channels) ch", "to": "\(Int(now.rate)) Hz, \(now.channels) ch"])
    }
    drop()
    do {
        capture = try Capture.make(now)
    } catch {
        status("error: cannot use \(device.name) (\(error))\(orDefault ? ", using another mic" : "")")
        let others = [defaultInput()] + inputDevices().filter { $0.transport == "built-in" }.map { $0.id }
        if orDefault, let other = others.first(where: { $0 != 0 && $0 != device.id }) { capture = try? Capture.make(setupOf(other)) }
    }
    if let capture { watch(capture.setup.device) }
    return (why, since(began))
}

/// The unit running (it may be already: the hold). False when it couldn't start: dropped, made again at the next start.
func run() -> Bool {
    guard let capture else { return false }
    if unitOn { return true }
    do {
        try check(AudioOutputUnitStart(capture.unit), "start")
        unitOn = true
        return true
    } catch {
        // Made again at the next start: it may be what failed.
        drop()
        status("error: cannot start microphone: \(error)")
        return false
    }
}

func halt() {
    guard unitOn, let capture else { return }
    AudioOutputUnitStop(capture.unit)
    unitOn = false
}

func start(at asked: DispatchTime = .now(), switched: Bool = false) {
    guard !open else { return }
    // A new press, counted from here whether or not its mic opens at once: one that couldn't be
    // opened and is opened at a later change (follow: `switched`) is still this press.
    if !switched {
        openedAt = asked
        press = Press(waits: false)
    }
    // The held mic's link went, or it's only being tried again: not waited for (pressWaits). It's
    // given up on here, and this press takes another mic.
    if let h = hold, h.liveMs == nil, !pressWaits(lost: h.lost != nil, retry: h.retry) { giveUp() }
    guard !open else { return } // giving up opened it already: a press that was waiting to be opened (follow)
    let (device, fallback, noLink) = pick()
    var using: [String: Any] = ["uid": device?.uid ?? "", "name": device?.name ?? "", "fallback": fallback, "switched": switched]
    if let wanted { using["wanted"] = ["uid": wanted.uid, "name": wanted.name] }
    if noLink { using["noLink"] = true }
    if let device, let made = prepare(device, orDefault: true) {
        using["fresh"] = made.why
        using["setupMs"] = made.ms
    }
    if let h = hold, h.device.id == capture?.setup.device, unitOn {
        using["held"] = true
        using["live"] = h.liveMs != nil
    }
    status("using \(json(using))")
    guard device != nil, let capture else {
        status("error: no usable input device")
        return
    }
    // Moved while open (`switched`): still the same press, counted from its own start; "started" isn't said twice.
    press = Press(waits: capture.waits, started: switched && press.started)
    capture.converter.reset()
    guard run() else { return }
    open = true
    shared.withLock { $0.open = true }
}

func stop(quietly: Bool = false) {
    guard open else { return }
    open = false
    // From this cycle on the I/O thread drops what it hears (PRIVACY, above).
    shared.withLock { $0.open = false }
    // The held mic's unit runs on: only what's sent on stops.
    if hold == nil || hold?.device.id != capture?.setup.device { halt() }
    if !quietly { status("stopped") }
    // A mic that gave no link a while ago is tried again now that you've talked: you're here, and want it.
    if !quietly { tryAgain("press") }
}

/// Open now, on another device than it should be (the chosen one came or went, the default changed):
/// moves over without a "stopped". And a press that's on but couldn't be opened (2026-11-14: its mic
/// went as it was asked for, AirPods listed for a quarter of a second and gone again) is opened
/// where it should be now: a device that comes and goes mid-press never leaves the press deaf.
func follow() {
    if pressed, !open { return start(switched: true) }
    guard open, pick().device?.id != capture?.setup.device else { return }
    stop(quietly: true)
    start(switched: true)
}

// ── The hold (held, and PRIVACY, above) ─────────────────────────────────────

func holdFields(_ h: Hold) -> [String: Any] {
    h.asDefault ? ["uid": h.device.uid, "name": h.device.name, "default": true] : ["uid": h.device.uid, "name": h.device.name]
}

/// The output side of a Bluetooth headset's mic: AirPods are two devices, "<address>:input" and
/// "<address>:output" (else the Bluetooth output of the same name). 0 when there's none.
func outputSide(of mic: Device) -> AudioDeviceID {
    let outputs = allDevices().filter { channels($0, kAudioDevicePropertyScopeOutput) > 0 && transportName($0) == "bluetooth" }
    if mic.uid.hasSuffix(":input") {
        let uid = String(mic.uid.dropLast(":input".count)) + ":output"
        if let same = outputs.first(where: { stringProperty($0, kAudioDevicePropertyDeviceUID) == uid }) { return same }
    }
    return outputs.first { stringProperty($0, kAudioObjectPropertyName) == mic.name } ?? 0
}

/// Something changed under the hold (`what`): said, and its link counts as down until sound comes again.
func lost(_ what: String, _ more: [String: Any] = [:]) {
    guard var h = hold else { return }
    var said = holdFields(h).merging(more) { _, new in new }
    said["what"] = what
    said["wasLive"] = h.liveMs != nil
    status("hold_lost \(json(said))")
    h.liveMs = nil
    h.lost = what
    h.since = .now()
    hold = h
    shared.withLock { $0.again = true }
}

/// The held mic's link gave its first sound, or went silent (half a second of exact zeros), as the I/O thread saw it.
func link(_ from: Capture, up: Bool) {
    guard from === capture, var h = hold, h.device.id == from.setup.device else { return }
    if !up {
        if h.liveMs != nil { lost("silent") }
        return
    }
    guard h.liveMs == nil else { return }
    let ms = since(h.since)
    h.liveMs = ms
    h.outRate = h.output != 0 ? nominalRate(h.output) : 0
    var said = holdFields(h)
    said["on"] = true
    said["live"] = true
    said["ms"] = ms
    if h.outRate > 0 { said["outRate"] = Int(h.outRate) }
    if let after = h.lost { said["after"] = after }
    if h.retry { said["retry"] = true }
    h.lost = nil
    h.kicked = false
    h.retry = false // up: held as any, from here
    gaveUps = 0
    hold = h
    status("hold \(json(said))")
}

/// The held headset's output changed rate: once the link was up, that's it leaving (or coming back to) its call profile.
func outputChanged() {
    guard var h = hold, h.output != 0 else { return }
    let rate = nominalRate(h.output)
    guard h.outRate > 0, rate != h.outRate else { return }
    let from = Int(h.outRate)
    h.outRate = rate
    hold = h
    var said = holdFields(h)
    said["what"] = "output format"
    said["from"] = from
    said["to"] = Int(rate)
    said["wasLive"] = h.liveMs != nil
    status("hold_lost \(json(said))")
}

/// The running unit stopped and started again where it is: the headset is asked for its call link once more.
func kick() {
    guard let capture, unitOn else { return }
    AudioOutputUnitStop(capture.unit)
    unitOn = false
    guard run(), var h = hold else { return }
    h.since = .now()
    h.kicked = true
    hold = h
    shared.withLock { $0.again = true }
}

/// The hold ends (`why`): closed, its unit stops, and the headset goes back to its music profile.
/// Never left running for a mic that's no longer the chosen one.
func release(_ why: String) {
    guard let h = hold else { return }
    hold = nil
    unlisten(watchedOutput)
    watchedOutput = []
    if !open { halt() }
    var said = holdFields(h)
    said["on"] = false
    said["why"] = why
    said["heldMs"] = since(h.began)
    status("hold \(json(said))")
}

/// The held mic gave no link: the hold ends, and it counts as away until it's tried again (tryAgain).
/// A press that's on it moves to the system default (follow).
func giveUp() {
    guard let h = hold else { return }
    away = (h.device.id, .now())
    gaveUps += 1
    release("no link")
    follow()
}

/// The hold begins on `target` (`why`), or goes on if it's held already: its unit set up and running,
/// a press or not. `retry`: after it gave no link (a press doesn't wait for it: pressWaits).
/// `asDefault`: it's the system default, not a mic you chose.
func grab(_ target: Device, _ why: String, retry: Bool, asDefault: Bool) {
    let same = hold?.device.id == target.id
    if same { hold?.asDefault = asDefault } // held as the default, now chosen (or the other way): the same hold
    if same, let c = capture, c.setup.device == target.id, unitOn, fresh(had: c.setup, now: setupOf(target.id)) == nil { return }
    if open {
        // A press is on, on it already (follow): the hold takes its unit as it is. On another device
        // (it couldn't be set up): not held; the next change or press tries again.
        guard capture?.setup.device == target.id, unitOn else { return }
    } else {
        _ = prepare(target, orDefault: false)
        guard capture?.setup.device == target.id, run() else {
            // It can't be opened: as one that gives no link, away until something changes. Said
            // either way (the app goes by it for what the setting shows), held before or not.
            away = (target.id, .now())
            gaveUps += 1
            if same { release("cannot open") } else { status("hold \(json(["on": false, "uid": target.uid, "name": target.name, "why": "cannot open"]))") }
            return
        }
    }
    if same, var h = hold {
        // Held already, its unit made or started again: its link is to come up again.
        h.since = .now()
        h.liveMs = nil
        hold = h
    } else {
        var h = Hold(device: target, began: .now(), since: .now())
        h.retry = retry
        h.asDefault = asDefault
        h.output = outputSide(of: target)
        if h.output != 0, let w = listen(h.output, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, { _, _ in outputChanged() }) { watchedOutput = [w] }
        hold = h
        var said = holdFields(h)
        said["on"] = true
        said["why"] = why
        if retry { said["retry"] = true }
        status("hold \(json(said))")
    }
    shared.withLock { $0.again = true }
}

/**
 * The hold put right for the devices, the default and the choice as they are now (`why`: what
 * changed): one on a mic that isn't the one to hold any more ends first (it went: "disconnected";
 * the choice changed: "another mic chosen"; macOS moved its default elsewhere: "default changed";
 * the mic you chose is there again: "chosen mic back"), a press that's on moves where it should be,
 * then the mic to hold is held. Called whenever the choice, the devices, the default input or the
 * unit's own device change, and after a sleep. A mic that gave no link (away) is left alone here: tryAgain.
 */
func settle(_ why: String, retry: Bool = false) {
    let devices = inputDevices()
    let defaultID = defaultInput()
    if let a = away, !devices.contains(where: { $0.id == a.device }) { away = nil } // gone: back, it's new
    let target = held(devices, defaultID: defaultID, wanted: wanted, away: away?.device)
    if let h = hold, h.device.id != target?.id {
        let listed = devices.contains { $0.id == h.device.id }
        release(!listed ? "disconnected" : why == "chosen" || why == "default" ? "another mic chosen" : h.device.id != defaultID ? "default changed" : "chosen mic back")
    }
    follow()
    if let target { grab(target, why, retry: retry, asDefault: find(devices, wanted)?.id != target.id) }
}

/**
 * A mic that gave no link is tried again (`why`: a press ended, the devices or the defaults
 * changed, the Mac woke): held again, and given up on again if it still gives none. Not sooner than
 * retryAfterMs after it was given up on (a change that comes sooner is kept for then), and not while
 * the mic is open (hands-free keeps it open: there it stays on the stand-in until the mic is chosen
 * again). Nothing else tries: no timer of its own asks a headset that's elsewhere for its mic.
 */
func tryAgain(_ why: String, now: Bool = false) {
    guard let a = away, !open else { return }
    let waited = since(a.at)
    let after = retryAfterMs(gaveUps: gaveUps)
    if now || waited >= after {
        away = nil
        return settle(why, retry: true)
    }
    guard why != "press", !retryDue else { return } // a press's try waits for a later press
    retryDue = true
    queue.asyncAfter(deadline: .now() + .milliseconds(Int(after - waited))) {
        retryDue = false
        tryAgain(why)
    }
}

/// The unit's device changed rate or channels, or went: open, it's set up again (or moves) at once,
/// without a "stopped"; closed, the next start sees to it. The hold follows (settle).
func deviceChanged() {
    if open, let had = capture?.setup, !(pick().device?.id == had.device && fresh(had: had, now: setupOf(had.device)) == nil) {
        stop(quietly: true)
        start(switched: true)
    }
    settle("changed")
}

/// Devices plugged in or out, or the default changed: say so, and move if open. The unit is left as it
/// is: a start makes it again only if its own device changed (fresh). The hold begins or ends with
/// its mic coming or going, or becoming or no longer being the default (settle), and one that gave
/// no link is tried again (AirPods back in your ears, or back from the iPhone, become the Mac's
/// default again).
func devicesChanged() {
    let devices = inputDevices()
    status("devices \(json(describe(devices)))")
    settle(hold == nil ? "connected" : "changed")
    tryAgain("changed")
}

/// The default output moved (to the AirPods, or away from them): nothing to say, but a mic that gave no link is tried again.
func outputMoved() {
    tryAgain("changed")
}

let system = AudioObjectID(kAudioObjectSystemObject)
for selector in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice] {
    var where_ = address(selector)
    AudioObjectAddPropertyListenerBlock(system, &where_, queue) { _, _ in devicesChanged() }
}
nonisolated(unsafe) var defaultOutputAddress = address(kAudioHardwarePropertyDefaultOutputDevice)
AudioObjectAddPropertyListenerBlock(system, &defaultOutputAddress, queue) { _, _ in outputMoved() }

// Every second, for the hold: a Mac that slept, a unit whose device stopped calling it, and a link
// that doesn't come up. Asleep, the uptime clock stands still and the wall clock doesn't: more than
// 2 s between them is a sleep, and the hold is looked at again (Bluetooth usually drops and comes
// back as devices, but not always). A held unit with no cycle in 4 s (after a wake, AirPods taken by
// the iPhone and still listed here) has lost its link. And a link that isn't up linkWaitMs after it
// was asked for is asked for once more, then given up on (linkStep).
nonisolated(unsafe) var lastWall = Date()
nonisolated(unsafe) var lastUp = DispatchTime.now()
nonisolated(unsafe) var lastBeats: UInt64 = 0
nonisolated(unsafe) var still = 0
let pulse = DispatchSource.makeTimerSource(queue: queue)
pulse.schedule(deadline: .now() + 1, repeating: 1)
pulse.setEventHandler {
    let wall = Date()
    let up = DispatchTime.now()
    let slept = wall.timeIntervalSince(lastWall) - Double(up.uptimeNanoseconds - lastUp.uptimeNanoseconds) / 1e9 > 2
    lastWall = wall
    lastUp = up
    if slept {
        still = 0
        settle("woke")
        tryAgain("woke", now: true) // at once: whatever it was elsewhere for, the Mac is back in use
    }
    guard hold != nil, unitOn else { return still = 0 }
    let beats = shared.withLock { $0.beats }
    if beats != lastBeats {
        lastBeats = beats
        still = 0
    } else {
        still += 1
        if still == 4 { lost("stalled") }
    }
    guard let h = hold, h.liveMs == nil else { return }
    switch linkStep(waitedMs: since(h.since), kicked: h.kicked) {
    case "kick": kick()
    case "give up": giveUp()
    default: break
    }
}
pulse.resume()

queue.sync { status("devices \(json(describe(inputDevices())))") }
status("ready")
while let line = readLine() {
    switch line {
    case "start":
        // The press's wait starts here, setup included: before 2026-11-13 it started after the setup,
        // and "started 159" hid more than a second of it.
        let asked = DispatchTime.now()
        queue.sync {
            start(at: asked)
            pressed = true // after: nothing in this start takes it for a press left unopened (follow)
        }
    case "stop":
        queue.sync {
            pressed = false
            stop()
        }
    case _ where line == "device" || line.hasPrefix("device "):
        let parts = line.dropFirst(7).split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        queue.sync {
            let uid = parts.first ?? ""
            wanted = uid.isEmpty ? nil : (uid, parts.count > 1 ? parts[1] : "")
            away = nil // chosen (again): tried afresh
            gaveUps = 0
            // "default": the system default set (or the app starting on it), which holds a Bluetooth default.
            settle(wanted == nil ? "default" : "chosen")
        }
    default: break
    }
}
// stdin closed (the app quit, or died): nothing is left open behind it, the hold least of all.
queue.sync {
    pressed = false
    stop(quietly: true)
    release("quit")
    drop()
}
