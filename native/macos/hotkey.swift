// Global push-to-talk key watcher for macOS.
// Usage: hotkey <virtual keycode>. Prints "down" / "up" lines on stdout.
//        hotkey capture. Prints "key <virtual keycode>" for the next key pressed, then exits.
// Uses a listen-only event tap, so the app it runs in needs Input Monitoring: the helper app
// (src/platform/macos/helper-app.ts), or the terminal when it runs directly.
import CoreGraphics
import Foundation

let capture = CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "capture"
guard CommandLine.arguments.count == 2, capture || Int64(CommandLine.arguments[1]) != nil else {
    FileHandle.standardError.write("usage: hotkey <virtual keycode> | hotkey capture\n".data(using: .utf8)!)
    exit(2)
}
let keycode = Int64(CommandLine.arguments[1]) ?? -1

// The event tap callback is a C function pointer and can't capture locals, so state lives here.
enum State {
    nonisolated(unsafe) static var keycode: Int64 = 0
    nonisolated(unsafe) static var isDown = false
    nonisolated(unsafe) static var tap: CFMachPort?
    nonisolated(unsafe) static var capture = false
}
State.keycode = keycode
State.capture = capture

// Device-specific modifier bits (IOKit NX_DEVICE*KEYMASK), so left and right sides are told apart.
let modifierMasks: [Int64: UInt64] = [
    59: 0x0001,  // left control
    56: 0x0002,  // left shift
    60: 0x0004,  // right shift
    55: 0x0008,  // left command
    54: 0x0010,  // right command
    58: 0x0020,  // left option
    61: 0x0040,  // right option
    62: 0x2000,  // right control
    63: 0x800000,  // fn (CGEventFlags.maskSecondaryFn)
]

func emit(_ down: Bool) {
    guard down != State.isDown else { return }
    State.isDown = down
    print(down ? "down" : "up")
    fflush(stdout)
}

let callback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = State.tap { CGEvent.tapEnable(tap: tap, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    if State.capture {
        let pressed = event.getIntegerValueField(.keyboardEventKeycode)
        let isPress = type == .keyDown || (type == .flagsChanged && modifierMasks[pressed].map { event.flags.rawValue & $0 != 0 } == true)
        if isPress {
            print("key \(pressed)")
            fflush(stdout)
            exit(0)
        }
        return Unmanaged.passUnretained(event)
    }
    let keycode = State.keycode
    guard event.getIntegerValueField(.keyboardEventKeycode) == keycode else {
        return Unmanaged.passUnretained(event)
    }
    switch type {
    case .flagsChanged:
        if let mask = modifierMasks[keycode] {
            emit(event.flags.rawValue & mask != 0)
        }
    case .keyDown:
        emit(true)
    case .keyUp:
        emit(false)
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
    | (1 << CGEventType.flagsChanged.rawValue)
guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
    eventsOfInterest: CGEventMask(mask), callback: callback, userInfo: nil
) else {
    FileHandle.standardError.write("hotkey: cannot create event tap; Input Monitoring isn't on for the app this runs in (the helper app, or the terminal)\n".data(using: .utf8)!)
    exit(1)
}
State.tap = tap
let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
// It reads nothing (its stdin is /dev/null) and writes only on a press, so an app that's gone would
// leave it running until the next press: it ends once its parent is gone instead (the app, or the
// helper app; it's left to launchd then), looked at every second.
let parent = getppid()
let orphaned = CFRunLoopTimerCreateWithHandler(nil, CFAbsoluteTimeGetCurrent() + 1, 1, 0, 0) { _ in
    if getppid() != parent || parent == 1 { exit(0) }
}
CFRunLoopAddTimer(CFRunLoopGetCurrent(), orphaned, .commonModes)
print("ready")
fflush(stdout)
CFRunLoopRun()
