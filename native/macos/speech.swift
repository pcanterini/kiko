// On-device speech-to-text for macOS (SpeechAnalyzer + SpeechTranscriber, macOS 26+).
// Reads framed messages on stdin: 1 byte type + 4 byte little-endian length + payload.
//   "B": a new press starts; payload is its u32 little-endian id.
//   "A": 16-bit little-endian mono PCM at 16 kHz.
//   "E": the press ended; flush and report the final transcript.
//   "C": words to expect (names, product words), a UTF-8 JSON array of strings: given to the
//        analyzer as contextual strings from the next press on.
// Prints JSON lines on stdout: {"type":"ready"}, {"type":"interim","id":…,"text":…} as the
// press's transcript changes, {"type":"final","id":…,"text":…} after "E",
// {"type":"status","message":…} for one-off notices (model download) and {"type":"error","message":…}.
import AVFoundation
import Foundation
import Speech

let locale = Locale(identifier: "en-US")
let inputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

func emit(_ fields: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    fflush(stdout)
}

func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    exit(1)
}

/// The words to expect ("C"), set on each press's analyzer before it starts. On macOS 27.0.1
/// SpeechTranscriber takes them without error but doesn't change what it writes; DictationTranscriber
/// follows them closely ("Ghostty", "clipkit") but transcribes ordinary speech worse, so this stays
/// with SpeechTranscriber and the app's dictionary (dictionary.ts) does the fixing.
var hints: [String] = []
var hintsFailed = false

/// Says once if the analyzer won't take them.
func noteHints(_ error: String?) {
    guard let error, !hintsFailed else { return }
    hintsFailed = true
    emit(["type": "status", "message": "contextual strings not taken: \(error)"])
}

func context(for strings: [String]) -> AnalysisContext {
    let context = AnalysisContext()
    context.contextualStrings[.general] = strings
    return context
}

func makeTranscriber() -> SpeechTranscriber {
    SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
}

/// Downloads the en-US model if this Mac doesn't have it yet (one-off; usually already there).
func ensureModel() async {
    guard SpeechTranscriber.isAvailable else { fail("on-device speech transcription isn't available on this Mac") }
    guard await SpeechTranscriber.supportedLocale(equivalentTo: locale) != nil else { fail("en-US isn't supported") }
    let modules = [makeTranscriber()]
    if await AssetInventory.status(forModules: modules) == .installed { return }
    do {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
            emit(["type": "status", "message": "downloading Apple speech model…"])
            try await request.downloadAndInstall()
        }
    } catch {
        fail("cannot install speech model: \(error.localizedDescription)")
    }
}

/// One press: its own analyzer fed from a stream, plus a task collecting the results.
final class Press: @unchecked Sendable {
    let analyzer: SpeechAnalyzer
    let input: AsyncStream<AnalyzerInput>.Continuation
    let format: AVAudioFormat
    let converter: AVAudioConverter?
    var id = 0
    var results: Task<String, Never>? = nil
    private let stream: AsyncStream<AnalyzerInput>
    private let transcriber: SpeechTranscriber

