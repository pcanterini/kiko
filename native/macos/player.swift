// Low-latency PCM player for macOS (AVAudioEngine).
// Reads framed messages on stdin: 1 byte type + 4 byte little-endian length + payload.
//   "A": 16-bit little-endian mono PCM at 24 kHz to queue.
//   "B": the same, for a cue (a press's beep): on a Bluetooth output that may be asleep, it waits for
//        the link to wake first (below).
//   "F": stop now and drop everything queued (barge-in).
//   "V": the gain from now, a 32-bit little-endian float, 0 to 1 (mute: src/core/mute.ts). Mid-line
//        too: what's queued plays on at it, so "playing" and "idle" come when they would have.
//   "C": act as if the output device changed: the engine stops and comes back (for tests).
//   "D" (tests, offline only): the engine stops on its own, as a real change of the output's format
//        stops it (AirPods switching between their music and call profiles): nothing brings it back
//        but the helper's own looking, and the offline output's rate changes with it (48 ↔ 24 kHz).
//   "H" (tests, offline only): the made-up output's rate changes the same way, and the engine isn't
//        stopped by it: it runs on, set up for the output as it was.
//   "S" / "R" (tests, offline only): the device stops taking sound, and takes it again.
//   "E" (tests, offline only): the next <n> plays fail (a 32-bit little-endian count), as a device that
//        stopped responding makes them fail (below).
//   "Q" (tests, offline only): renders what real time has asked for so far, then prints "output <frames>
//        <rendered>": the frames not exactly silent since the last "Q", and how many it rendered in all
//        (its render clock), so a test measures by what was rendered, not by how long it slept.
//   "L" (tests, offline only): renders the same way, then prints "levels <rate> <channels> <left> <right>":
//        the made-up output's format as it's rendered, and each channel's level since the last "L" (below).
// Prints "ready", then "playing" when queued audio starts and "idle" when the queue runs dry; and
// "rerouted <ms>" when the engine came back after a device change, with <ms> of audio still to play;
// "rate <hz>" at start and whenever the output device's sample rate changes (a Bluetooth headset's
// says which profile it's in: 48 kHz for music, 24 or 16 kHz for calls);
// "stalled <ms> <rendering> <device>" when it gave up on <ms> of audio the device wouldn't play (an
// "idle" follows), and "back" once the device is seen taking sound again after that; "route <bt>
// <device>" at start and whenever the output changes (<bt> 1 for a Bluetooth one); "keepalive on" /
// "keepalive off" (Bluetooth only, below); "waking <ms> <asleep>" when a cue waits <ms> for the
// link (<asleep> 1: nothing was keeping it awake); and, for an output that stopped responding (below),
// "retry <step> <why>", "fallback_default <device>" and "rebuilt <why> <device>"; and "channels <why>
// <device rate> <device channels> <engine rate> <engine channels> <map> <stereo> <layout> <left> <right>"
// (below).
//
// An output device change (AirPods connect, the default output moves) stops the engine. Nothing
// queued is lost to it: the engine comes back on the new device and whatever hadn't been heard yet
// plays on, from the start of the slice it was in (slices are 100 ms, so at most that much is said
// twice, plus what was still on its way out of the device). Only "F" drops anything. If the engine
// can't come back yet, it keeps trying, queue kept.
//
// What counts as heard (2026-11-13): an engine that stops calls the completion of every buffer still
// scheduled, at once, played or not. A real change of the output's format (AirPods going between
// 48 kHz, their music profile, and 24 kHz, their call profile, as their mic is opened or closed)
// stops the engine by itself, before anything here knows: every slice of a 19 s reply was taken for
// heard 2.4 s in, "idle" was said, and the reply stopped mid-sentence ("rerouted 0", three times
// that day). The "C" of the tests never showed it: it stopped the engine and brought it back in one
// step. So a slice is heard only if its completion comes while the engine runs and no sooner than
// it could have played (heardBy): sound doesn't come out faster than time. One that fails that stays
// queued, and plays again once the engine is back.
//
// A stalled output: AirPods that are the Mac's default output while they're with the iPhone (Apple
// moves them between devices) stay a live device here (no device change, so the engine runs on), but
// the device doesn't take the sound: nothing scheduled was ever played back, and "idle" never came
// (2026-10-29: three minutes of "speaking" in silence, until the AirPods were picked on the Mac and
// it all played; no "rerouted" either). So once queued sound has gone stallMs (5 s) with none of it
// heard (no slice played back, slices being 100 ms), it's dropped, "stalled" says how much and on
// what, and "idle" follows: the app goes on, and offers it again. Most likely the device isn't asking
// for sound at all, so the engine's render clock (which runs on, silence and all, on a working
// device) stands still: <rendering> says which it was, 1 when the clock was moving all the same.
// "back" then comes once sound is seen coming out again: the clock moving after it stood still, or a
// slice of later sound played back.
//
// A Bluetooth output that's been quiet (2026-10-31: AirPods; the cues, ~130 ms, never heard, the
// spoken replies were, and a cue right after something had played was heard): the engine runs all
// along, but what it plays between sounds is digital silence, and the Bluetooth link goes to sleep
// on that all the same. The first few hundred ms of sound after it are lost while it wakes: a whole
// cue, a long line's first syllable. So on a Bluetooth output only (the device's transport type,
// Classic or LE; wired, USB, HDMI and built-in outputs get none of this):
//   - keep-alive: a signal far below hearing (30 Hz at -54 dBFS: under the threshold of hearing at
//     that pitch even at full volume, but not digital silence) plays under everything, from the
//     first sound or cue until keepAliveMs (30 s) after the last one ends: a conversation's back and
//     forth stays on an awake link. Then it stops, so the AirPods aren't held "in use" for good
//     (battery, and Apple moving them to another of your devices). It follows the gain ("V"):
//     muted, it's silent too.
//   - wake-up pre-roll: a cue ("B") that comes while the keep-alive isn't running (or only just
//     started) waits until it has run preRollMs (500 ms), then plays on the woken link: the first
//     press after a quiet spell gets its cue that much later. Speech ("A") never waits.
//
// An output that stopped responding (2026-11-04: many iOS simulators overloading CoreAudio; on
// macOS 27 every play threw -10863 "player did not see an IO cycle", each line was given up on 5 s
// later, and nothing was heard until Kiko was restarted). A play that fails (that error, -10868, a
// device gone, any other the player gives) is a sign the engine is wedged, not that the line is bad:
//   1. "retry 1 <why>": after retryMs the engine is built again from scratch (a new AVAudioEngine,
//      the same nodes) and what hadn't been heard is played again;
//   2. failing again, "retry 2 <why>" and "fallback_default <device>": the same, on the system's
//      default output device (the one alerts play on; else the default output) rather than the one
//      that failed. Kept on it for fallbackHoldMs, then a new line follows the default output again;
//   3. failing that too: given up on as a stall ("stalled", with the device that failed), at once,
//      so the app says its "Couldn't play on …" line and goes on.
// Sound heard starts the count over. And the engine is built again before anything fails when it's
// likely to: its configuration changed and it couldn't start again, the default output device
// changed, or the device it plays on went away (CoreAudio's listeners), each "rebuilt <why>"; and
// after a stall in which the device asked for nothing (no play left to fail and say so). Nothing
// here waits on the stdin loop for long: each step is scheduled on the player queue.
//
// Both channels (2026-11-14): with the AirPods' mic held open (their call profile: 24 kHz, two
// channels) the replies were heard in the right ear only, while every other app played in both. The
// engine had lived through the output's change from 48 to 24 kHz: stopped by it, started again, the
// same engine and output unit. It couldn't be made to happen without the AirPods (the speakers taken
// from 48 to 44.1 kHz and back under an inaudible signal: the mixer gave both channels the same, the
// output unit's channel map stayed 0,1; offline, every two-channel format the same), so what's here
// is what leaves nothing from before a change, and what says how it was next time:
//   - an engine that stopped is never started again: a new one is made for the output as it is now
//     (reroute, as rebuild always did), so no connection, converter or channel map outlives a format;
//   - a sound never starts on an engine started for another format: the output's rate and channels
//     are read as it starts, and if they aren't what they were when the engine was started (it came
//     back 0.14 s into the AirPods' change of profile that day, 1.4 s before their link was up, and
//     nothing looked again), a new engine is made first ("rerouted 0");
//   - on a two-channel output the mixer is connected to it in plain stereo at the output's rate
//     (wireOutput), not in whatever layout the device gives its two channels: a mixer that follows
//     a layout that isn't left and right (channels with no labels, mid/side) puts mono speech on the
//     first channel alone (seen offline). The speech and the keep-alive are mono, panned to the
//     middle: the same in both;
//   - "channels" says the output's format as the device has it and as the engine plays into it,
//     the output unit's channel map ("0,1"), the device's channels for stereo ("1,2"), what the
//     output unit calls the device's channels ("labels=1,2": left and right; or "tag=<layout tag>"),
//     and, for "idle", the level of each of the first two channels the mixer gave the output over
//     that sound (dBFS; -120 for silence, "-" for none): at start, on "rerouted" and "rebuilt", as a
//     sound starts ("playing") and after it ends. Levels only: nothing of the sound is kept.
//
// KIKO_PLAYER_OFFLINE=1 (tests): no device. It renders in real time to nowhere, and before each
// "idle" prints "heard <frames>": how many non-silent frames came out since the last one. The
// nowhere has two channels and a rate (48 kHz, or KIKO_PLAYER_OFFLINE_RATE; "D" changes it), and
// is rendered at the helper's own 24 kHz, so what's counted is the frames it was given;
// KIKO_PLAYER_OFFLINE_RENDER=device renders it at its own rate, as a device takes it (counts are
// then in 24 kHz frames, to within the rate conversion's edges: "L" is what's measured there).
// KIKO_PLAYER_BLUETOOTH=1 (offline only) makes that nowhere a Bluetooth output; "heard" then
// counts only what's louder than the keep-alive. KIKO_PLAYER_KEEPALIVE_MS and
// KIKO_PLAYER_PREROLL_MS set those times (tests set them shorter).
import AVFoundation
import CoreAudio
import Foundation

