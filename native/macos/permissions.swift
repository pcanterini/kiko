// The macOS permissions Kiko's helpers need, checked and asked for (src/platform/macos/permissions.ts).
// They're the app this runs in: the helper app (src/platform/macos/helper-app.ts), or the terminal
// app when it runs directly, so what this says is about that app.
//   permissions status          stdout: {"mic":…,"speech":…,"input":…}, each "granted", "denied",
//                               "restricted" or "unknown" (never asked yet). Asks nothing.
//   permissions request <which> asks macOS (mic, speech or input), waits for the answer, then prints
//                               the same JSON. Input Monitoring has no answer to wait for: macOS shows
//                               its prompt (which opens System Settings) and the app is let in only
//                               once you turn it on there, often after the terminal app restarts.
// Input Monitoring is for the talk key's listen-only event tap (hotkey.swift); macOS only says
// whether it's granted, so "unknown" stands for not granted.
import AVFoundation
import CoreGraphics
import Foundation
import Speech

func word(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "unknown"
    }
}

func word(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "unknown"
    }
}

func printStatus() {
    let fields = [
        "mic": word(AVCaptureDevice.authorizationStatus(for: .audio)),
        "speech": word(SFSpeechRecognizer.authorizationStatus()),
        "input": CGPreflightListenEventAccess() ? "granted" : "unknown",
    ]
    let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    fflush(stdout)
}

let args = Array(CommandLine.arguments.dropFirst())
switch (args.first, args.count) {
case ("status", 1):
    printStatus()
case ("request", 2):
    let done = DispatchSemaphore(value: 0)
    switch args[1] {
    case "mic":
        AVCaptureDevice.requestAccess(for: .audio) { _ in done.signal() }
        done.wait()
    case "speech":
        SFSpeechRecognizer.requestAuthorization { _ in done.signal() }
        done.wait()
    case "input":
        _ = CGRequestListenEventAccess()
    default:
        FileHandle.standardError.write("usage: permissions request mic|speech|input\n".data(using: .utf8)!)
        exit(2)
    }
    printStatus()
default:
    FileHandle.standardError.write("usage: permissions status | permissions request mic|speech|input\n".data(using: .utf8)!)
    exit(2)
}
