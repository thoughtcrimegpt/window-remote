// Window Remote: the Mac app (the window you open from the Dock, Spotlight or Launchpad).
// It shows whether the iPhone is connected, pairs a new iPhone (QR code + pairing code), lists the
// paired phones, checks permissions, and has the start-at-login switch. The remote itself runs in
// the background helper (~/Library/Application Support/Window Remote/Window Remote Helper.app),
// so closing this window does not stop it. Talks only to the local server on 127.0.0.1 with a key only this Mac user can read.

import SwiftUI
import AppKit
import CoreImage.CIFilterBuiltins

let home = FileManager.default.homeDirectoryForCurrentUser.path
let supportDir = home + "/Library/Application Support/Window Remote"
let logDir = home + "/Library/Logs/Window Remote"
let api = URL(string: "http://127.0.0.1:8765/api/admin/")!

/** A line in ~/Library/Logs/Window Remote/app.log (only when something changes, never every second). */
func appLog(_ s: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) app: \(s)\n"
    let path = logDir + "/app.log"
    try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
    if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
}

/** Runs a small system tool and returns its exit status. */
@discardableResult
func run(_ tool: String, _ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: tool)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    do { try p.run(); p.waitUntilExit(); return p.terminationStatus } catch { return -1 }
}

// MARK: - data from the server

struct Client: Decodable, Identifiable {
    var id: String { device + (viewing ?? "") }
    let device: String
    let viewing: String?
    let basic: Bool?
    let fps: Int?
    let delayMs: Int?
    let mbps: Double?
}
struct Device: Decodable, Identifiable {
    let id: String
    let name: String
    let paired: String?
    let lastSeen: String?
    let online: Bool
}
struct Pairing: Decodable { let code: String; let seconds: Int; let forDevice: String }
struct AdminState: Decodable {
    let helper: Bool
    let screen: Bool?
    let accessibility: Bool?
    let locked: Bool
    let displayAsleep: Bool
    let tailscale: Bool
    let phoneUrl: String?
    let secureUrl: String?
    let clients: [Client]
    let devices: [Device]
    let pairing: Pairing?
    let pausedFor: Int
    let loginItem: Bool
}

@MainActor
final class Model: ObservableObject {
    @Published var state: AdminState?
    @Published var reachable = true
    @Published var note: String?
    @Published var loginBusy = false
    /// Seconds the helper has been running while the server does not answer (0 when it answers).
    @Published var stuckFor = 0
    private var misses = 0
    private var startedHelper = false
    private var unreachableSince: Date?
    private var loggedStuck = false
    private var askedPermissions = false
    private var timer: Timer?