let sampleRate = 24000.0
let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
// Audio is scheduled in slices this long: the most a device change can make it repeat.
let sliceFrames = 2400
// The app's environment variables' prefix (src/core/name.ts ENV_PREFIX, repeated: tests/unit/core/name.test.ts checks it).
let envPrefix = "KIKO_"
// A setting from the environment: KIKO_<name>.
func setting(_ name: String) -> String? {
    ProcessInfo.processInfo.environment[envPrefix + name]
}
let offline = setting("PLAYER_OFFLINE") == "1"
// How long queued sound may go with none of it heard before it's given up on (tests set it shorter).
let stallMs = Int(setting("PLAYER_STALL_MS") ?? "") ?? 5000
// Bluetooth outputs: how long the keep-alive runs after the last sound, and how long a cue waits for
// a link it didn't find awake (see the top).
let keepAliveMs = Int(setting("PLAYER_KEEPALIVE_MS") ?? "") ?? 30000
let preRollMs = Int(setting("PLAYER_PREROLL_MS") ?? "") ?? 500
let offlineBluetooth = offline && setting("PLAYER_BLUETOOTH") == "1"
let keepAliveLevel: Float = 0.002 // -54 dBFS
let keepAliveHz = 30.0
// Built again when it's wedged (rebuild()): read it afresh each time, never kept.
nonisolated(unsafe) var engine = AVAudioEngine()
let player = AVAudioPlayerNode()
// An output that stopped responding (see the top): the wait before each try, and how long the
// fallback device is kept before a new line goes back to the default output.
let retryMs = Int(setting("PLAYER_RETRY_MS") ?? "") ?? 300
let fallbackHoldMs = Int(setting("PLAYER_FALLBACK_HOLD_MS") ?? "") ?? 60000

// ── macOS 27's throwing calls ───────────────────────────────────────────────
// macOS 27 deprecates AVAudioEngine's connect, AVAudioPlayerNode's play and an I/O node's
// audioUnit, for versions that throw (connectNode, playAudio) or lend the unit (withAudioUnit). Kiko
// runs on macOS 13 and later (scripts/release.sh MIN_MACOS), where only the old ones exist: each is
// used through one of these, the new one where there is one. Where the old one would have raised (an
// Objective-C exception: the helper gone), the new one's error is said on stderr: at start, then
// the helper exits as it did; in play(), it plays on (the next sound tries again).

/** `from` into `to`, in `format`: false when it couldn't be (said). */
@discardableResult
func connect(_ from: AVAudioNode, to: AVAudioNode, in format: AVAudioFormat) -> Bool {
    if #available(macOS 27.0, *) {
        do {
            try engine.connectNode(from, to: to, format: format)
        } catch {
            FileHandle.standardError.write("player: cannot connect the audio graph: \(error)\n".data(using: .utf8)!)
            return false
        }
    } else {
        engine.connect(from, to: to, format: format)
    }
    return true
}

/** `node` into the main mixer, in `format`. */
func connectToMixer(_ node: AVAudioNode) {
    if !connect(node, to: engine.mainMixerNode, in: format) { exit(1) }
}

// Tests ("E", offline only): this many plays still to fail.
nonisolated(unsafe) var failPlays = 0

