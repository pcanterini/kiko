// Opus for the phone's audio, with Apple's own codec (AudioToolbox through AVAudioConverter,
// kAudioFormatOpus: the same one the iPhone has). One helper serves many streams, each an encoder
// (16-bit mono PCM in, 20 ms Opus packets out) or a decoder (packets in, PCM out), at 16 or 24 kHz.
//
// Reads framed messages on stdin: 1 byte type + 4 byte little-endian stream id + 4 byte
// little-endian length + payload.
//   "E": open an encoder; payload: rate u32 LE, bitrate u32 LE (bits per second).
//   "D": open a decoder; payload: rate u32 LE.
//   "P": push. To an encoder: 16-bit LE mono PCM at its rate (any length; what's short of a 20 ms
//        frame waits for the next push). To a decoder: packets, each behind a 2-byte big-endian length.
//   "F": flush. An encoder pads what's waiting with silence to a whole frame and encodes it; a decoder
//        has nothing to flush.
//   "C": close the stream (no answer).
// Answers every "E", "D", "P" and "F" with one frame of the same shape, in order:
//   "o": the output (an encoder's: packets behind 2-byte big-endian lengths; a decoder's: PCM), may be
//        empty. "E" and "D" are answered with an empty "o" once the stream is ready.
//   "x": it failed (payload: why, UTF-8); the stream is closed.
import AVFoundation
import Foundation

let frameMs = 20

func pcmFormat(_ rate: Double) -> AVAudioFormat {
    AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!
}

func opusFormat(_ rate: Double) -> AVAudioFormat? {
    var desc = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatOpus, mFormatFlags: 0, mBytesPerPacket: 0,
                                           mFramesPerPacket: UInt32(rate) * UInt32(frameMs) / 1000, mBytesPerFrame: 0,
                                           mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)
    return AVAudioFormat(streamDescription: &desc)
}

struct Failure: Error { let why: String }

final class Encoder {
    let converter: AVAudioConverter
    let pcm: AVAudioFormat
    let opus: AVAudioFormat
    let frame: Int
    var waiting = Data()

    init(rate: Double, bitrate: Int) throws {
        pcm = pcmFormat(rate)
        guard let opus = opusFormat(rate), let converter = AVAudioConverter(from: pcm, to: opus) else {
            throw Failure(why: "no Opus encoder at \(Int(rate)) Hz")
        }
        self.opus = opus
        converter.bitRate = bitrate
        self.converter = converter
        frame = Int(rate) * frameMs / 1000
    }

    func push(_ data: Data) throws -> Data {
        waiting.append(data)
        var out = Data()
        let bytes = frame * 2
        while waiting.count >= bytes {
            out.append(try encode(waiting.prefix(bytes)))
            waiting.removeFirst(bytes)
        }
        return out
    }

    func flush() throws -> Data {
        guard !waiting.isEmpty else { return Data() }
        var last = waiting
        last.append(Data(count: frame * 2 - waiting.count))
        waiting = Data()
        return try encode(last)
    }

    /// One 20 ms frame to one packet, behind its 2-byte length.
    private func encode(_ samples: Data) throws -> Data {
        let input = AVAudioPCMBuffer(pcmFormat: pcm, frameCapacity: AVAudioFrameCount(frame))!
        input.frameLength = AVAudioFrameCount(frame)
        samples.withUnsafeBytes { raw in
            input.int16ChannelData![0].update(from: raw.bindMemory(to: Int16.self).baseAddress!, count: frame)
        }
        let maxPacket = max(converter.maximumOutputPacketSize, 1500)
        let output = AVAudioCompressedBuffer(format: opus, packetCapacity: 1, maximumPacketSize: maxPacket)
        var given = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, state in
            if given {
                state.pointee = .noDataNow
                return nil
            }
            given = true
            state.pointee = .haveData
            return input
        }
        if status == .error { throw Failure(why: "encode: \(error?.localizedDescription ?? "failed")") }
        var out = Data()
        for i in 0..<Int(output.packetCount) {
            guard let d = output.packetDescriptions?[i] else { continue }
            let size = Int(d.mDataByteSize)
            out.append(UInt8(size >> 8))
            out.append(UInt8(size & 0xff))
            out.append(Data(bytes: output.data.advanced(by: Int(d.mStartOffset)), count: size))
        }
        return out
    }
}