    /// The background helper lives on its own (not inside this app), so macOS ties Screen Recording
    /// to it directly and rebuilding this window app never affects the permission.
    var helperURL: URL { URL(fileURLWithPath: supportDir + "/Window Remote Helper.app") }
    /// The name the helper shows in System Settings ("Window Remote Helper"; older installs: "Window Remote").
    var helperName: String { (Bundle(url: helperURL)?.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? "Window Remote Helper" }
    var key: String { ((try? String(contentsOfFile: supportDir + "/admin.key", encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }

    func start() {
        Task { await refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in Task { await self?.refresh() } }
    }

    func refresh() async {
        guard let (obj, _) = await call("state", post: false), let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = try? JSONDecoder().decode(AdminState.self, from: data) else {
            misses += 1
            if misses >= 2 {
                reachable = false
                let since = unreachableSince ?? Date()
                unreachableSince = since
                if helperRunning() {
                    // Starting it again would only make a second copy that exits at once: say what is wrong instead.
                    stuckFor = Int(Date().timeIntervalSince(since))
                    if stuckFor >= 30 && !loggedStuck {
                        loggedStuck = true
                        appLog("the helper is running but the server has not answered for 30 s; macOS may be waiting on a permission prompt (look behind other windows), or run ./install.sh again")
                    }
                } else {
                    stuckFor = 0
                    startHelperIfNeeded()
                }
            }
            return
        }
        if loggedStuck { appLog("the server is answering again"); loggedStuck = false }
        misses = 0
        unreachableSince = nil
        stuckFor = 0
        reachable = true
        state = s
        // Ask macOS once per launch, so the helper shows up in the Screen Recording and Accessibility lists.
        if s.helper, s.screen == false || s.accessibility == false, !askedPermissions {
            askedPermissions = true
            appLog("asking macOS for the missing permissions")
            await askPermissions()
        }
    }

    func helperRunning() -> Bool { run("/usr/bin/pgrep", ["-x", "WindowRemote"]) == 0 }

    /// Restarts the helper's two parts (they pick up a permission that was just turned on).
    func restartHelper() {
        run("/usr/bin/pkill", ["-HUP", "-x", "WindowRemote"])
        appLog("restarted the helper")
        note = "Restarting the helper…"
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { if self.note == "Restarting the helper…" { self.note = nil } }
    }

    func showHelperInFinder() { NSWorkspace.shared.activateFileViewerSelecting([helperURL]) }

    /// If the remote is not running (after a restart, before "start at login" is on), start it.
    func startHelperIfNeeded() {
        guard !startedHelper, FileManager.default.fileExists(atPath: helperURL.path) else { return }
        startedHelper = true
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = false
        cfg.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: helperURL, configuration: cfg) { _, _ in }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { self.startedHelper = false }
    }

    @discardableResult
    func call(_ action: String, post: Bool = true, body: [String: Any] = [:]) async -> ([String: Any], Int)? {
        var req = URLRequest(url: api.appendingPathComponent(action), timeoutInterval: action == "loginItem" ? 40 : 4)
        req.setValue(key, forHTTPHeaderField: "X-WR-Admin")
        req.setValue("127.0.0.1:8765", forHTTPHeaderField: "Host")
        if post {
            req.httpMethod = "POST"
            req.setValue("1", forHTTPHeaderField: "X-WR")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return (obj, (resp as? HTTPURLResponse)?.statusCode ?? 0)
    }

    func pair() async { await call("pair"); await refresh() }
    func forget(_ d: Device) async { await call("forget", body: ["id": d.id]); await refresh() }
    func pause(_ minutes: Int) async { await call("pause", body: ["minutes": minutes]); await refresh() }
    func askPermissions() async { await call("permissions") }
    func setLoginItem(_ on: Bool) async {
        loginBusy = true
        if let (r, _) = await call("loginItem", body: ["on": on]), r["ok"] as? Bool == false { note = r["message"] as? String }
        loginBusy = false
        await refresh()
    }
}

// MARK: - helpers

func openSettings(_ pane: String) {
    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!)
}

func qrImage(_ text: String) -> NSImage? {
    let f = CIFilter.qrCodeGenerator()
    f.message = Data(text.utf8)
    f.correctionLevel = "M"
    guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return nil }
    let rep = NSCIImageRep(ciImage: out)
    let img = NSImage(size: rep.size)
    img.addRepresentation(rep)
    return img
}

func relative(_ iso: String?) -> String {
    guard let iso, let d = ISO8601DateFormatter().date(from: iso) else { return "" }
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .full
    return f.localizedString(for: d, relativeTo: Date())
}

// MARK: - views

struct Card<Content: View>: View {
    let title: String
    var systemImage: String? = nil
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: systemImage ?? "circle").labelStyle(TitleOnly(show: systemImage != nil))
                .font(.headline)
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 14))
    }
}
struct TitleOnly: LabelStyle {
    let show: Bool
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) { if show { configuration.icon.foregroundStyle(.tint) }; configuration.title }
    }
}

