// wr-core: the Window Remote helper. Runs as a child of the "Window Remote" launcher app (which
// holds the Screen Recording and Accessibility permissions) and does the Mac-side work the web
// server asks for over a private socket: list windows, thumbnails, live video, mouse and keyboard,
// "needs you" scanning, and the pairing-code window.

import AppKit
import ScreenCaptureKit

let args = CommandLine.arguments
if args.count >= 3 && args[1] == "--testpad" { TestPad.run(eventsPath: args[2]) }

let supportDir = ProcessInfo.processInfo.environment["WR_SUPPORT_DIR"]
    ?? FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Application Support/Window Remote"
let socketPath = ProcessInfo.processInfo.environment["WR_SOCKET"] ?? supportDir + "/core.sock"

final class Core {
    let ipc = IPC(path: socketPath)
    lazy var capture = Capture(ipc: ipc)
    let ui = MacUI()
    var scanning = false

    func start() {
        ui.install()
        ui.onPairRequest = { [weak self] in self?.ipc.sendJSON(["type": "pairRequestFromMac"]) }
        ui.onDisconnect = { [weak self] in self?.ipc.sendJSON(["type": "disconnectFromMac"]) }
        ui.onForget = { [weak self] in self?.ipc.sendJSON(["type": "forgetAllFromMac"]) }
        ipc.onConnect = { [weak self] in
            Windows.sentIcons.removeAll()
            self?.ipc.sendJSON(["type": "hello", "pid": getpid()])
            self?.sendStatus()
        }
        ipc.onMessage = { [weak self] m in self?.handle(m) }
        NotificationCenter.default.addObserver(forName: .ipcDisconnected, object: nil, queue: .main) { [weak self] _ in
            self?.capture.stop()
            self?.inputQueue.async { Input.releaseButton() }
            Windows.restoreAll()
        }
        ipc.start()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.sendStatus() }
    }

    /// Never touch screen capture without permission: every attempt makes macOS ask again.
    var canCapture: Bool { CGPreflightScreenCaptureAccess() }

    func status() -> [String: Any] {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
        let locked = (session["CGSSessionScreenIsLocked"] as? Bool) ?? false
        let saver = NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == "com.apple.ScreenSaver.Engine" }
        return ["type": "status", "screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(),
                "locked": locked, "displayAsleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0, "screensaver": saver,
                "streaming": capture.streaming, "capture": capture.stats(), "frontApp": NSWorkspace.shared.frontmostApplication?.localizedName ?? ""]
    }

    func sendStatus() { ipc.sendJSON(status()) }

    func reply(_ m: [String: Any], _ obj: [String: Any]) {
        var o = obj
        if let rid = m["rid"] { o["re"] = rid }
        ipc.sendJSON(o)
    }

    /// Phone coordinates are 0...1 across the whole window or display being streamed.
    func globalPoint(_ m: [String: Any]) -> CGPoint? {
        guard let nx = m["x"] as? Double, let ny = m["y"] as? Double else { return nil }
        let r = capture.req
        let f: CGRect? = r.kind == "display" ? CGDisplayBounds(r.id) : Windows.bounds(of: r.id)
        guard let f else { return nil }
        return CGPoint(x: f.minX + CGFloat(nx) * f.width, y: f.minY + CGFloat(ny) * f.height)
    }

    /// All mouse and keyboard work runs here, one item after another, so a tap is never overtaken
    /// by the drag or key that follows it, and the main thread stays free.
    let inputQueue = DispatchQueue(label: "input", qos: .userInteractive)

    /// Runs on the input queue: bring the streamed window to the front first if needed.
    func ensureFront(_ then: () -> Void) {
        let r = capture.req
        if r.kind == "window", capture.streaming, !Windows.isFront(r.id) {
            Windows.focus(r.id)
            Thread.sleep(forTimeInterval: 0.08)
        }
        then()
    }

    func handle(_ m: [String: Any]) {
        guard let cmd = m["cmd"] as? String else { return }
        switch cmd {
        case "status": reply(m, status())
        case "probeCapture":
            // Diagnostic: try to list shareable content for real (the yes/no answer can be stale).
            Task {
                do { let c = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true); reply(m, ["type": "probe", "ok": true, "windows": c.windows.count]) }
                catch { reply(m, ["type": "probe", "ok": false, "message": error.localizedDescription]) }
            }
        case "requestPermissions":
            if !CGPreflightScreenCaptureAccess() { CGRequestScreenCaptureAccess() }
            if !AXIsProcessTrusted() {
                AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            }
            reply(m, status())
        case "list":
            var l = Windows.list(includeIcons: (m["icons"] as? Bool) ?? true)
            if let rid = m["rid"] { l["re"] = rid }
            ipc.sendJSON(l)
        case "thumbs":
            guard canCapture else { reply(m, ["type": "thumbsDone"]); return }
            let ids = (m["ids"] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.uint32Value }
            let displays = (m["displays"] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.uint32Value }
            let maxW = m["maxW"] as? Int ?? 480
            Task {
                for id in ids {
                    if let img = await Windows.snapshot(windowID: id, displayID: nil, maxW: maxW), let jpg = Images.jpeg(img, quality: 0.72) {
                        ipc.sendImage(meta: ["kind": "thumb", "id": id, "w": img.width, "h": img.height], jpeg: jpg)
                    }
                }
                for d in displays {
                    if let img = await Windows.snapshot(windowID: nil, displayID: d, maxW: maxW), let jpg = Images.jpeg(img, quality: 0.72) {
                        ipc.sendImage(meta: ["kind": "thumb", "id": "d\(d)", "w": img.width, "h": img.height], jpeg: jpg)
                    }
                }
                reply(m, ["type": "thumbsDone"])
            }
        case "stream":
            guard canCapture else {
                ipc.sendJSON(["type": "streamError", "message": "Screen Recording is off for Window Remote.", "permission": true])
                return
            }
            var r = StreamRequest()
            r.kind = m["kind"] as? String == "display" ? "display" : "window"
            r.id = (m["id"] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
            if let c = m["crop"] as? [String: Double] { r.crop = Capture.clampCrop(CGRect(x: c["x"] ?? 0, y: c["y"] ?? 0, width: c["w"] ?? 1, height: c["h"] ?? 1)) }
            r.maxW = m["maxW"] as? Int ?? 1290; r.maxH = m["maxH"] as? Int ?? 2796
            r.fps = m["fps"] as? Int ?? 60; r.bitrate = m["bitrate"] as? Int ?? 10_000_000
            r.jpeg = m["jpeg"] as? Bool ?? false
            if r.kind == "window", (m["focus"] as? Bool) ?? true { Windows.focus(r.id) }
            capture.start(r)
        case "update":
            var crop: CGRect?
            if let c = m["crop"] as? [String: Double] { crop = CGRect(x: c["x"] ?? 0, y: c["y"] ?? 0, width: c["w"] ?? 1, height: c["h"] ?? 1) }
            capture.update(crop: crop, maxW: m["maxW"] as? Int, maxH: m["maxH"] as? Int, fps: m["fps"] as? Int, bitrate: m["bitrate"] as? Int)
        case "jpeg": capture.setJPEG((m["on"] as? Bool) ?? false)
        case "keyframe": capture.keyframe()
        case "profile": capture.setProfile((m["value"] as? String) == "baseline" ? "baseline" : "high")
        case "stopStream": capture.stop(); inputQueue.async { Input.releaseButton() }
        case "focus":
            if let id = (m["id"] as? NSNumber)?.uint32Value { Windows.focus(id) }
        case "input": inputQueue.async { self.input(m) }
        case "phoneLayout":
            if let id = (m["id"] as? NSNumber)?.uint32Value, let w = m["w"] as? Double, let h = m["h"] as? Double {
                let f = Windows.phoneLayout(id, width: w, height: h)
                reply(m, ["type": "layout", "ok": f != nil, "id": id])
            }
        case "restore":
            if let id = (m["id"] as? NSNumber)?.uint32Value { Windows.restore(id) } else { Windows.restoreAll() }
        case "needs":
            guard canCapture else { reply(m, ["type": "needs", "hits": [] as [Any]]); return }
            guard !scanning else { return }
            scanning = true
            let wins = (Windows.list(includeIcons: false)["windows"] as? [[String: Any]]) ?? []
            Task {
                let hits = await Needs.scan(windows: wins, extra: (m["extra"] as? [String]) ?? [])
                scanning = false
                reply(m, ["type": "needs", "hits": hits.map { h in
                    ["id": h.id, "app": h.app, "title": h.title, "reason": h.reason, "score": h.score,
                     "actions": h.actions.map { ["label": $0.label, "kind": $0.kind, "x": $0.x, "y": $0.y, "key": $0.key] }] as [String: Any] }])
            }
        case "answer":
            guard canCapture else { reply(m, ["type": "answered", "ok": false, "message": "Screen Recording is off for Window Remote."]); return }
            guard let id = (m["id"] as? NSNumber)?.uint32Value, let a = m["action"] as? [String: Any] else { return }
            Task {
                let (ok, msg) = await Needs.answer(windowID: id, action: a)
                reply(m, ["type": "answered", "ok": ok, "message": msg, "id": id])
            }
        case "clipboard":
            reply(m, ["type": "clipboard", "text": String((NSPasteboard.general.string(forType: .string) ?? "").prefix(20000))])
        case "focusedText":
            var o: [String: Any] = ["type": "focusedText", "text": false]
            if let f = Smart.focusedText() { o["text"] = true; o["rect"] = ["x": f.minX, "y": f.minY, "w": f.width, "h": f.height] }
            reply(m, o)
        case "showCode":
            // The Window Remote window shows the code big; without it, a small floating panel does.
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "local.window-remote.app") {
                NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
            } else {
                ui.showCode(m["code"] as? String ?? "", seconds: m["seconds"] as? Int ?? 300, device: m["device"] as? String ?? "")
            }
        case "hideCode": ui.hideCode()
        case "uiStatus": ui.setStatus(m["text"] as? String ?? "", active: (m["active"] as? Bool) ?? false)
        case "wake": Input.wake(); reply(m, status())
        default: break
        }
    }

    /// Tell the phone where the click really landed (and what it hit), and whether a text box now has focus.
    func reportClick(_ p: CGPoint, rect: CGRect?, seq: Any?) {
        let r = capture.req
        guard let f: CGRect = r.kind == "display" ? CGDisplayBounds(r.id) : Windows.bounds(of: r.id), f.width > 0 else { return }
        func norm(_ q: CGRect) -> [String: Double] {
            ["x": Double((q.minX - f.minX) / f.width), "y": Double((q.minY - f.minY) / f.height), "w": Double(q.width / f.width), "h": Double(q.height / f.height)]
        }
        var o: [String: Any] = ["type": "clicked", "x": Double((p.x - f.minX) / f.width), "y": Double((p.y - f.minY) / f.height)]
        if let rect { o["rect"] = norm(rect) }
        if let seq { o["seq"] = seq }
        ipc.sendJSON(o)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            if let t = Smart.focusedText() { self.ipc.sendJSON(["type": "textFocus", "on": true, "rect": norm(t)]) }
            else { self.ipc.sendJSON(["type": "textFocus", "on": false]) }
        }
    }

    func input(_ m: [String: Any]) {
        guard let kind = m["kind"] as? String else { return }
        switch kind {
        case "click":
            guard let p = globalPoint(m) else { return }
            let right = (m["button"] as? String) == "right"
            let count = m["count"] as? Int ?? 1
            let radius = CGFloat(m["snap"] as? Double ?? 0)
            ensureFront {
                // Near-misses snap onto the closest button, link or text box (not for precise taps).
                var target = p
                var rect: CGRect?
                if radius > 0 && count == 1 {
                    if let pid = self.capture.req.kind == "window" ? (Windows.info(of: self.capture.req.id)?[kCGWindowOwnerPID as String] as? Int32) : nil { Smart.enable(pid: pid) }
                    let s = Smart.snap(p, radius: min(40, max(4, radius)))
                    target = s.point; rect = s.rect
                }
                Input.click(target, right: right, count: count)
                self.reportClick(target, rect: rect, seq: m["seq"])
            }
        case "down": if let p = globalPoint(m) { ensureFront { Input.down(p) } }
        case "move": if let p = globalPoint(m) { Input.move(p) }
        case "up": if let p = globalPoint(m) { Input.up(p) }
        case "scroll":
            guard let p = globalPoint(m) else { return }
            Input.scroll(p, dx: Int32((m["dx"] as? Double ?? 0).rounded()), dy: Int32((m["dy"] as? Double ?? 0).rounded()), phase: m["phase"] as? String)
        case "key":
            let k = m["key"] as? String ?? ""
            let mods = m["mods"] as? [String] ?? []
            ensureFront { Input.key(k, mods: mods) }
        case "text": if let t = m["text"] as? String { ensureFront { Input.text(t) } }
        case "paste": if let t = m["text"] as? String { ensureFront { DispatchQueue.main.sync { Input.paste(t) } } }
        default: break
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
// Accessibility questions to other apps give up after a quarter second (a frozen app must not stall input).
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
let core = Core()
core.start()
signal(SIGTERM, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler { Windows.restoreAll(); exit(0) }
term.resume()
Log.info("started (pid \(getpid())), socket \(socketPath)")
app.run()
