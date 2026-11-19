// The live half of scripts/perf/noise-live.ts: plays clips out of a speaker and records a mic at the
// same time, with Apple's voice processing (echo cancellation, noise suppression, AGC) off or on.
// THIS PLAYS SOUND AND OPENS THE MIC: only noise-live.ts runs it, after its preflight.
//
//   noise-live-rec --auth
//     The microphone permission this process has (authorized, denied, notDetermined, restricted).
//   noise-live-rec --list
//     The audio devices as JSON (nothing opened): {inputs: [...], outputs: [...]}, each
//     {id, uid, name, builtIn, isDefault}.
//   noise-live-rec session --input <uid|name|default> --output <uid|name|default> --vp on|off
//       --plan <file: one wav path per line> --out <rec.wav> [--settle 2] [--gap 1]
//     Opens the input (voice processing on or off), waits --settle s (the room's own level, and
//     voice processing's AGC and noise estimate settling), then plays each wav in turn on the
//     output with --gap s between, recording all along, and writes <rec.wav>: 16-bit mono PCM at
//     16 kHz. stdout JSON lines: {"type":"using",…} (the devices really in use, which may differ
//     from the ones asked for once voice processing is on), {"type":"clip","i":…,"start":…} (the
//     recording's frame at 16 kHz when clip i was handed to the output; the sound arrives a little
//     later, which noise-live.ts finds by cross-correlation), {"type":"done","frames":…};
//     {"type":"error","message":…}.
//
// The clips play from their own engine, not the recording one: to the voice processor they are
// sound in the room (a person, a TV), not the app's own output. With voice processing on, the other
// audio ducking is set to the minimum and advanced ducking off (macOS 14+), so it doesn't turn the
// clips down. Whether its echo canceller still treats them as echo (it may reference everything
// the Mac plays) is what noise-live.ts measures.
import AVFoundation
import CoreAudio
import Foundation

let out16 = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

func emit(_ fields: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
  fflush(stdout)
}

func fail(_ message: String) -> Never {
  emit(["type": "error", "message": message])
  exit(1)
}

// ── Devices ─────────────────────────────────────────────────────────────────────────────────────

struct Device {
  let id: AudioDeviceID
  let uid: String
  let name: String
  let builtIn: Bool
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

func uint32Property(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32 {
  var where_ = address(selector)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  AudioObjectGetPropertyData(id, &where_, 0, nil, &size, &value)
  return value
}

func channels(_ id: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Int {
  var where_ = address(kAudioDevicePropertyStreamConfiguration, scope)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &where_, 0, nil, &size) == noErr, size > 0 else { return 0 }
  let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(id, &where_, 0, nil, &size, raw) == noErr else { return 0 }
  return UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self)).reduce(0) { $0 + Int($1.mNumberChannels) }
}

func devices(_ scope: AudioObjectPropertyScope) -> [Device] {
  let system = AudioObjectID(kAudioObjectSystemObject)
  var where_ = address(kAudioHardwarePropertyDevices)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &where_, 0, nil, &size) == noErr else { return [] }
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(system, &where_, 0, nil, &size, &ids) == noErr else { return [] }
  return ids.compactMap { id in
    guard channels(id, scope) > 0, uint32Property(id, kAudioDevicePropertyIsHidden) == 0, let uid = stringProperty(id, kAudioDevicePropertyDeviceUID) else { return nil }
    let builtIn = uint32Property(id, kAudioDevicePropertyTransportType) == kAudioDeviceTransportTypeBuiltIn
    return Device(id: id, uid: uid, name: stringProperty(id, kAudioObjectPropertyName) ?? uid, builtIn: builtIn)
  }
}

func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioDeviceID {
  uint32Property(AudioObjectID(kAudioObjectSystemObject), selector)
}

let inputs = devices(kAudioDevicePropertyScopeInput)
let outputs = devices(kAudioDevicePropertyScopeOutput)
let defaultIn = defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
let defaultOut = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)

func describe(_ d: Device, _ fallback: AudioDeviceID) -> [String: Any] {
  ["id": d.id, "uid": d.uid, "name": d.name, "builtIn": d.builtIn, "isDefault": d.id == fallback]
}

func describe(id: AudioDeviceID) -> [String: Any] {
  guard let d = (inputs + outputs).first(where: { $0.id == id }) else { return ["id": id, "name": stringProperty(id, kAudioObjectPropertyName) ?? "?"] }
  return ["id": d.id, "uid": d.uid, "name": d.name, "builtIn": d.builtIn]
}