/**
 * The player node starts (or goes on) playing what's scheduled on it. False when it couldn't, with
 * why: the error's code ("-10863"), or "test" for one "E" made fail.
 */
@discardableResult
func play() -> (ok: Bool, why: String) {
    if failPlays > 0 {
        failPlays -= 1
        warn("cannot play: a failure made for the test")
        return (false, "test")
    }
    if #available(macOS 27.0, *) {
        do {
            try player.playAudio()
        } catch {
            warn("cannot play: \(error)")
            return (false, String((error as NSError).code))
        }
    } else {
        player.play()
    }
    return (true, "")
}

/** The output node's audio unit, lent to `body` (nil when there's none). */
func withOutputUnit(_ body: (AudioUnit?) -> Void) {
    if #available(macOS 27.0, *) {
        engine.outputNode.withAudioUnit { body($0) }
    } else {
        body(engine.outputNode.audioUnit)
    }
}

// The keep-alive signal, made as it renders. `keepAliveTarget` (set on the player queue) is the level
// it should be at: it fades there over 50 ms, from and to nothing, so it never clicks.
nonisolated(unsafe) var keepAliveTarget: Float = 0
final class Tone: @unchecked Sendable {
    var level: Float = 0
    var phase = 0.0
}
let tone = Tone()
let keepAlive = AVAudioSourceNode(format: format) { isSilence, _, frameCount, buffers in
    let list = UnsafeMutableAudioBufferListPointer(buffers)
    let out = list[0].mData!.assumingMemoryBound(to: Float.self)
    let target = keepAliveTarget
    let frames = Int(frameCount)
    if target == 0 && tone.level == 0 {
        for i in 0..<frames { out[i] = 0 }
        tone.phase = 0
        isSilence.pointee = true
        return noErr
    }
    let step = keepAliveLevel / Float(sampleRate * 0.05)
    let delta = 2 * Double.pi * keepAliveHz / sampleRate
    for i in 0..<frames {
        if tone.level < target { tone.level = min(target, tone.level + step) }
        else if tone.level > target { tone.level = max(target, tone.level - step) }
        out[i] = Float(sin(tone.phase)) * tone.level
        tone.phase += delta
        if tone.phase > 2 * Double.pi { tone.phase -= 2 * Double.pi }
    }
    return noErr
}

// Offline: the made-up output's rate; "D" changes it, as AirPods changing profile do. It has two
// channels, and is rendered at the helper's own rate unless asked at its own (see the top).
nonisolated(unsafe) var offlineRate = Double(setting("PLAYER_OFFLINE_RATE") ?? "") ?? 48000.0
let offlineAtRate = setting("PLAYER_OFFLINE_RENDER") == "device"
// Offline: what an engine renders into, and at what rate: made with each engine (wire).
nonisolated(unsafe) var renderOut: AVAudioPCMBuffer! = nil
nonisolated(unsafe) var renderRate = sampleRate

/** A level in dBFS, to a tenth: -120 for silence (and anything under it). */
func dBFS(_ rms: Double) -> String {
    String(format: "%.1f", max(-120, 20 * log10(max(rms, 1e-12))))
}

/** The sum of the squares of `count` samples. */
func energy(_ samples: UnsafePointer<Float>, _ count: Int) -> Double {
    var sum = 0.0
    for i in 0..<count { sum += Double(samples[i]) * Double(samples[i]) }
    return sum
}

/**
 * The level of each of the output's first two channels over a while (see the top, "Both channels"):
 * sums only, added to from wherever the sound is seen (the mixer's tap, on its own thread; offline,
 * the render) and taken on the player queue.
 */
final class Levels: @unchecked Sendable {
    private let lock = NSLock()
    private var left = 0.0
    private var right = 0.0
    private var stereo = false
    private var frames = 0

    /** `count` frames more: the sum of the squares of each channel's (`right` nil: there's only one). */
    func add(left: Double, right: Double?, frames count: Int) {
        lock.lock()
        defer { lock.unlock() }
        self.left += left
        self.right += right ?? 0
        if right != nil { stereo = true }
        frames += count
    }

    /** "<left> <right>" since the last one, in dBFS ("-": no such channel, or nothing seen), and starts over. */
    func take() -> String {
        lock.lock()
        defer { lock.unlock() }
        let n = Double(frames)
        let text = frames == 0 ? "- -" : "\(dBFS((left / n).squareRoot())) \(stereo ? dBFS((right / n).squareRoot()) : "-")"
        left = 0
        right = 0
        stereo = false
        frames = 0
        return text
    }
}
// Over the sound that's playing (said after its "idle": "channels"), and since the last "L" (tests).
let spoken = Levels()
let probed = Levels()

/** The graph on `engine` as it is now: the player and the keep-alive into its mixer (offline: rendered by hand, as the made-up output takes it). */
func wire() {
    engine.attach(player)
    connectToMixer(player)
    engine.attach(keepAlive)
    connectToMixer(keepAlive)
    if offline {
        renderRate = offlineAtRate ? offlineRate : sampleRate
        let device = AVAudioFormat(standardFormatWithSampleRate: renderRate, channels: 2)!
        do {
            try engine.enableManualRenderingMode(.offline, format: device, maximumFrameCount: 4096)
        } catch {
            FileHandle.standardError.write("player: cannot render offline: \(error)\n".data(using: .utf8)!)
            exit(1)
        }
        renderOut = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 4096)!
    }
}

/**
 * The mixer into the output, for the output the engine is on now (before each start: see the top,
 * "Both channels"). Two channels: in plain stereo at the output's rate, whatever the device calls
 * its two channels, so mono speech is on both. Any other count is left as the engine has it (it
 * follows the output). And the mixer's output is listened to for each channel's level.
 */
func wireOutput() {
    let hardware = engine.outputNode.outputFormat(forBus: 0)
    if hardware.channelCount == 2, hardware.sampleRate > 0, let plain = AVAudioFormat(standardFormatWithSampleRate: hardware.sampleRate, channels: 2) {
        connect(engine.mainMixerNode, to: engine.outputNode, in: plain)
    }
    guard !offline else { return } // what's rendered is measured as it's rendered (pull)
    let mixer = engine.mainMixerNode
    mixer.removeTap(onBus: 0)
    // A tenth of a second at a time (the least a tap gives), off the audio thread.
    let size = AVAudioFrameCount(max(hardware.sampleRate, sampleRate) / 10)
    if #available(macOS 27.0, *) {
        do {
            try mixer.installAudioTap(onBus: 0, bufferSize: size, format: nil) { buffer, _ in
                var sums: [Double] = []
                for channel in 0..<min(2, Int(buffer.format.channelCount)) {
                    guard case .float(let samples) = buffer.channelData(channel) else { return }
                    var sum = 0.0
                    for i in stride(from: 0, to: samples.count, by: max(1, buffer.stride)) { sum += Double(samples[i]) * Double(samples[i]) }
                    sums.append(sum)
                }
                guard let first = sums.first else { return }
                spoken.add(left: first, right: sums.count > 1 ? sums[1] : nil, frames: buffer.frameLength)
            }
        } catch {
            warn("cannot listen to the mixer for its channels' levels: \(error)")
        }
    } else {
        mixer.installTap(onBus: 0, bufferSize: size, format: nil) { buffer, _ in
            guard let data = buffer.floatChannelData else { return }
            let frames = Int(buffer.frameLength)
            spoken.add(left: energy(data[0], frames), right: buffer.format.channelCount > 1 ? energy(data[1], frames) : nil, frames: frames)
        }
    }
}

