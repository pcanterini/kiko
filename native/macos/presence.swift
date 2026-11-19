// Whether someone is at this Mac, for the phone: a line said while you're at it reaches an away phone
// without a buzz (src/platform/macos/presence.ts). Prints one JSON line and exits:
//   {"idleMs":1234,"locked":false,"asleep":false}
// idleMs: since the last keyboard, mouse or trackpad input (the HID system's idle time); locked: the
// screen is locked, or this session isn't the one on the screen (another user's, fast user switching);
// asleep: the main display is asleep. Nothing else is read.
import CoreGraphics
import Foundation

// kCGAnyInputEventType: any input at all.
let anyInput = CGEventType(rawValue: ~0)!
let idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyInput)
let session = (CGSessionCopyCurrentDictionary() as? [String: Any]) ?? [:]
let screenLocked = (session["CGSSessionScreenIsLocked"] as? Bool) ?? false
let onConsole = (session[kCGSessionOnConsoleKey as String] as? Bool) ?? true
let asleep = CGDisplayIsAsleep(CGMainDisplayID()) != 0
let idleMs = idle.isFinite && idle >= 0 ? Int((idle * 1000).rounded()) : -1
print("{\"idleMs\":\(idleMs),\"locked\":\(screenLocked || !onConsole),\"asleep\":\(asleep)}")
