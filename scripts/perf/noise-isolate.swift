// Apple's Voice Isolation (AUSoundIsolation, aufx 'vois', macOS 13+), offline: the effect behind
// FaceTime's "Voice Isolation" mic mode, run over files with AVAudioEngine's manual rendering. No
// device is opened, nothing is played or recorded. For scripts/perf/noise.ts.
//
//   noise-isolate [--hq]   then stdin lines "<in.wav>\t<out.wav>", one per file
// In and out: 16-bit mono PCM at 16 kHz. The effect runs at 48 kHz (its only format), so each file
// is converted up and back down. "--hq" picks the high-quality voice model (macOS 15+) instead of
// the standard one (the default). Prints "ok <out>" or "error <in> <why>" per line.
import AVFoundation

let hq = CommandLine.arguments.contains("--hq")
let rate48 = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
let pcm16 = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
  let converter = AVAudioConverter(from: buffer.format, to: format)!
  let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1024
  let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity)!
  var fed = false
  var error: NSError?
  let status = converter.convert(to: out, error: &error) { _, inputStatus in
    if fed {
      inputStatus.pointee = .endOfStream
      return nil
    }
    fed = true
    inputStatus.pointee = .haveData
    return buffer
  }
  if status == .error { throw error ?? NSError(domain: "convert", code: 1) }
  return out
}

func isolate(_ input: URL, _ output: URL) throws {
  let file = try AVAudioFile(forReading: input)
  let src = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
  try file.read(into: src)
  let up = try convert(src, to: rate48)

  // A fresh engine and effect per file: no state carried over from the last one.
  let engine = AVAudioEngine()
  let player = AVAudioPlayerNode()
  let desc = AudioComponentDescription(componentType: kAudioUnitType_Effect, componentSubType: 0x766f_6973, componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
  let fx = AVAudioUnitEffect(audioComponentDescription: desc)
  if let p = fx.auAudioUnit.parameterTree?.parameter(withAddress: 1) { p.value = hq ? 0 : 1 }
  if let p = fx.auAudioUnit.parameterTree?.parameter(withAddress: 0) { p.value = 100 }
  engine.attach(player)
  engine.attach(fx)
  engine.connect(player, to: fx, format: rate48)
  engine.connect(fx, to: engine.mainMixerNode, format: rate48)
  try engine.enableManualRenderingMode(.offline, format: rate48, maximumFrameCount: 1024)
  try engine.start()
  player.scheduleBuffer(up, completionHandler: nil)
  player.play()

  // The effect's own delay, rendered past the end and dropped from the start.
  let latency = AVAudioFramePosition((fx.auAudioUnit.latency + engine.outputNode.presentationLatency) * 48000)
  let total = AVAudioFramePosition(up.frameLength) + latency
  let out = AVAudioPCMBuffer(pcmFormat: rate48, frameCapacity: AVAudioFrameCount(total))!
  let chunk = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: engine.manualRenderingMaximumFrameCount)!
  while engine.manualRenderingSampleTime < total {
    let n = min(AVAudioFrameCount(total - engine.manualRenderingSampleTime), chunk.frameCapacity)
    let status = try engine.renderOffline(n, to: chunk)
    guard status == .success else { throw NSError(domain: "render", code: status.rawValue) }
    memcpy(out.floatChannelData![0] + Int(out.frameLength), chunk.floatChannelData![0], Int(chunk.frameLength) * 4)
    out.frameLength += chunk.frameLength
  }
  player.stop()
  engine.stop()
  let trimmed = AVAudioPCMBuffer(pcmFormat: rate48, frameCapacity: up.frameLength)!
  memcpy(trimmed.floatChannelData![0], out.floatChannelData![0] + Int(latency), Int(up.frameLength) * 4)
  trimmed.frameLength = up.frameLength
  let down = try convert(trimmed, to: pcm16)
  let writer = try AVAudioFile(forWriting: output, settings: pcm16.settings, commonFormat: .pcmFormatInt16, interleaved: true)
  try writer.write(from: down)
}

while let line = readLine() {
  let parts = line.split(separator: "\t", maxSplits: 1).map(String.init)
  guard parts.count == 2 else { continue }
  do {
    try isolate(URL(fileURLWithPath: parts[0]), URL(fileURLWithPath: parts[1]))
    print("ok \(parts[1])")
  } catch {
    print("error \(parts[0]) \(error)")
  }
  fflush(stdout)
}