/** A new engine, with the same nodes on it (wire). Not started; its output isn't connected yet (wireOutput). */
func fresh() {
    engine.stop()
    engine.detach(player)
    engine.detach(keepAlive)
    engine = AVAudioEngine()
    wire()
}

/** The engine's output unit put on `device` rather than the default output: false when it can't be (said). */
func setDevice(_ device: AudioDeviceID) -> Bool {
    var id = device
    var status: OSStatus = noErr
    withOutputUnit { unit in
        if let unit {
            status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size))
        }
    }
    if status != noErr { warn("cannot play on the default output device (\(status))") }
    return status == noErr
}
wire()
wireOutput()

final class Slice {
    let buffer: AVAudioPCMBuffer
    /// The play clock (playClock) before which it can't have been heard: set as it's scheduled.
    var earliest = 0.0
    init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
}

/**
 * Whether a slice whose completion came at `at` on the play clock was heard: only at or after the
 * moment it could have finished playing (`earliest`, with `slack` for the clock's grain and a
 * device's clock running a little fast over a long reply). An engine that stops completes
 * everything scheduled at once: seconds early. Pure, tested through "D".
 */
func heardBy(_ at: Double, earliest: Double, slack: Double = 0.05) -> Bool {
    at >= earliest - slack
}

// All playback state is touched on this queue only.
let queue = DispatchQueue(label: "player")
// Given and not heard yet, in order. While the engine runs, each is scheduled on the player in this generation.
nonisolated(unsafe) var unheard: [Slice] = []
nonisolated(unsafe) var generation = 0
// The play clock by which everything scheduled in this generation could have been heard, at the earliest.
nonisolated(unsafe) var dueEnd = 0.0
// Slices came back unheard (the engine dropped them): a look at it is on its way (unplayed).
nonisolated(unsafe) var checking = false
nonisolated(unsafe) var down = false // the engine stopped and hasn't come back yet (said once on stderr)
nonisolated(unsafe) var heard = 0.0 // offline: non-silent frames rendered since the last "idle" (in 24 kHz frames, as "Q"'s)
// When the queue last moved: sound started waiting in it, a slice was heard, or the engine came back.
nonisolated(unsafe) var movedAt = DispatchTime.now()
// The render clock at the last look (seconds), and whether it moved since the one before.
nonisolated(unsafe) var lastClock: Double? = nil
nonisolated(unsafe) var rendering = false
// It gave up on what it had: whether the render clock was moving then. Nil once "back" (or never stalled).
nonisolated(unsafe) var stalledRendering: Bool? = nil
nonisolated(unsafe) var held = false // offline, "S" until "R": the device takes no sound
nonisolated(unsafe) var rendered = 0 // offline: frames rendered, its render clock
// The output's rate and channels when the engine was last started on it (enqueue: a sound starts on that, or on a new engine).
nonisolated(unsafe) var startedOn = (rate: 0.0, channels: 0)
// The "idle" whose channels' levels are still to say (0: none), of how many said.
nonisolated(unsafe) var levelsDue = 0
nonisolated(unsafe) var idles = 0
// Offline: the frames real time has asked for and the render hasn't given yet, and when it last asked.
nonisolated(unsafe) var owed = 0.0
nonisolated(unsafe) var askedAt = DispatchTime.now()
nonisolated(unsafe) var output = 0.0 // offline: frames not exactly silent since the last "Q"
// The output now: Bluetooth or not, and its name (nil before the first look), and its sample rate
// as last said ("rate").
nonisolated(unsafe) var bluetooth = false
nonisolated(unsafe) var routeName: String? = nil
nonisolated(unsafe) var routeRate = 0.0
// The keep-alive (Bluetooth only): running since `awakeSince` (nil: not running), until `aliveUntil`.
nonisolated(unsafe) var awakeSince: DispatchTime? = nil
nonisolated(unsafe) var aliveUntil = DispatchTime.now()
// A cue waiting for the link to wake: nothing queued is scheduled until then ("waking").
nonisolated(unsafe) var holding = false
nonisolated(unsafe) var holdToken = 0
// An output that stopped responding (see the top): failed plays of what's queued since sound was last
// heard, a try scheduled (`retryToken` cancels it), the device the first one failed on (what a stall
// then names), and the fallback device played on until when (nil: following the default output).
nonisolated(unsafe) var failures = 0
nonisolated(unsafe) var recovering = false
nonisolated(unsafe) var retryToken = 0
nonisolated(unsafe) var failedOn: String? = nil
nonisolated(unsafe) var pinned: AudioDeviceID? = nil
nonisolated(unsafe) var pinnedUntil = DispatchTime.now()

func say(_ line: String) {
    print(line)
    fflush(stdout)
}

func warn(_ line: String) {
    FileHandle.standardError.write("player: \(line)\n".data(using: .utf8)!)
}

func msOf(_ frames: Int) -> Int { Int(Double(frames) * 1000 / sampleRate) }

/**
 * The clock sound is played against, in seconds: real time (the device takes a second of sound a
 * second); offline, what's been rendered (it renders late and catches up on a busy machine, so real
 * time would run ahead of it).
 */
func playClock() -> Double {
    offline ? Double(rendered) / sampleRate : Double(DispatchTime.now().uptimeNanoseconds) / 1e9
}

/** What's scheduled is no longer: the next generation's slices are counted from now. */
func newGeneration() {
    generation += 1
    dueEnd = 0
}

/** Where the device's rendering is, in seconds: nil when the engine isn't running. */
func renderClock() -> Double? {
    guard engine.isRunning else { return nil }
    if offline { return Double(rendered) / sampleRate }
    guard let t = engine.outputNode.lastRenderTime, t.isSampleTimeValid, t.sampleRate > 0 else { return nil }
    return Double(t.sampleTime) / t.sampleRate
}