struct StatusHeader: View {
    @EnvironmentObject var m: Model
    var body: some View {
        let (text, color) = status
        HStack(spacing: 14) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 56, height: 56)
            VStack(alignment: .leading, spacing: 3) {
                Text("Window Remote").font(.title2.weight(.semibold))
                HStack(spacing: 6) {
                    Circle().fill(color).frame(width: 9, height: 9)
                    Text(text).foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
    }
    var status: (String, Color) {
        guard m.reachable, let s = m.state else { return ("Starting…", .orange) }
        if !s.helper { return ("Starting the helper…", .orange) }
        if s.screen == false || s.accessibility == false { return ("Needs your attention", .red) }
        if !s.tailscale { return ("Tailscale is off", .red) }
        if s.pausedFor > 0 { return ("Paused for \(max(1, s.pausedFor / 60)) more minutes", .orange) }
        if let c = s.clients.first(where: { $0.viewing != nil }), let v = c.viewing { return ("\(c.device) is viewing \(v)", .green) }
        if let c = s.clients.first { return ("\(c.device) is connected", .green) }
        if s.locked { return ("Ready (unlock the Mac to use it)", .yellow) }
        return ("Ready for your iPhone", .green)
    }
}

struct AttentionCard: View {
    @EnvironmentObject var m: Model
    let s: AdminState
    var body: some View {
        if s.screen == false || s.accessibility == false || !s.tailscale {
            Card(title: "Needs your attention", systemImage: "exclamationmark.triangle.fill") {
                if s.screen == false {
                    Fix(text: "Screen Recording is off, so your iPhone cannot see the screen.", button: "Open Settings") {
                        Task { await m.askPermissions(); openSettings("Privacy_ScreenCapture") }
                    }
                }
                if s.accessibility == false {
                    Fix(text: "Accessibility is off, so taps and typing from your iPhone cannot reach the Mac.", button: "Open Settings") {
                        Task { await m.askPermissions(); openSettings("Privacy_Accessibility") }
                    }
                }
                if s.screen == false || s.accessibility == false {
                    Text("Turn on the switch next to **\(m.helperName)** (the background part of Window Remote, with this app's icon). Not in the list? Click Show Helper in Finder, then drag it into the list. After turning on Screen Recording, click Restart Helper (or Quit & Reopen, if macOS offers it).")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Show Helper in Finder") { m.showHelperInFinder() }
                        Button("Restart Helper") { m.restartHelper() }
                    }
                }
                if !s.tailscale {
                    if FileManager.default.fileExists(atPath: "/Applications/Tailscale.app") {
                        Fix(text: "Tailscale is off or signed out on this Mac, so your iPhone cannot reach it. Turn it on and sign in with the same account as your iPhone.", button: "Open Tailscale") {
                            NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Tailscale.app"))
                        }
                    } else {
                        Fix(text: "Tailscale is not installed. Install it on this Mac and your iPhone, and sign in with the same account on both.", button: "Get Tailscale") {
                            NSWorkspace.shared.open(URL(string: "https://tailscale.com/download")!)
                        }
                    }
                }
                if let note = m.note { Text(note).font(.caption).foregroundStyle(.orange) }
            }
            .tint(.orange)
        }
    }
}
struct Fix: View {
    let text: String; let button: String; let action: () -> Void
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text).fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button(button, action: action)
        }
    }
}

struct LiveCard: View {
    @EnvironmentObject var m: Model
    let s: AdminState
    var body: some View {
        if !s.clients.isEmpty {
            Card(title: "Connected now", systemImage: "iphone.radiowaves.left.and.right") {
                ForEach(s.clients) { c in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c.device).font(.body.weight(.medium))
                            Text(c.viewing.map { "Viewing \($0)" } ?? "On the home screen").foregroundStyle(.secondary).font(.callout)
                        }
                        Spacer()
                        if let fps = c.fps, let d = c.delayMs {
                            Text(c.basic == true ? "basic video" : "\(fps) fps · \(d) ms").font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                }
                HStack {
                    Spacer()
                    Button("Disconnect and pause 10 minutes") { Task { await m.pause(10) } }
                }
            }
        }
    }
}

struct PairCard: View {
    @EnvironmentObject var m: Model
    let s: AdminState
    @State private var expanded = false
    var body: some View {
        let first = s.devices.isEmpty
        Card(title: first ? "Set up your iPhone" : "Pair another iPhone", systemImage: "qrcode") {
            if let p = s.pairing {
                VStack(spacing: 6) {
                    Text(p.code.map(String.init).joined(separator: " "))
                        .font(.system(size: 46, weight: .bold, design: .rounded).monospacedDigit())
                        .frame(maxWidth: .infinity)
                        .textSelection(.enabled)
                    Text("Type this code on your iPhone\(p.forDevice.isEmpty ? "" : " (\(p.forDevice))"). It works once, for \(max(1, p.seconds / 60)) more minutes.")
                        .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: .infinity)
                }
                .padding(.vertical, 6)
            } else if first || expanded {
                HStack(alignment: .top, spacing: 16) {
                    if let url = s.phoneUrl, let qr = qrImage(url) {
                        Image(nsImage: qr).interpolation(.none).resizable().frame(width: 132, height: 132)
                            .padding(8).background(.white, in: RoundedRectangle(cornerRadius: 10))
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Step(n: 1, text: "Turn on Tailscale on your iPhone.")
                        Step(n: 2, text: "Point the iPhone camera at this code and tap the link.")
                        Step(n: 3, text: "In Safari tap Share, then Add to Home Screen.")
                        Step(n: 4, text: "Open Remote from your Home Screen and tap Show a code on my Mac. The code appears right here.")
                    }
                }
                if let url = s.phoneUrl {
                    HStack {
                        Text(url).font(.callout.monospaced()).textSelection(.enabled).foregroundStyle(.secondary)
                        Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(url, forType: .string) } label: { Image(systemName: "doc.on.doc") }
                            .buttonStyle(.borderless).help("Copy the address")
                        Spacer()
                        Button("Show a code now") { Task { await m.pair() } }
                    }
                }
            } else {
                HStack {
                    Text("Add a second phone or set yours up again.").foregroundStyle(.secondary)
                    Spacer()
                    Button("Show me how") { expanded = true }
                }
            }
        }
    }
}
struct Step: View {
    let n: Int; let text: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(n)").font(.caption.weight(.bold)).frame(width: 20, height: 20).background(Circle().fill(.tint.opacity(0.2)))
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct DevicesCard: View {
    @EnvironmentObject var m: Model
    let s: AdminState
    @State private var confirm: Device?
    var body: some View {
        if !s.devices.isEmpty {
            Card(title: "Paired phones", systemImage: "iphone") {
                ForEach(s.devices) { d in
                    HStack {
                        Image(systemName: "iphone").foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(d.name)
                            Text(d.online ? "Connected now" : "Last used \(relative(d.lastSeen))").font(.caption).foregroundStyle(d.online ? .green : .secondary)
                        }
                        Spacer()
                        Button("Forget…") { confirm = d }
                    }
                }
            }
            .alert("Forget \(confirm?.name ?? "this phone")?", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } })) {
                Button("Forget", role: .destructive) { if let d = confirm { Task { await m.forget(d) } } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("It disconnects now and has to pair again with a new code from this Mac. Use this for a lost phone.") }
        }
    }
}

