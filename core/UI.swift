// What you see on the Mac: a menu bar item (status, pairing, disconnect) and the pairing-code
// window. The code is shown only here, on the Mac, never sent anywhere else.

import AppKit

final class MacUI: NSObject {
    private var item: NSStatusItem?
    private var statusLine = NSMenuItem(title: "No phone connected", action: nil, keyEquivalent: "")
    private var panel: NSPanel?
    private var codeLabel: NSTextField?
    private var expiryTimer: Timer?
    var onPairRequest: (() -> Void)?
    var onDisconnect: (() -> Void)?

    func install() {
        let it = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        it.button?.image = NSImage(systemSymbolName: "iphone.radiowaves.left.and.right", accessibilityDescription: "Window Remote")
        it.button?.image?.isTemplate = true
        let menu = NSMenu()
        let head = NSMenuItem(title: "Open Window Remote…", action: #selector(openAppClicked), keyEquivalent: ""); head.target = self
        menu.addItem(head)
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        let pair = NSMenuItem(title: "Pair an iPhone…", action: #selector(pairClicked), keyEquivalent: ""); pair.target = self
        menu.addItem(pair)
        let disc = NSMenuItem(title: "Disconnect phone now", action: #selector(disconnectClicked), keyEquivalent: ""); disc.target = self
        menu.addItem(disc)
        let open = NSMenuItem(title: "Open phone page on this Mac", action: #selector(openClicked), keyEquivalent: ""); open.target = self
        menu.addItem(open)
        menu.addItem(.separator())
        let forget = NSMenuItem(title: "Forget paired phones…", action: #selector(forgetClicked), keyEquivalent: ""); forget.target = self
        menu.addItem(forget)
        it.menu = menu
        item = it
    }

    func setStatus(_ text: String, active: Bool) {
        statusLine.title = text
        item?.button?.image = NSImage(systemSymbolName: active ? "iphone.radiowaves.left.and.right.circle.fill" : "iphone.radiowaves.left.and.right",
                                      accessibilityDescription: "Window Remote")
        item?.button?.image?.isTemplate = true
    }

    var onForget: (() -> Void)?
    @objc private func forgetClicked() {
        let a = NSAlert()
        a.messageText = "Forget all paired phones?"
        a.informativeText = "Every phone has to pair again with a new code from this Mac. Use this if a phone was lost."
        a.addButton(withTitle: "Forget them"); a.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        if a.runModal() == .alertFirstButtonReturn { onForget?() }
    }
    @objc private func pairClicked() { onPairRequest?() }
    /// The Window Remote window (the Mac app this helper lives inside).
    @objc private func openAppClicked() {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "local.window-remote.app") {
            NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
        }
    }
    @objc private func disconnectClicked() { onDisconnect?() }
    @objc private func openClicked() { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:8765/")!) }

    func showCode(_ code: String, seconds: Int, device: String) {
        if panel == nil { buildPanel() }
        let spaced = code.map(String.init).joined(separator: " ")
        codeLabel?.stringValue = spaced
        if let sub = panel?.contentView?.viewWithTag(2) as? NSTextField {
            sub.stringValue = "Type this code on \(device.isEmpty ? "your iPhone" : device). It works once and expires in \(seconds / 60) minutes."
        }
        panel?.center()
        panel?.orderFrontRegardless()
        expiryTimer?.invalidate()
        expiryTimer = Timer.scheduledTimer(withTimeInterval: TimeInterval(seconds), repeats: false) { [weak self] _ in self?.hideCode() }
    }

    func hideCode() { panel?.orderOut(nil); expiryTimer?.invalidate() }

    private func buildPanel() {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 230), styleMask: [.titled, .closable, .nonactivatingPanel, .hudWindow, .utilityWindow], backing: .buffered, defer: false)
        p.title = "Window Remote pairing code"
        p.level = .floating
        p.isFloatingPanel = true
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let v = NSView(frame: p.contentRect(forFrameRect: p.frame))
        let title = NSTextField(labelWithString: "Pair your iPhone")
        title.font = .systemFont(ofSize: 17, weight: .semibold)
        title.frame = NSRect(x: 24, y: 168, width: 372, height: 24)
        let code = NSTextField(labelWithString: "")
        code.font = .monospacedDigitSystemFont(ofSize: 56, weight: .bold)
        code.alignment = .center
        code.frame = NSRect(x: 12, y: 88, width: 396, height: 70)
        let sub = NSTextField(wrappingLabelWithString: "")
        sub.tag = 2
        sub.font = .systemFont(ofSize: 13)
        sub.textColor = .secondaryLabelColor
        sub.frame = NSRect(x: 24, y: 24, width: 372, height: 54)
        [title, code, sub].forEach(v.addSubview)
        p.contentView = v
        panel = p; codeLabel = code
    }
}