/** The output device the engine plays on (0 when it can't be read). */
func outputDevice() -> AudioDeviceID {
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    withOutputUnit { unit in
        if let unit { AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, &size) }
    }
    return id
}

/** Whether the output device is a Bluetooth one (Classic or LE: AirPods and the like). */
func isBluetooth() -> Bool {
    if offline { return offlineBluetooth }
    let id = outputDevice()
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var transport = UInt32(0)
    var size = UInt32(MemoryLayout<UInt32>.size)
    guard id != 0, AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &transport) == noErr else { return false }
    return transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE
}

/** The output device's sample rate (0 when it can't be read). */
func deviceRate() -> Double {
    if offline { return offlineRate }
    let id = outputDevice()
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyNominalSampleRate, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var rate = Float64(0)
    var size = UInt32(MemoryLayout<Float64>.size)
    guard id != 0, AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &rate) == noErr else { return 0 }
    return rate
}

/** The output device's name, as the Sound settings show it ("" when it can't be read). */
func deviceName() -> String {
    if offline { return "offline" }
    let id = outputDevice()
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var name: Unmanaged<CFString>?
    var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard id != 0, AudioObjectGetPropertyData(id, &addr, 0, nil, &nameSize, &name) == noErr, let cf = name?.takeRetainedValue()
    else { return "" }
    return (cf as String).replacingOccurrences(of: "\n", with: " ")
}

func idle() {
    if offline {
        say("heard \(Int(heard.rounded()))")
        heard = 0
    }
    say("idle")
    // Its channels' levels, a moment later: the mixer's tap gives them a tenth of a second at a time.
    idles += 1
    levelsDue = idles
    let due = idles
    queue.asyncAfter(deadline: .now() + .milliseconds(300)) {
        if levelsDue == due { sayLevels() }
    }
}

/** The levels of the sound that just ended, each channel's ("channels idle"). */
func sayLevels() {
    levelsDue = 0
    sayChannels("idle", levels: spoken.take())
}

/** A sound starts: said, with the output as it starts on it (the last sound's levels first, if they're still to say). */
func playing() {
    if levelsDue != 0 { sayLevels() }
    _ = spoken.take() // from here, this sound's
    say("playing")
    sayChannels("playing")
}

/** How many channels the output device has (0 when it can't be read). */
func deviceChannels() -> Int {
    if offline { return 2 }
    let id = outputDevice()
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioObjectPropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(0)
    guard id != 0, AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size >= UInt32(MemoryLayout<AudioBufferList>.size) else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    return UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self)).reduce(0) { $0 + Int($1.mNumberChannels) }
}

/** The output unit's channel map: which of the engine's channels each of the device's gets ("0,1"; "-" when there's none to read). */
func channelMap() -> String {
    if offline { return "-" }
    var map: [Int32] = []
    withOutputUnit { unit in
        guard let unit else { return }
        var size = UInt32(0)
        guard AudioUnitGetPropertyInfo(unit, kAudioOutputUnitProperty_ChannelMap, kAudioUnitScope_Output, 0, &size, nil) == noErr, size > 0 else { return }
        var read = [Int32](repeating: -1, count: Int(size) / MemoryLayout<Int32>.size)
        if AudioUnitGetProperty(unit, kAudioOutputUnitProperty_ChannelMap, kAudioUnitScope_Output, 0, &read, &size) == noErr { map = read }
    }
    return map.isEmpty ? "-" : map.map(String.init).joined(separator: ",")
}

/** The device's channels for stereo, as it says them ("1,2"; "-" when it doesn't). */
func stereoPair() -> String {
    if offline { return "-" }
    let id = outputDevice()
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyPreferredChannelsForStereo, mScope: kAudioObjectPropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    var pair: [UInt32] = [0, 0]
    var size = UInt32(2 * MemoryLayout<UInt32>.size)
    guard id != 0, AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &pair) == noErr else { return "-" }
    return "\(pair[0]),\(pair[1])"
}

/**
 * What the output node calls the device's channels: "labels=1,2" (each channel's label: 1 left,
 * 2 right), or "tag=<n>" for a layout known by its tag (6619138: stereo); "-" when it has none.
 */
func outputLayout() -> String {
    guard let layout = engine.outputNode.outputFormat(forBus: 0).channelLayout?.layout else { return "-" }
    let tag = layout.pointee.mChannelLayoutTag
    guard tag == kAudioChannelLayoutTag_UseChannelDescriptions else { return "tag=\(tag)" }
    let count = Int(layout.pointee.mNumberChannelDescriptions)
    let first = UnsafeRawPointer(layout).advanced(by: MemoryLayout<AudioChannelLayout>.offset(of: \.mChannelDescriptions)!)
    let labels = (0..<count).map { String(first.advanced(by: $0 * MemoryLayout<AudioChannelDescription>.stride).load(as: AudioChannelDescription.self).mChannelLabel) }
    return "labels=" + labels.joined(separator: ",")
}

/**
 * "channels <why> …" (see the top): the output's rate and channels as the device has them, as the
 * engine plays into it, the output unit's channel map, the device's channels for stereo, what the
 * output node calls its channels, and `levels` ("<left> <right>") when there are some to say.
 */
func sayChannels(_ why: String, levels: String = "- -") {
    let into = engine.outputNode.inputFormat(forBus: 0)
    say("channels \(why) \(Int(deviceRate())) \(deviceChannels()) \(Int(into.sampleRate)) \(into.channelCount) \(channelMap()) \(stereoPair()) \(outputLayout()) \(levels)")
}

func schedule(_ slice: Slice) {
    let gen = generation
    // It plays after what's scheduled before it, or from now: the soonest it can have been heard.
    dueEnd = max(dueEnd, playClock()) + Double(slice.buffer.frameLength) / sampleRate
    slice.earliest = dueEnd
    // Done once it's come out of the device, not just handed to it: what's still on its way when
    // the device goes is played again on the next one. (Offline there's no device: once rendered.)
    player.scheduleBuffer(slice.buffer, completionCallbackType: offline ? .dataRendered : .dataPlayedBack) { _ in
        // Stopping the player ends what's scheduled too: that one's of an older generation, not heard.
        // (Nothing on the engine here: player.stop() waits for this, holding the engine's lock.)
        let at = Double(DispatchTime.now().uptimeNanoseconds) / 1e9
        queue.async {
            guard gen == generation, let i = unheard.firstIndex(where: { $0 === slice }) else { return }
            // An engine that stopped by itself (the output's format changed) ends what's scheduled
            // too, in this generation: not heard (the top). It stays queued for when it's back.
            guard engine.isRunning, heardBy(offline ? playClock() : at, earliest: slice.earliest) else { return unplayed() }
            unheard.remove(at: i)
            movedAt = .now()
            failures = 0 // it plays: a later failure starts over
            failedOn = nil
            if stalledRendering != nil {
                stalledRendering = nil
                say("back")
            }
            if unheard.isEmpty {
                idle()
                keepAwake() // its keepAliveMs start from the end of the sound
            }
        }
    }
}

