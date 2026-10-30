// Window Remote launcher.
//
// This tiny program is the part macOS attaches Screen Recording and Accessibility permission to.
// It is meant to be built once and left alone: rebuilding it makes macOS forget those permissions.
// Everything that changes (the capture helper and the web server) runs as its children, so they
// can be rebuilt freely and still use the permissions granted to this launcher.
//
// It starts two children and restarts either one if it stops:
//   core:   the Swift helper (screen capture, video encoding, mouse and keyboard)
//   server: the Node web server the iPhone talks to
// Paths come from ~/Library/Application Support/Window Remote/launcher.json (written by install.sh).
// Signals: TERM or INT stops everything; HUP restarts both children (used after a rebuild).

import Foundation

let home = FileManager.default.homeDirectoryForCurrentUser.path
let supportDir = home + "/Library/Application Support/Window Remote"
let logDir = home + "/Library/Logs/Window Remote"
try? FileManager.default.createDirectory(atPath: supportDir, withIntermediateDirectories: true)
try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)

struct Config {
    var remoteDir = ""
    var node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/usr/local/bin/node"
    var core: String { remoteDir + "/bin/wr-core" }
    var server: String { remoteDir + "/server/server.mjs" }
}

func loadConfig() -> Config {
    var c = Config()
    if let data = FileManager.default.contents(atPath: supportDir + "/launcher.json"),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        if let v = obj["remoteDir"] as? String, !v.isEmpty { c.remoteDir = v }
        if let v = obj["node"] as? String, !v.isEmpty { c.node = v }
    }
    return c
}

func log(_ s: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) launcher: \(s)\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
    let path = logDir + "/launcher.log"
    if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
    if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
}

// One copy at a time.
let lockFd = open(supportDir + "/launcher.lock", O_CREAT | O_RDWR, 0o600)
if lockFd < 0 || flock(lockFd, LOCK_EX | LOCK_NB) != 0 {
    log("another copy is already running; exiting")
    exit(0)
}

// Keep each log under about 20 MB by moving a full one aside with the date in its name.
func logHandle(_ name: String) -> FileHandle? {
    let path = logDir + "/\(name).log"
    if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
       let size = attrs[.size] as? NSNumber, size.intValue > 20_000_000 {
        let f = DateFormatter(); f.dateFormat = "yyyyMMdd-HHmmss"
        try? FileManager.default.moveItem(atPath: path, toPath: logDir + "/\(name)-\(f.string(from: Date())).log")
    }
    if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
    let h = FileHandle(forWritingAtPath: path)
    h?.seekToEndOfFile()
    return h
}

final class Child {
    let name: String
    let args: () -> [String]
    var process: Process?
    var failures = 0
    var startedAt = Date.distantPast
    var stopping = false

    init(name: String, args: @escaping () -> [String]) { self.name = name; self.args = args }

    func start() {
        guard !stopping else { return }
        let a = args()
        guard FileManager.default.isExecutableFile(atPath: a[0]) else {
            log("\(name): \(a[0]) is missing; trying again in 10 seconds")
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { self.start() }
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: a[0])
        p.arguments = Array(a.dropFirst())
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\((loadConfig().node as NSString).deletingLastPathComponent):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env["WR_SUPPORT_DIR"] = supportDir
        env["WR_LAUNCHER_PID"] = String(getpid())
        p.environment = env
        p.currentDirectoryURL = URL(fileURLWithPath: (a.count > 1 ? (a[1] as NSString).deletingLastPathComponent : (a[0] as NSString).deletingLastPathComponent))
        if let h = logHandle(name) { p.standardOutput = h; p.standardError = h }
        p.standardInput = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.exited(proc.terminationStatus) }
        }
        do {
            try p.run()
            process = p
            startedAt = Date()
            log("\(name): started (pid \(p.processIdentifier))")
        } catch {
            log("\(name): could not start: \(error.localizedDescription)")
            exited(-1)
        }
    }

    func exited(_ status: Int32) {
        process = nil
        guard !stopping else { return }
        if Date().timeIntervalSince(startedAt) > 60 { failures = 0 }
        failures += 1
        let delay = min(30.0, pow(2.0, Double(min(failures - 1, 5))) * 0.5)
        log("\(name): stopped (status \(status)); restarting in \(delay) seconds")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { self.start() }
    }

    func restartNow() {
        failures = 0
        if let p = process, p.isRunning { p.terminate() } else { start() }
    }

    func stop() {
        stopping = true
        if let p = process, p.isRunning { p.terminate() }
    }
}

let core = Child(name: "core") { [loadConfig().core] }
let server = Child(name: "server") { let c = loadConfig(); return [c.node, c.server] }
let children = [core, server]

signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN); signal(SIGHUP, SIG_IGN)
var sources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
    let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    s.setEventHandler {
        log("stopping")
        children.forEach { $0.stop() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { exit(0) }
    }
    s.resume(); sources.append(s)
}
let hup = DispatchSource.makeSignalSource(signal: SIGHUP, queue: .main)
hup.setEventHandler { log("restarting children"); children.forEach { $0.restartNow() } }
hup.resume(); sources.append(hup)

log("starting (pid \(getpid()))")
children.forEach { $0.start() }
dispatchMain()
