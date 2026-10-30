// Test window used only by the automated checks (wr-core --testpad <events-file>).
// It shows a moving bar (so every frame changes), small text (to judge sharpness), and a strip
// of black and white blocks that encode the current time, so the test can read each received
// video frame and measure the real delay. Every click, scroll and key it receives is written to
// the events file, so the test can check that touches land in the right place.

import AppKit

final class TestPadView: NSView {
    var eventsPath: String
    var lastEvent = "waiting for input"
    let start = Date()
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    init(frame: NSRect, eventsPath: String) {
        self.eventsPath = eventsPath
        super.init(frame: frame)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirty: NSRect) {
        NSColor(calibratedWhite: 0.97, alpha: 1).setFill(); bounds.fill()
        // Time strip: 4 marker blocks (1010), then 40 bits of the time in milliseconds, then 0110.
        let ms = UInt64(Date().timeIntervalSince1970 * 1000) & ((1 << 40) - 1)
        var bits: [Bool] = [true, false, true, false]
        for i in (0..<40).reversed() { bits.append((ms >> UInt64(i)) & 1 == 1) }
        bits += [false, true, true, false]
        let block: CGFloat = 10
        for (i, b) in bits.enumerated() {
            (b ? NSColor.black : NSColor.white).setFill()
            NSRect(x: 0 + CGFloat(i) * block, y: 0, width: block, height: block * 2).fill()
        }
        // Moving bar.
        let t = Date().timeIntervalSince(start)
        let x = (sin(t * 2.4) * 0.5 + 0.5) * (bounds.width - 60)
        NSColor.systemTeal.setFill()
        NSBezierPath(roundedRect: NSRect(x: x, y: 40, width: 60, height: 60), xRadius: 12, yRadius: 12).fill()
        // Click targets: a 3 by 3 grid of numbered boxes.
        let para = NSMutableParagraphStyle(); para.alignment = .center
        for r in 0..<3 { for c in 0..<3 {
            let cell = NSRect(x: 20 + CGFloat(c) * 150, y: 120 + CGFloat(r) * 110, width: 140, height: 100)
            NSColor(calibratedRed: 0.85, green: 0.92, blue: 0.93, alpha: 1).setFill()
            NSBezierPath(roundedRect: cell, xRadius: 10, yRadius: 10).fill()
            ("\(r * 3 + c + 1)" as NSString).draw(in: cell.insetBy(dx: 0, dy: 28), withAttributes: [.font: NSFont.boldSystemFont(ofSize: 32), .paragraphStyle: para])
        } }
        let small: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.darkGray]
        for i in 0..<12 {
            ("Small text line \(i + 1): The quick brown fox jumps over the lazy dog 0123456789." as NSString)
                .draw(at: NSPoint(x: 20, y: 470 + CGFloat(i) * 16), withAttributes: small)
        }
        if ProcessInfo.processInfo.environment["WR_TESTPAD_PROMPT"] != nil {
            let big: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15, weight: .semibold), .foregroundColor: NSColor.black]
            ("Do you want to proceed with this command?" as NSString).draw(at: NSPoint(x: 20, y: 700), withAttributes: big)
            ("1. Yes" as NSString).draw(at: NSPoint(x: 20, y: 722), withAttributes: big)
            ("2. No, and tell Claude what to do differently" as NSString).draw(at: NSPoint(x: 20, y: 740), withAttributes: big)
        }
        ("Last input: \(lastEvent)" as NSString).draw(at: NSPoint(x: 20, y: 680), withAttributes: [.font: NSFont.systemFont(ofSize: 15, weight: .semibold)])
    }

    private func record(_ type: String, _ e: NSEvent, extra: [String: Any] = [:]) {
        let p = convert(e.locationInWindow, from: nil)
        var obj: [String: Any] = ["t": Date().timeIntervalSince1970, "type": type, "x": p.x, "y": p.y, "w": bounds.width, "h": bounds.height]
        if [.leftMouseDown, .rightMouseDown, .leftMouseUp].contains(e.type) { obj["clicks"] = e.clickCount }
        obj.merge(extra) { a, _ in a }
        lastEvent = "\(type) at \(Int(p.x)), \(Int(p.y))"
        if let d = try? JSONSerialization.data(withJSONObject: obj), let h = FileHandle(forWritingAtPath: eventsPath) {
            h.seekToEndOfFile(); h.write(d); h.write("\n".data(using: .utf8)!); try? h.close()
        }
    }

    override func mouseDown(with e: NSEvent) { window?.makeFirstResponder(self); record("down", e) }
    override func mouseUp(with e: NSEvent) { record("up", e) }
    override func mouseDragged(with e: NSEvent) { record("drag", e) }
    override func rightMouseDown(with e: NSEvent) { record("rightdown", e) }
    override func scrollWheel(with e: NSEvent) { record("scroll", e, extra: ["dx": e.scrollingDeltaX, "dy": e.scrollingDeltaY, "precise": e.hasPreciseScrollingDeltas]) }
    // Command-key combinations arrive as key equivalents first; record them here too.
    override func performKeyEquivalent(with e: NSEvent) -> Bool {
        guard e.type == .keyDown, e.modifierFlags.contains(.command) else { return false }
        keyDown(with: e)
        return true
    }
    override func keyDown(with e: NSEvent) {
        var mods: [String] = []
        if e.modifierFlags.contains(.command) { mods.append("cmd") }
        if e.modifierFlags.contains(.shift) { mods.append("shift") }
        record("key", e, extra: ["chars": e.characters ?? "", "keyCode": e.keyCode, "mods": mods])
    }
}

enum TestPad {
    static func run(eventsPath: String) {
        FileManager.default.createFile(atPath: eventsPath, contents: nil)
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        // Prefer a Retina screen, so the zoom test can check full-resolution re-capture.
        let screen = NSScreen.screens.first { $0.backingScaleFactor >= 2 } ?? NSScreen.main ?? NSScreen.screens[0]
        let vf = screen.visibleFrame
        let origin = NSPoint(x: vf.minX + 40, y: max(vf.minY + 10, vf.maxY - 760 - 60))
        let win = NSWindow(contentRect: NSRect(origin: origin, size: NSSize(width: 480, height: 760)), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        win.title = "Window Remote Test Pad"
        win.setFrameOrigin(NSPoint(x: origin.x, y: origin.y))
        let view = TestPadView(frame: win.contentLayoutRect, eventsPath: eventsPath)
        view.autoresizingMask = [.width, .height]
        win.contentView = view
        win.makeKeyAndOrderFront(nil)
        win.makeFirstResponder(view)
        let timer = Timer(timeInterval: 1.0 / 120, repeats: true) { _ in view.needsDisplay = true }
        RunLoop.main.add(timer, forMode: .common)
        print("testpad window \(win.windowNumber)")
        fflush(stdout)
        app.run()
    }
}