/**
 * Slices came back without having played: the engine dropped them. It's usually stopped, and its
 * configuration change (or the next look) brings it back with them (reroute); a moment is left for
 * that. Should it be running all the same, with nothing of ours scheduled on it any more, they're
 * scheduled again here.
 */
func unplayed() {
    guard !checking else { return }
    checking = true
    let gen = generation
    queue.asyncAfter(deadline: .now() + .milliseconds(300)) {
        checking = false
        guard gen == generation, !unheard.isEmpty, !holding, !recovering else { return } // brought back meanwhile, or dropped
        if !engine.isRunning { return reroute() }
        newGeneration()
        player.stop()
        movedAt = .now()
        let frames = unheard.reduce(0) { $0 + Int($1.buffer.frameLength) }
        say("rerouted \(msOf(frames))")
        for slice in unheard { schedule(slice) }
        playQueued()
    }
}

func enqueue(_ data: Data) {
    let frames = data.count / 2
    let was = unheard.isEmpty
    // A sound starting on an output that's no longer what the engine was started on, with nothing
    // having stopped the engine for it (the top, "Both channels"): a new engine first, for what it is now.
    if was, engine.isRunning, !recovering, (deviceRate(), deviceChannels()) != startedOn {
        engine.stop()
        reroute()
    }
    data.withUnsafeBytes { raw in
        let samples = raw.bindMemory(to: Int16.self)
        var start = 0
        while start < frames {
            let count = min(sliceFrames, frames - start)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else { return }
            buffer.frameLength = AVAudioFrameCount(count)
            let out = buffer.floatChannelData![0]
            for i in 0..<count { out[i] = Float(Int16(littleEndian: samples[start + i])) / 32768.0 }
            let slice = Slice(buffer)
            unheard.append(slice)
            if engine.isRunning && !holding { schedule(slice) }
            start += count
        }
    }
    guard !unheard.isEmpty else { return }
    if was { movedAt = .now() }
    if holding { return } // waiting for the link: "playing" once it's scheduled (release)
    if was { playing() }
    // A new line on the fallback device, past its time there: back to the default output first (the
    // one that failed may answer again; if it doesn't, the steps below come again).
    if was, pinned != nil, DispatchTime.now() >= pinnedUntil, !recovering {
        return rebuild("unpin", device: nil)
    }
    if engine.isRunning && !player.isPlaying && !recovering { playQueued() }
}

/** What's scheduled plays; if it can't, the steps for an output that stopped responding (recover). */
func playQueued() {
    let played = play()
    if !played.ok { recover(played.why) }
}

// ── Bluetooth: the keep-alive and the wake-up pre-roll (see the top) ────────

/** Sound now, or a cue coming: the keep-alive runs, until keepAliveMs from now. Bluetooth only. */
func keepAwake() {
    guard bluetooth else { return }
    aliveUntil = .now() + .milliseconds(keepAliveMs)
    guard awakeSince == nil else { return }
    awakeSince = .now()
    keepAliveTarget = keepAliveLevel
    say("keepalive on")
}

func keepAliveOff() {
    guard awakeSince != nil else { return }
    awakeSince = nil
    keepAliveTarget = 0
    say("keepalive off")
}

/** A cue: on a Bluetooth output whose link hasn't been kept awake preRollMs yet, it waits until it has. */
func cue(_ data: Data) {
    let asleep = bluetooth && awakeSince == nil
    keepAwake()
    if bluetooth, unheard.isEmpty, !holding, let since = awakeSince {
        let ready = since + .milliseconds(preRollMs)
        let now = DispatchTime.now()
        if ready > now {
            holding = true
            holdToken += 1
            let token = holdToken
            say("waking \(Int((ready.uptimeNanoseconds - now.uptimeNanoseconds) / 1_000_000)) \(asleep ? 1 : 0)")
            queue.asyncAfter(deadline: ready) {
                if holding && holdToken == token { release() }
            }
        }
    }
    enqueue(data)
}

// A gain changed while the player plays nothing doesn't take until the node renders again, and then
// eases in over ~25 ms: muted while quiet, the next sound's first 25 ms came out. So when it changes
// with nothing playing, the node plays a moment of silence (not queued sound: no "playing", nothing
// to hear), and the change is done before anything comes.
let primeFrames = AVAudioFrameCount(sampleRate * 0.04)
let prime: AVAudioPCMBuffer = {
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: primeFrames)!
    buffer.frameLength = primeFrames
    for i in 0..<Int(primeFrames) { buffer.floatChannelData![0][i] = 0 }
    return buffer
}()
func primeGain() {
    guard unheard.isEmpty, engine.isRunning else { return }
    player.scheduleBuffer(prime, completionHandler: nil)
    if !player.isPlaying { play() }
}

/** The link is awake (or isn't Bluetooth any more): what waited plays now. */
func release() {
    holding = false
    guard engine.isRunning, !unheard.isEmpty else { return } // a stopped engine schedules it as it comes back
    for slice in unheard { schedule(slice) }
    movedAt = .now()
    playing()
    playQueued()
}

/** The output, looked at: said when it's another one; the keep-alive starts over on it. */
func lookAtRoute() {
    guard engine.isRunning else { return }
    watchDevice()
    let bt = isBluetooth()
    let name = deviceName()
    let rate = deviceRate()
    let moved = bt != bluetooth || name != routeName
    // Said after the route it's the rate of: the app keeps the two together (ducking goes by them).
    defer {
        if rate != routeRate || moved {
            routeRate = rate
            say("rate \(Int(rate))")
        }
    }
    guard moved else { return }
    let wasAlive = awakeSince != nil
    bluetooth = bt
    routeName = name
    say("route \(bt ? 1 : 0) \(name)")
    // Another link, asleep as far as is known: kept awake from now if the last one was being kept awake.
    keepAliveOff()
    if wasAlive || !unheard.isEmpty { keepAwake() }
    if holding && !bt { release() }
}

func flush() {
    newGeneration()
    player.stop()
    // Nothing left to try again for: a step already scheduled finds nothing to play, and does nothing.
    failures = 0
    failedOn = nil
    if !unheard.isEmpty { idle() }
    unheard.removeAll()
}

