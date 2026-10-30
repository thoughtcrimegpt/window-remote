// Window list, live thumbnails, and window actions (bring to front, un-minimize, resize for the
// phone and put back). Resizing and raising use the Accessibility permission.

import Foundation
import AppKit
import ScreenCaptureKit
import ApplicationServices

enum Windows {
    static let ignoredOwners: Set<String> = ["Window Server", "Dock", "Control Center", "SystemUIServer", "Notification Center",
                                            "Spotlight", "WindowManager", "TextInputMenuAgent", "Wallpaper", "loginwindow",
                                            "screencaptureui", "Screenshot", "CursorUIViewService", "AutoFill", "Open and Save Panel Service"]
    /// Owners whose small floating windows are usually a question for you.
    static let dialogOwners: Set<String> = ["UserNotificationCenter", "CoreServicesUIAgent", "SecurityAgent", "universalAccessAuthWarn",
                                           "Software Update", "Installer", "coreautha"]

    static func bounds(of id: UInt32) -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]],
              let info = list.first, let b = info[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
        if let onscreen = info[kCGWindowIsOnscreen as String] as? Bool, !onscreen,
           let layer = info[kCGWindowLayer as String] as? Int, layer != 0 { return nil }
        return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
    }

    static func info(of id: UInt32) -> [String: Any]? {
        (CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]])?.first
    }

    static var sentIcons = Set<String>()

    /// Windows you might want: everything on screen first, then minimized or other-desktop windows.
    static func list(includeIcons: Bool) -> [String: Any] {
        let me = getpid()
        let parent = ProcessInfo.processInfo.environment["WR_LAUNCHER_PID"].flatMap { Int32($0) } ?? -1
        var out: [[String: Any]] = []
        var seen = Set<UInt32>()
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        func add(_ info: [String: Any], onScreen: Bool, order: Int) {
            guard let id = info[kCGWindowNumber as String] as? UInt32, !seen.contains(id),
                  let pid = info[kCGWindowOwnerPID as String] as? Int32, pid != me, pid != parent,
                  let owner = info[kCGWindowOwnerName as String] as? String, !ignoredOwners.contains(owner),
                  let b = info[kCGWindowBounds as String] as? [String: CGFloat] else { return }
            let layer = info[kCGWindowLayer as String] as? Int ?? 0
            let alpha = info[kCGWindowAlpha as String] as? Double ?? 1
            let w = b["Width"] ?? 0, h = b["Height"] ?? 0
            let title = info[kCGWindowName as String] as? String ?? ""
            let app = NSRunningApplication(processIdentifier: pid)
            let isDialogOwner = dialogOwners.contains(owner)
            if alpha < 0.05 || w < 120 || h < 80 { return }
            if layer != 0 && !(isDialogOwner && onScreen) { return }
            if !onScreen && (title.isEmpty || app?.activationPolicy != .regular || w < 240 || h < 160) { return }
            if onScreen && app?.activationPolicy == .prohibited && !isDialogOwner { return }
            seen.insert(id)
            var item: [String: Any] = ["id": id, "pid": pid, "app": app?.localizedName ?? owner, "owner": owner,
                                       "bundleId": app?.bundleIdentifier ?? "", "title": title,
                                       "frame": ["x": b["X"] ?? 0, "y": b["Y"] ?? 0, "w": w, "h": h],
                                       "onScreen": onScreen, "order": order, "layer": layer,
                                       "frontApp": pid == front, "dialog": isDialogOwner]
            if includeIcons, let bid = app?.bundleIdentifier, !sentIcons.contains(bid), let icon = app?.icon {
                sentIcons.insert(bid)
                item["icon"] = iconPNG(icon)
            }
            out.append(item)
        }
        if let onscreen = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            for (i, info) in onscreen.enumerated() { add(info, onScreen: true, order: i) }
        }
        if let all = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            for (i, info) in all.enumerated() { add(info, onScreen: false, order: 10_000 + i) }
        }
        var displays: [[String: Any]] = []
        var ids = [CGDirectDisplayID](repeating: 0, count: 8); var n: UInt32 = 0
        CGGetActiveDisplayList(8, &ids, &n)
        for d in ids.prefix(Int(n)) {
            let b = CGDisplayBounds(d)
            let name = NSScreen.screens.first(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == d })?.localizedName ?? "Display"
            displays.append(["id": d, "name": name, "main": CGDisplayIsMain(d) != 0,
                             "frame": ["x": b.minX, "y": b.minY, "w": b.width, "h": b.height]])
        }
        return ["type": "windows", "windows": out, "displays": displays]
    }

    static func iconPNG(_ icon: NSImage) -> String? {
        let size = NSSize(width: 96, height: 96)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 96, pixelsHigh: 96, bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        icon.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])?.base64EncodedString()
    }

    // MARK: thumbnails and snapshots

    private static var cachedContent: SCShareableContent?
    private static var cachedAt = Date.distantPast
    private static let cacheLock = NSLock()

    static func content() async throws -> SCShareableContent {
        let hit = cacheLock.withLock { cachedContent.flatMap { Date().timeIntervalSince(cachedAt) < 1.5 ? $0 : nil } }
        if let hit { return hit }
        let c = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        cacheLock.withLock { cachedContent = c; cachedAt = Date() }
        return c
    }

    /// Picture of one window (id) or display ("d" + id), at most maxW pixels wide.
    static func snapshot(windowID: UInt32?, displayID: UInt32?, maxW: Int) async -> CGImage? {
        guard let content = try? await content() else { return nil }
        let filter: SCContentFilter
        var size: CGSize
        if let d = displayID {
            guard let disp = content.displays.first(where: { $0.displayID == d }) else { return nil }
            filter = SCContentFilter(display: disp, excludingApplications: [], exceptingWindows: [])
            size = CGSize(width: disp.width, height: disp.height)
        } else if let w = windowID, let win = content.windows.first(where: { $0.windowID == w }) {
            filter = SCContentFilter(desktopIndependentWindow: win)
            size = win.frame.size
        } else { return nil }
        let cfg = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        let k = min(1.0, CGFloat(maxW) / max(1, size.width * scale))
        cfg.width = max(32, Int(size.width * scale * k)); cfg.height = max(32, Int(size.height * scale * k))
        cfg.showsCursor = false
        if #available(macOS 14.0, *) { cfg.ignoreShadowsSingleWindow = true; cfg.shouldBeOpaque = true }
        return try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    }

    // MARK: Accessibility actions

    private typealias GetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
    private static let getWindow: GetWindowFn? = {
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
        return unsafeBitCast(sym, to: GetWindowFn.self)
    }()

    static func axWindow(_ id: UInt32) -> (AXUIElement, AXUIElement)? {
        guard let info = info(of: id), let pid = info[kCGWindowOwnerPID as String] as? Int32 else { return nil }
        let app = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let wins = value as? [AXUIElement] else { return nil }
        if let fn = getWindow {
            for w in wins { var wid: CGWindowID = 0; if fn(w, &wid) == .success, wid == id { return (app, w) } }
        }
        // Fallback: match by title and position.
        let title = info[kCGWindowName as String] as? String ?? ""
        let b = bounds(of: id) ?? .zero
        for w in wins {
            var t: CFTypeRef?; AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t)
            if let p = axPoint(w, kAXPositionAttribute), abs(p.x - b.minX) < 2, abs(p.y - b.minY) < 2,
               (t as? String ?? "") == title { return (app, w) }
        }
        return nil
    }

    static func axPoint(_ el: AXUIElement, _ attr: String) -> CGPoint? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let v else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }

    /// Bring a window to the front (un-minimizing it if needed) so clicks land on it.
    @discardableResult
    static func focus(_ id: UInt32) -> Bool {
        guard let info = info(of: id), let pid = info[kCGWindowOwnerPID as String] as? Int32 else { return false }
        let running = NSRunningApplication(processIdentifier: pid)
        if let (app, w) = axWindow(id) {
            AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
            AXUIElementPerformAction(w, kAXRaiseAction as CFString)
            AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        }
        running?.activate(options: [])
        return true
    }

    static func isFront(_ id: UInt32) -> Bool {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
        let firstNormal = list.first { ($0[kCGWindowLayer as String] as? Int ?? 1) == 0 && ($0[kCGWindowAlpha as String] as? Double ?? 1) > 0.05 }
        return (firstNormal?[kCGWindowNumber as String] as? UInt32) == id
            && NSWorkspace.shared.frontmostApplication?.processIdentifier == (firstNormal?[kCGWindowOwnerPID as String] as? Int32)
    }

    static var savedFrames: [UInt32: CGRect] = [:]

    /// Resize a window to a phone-shaped size (in points). It goes on a Retina screen when there is
    /// one (twice the pixels, so text stays sharp on the phone), at that screen's top left; the
    /// original place and size are kept and put back afterwards.
    static func phoneLayout(_ id: UInt32, width: CGFloat, height: CGFloat) -> CGRect? {
        guard let (_, w) = axWindow(id), let before = bounds(of: id) else { return nil }
        if savedFrames[id] == nil { savedFrames[id] = before }
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        // Screens in top-left coordinates (what Accessibility uses).
        func topLeft(_ r: NSRect) -> CGRect { CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height) }
        let current = NSScreen.screens.first { topLeft($0.frame).contains(CGPoint(x: before.midX, y: before.midY)) } ?? NSScreen.main
        let retina = NSScreen.screens.filter { $0.backingScaleFactor >= 2 }.max { $0.visibleFrame.height < $1.visibleFrame.height }
        let screen = (current?.backingScaleFactor ?? 1) >= 2 ? current : (retina ?? current)
        let visible = topLeft(screen?.visibleFrame ?? .zero)
        let hh = min(height, visible.height - 8)
        var size = CGSize(width: min(width, visible.width - 8), height: hh)
        var pos: CGPoint
        if screen === current {
            pos = CGPoint(x: max(visible.minX + 4, min(before.minX, visible.maxX - size.width - 4)), y: max(visible.minY + 4, min(before.minY, visible.maxY - hh - 4)))
        } else {
            pos = CGPoint(x: visible.minX + 8, y: visible.minY + 4)
        }
        if let v = AXValueCreate(.cgPoint, &pos) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, v) }
        if let v = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, v) }
        // Some apps apply a new size only after the move settles; ask once more.
        if let v = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, v) }
        return bounds(of: id)
    }

    static func restore(_ id: UInt32) {
        guard let f = savedFrames.removeValue(forKey: id), let (_, w) = axWindow(id) else { return }
        var size = f.size, pos = f.origin
        // Size, place, then size again: macOS trims a window that does not fit where it is while moving.
        if let v = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, v) }
        if let v = AXValueCreate(.cgPoint, &pos) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, v) }
        if let v = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, v) }
    }

    static func restoreAll() { for id in Array(savedFrames.keys) { restore(id) } }
}
