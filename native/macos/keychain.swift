// Kiko's API keys in the macOS Keychain (src/platform/macos/keychain.ts): generic passwords, one
// service per flavour (sh.kiko.keys, the release's; sh.kiko.dev.keys, Kiko Dev's:
// src/core/name.ts flavourNames), the account the key's name (OPENROUTER_API_KEY…). A key only ever
// comes in on stdin and goes out on stdout, to the app's pipe: never in argv, never on stderr,
// never logged.
//   keychain get <name>…   stdout: a JSON object of the ones found, {"<name>":"<key>"}
//   keychain set <name>    stdin: the key (one line); added, or replaced if there's one already
//   keychain delete <name> exit 0 when one was taken out, 3 when there was none
//   keychain list          stdout: a JSON array of the names it holds (no keys)
//   keychain copy <from>   each key of service <from> this service lacks, copied in (Kiko Dev's
//                          first start: src/core/first-start.ts); the keys never leave this process.
//                          stdout: a JSON array of the names copied (no keys)
// Before the command: `--service <name>` (the service: always given), `--app <name>` (the app's
// name, src/core/name.ts NAME, for the items' label and description: "Kiko: OPENROUTER_API_KEY"),
// `--keychain <path>` (that keychain file instead of the login keychain: only tests use it, with a
// throwaway one made by `security create-keychain`).
// Errors: one line on stderr ("keychain: <what the Security framework says>"), exit 1; exit 4 when
// you said no to the Keychain's "allow access" prompt.
//
// Access: an item this helper adds trusts this helper (its code signature) and no other program,
// so another one reading it gets the Keychain's prompt instead of the key. The helper is signed with
// your developer identity when there is one (native.ts), so a rebuilt helper is still the same
// program to the Keychain; signed ad hoc, a rebuild is a new one and the Keychain asks once more.
import Foundation
import Security

var service = ""
var app = ""

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write("keychain: \(message)\n".data(using: .utf8)!)
    exit(code)
}

func say(_ status: OSStatus) -> String {
    (SecCopyErrorMessageString(status, nil) as String?) ?? "error \(status)"
}

/** A failed call: said, and the exit code for it (the prompt said no to: 4). */
func failed(_ what: String, _ status: OSStatus) -> Never {
    let refused = status == errSecUserCanceled || status == errSecAuthFailed || status == errSecInteractionNotAllowed
    fail("\(what): \(say(status))", code: refused ? 4 : 1)
}

func json(_ value: Any) -> String {
    String(decoding: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
}

/**
 * A keychain file, opened. SecKeychainOpen is deprecated, and still the only way to name a file for
 * SecItem's kSecMatchSearchList and kSecUseKeychain; called through a protocol, so the build is quiet.
 */
protocol KeychainOpening { func open(_ path: String) -> SecKeychain }
struct KeychainOpener: KeychainOpening {
    @available(macOS, deprecated: 10.10)
    func open(_ path: String) -> SecKeychain {
        var opened: SecKeychain?
        let status = SecKeychainOpen(path, &opened)
        guard status == errSecSuccess, let kc = opened else { failed("couldn't open \(path)", status) }
        return kc
    }
}

var args = Array(CommandLine.arguments.dropFirst())

/** Only names like sh.kiko.keys: a service is never anything else. */
func checkService(_ name: String) {
    if name.isEmpty || name.count > 64 || name.contains(where: { !($0.isLowercase || $0.isNumber || $0 == "." || $0 == "-") }) {
        fail("not a service's name: \(name)")
    }
}

// The keychain file asked for, if any: searched and written alone. The service, and the app's name.
var file: SecKeychain? = nil
var filePath: String? = nil
while let option = args.first, option.hasPrefix("--") {
    guard args.count >= 2 else { fail("\(option) needs a value") }
    switch option {
    case "--keychain":
        file = (KeychainOpener() as KeychainOpening).open(args[1])
        filePath = args[1]
    case "--service":
        checkService(args[1])
        service = args[1]
    case "--app":
        app = args[1]
    default: fail("unknown option \(option)")
    }
    args.removeFirst(2)
}
if service.isEmpty { fail("--service <name> is needed") }

/** The query every call starts from: our service (`of`: another), in the file asked for (else the login keychain's list). */
func base(_ account: String? = nil, of: String? = nil) -> [String: Any] {
    var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: of ?? service]
    if let account { q[kSecAttrAccount as String] = account }
    if let file { q[kSecMatchSearchList as String] = [file] }
    return q
}

/** Only names like OPENROUTER_API_KEY: an account is never anything else. */
func checkName(_ name: String) {
    if name.isEmpty || name.count > 64 || name.contains(where: { !($0.isUppercase || $0.isNumber || $0 == "_") }) {
        fail("not a key's name: \(name)")
    }
}

/** The key on stdin: its first line, without the line end. */
func readKey() -> Data {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard var text = String(data: data, encoding: .utf8) else { fail("the key isn't text") }
    if let end = text.firstIndex(where: { $0 == "\n" || $0 == "\r" }) { text = String(text[..<end]) }
    if text.isEmpty { fail("no key on stdin") }
    return Data(text.utf8)
}

/** A key added under `name`, in our service (in the file asked for). */
func add(_ name: String, _ key: Data) {
    var add: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: name,
        kSecAttrLabel as String: app.isEmpty ? name : "\(app): \(name)",
        kSecAttrDescription as String: app.isEmpty ? "API key" : "\(app) API key",
        kSecValueData as String: key,
    ]
    if let file { add[kSecUseKeychain as String] = file }
    let status = SecItemAdd(add as CFDictionary, nil)
    if status != errSecSuccess { failed("couldn't save \(name)", status) }
}

/** The names a service holds (ours, or `of`), sorted; no keys. */
func accounts(of: String? = nil) -> [String] {
    var q = base(of: of)
    q[kSecReturnAttributes as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitAll
    var out: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let items = out as? [[String: Any]] else { failed("couldn't list the keys", status) }
    return items.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
}

guard let command = args.first else { fail("say get, set, delete, list or copy") }
let names = Array(args.dropFirst())

switch command {
case "get":
    var found: [String: String] = [:]
    for name in names {
        checkName(name)
        var q = base(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { continue }
        guard status == errSecSuccess, let data = out as? Data, let key = String(data: data, encoding: .utf8) else { failed("couldn't read \(name)", status) }
        found[name] = key
    }
    print(json(found))

case "set":
    guard names.count == 1 else { fail("set takes one name") }
    let name = names[0]
    checkName(name)
    let key = readKey()
    let update = SecItemUpdate(base(name) as CFDictionary, [kSecValueData as String: key] as CFDictionary)
    if update == errSecItemNotFound {
        add(name, key)
    } else if update != errSecSuccess {
        failed("couldn't save \(name)", update)
    }

case "copy":
    guard names.count == 1 else { fail("copy takes one service") }
    let from = names[0]
    checkService(from)
    if from == service { fail("copy from another service") }
    let have = Set(accounts())
    var copied: [String] = []
    for name in accounts(of: from) where !have.contains(name) {
        checkName(name)
        var q = base(name, of: from)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data else { failed("couldn't read \(name)", status) }
        add(name, data)
        copied.append(name)
    }
    print(json(copied))

case "delete":
    guard names.count == 1 else { fail("delete takes one name") }
    checkName(names[0])
    let status = SecItemDelete(base(names[0]) as CFDictionary)
    if status == errSecItemNotFound { exit(3) }
    if status != errSecSuccess { failed("couldn't remove \(names[0])", status) }

case "list":
    print(json(accounts()))

default:
    fail("unknown command \(command): say get, set, delete, list or copy")
}