// The engine stopped (the output device changed, or its format): it comes back, and what wasn't heard
// plays on. As a new engine, on the device it was on (2026-11-14, the top, "Both channels"): the
// one that stopped was set up for the output as it was. One that couldn't start is tried again as
// it is, its output connected for what the output is by then.
func reroute() {
    guard !engine.isRunning else { return }
    newGeneration()
    player.stop()
    if !down {
        fresh()
        if let device = pinned, !offline, !setDevice(device) { pinned = nil }
    }
    wireOutput()
    do {
        try engine.start()
    } catch {
        if !down { warn("audio engine stopped and can't restart yet (\(error)); still trying, queue kept") }
        down = true
        return
    }
    down = false
    startedOn = (deviceRate(), deviceChannels())
    movedAt = .now() // its time starts over on the new device
    let frames = unheard.reduce(0) { $0 + Int($1.buffer.frameLength) }
    say("rerouted \(msOf(frames))")
    sayChannels("rerouted")
    lookAtRoute()
    if holding { return } // a cue waiting for the link: scheduled once it's awake
    for slice in unheard { schedule(slice) }
    if !unheard.isEmpty { playQueued() }
}

// ── An output that stopped responding (see the top) ─────────────────────────

/** A play failed (`why`: its code): the next step, after retryMs; past the last, given up on as a stall. */
func recover(_ why: String) {
    guard !recovering, !unheard.isEmpty else { return }
    if failedOn == nil { failedOn = deviceName() }
    failures += 1
    guard failures <= 2 else { return stall() }
    let step = failures
    recovering = true
    retryToken += 1
    let token = retryToken
    movedAt = .now() // not a stall while it's being tried again
    say("retry \(step) \(why)")
    queue.asyncAfter(deadline: .now() + .milliseconds(retryMs)) {
        guard recovering, retryToken == token else { return }
        recovering = false
        if unheard.isEmpty { return } // dropped meanwhile ("F"): nothing to play
        if step == 1 { return rebuild(why, device: nil) }
        let fallback = defaultOutput(system: true)
        say("fallback_default \(name(of: fallback))")
        rebuild(why, device: fallback)
    }
}

/**
 * The engine built again from scratch: a new AVAudioEngine with the same nodes, on `device` (nil:
 * the default output, as an engine follows it), started, and what hadn't been heard scheduled again
 * from the start of its slice. One that won't start, with sound queued, is the next step (recover).
 */
func rebuild(_ why: String, device: AudioDeviceID?) {
    newGeneration()
    player.stop()
    fresh()
    pinned = nil
    if let device, offline || (device != 0 && setDevice(device)) {
        pinned = device
        pinnedUntil = .now() + .milliseconds(fallbackHoldMs)
    }
    wireOutput()
    do {
        try engine.start()
    } catch {
        warn("audio engine built again but can't start (\(error))")
        down = true
        if !unheard.isEmpty { recover(String((error as NSError).code)) }
        return
    }
    down = false
    startedOn = (deviceRate(), deviceChannels())
    movedAt = .now()
    say("rebuilt \(why) \(deviceName())")
    sayChannels("rebuilt")
    watchDevice()
    lookAtRoute()
    if holding { return }
    for slice in unheard { schedule(slice) }
    if !unheard.isEmpty { playQueued() }
}

/** The default output device: the system's (alerts, `system`), else the default output; 0 when neither can be read. */
func defaultOutput(system: Bool) -> AudioDeviceID {
    if offline { return 1 }
    for selector in system ? [kAudioHardwarePropertyDefaultSystemOutputDevice, kAudioHardwarePropertyDefaultOutputDevice] : [kAudioHardwarePropertyDefaultOutputDevice] {
        var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        if AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr, id != 0 { return id }
    }
    return 0
}

/** A device's name, as the Sound settings show it ("" when it can't be read). */
func name(of id: AudioDeviceID) -> String {
    if offline { return "offline" }
    var addr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard id != 0, AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &name) == noErr, let cf = name?.takeRetainedValue() else { return "" }
    return (cf as String).replacingOccurrences(of: "\n", with: " ")
}

// The device it plays on, watched for going away (kAudioDevicePropertyDeviceIsAlive): built again on
// the default output then, before a play fails on it.
nonisolated(unsafe) var watched: AudioDeviceID = 0
let aliveListener: AudioObjectPropertyListenerBlock = { _, _ in
    queue.async {
        guard watched != 0 else { return }
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsAlive, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var alive = UInt32(1)
        var size = UInt32(MemoryLayout<UInt32>.size)
        let read = AudioObjectGetPropertyData(watched, &addr, 0, nil, &size, &alive)
        if read != noErr || alive == 0 { rebuild("device_gone", device: nil) }
    }
}
nonisolated(unsafe) var aliveAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsAlive, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
// Its sample rate too: said at once ("rate"), not at the next half-second look.
let rateListener: AudioObjectPropertyListenerBlock = { _, _ in
    queue.async { lookAtRoute() }
}
nonisolated(unsafe) var rateAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyNominalSampleRate, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)

func watchDevice() {
    guard !offline else { return }
    let id = outputDevice()
    guard id != watched else { return }
    if watched != 0 {
        AudioObjectRemovePropertyListenerBlock(watched, &aliveAddress, nil, aliveListener)
        AudioObjectRemovePropertyListenerBlock(watched, &rateAddress, nil, rateListener)
    }
    watched = id
    if id != 0 {
        AudioObjectAddPropertyListenerBlock(id, &aliveAddress, nil, aliveListener)
        AudioObjectAddPropertyListenerBlock(id, &rateAddress, nil, rateListener)
    }
}

// Queued sound none of which has been heard for stallMs: the device isn't taking it. Dropped, and
// said. Also the last step for one whose plays fail (recover): said with the device that failed.
func stall() {
    let frames = unheard.reduce(0) { $0 + Int($1.buffer.frameLength) }
    let name = failedOn ?? deviceName()
    // On the fallback device and it failed too: the next line tries the default output again.
    if pinned != nil { pinnedUntil = .now() }
    failures = 0
    failedOn = nil
    recovering = false
    retryToken += 1
    newGeneration()
    player.stop()
    unheard.removeAll()
    stalledRendering = rendering
    say("stalled \(msOf(frames)) \(rendering ? 1 : 0) \(name)")
    idle()
}

// Every half second: brings a stopped engine back, gives up on sound that isn't coming out, and
// after that watches for the device taking sound again.
func look() {
    reroute()
    lookAtRoute()
    if !unheard.isEmpty { keepAwake() }
    else if awakeSince != nil && DispatchTime.now() >= aliveUntil { keepAliveOff() }
    let clock = renderClock()
    rendering = clock != nil && lastClock != nil && clock! > lastClock! + 0.1
    lastClock = clock
    let waited = Int((DispatchTime.now().uptimeNanoseconds - movedAt.uptimeNanoseconds) / 1_000_000)
    if !unheard.isEmpty && !holding && !recovering && waited >= stallMs {
        stall()
        // The device asked for nothing at all (its render clock stood still): the engine may be what's
        // wedged, with no play left to fail and say so. Built again for what comes next (not offline,
        // where "S" holds the device on purpose).
        if !rendering && !offline { rebuild("stalled", device: nil) }
    } else if stalledRendering == false && rendering {
        stalledRendering = nil
        say("back")
    }
}