final class Decoder {
    let converter: AVAudioConverter
    let pcm: AVAudioFormat
    let opus: AVAudioFormat

    init(rate: Double) throws {
        pcm = pcmFormat(rate)
        guard let opus = opusFormat(rate), let converter = AVAudioConverter(from: opus, to: pcm) else {
            throw Failure(why: "no Opus decoder at \(Int(rate)) Hz")
        }
        self.opus = opus
        self.converter = converter
    }

    func push(_ data: Data) throws -> Data {
        var out = Data()
        var at = data.startIndex
        while at + 2 <= data.endIndex {
            let size = Int(data[at]) << 8 | Int(data[at + 1])
            at += 2
            guard size > 0, at + size <= data.endIndex else { throw Failure(why: "decode: a packet runs past the end") }
            out.append(try decode(data[at..<(at + size)]))
            at += size
        }
        return out
    }

    private func decode(_ packet: Data) throws -> Data {
        let input = AVAudioCompressedBuffer(format: opus, packetCapacity: 1, maximumPacketSize: packet.count)
        packet.withUnsafeBytes { raw in input.data.copyMemory(from: raw.baseAddress!, byteCount: packet.count) }
        input.byteLength = UInt32(packet.count)
        input.packetCount = 1
        input.packetDescriptions![0] = AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(packet.count))
        // Room for Opus's longest packet (120 ms).
        let output = AVAudioPCMBuffer(pcmFormat: pcm, frameCapacity: AVAudioFrameCount(pcm.sampleRate * 0.12))!
        var given = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, state in
            if given {
                state.pointee = .noDataNow
                return nil
            }
            given = true
            state.pointee = .haveData
            return input
        }
        if status == .error { throw Failure(why: "decode: \(error?.localizedDescription ?? "failed")") }
        return Data(bytes: output.int16ChannelData![0], count: Int(output.frameLength) * 2)
    }
}

enum Stream {
    case encoder(Encoder)
    case decoder(Decoder)
}

var streams: [UInt32: Stream] = [:]
let input = FileHandle.standardInput
let output = FileHandle.standardOutput

func read(_ count: Int) -> Data? {
    var data = Data()
    while data.count < count {
        let chunk = input.readData(ofLength: count - data.count)
        if chunk.isEmpty { return nil }
        data.append(chunk)
    }
    return data
}

func u32(_ d: Data, _ at: Int) -> UInt32 {
    let b = [UInt8](d[(d.startIndex + at)..<(d.startIndex + at + 4)])
    return UInt32(b[0]) | UInt32(b[1]) << 8 | UInt32(b[2]) << 16 | UInt32(b[3]) << 24
}

func answer(_ type: Character, _ id: UInt32, _ payload: Data) {
    var frame = Data([type.asciiValue!])
    withUnsafeBytes(of: id.littleEndian) { frame.append(contentsOf: $0) }
    withUnsafeBytes(of: UInt32(payload.count).littleEndian) { frame.append(contentsOf: $0) }
    frame.append(payload)
    output.write(frame)
}

while let header = read(9) {
    let type = Character(UnicodeScalar(header[header.startIndex]))
    let id = u32(header, 1)
    let length = Int(u32(header, 5))
    guard let payload = length == 0 ? Data() : read(length) else { break }
    do {
        switch type {
        case "E":
            guard payload.count >= 8 else { throw Failure(why: "E: rate and bitrate") }
            streams[id] = .encoder(try Encoder(rate: Double(u32(payload, 0)), bitrate: Int(u32(payload, 4))))
            answer("o", id, Data())
        case "D":
            guard payload.count >= 4 else { throw Failure(why: "D: rate") }
            streams[id] = .decoder(try Decoder(rate: Double(u32(payload, 0))))
            answer("o", id, Data())
        case "P", "F":
            switch streams[id] {
            case let .encoder(e)?: answer("o", id, type == "P" ? try e.push(payload) : try e.flush())
            case let .decoder(d)?: answer("o", id, type == "P" ? try d.push(payload) : Data())
            case nil: throw Failure(why: "no stream \(id)")
            }
        case "C":
            streams[id] = nil
        default:
            throw Failure(why: "unknown message \(type)")
        }
    } catch {
        streams[id] = nil
        answer("x", id, Data(((error as? Failure)?.why ?? "\(error)").utf8))
    }
}