    /// Loads the model (and sets the words to expect) up front so begin() costs nothing when the key goes down.
    init(hints: [String]) async throws {
        transcriber = makeTranscriber()
        format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: inputFormat) ?? inputFormat
        converter = format == inputFormat ? nil : AVAudioConverter(from: inputFormat, to: format)
        analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .processLifetime))
        try await analyzer.prepareToAnalyze(in: format)
        (stream, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
        hintsError = await setHints(hints)
    }

    /// Why the hints weren't taken in init, if they weren't.
    var hintsError: String? = nil

    /// Best effort: without them it transcribes as before. The error, if any.
    func setHints(_ strings: [String]) async -> String? {
        do {
            try await analyzer.setContext(context(for: strings))
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func start(id: Int) async throws {
        self.id = id
        let transcriber = transcriber
        results = Task {
            var finals: [String] = []
            var volatile = ""
            var last = ""
            let joined = { (finals + [volatile]).joined(separator: " ").split(whereSeparator: \.isWhitespace).joined(separator: " ") }
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    if result.isFinal {
                        finals.append(text)
                        volatile = ""
                    } else {
                        volatile = text
                    }
                    let now = joined()
                    if now != last {
                        last = now
                        emit(["type": "interim", "id": id, "text": now])
                    }
                }
            } catch is CancellationError {
            } catch {
                emit(["type": "error", "message": "transcription failed: \(error.localizedDescription)"])
            }
            return joined()
        }
        try await analyzer.start(inputSequence: stream)
    }

    func feed(_ data: Data) {
        let frames = data.count / 2
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(frames))
        else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        data.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            let out = buffer.int16ChannelData![0]
            for i in 0..<frames { out[i] = Int16(littleEndian: samples[i]) }
        }
        guard let converter else {
            input.yield(AnalyzerInput(buffer: buffer))
            return
        }
        let capacity = AVAudioFrameCount(Double(frames) * format.sampleRate / inputFormat.sampleRate) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
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
        if error == nil, out.frameLength > 0 { input.yield(AnalyzerInput(buffer: out)) }
    }

    /// Ends input and waits for the recognizer to finalize everything it heard.
    func finish() async -> String {
        input.finish()
        do {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
            emit(["type": "error", "message": "finalize failed: \(error.localizedDescription)"])
            await analyzer.cancelAndFinishNow()
        }
        return await results?.value ?? ""
    }

    func cancel() async {
        input.finish()
        await analyzer.cancelAndFinishNow()
        _ = await results?.value
    }
}

enum Command {
    case begin(Int), audio(Data), end, hints([String])
}

// stdin is read on its own thread; commands are handled strictly in order below.
let (commands, sink) = AsyncStream.makeStream(of: Command.self)
Thread.detachNewThread {
    let stdin = FileHandle.standardInput
    func read(_ count: Int) -> Data? {
        var data = Data()
        while data.count < count {
            let chunk = stdin.readData(ofLength: count - data.count)
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
        case UInt8(ascii: "B"):
            let id = payload.count >= 4 ? payload.withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))) } : 0
            sink.yield(.begin(id))
        case UInt8(ascii: "A"): sink.yield(.audio(payload))
        case UInt8(ascii: "E"): sink.yield(.end)
        case UInt8(ascii: "C"):
            if let strings = try? JSONSerialization.jsonObject(with: payload) as? [String] { sink.yield(.hints(strings)) }
        default: break
        }
    }
    sink.finish()
}

await ensureModel()
var next: Press? = nil
var current: Press? = nil
var lastId = 0
do {
    next = try await Press(hints: hints)
    noteHints(next?.hintsError)
} catch {
    fail("cannot start speech analyzer: \(error.localizedDescription)")
}
emit(["type": "ready"])

for await command in commands {
    switch command {
    case .begin(let id):
        lastId = id
        if let stale = current { await stale.cancel() }
        do {
            let press: Press
            if let warm = next { press = warm } else { press = try await Press(hints: hints) }
            next = nil
            try await press.start(id: id)
            current = press
        } catch {
            current = nil
            emit(["type": "error", "message": "cannot start transcription: \(error.localizedDescription)"])
        }
    case .audio(let data):
        current?.feed(data)
    case .hints(let strings):
        hints = strings
        // The warm analyzer takes them now; a press under way keeps what it started with.
        if let warm = next { noteHints(await warm.setHints(strings)) }
    case .end:
        guard let press = current else {
            emit(["type": "final", "id": lastId, "text": ""])
            continue
        }
        current = nil
        emit(["type": "final", "id": press.id, "text": await press.finish()])
        // Warm the analyzer for the next press now rather than when the key goes down.
        next = try? await Press(hints: hints)
        noteHints(next?.hintsError)
    }
}