// The engine's configuration changed (its device went or changed): it comes back on its own device
// (reroute); one that can't is built again from scratch at once rather than tried every half second.
// Any engine's: it's built again now and then, so the one that said it is checked to be this one.
NotificationCenter.default.addObserver(
    forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil
) { note in
    let from = note.object as AnyObject?
    queue.async {
        guard from === engine else { return }
        reroute()
        if down { rebuild("config", device: nil) }
    }
}

// The default output device changed: an engine kept on a fallback one follows it again, and one
// that didn't move with it (or stopped) is built again on it.
nonisolated(unsafe) var defaultAddress = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
if !offline {
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &defaultAddress, queue) { _, _ in
        // A moment later: the engine's own configuration change usually comes with it, and moves it.
        queue.asyncAfter(deadline: .now() + .milliseconds(250)) {
            guard !recovering else { return }
            if pinned != nil || !engine.isRunning || outputDevice() != defaultOutput(system: false) {
                rebuild("default_changed", device: nil)
            }
        }
    }
}

// Tries again while it can't come back, catches an engine that stopped without saying so, and a
// device that takes no sound.
let watch = DispatchSource.makeTimerSource(queue: queue)
watch.schedule(deadline: .now() + 0.5, repeating: 0.5)
watch.setEventHandler { look() }
watch.resume()

do {
    try engine.start()
} catch {
    warn("cannot start audio engine: \(error)")
    exit(1)
}
queue.sync {
    startedOn = (deviceRate(), deviceChannels())
    lookAtRoute()
    sayChannels("start")
}

// Offline: pulls the engine's output in real time, 10 ms at a time, and counts what isn't silence.
// Real time by the wall clock, as a device pulls it, not one chunk a tick: on a busy machine (a CI
// runner's VM) the timer fires late, or a few ticks at once, and the render fell behind (0 ms of
// a line played 350 ms after "playing"). Each tick renders what the time since the last one asks
// for. Stopped (the engine down, the device taking no sound), nothing is owed: it doesn't catch
// up on the time it didn't play, as a device wouldn't.
// "Q" catches up the same way first, so what it counts is all that real time has asked for until then
// (a tick that came late under load would otherwise leave some of it to the next count).
let render = DispatchSource.makeTimerSource(queue: queue)
let renderChunk = sampleRate / 100
/**
 * Offline: renders what the time since it last did asks for, in the made-up output's format (two
 * channels; at renderRate). What it owes, its clock and what it counts are in the helper's own 24 kHz
 * frames whatever that rate is; a frame counts when either channel has something. On the player queue.
 */
func pull() {
    let now = DispatchTime.now()
    owed += Double(now.uptimeNanoseconds - askedAt.uptimeNanoseconds) / 1e9 * sampleRate
    askedAt = now
    guard engine.isRunning, !held else { return owed = 0 }
    owed = min(owed, sampleRate) // a second at most: a process stopped longer starts again from now
    let each = sampleRate / renderRate // of the helper's frames in one of the output's
    while owed >= renderChunk {
        guard (try? engine.renderOffline(AVAudioFrameCount(renderChunk / each), to: renderOut)) == .success else { return owed = 0 }
        let frames = Int(renderOut.frameLength)
        owed -= Double(frames) * each
        rendered += Int((Double(frames) * each).rounded())
        let left = renderOut.floatChannelData![0]
        let right = renderOut.floatChannelData![1]
        // On a Bluetooth output the keep-alive is under it all: heard is what's louder than that.
        let floor: Float = offlineBluetooth ? keepAliveLevel * 2 : 0
        for i in 0..<frames {
            if left[i] != 0 || right[i] != 0 { output += each }
            if abs(left[i]) > floor || abs(right[i]) > floor { heard += each }
        }
        for levels in [spoken, probed] { levels.add(left: energy(left, frames), right: energy(right, frames), frames: frames) }
    }
}
if offline {
    render.schedule(deadline: .now(), repeating: .milliseconds(10))
    render.setEventHandler { pull() }
    render.resume()
}

say("ready")

let input = FileHandle.standardInput
func read(_ count: Int) -> Data? {
    var data = Data()
    while data.count < count {
        let chunk = input.readData(ofLength: count - data.count)
        if chunk.isEmpty { return nil }
        data.append(chunk)
    }
    return data
}

while let header = read(5) {
    let type = header[header.startIndex]
    let length = header.dropFirst().withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }
    guard let payload = length > 0 ? read(length) : Data() else { break }
    switch type {
    case UInt8(ascii: "A"):
        queue.sync {
            keepAwake()
            enqueue(payload)
        }
    case UInt8(ascii: "B"): queue.sync { cue(payload) }
    case UInt8(ascii: "F"): queue.sync { flush() }
    case UInt8(ascii: "V") where payload.count == 4:
        let bits = payload.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
        let level = Float(bitPattern: bits)
        // The player node's own volume, applied as it renders: heard (or not) within a render cycle.
        // The keep-alive's too: muted, it's silent as well.
        queue.sync {
            player.volume = level.isFinite ? min(1, max(0, level)) : 1
            keepAlive.volume = player.volume
            primeGain()
        }
    case UInt8(ascii: "C"):
        queue.sync {
            engine.stop()
            reroute()
        }
    case UInt8(ascii: "D") where offline:
        queue.sync {
            offlineRate = offlineRate == 48000 ? 24000 : 48000
            engine.stop()
        }
    case UInt8(ascii: "H") where offline: queue.sync { offlineRate = offlineRate == 48000 ? 24000 : 48000 }
    case UInt8(ascii: "S") where offline: queue.sync { held = true }
    case UInt8(ascii: "R") where offline: queue.sync { held = false }
    case UInt8(ascii: "E") where offline && payload.count == 4:
        let n = payload.withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) }
        queue.sync { failPlays = n }
    case UInt8(ascii: "Q") where offline:
        queue.sync {
            pull()
            say("output \(Int(output.rounded())) \(rendered)")
            output = 0
        }
    case UInt8(ascii: "L") where offline:
        queue.sync {
            pull()
            say("levels \(Int(renderRate)) \(renderOut.format.channelCount) \(probed.take())")
        }
    default: break
    }
}