struct SettingsCard: View {
    @EnvironmentObject var m: Model
    let s: AdminState
    var body: some View {
        Card(title: "Settings", systemImage: "gearshape") {
            Toggle(isOn: Binding(get: { s.loginItem }, set: { on in Task { await m.setLoginItem(on) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Start when I log in")
                    Text("Keeps the remote ready after the Mac restarts, and restarts it if it ever stops.").font(.caption).foregroundStyle(.secondary)
                }
            }
            .toggleStyle(.switch)
            .disabled(m.loginBusy)
            Divider()
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.pausedFor > 0 ? "Paused" : "Pause the remote")
                    Text(s.pausedFor > 0 ? "No phone can connect for \(max(1, s.pausedFor / 60)) more minutes." : "Disconnects any phone and blocks it for a while.").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if s.pausedFor > 0 { Button("Resume now") { Task { await m.pause(0) } } }
                else { Menu("Pause") { Button("10 minutes") { Task { await m.pause(10) } }; Button("1 hour") { Task { await m.pause(60) } }; Button("Until tomorrow") { Task { await m.pause(12 * 60) } } }.fixedSize() }
            }
            if let note = m.note { Text(note).font(.caption).foregroundStyle(.orange) }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var m: Model
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                StatusHeader()
                if let s = m.state, m.reachable {
                    AttentionCard(s: s)
                    LiveCard(s: s)
                    PairCard(s: s)
                    DevicesCard(s: s)
                    SettingsCard(s: s)
                } else {
                    if m.stuckFor >= 10 {
                        Card(title: "The remote is not answering", systemImage: "exclamationmark.triangle.fill") {
                            Text("It is running, but its web server has not answered for \(m.stuckFor) seconds. Most likely macOS is waiting for you to answer a question, such as access to a folder. Look for a dialog hidden behind other windows and click Allow or OK.")
                                .fixedSize(horizontal: false, vertical: true)
                            Text("If nothing is there, click Restart Helper. Still stuck? Run ./install.sh again from the Window Remote folder. Details are in ~/Library/Logs/Window Remote.")
                                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            Button("Restart Helper") { m.restartHelper() }
                        }
                        .tint(.orange)
                    } else {
                        Card(title: "Starting the remote…") {
                            HStack { ProgressView().controlSize(.small); Text("One moment. If this stays, restart the Mac or open Window Remote again.").foregroundStyle(.secondary) }
                        }
                    }
                }
                Text("Closing this window keeps the remote running. It is only reachable from your own devices on Tailscale.")
                    .font(.caption).foregroundStyle(.tertiary).frame(maxWidth: .infinity, alignment: .center).multilineTextAlignment(.center)
            }
            .padding(20)
        }
        .frame(width: 500)
        .frame(minHeight: 560, idealHeight: 760, maxHeight: 1000)
        .onAppear { m.start() }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct WindowRemoteApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = Model()
    var body: some Scene {
        Window("Window Remote", id: "main") {
            ContentView().environmentObject(model)
        }
        .windowResizability(.contentMinSize)
        .defaultSize(width: 500, height: 760)
        .defaultPosition(.center)
    }
}