// Microphone permission belongs to the app this runs under (the terminal): without it macOS hands
// over digital silence, no error.
if CommandLine.arguments.contains("--auth") {
  print(["notDetermined", "restricted", "denied", "authorized"][AVCaptureDevice.authorizationStatus(for: .audio).rawValue])
  exit(0)
}

if CommandLine.arguments.contains("--list") {
  emit(["inputs": inputs.map { describe($0, defaultIn) }, "outputs": outputs.map { describe($0, defaultOut) }])
  exit(0)
}

// ── A session ───────────────────────────────────────────────────────────────────────────────────

func arg(_ name: String) -> String? {
  guard let i = CommandLine.arguments.firstIndex(of: name), i + 1 < CommandLine.arguments.count else { return nil }
  return CommandLine.arguments[i + 1]
}

func find(_ wanted: String, in list: [Device], fallback: AudioDeviceID) -> Device {
  if wanted == "default", let d = list.first(where: { $0.id == fallback }) { return d }
  if let d = list.first(where: { $0.uid == wanted }) ?? list.first(where: { $0.name == wanted }) ?? list.first(where: { $0.name.localizedCaseInsensitiveContains(wanted) }) { return d }
  fail("no device \"\(wanted)\" (have: \(list.map(\.name).joined(separator: ", ")))")
}

func currentDevice(_ unit: AudioUnit, element: AudioUnitElement) -> AudioDeviceID {
  var id: AudioDeviceID = 0
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, element, &id, &size)
  return id
}

@discardableResult
func setDevice(_ unit: AudioUnit, _ device: AudioDeviceID, element: AudioUnitElement) -> OSStatus {
  var id = device
  return AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, element, &id, UInt32(MemoryLayout<AudioDeviceID>.size))
}

guard CommandLine.arguments.dropFirst().first == "session" else { fail("usage: noise-live-rec --list | session …") }
let input = find(arg("--input") ?? "default", in: inputs, fallback: defaultIn)
let output = find(arg("--output") ?? "default", in: outputs, fallback: defaultOut)
let vp = arg("--vp") == "on"
let settle = Double(arg("--settle") ?? "2") ?? 2
let gap = Double(arg("--gap") ?? "1") ?? 1
guard let planPath = arg("--plan"), let outPath = arg("--out") else { fail("--plan and --out are needed") }
let plan = (try? String(contentsOfFile: planPath, encoding: .utf8))?.split(separator: "\n").map(String.init).filter { !$0.isEmpty } ?? []

// The recording engine: the chosen input; with voice processing, its output side is the chosen
// output too (the voice processor's echo reference), playing nothing.
let rec = AVAudioEngine()
var notes: [String] = []
if vp {
  do {
    try rec.inputNode.setVoiceProcessingEnabled(true)
  } catch {
    fail("voice processing could not be turned on: \(error)")
  }
  if #available(macOS 14.0, *) {
    rec.inputNode.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
  } else {
    notes.append("macOS < 14: other-audio ducking can't be turned down; the clips may be ducked")
  }
  // The voice-processing unit (the input and output nodes share it) takes its input device on
  // element 1 and its output device on element 0, set in that order (tried on macOS 27.0.1).
  if let unit = rec.inputNode.audioUnit {
    let a = currentDevice(unit, element: 1) == input.id ? noErr : setDevice(unit, input.id, element: 1)
    let b = currentDevice(unit, element: 0) == output.id ? noErr : setDevice(unit, output.id, element: 0)
    if a != noErr || b != noErr { notes.append("setting voice processing's devices: input \(a), output \(b)") }
  }
} else if let unit = rec.inputNode.audioUnit {
  let err = setDevice(unit, input.id, element: 0)
  if err != noErr { notes.append("setting the input device: \(err)") }
}
// No mixer on the recording engine: with voice processing on, touching mainMixerNode left the input
// with no format (0 ch) and the engine failing to start (kAUInitialize, -10875) on macOS 27.0.1;
// without it the voice-processing unit runs both sides by itself.

// The tap's format: with voice processing on, several channels (5 on a USB mic, macOS 27); the
// processed voice is taken to be the first, so only channel 0 is kept; each channel's level is
// reported at the end ("done"), to check that.
let inFormat = rec.inputNode.outputFormat(forBus: 0)
guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else { fail("no usable input format (\(inFormat))") }
let mono = AVAudioFormat(standardFormatWithSampleRate: inFormat.sampleRate, channels: 1)!
guard let converter = AVAudioConverter(from: mono, to: out16) else { fail("no converter from \(mono)") }
var channelPower = [Double](repeating: 0, count: Int(inFormat.channelCount))
var tapFrames = 0
let lock = NSLock()
var recorded = Data()
var frames: Int64 = 0
rec.inputNode.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { whole, _ in
  guard let data = whole.floatChannelData, let buffer = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: whole.frameLength) else { return }
  buffer.frameLength = whole.frameLength
  memcpy(buffer.floatChannelData![0], data[0], Int(whole.frameLength) * 4)
  lock.lock()
  for c in 0..<Int(whole.format.channelCount) {
    var p = 0.0
    for i in 0..<Int(whole.frameLength) { p += Double(data[c][i] * data[c][i]) }
    channelPower[c] += p
  }
  tapFrames += Int(whole.frameLength)
  lock.unlock()
  let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16000 / inFormat.sampleRate) + 16
  guard let out = AVAudioPCMBuffer(pcmFormat: out16, frameCapacity: capacity) else { return }
  var fed = false
  var error: NSError?
  converter.convert(to: out, error: &error) { _, status in
    if fed {
      status.pointee = .noDataNow
      return nil
    }
    fed = true
    status.pointee = .haveData
    return buffer
  }
  guard error == nil, out.frameLength > 0 else { return }
  lock.lock()
  recorded.append(Data(bytes: out.int16ChannelData![0], count: Int(out.frameLength) * 2))
  frames += Int64(out.frameLength)
  lock.unlock()
}

// The playing engine: the chosen output, nothing else.
let play = AVAudioEngine()
let player = AVAudioPlayerNode()
play.attach(player)
if let unit = play.outputNode.audioUnit {
  let err = setDevice(unit, output.id, element: 0)
  if err != noErr { notes.append("setting the output device: \(err)") }
}

do {
  try rec.start()
} catch {
  fail("cannot start recording: \(error)")
}
var using: [String: Any] = ["type": "using", "vp": vp, "asked": ["input": describe(input, defaultIn), "output": describe(output, defaultOut)], "inputFormat": "\(inFormat)"]
if let unit = rec.inputNode.audioUnit {
  using["recordingFrom"] = describe(id: currentDevice(unit, element: vp ? 1 : 0))
  if vp { using["echoReference"] = describe(id: currentDevice(unit, element: 0)) }
}
if let unit = play.outputNode.audioUnit { using["playingTo"] = describe(id: currentDevice(unit, element: 0)) }
if vp {
  using["agc"] = rec.inputNode.isVoiceProcessingAGCEnabled
  if #available(macOS 14.0, *) {
    let d = rec.inputNode.voiceProcessingOtherAudioDuckingConfiguration
    using["ducking"] = ["advanced": d.enableAdvancedDucking, "level": d.duckingLevel.rawValue]
  }
}
using["notes"] = notes
emit(using)

Thread.sleep(forTimeInterval: settle)
var connectedFormat: AVAudioFormat? = nil
for (i, path) in plan.enumerated() {
  guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)),
    let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
    (try? file.read(into: buffer)) != nil
  else { fail("cannot read \(path)") }
  if connectedFormat != file.processingFormat {
    play.stop()
    play.connect(player, to: play.mainMixerNode, format: file.processingFormat)
    connectedFormat = file.processingFormat
    do {
      try play.start()
    } catch {
      fail("cannot start playing: \(error)")
    }
  }
  let done = DispatchSemaphore(value: 0)
  lock.lock()
  let start = frames
  lock.unlock()
  player.scheduleBuffer(buffer, at: nil, options: [], completionCallbackType: .dataPlayedBack) { _ in done.signal() }
  player.play()
  emit(["type": "clip", "i": i, "start": start, "file": path])
  done.wait()
  Thread.sleep(forTimeInterval: gap)
}
player.stop()
play.stop()
rec.inputNode.removeTap(onBus: 0)
rec.stop()

// The recording as a WAV file.
lock.lock()
let pcm = recorded
lock.unlock()
var head = Data()
func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { head.append(contentsOf: $0) } }
func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { head.append(contentsOf: $0) } }
head.append("RIFF".data(using: .ascii)!)
le32(UInt32(36 + pcm.count))
head.append("WAVEfmt ".data(using: .ascii)!)
le32(16); le16(1); le16(1); le32(16000); le32(32000); le16(2); le16(16)
head.append("data".data(using: .ascii)!)
le32(UInt32(pcm.count))
do {
  try (head + pcm).write(to: URL(fileURLWithPath: outPath))
} catch {
  fail("cannot write \(outPath): \(error)")
}
lock.lock()
let channelDb = channelPower.map { tapFrames > 0 ? (10 * log10($0 / Double(tapFrames) + 1e-12) * 10).rounded() / 10 : -120 }
lock.unlock()
emit(["type": "done", "frames": pcm.count / 2, "channelDb": channelDb])
