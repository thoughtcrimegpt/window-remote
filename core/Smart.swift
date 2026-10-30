// Making phone taps land: a tap that is near (but not on) a button, link, checkbox or text box is
// moved onto it, using the Mac's accessibility information about what is on screen. Also finds out
// whether a text box has the keyboard focus, so the phone can offer its keyboard.

import AppKit
import ApplicationServices

enum Smart {
    static let clickableRoles: Set<String> = ["AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
                                              "AXMenuItem", "AXMenuBarItem", "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField",
                                              "AXDisclosureTriangle", "AXIncrementor", "AXTab", "AXSegment", "AXSwitch", "AXToggle", "AXColorWell",
                                              "AXDockItem", "AXSlider"]
    static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
    static var enabledApps = Set<pid_t>()

    static func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
    }
    static func role(_ el: AXUIElement) -> String { attr(el, kAXRoleAttribute) as? String ?? "" }
    static func frame(_ el: AXUIElement) -> CGRect? {
        guard let pv = attr(el, kAXPositionAttribute), let sv = attr(el, kAXSizeAttribute) else { return nil }
        var p = CGPoint.zero, s = CGSize.zero
        AXValueGetValue(pv as! AXValue, .cgPoint, &p); AXValueGetValue(sv as! AXValue, .cgSize, &s)
        return CGRect(origin: p, size: s)
    }

    /// Electron apps (Claude, Codex, Slack and others) only describe their content when asked to.
    static func enable(pid: pid_t) {
        guard AXIsProcessTrusted(), !enabledApps.contains(pid) else { return }
        enabledApps.insert(pid)
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }

    /// The clickable element at a point, looking a few levels up (text inside a button counts as the button).
    static func clickable(at p: CGPoint) -> (AXUIElement, String, CGRect)? {
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.08)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(sys, Float(p.x), Float(p.y), &hit) == .success, var el = hit else { return nil }
        for _ in 0..<5 {
            let r = role(el)
            if clickableRoles.contains(r) || hasPress(el), let f = frame(el), f.width < 1400, f.height < 700, f.width > 2, f.height > 2 {
                return (el, r, f)
            }
            if ["AXWindow", "AXWebArea", "AXScrollArea", "AXApplication", "AXGroup"].contains(r) && !hasPress(el) && r != "AXGroup" { break }
            guard let parent = attr(el, kAXParentAttribute) else { break }
            el = parent as! AXUIElement
        }
        return nil
    }

    static func hasPress(_ el: AXUIElement) -> Bool {
        var names: CFArray?
        guard AXUIElementCopyActionNames(el, &names) == .success, let list = names as? [String] else { return false }
        return list.contains("AXPress") && !["AXGroup", "AXStaticText", "AXWebArea", "AXRow", "AXCell", "AXImage"].contains(role(el))
    }

    /// Where a tap at `p` should really click. `radius` is about a fingertip, in Mac points.
    static func snap(_ p: CGPoint, radius: CGFloat) -> (point: CGPoint, rect: CGRect?, role: String?) {
        guard AXIsProcessTrusted() else { return (p, nil, nil) }
        if let (_, r, f) = clickable(at: p) {
            return (p, f, r) // on target already: click exactly where tapped (keeps the caret where you meant)
        }
        var best: (CGPoint, CGRect, String, CGFloat)?
        for ring in [radius * 0.5, radius] {
            for i in 0..<8 {
                let a = Double(i) * .pi / 4
                let q = CGPoint(x: p.x + ring * CGFloat(cos(a)), y: p.y + ring * CGFloat(sin(a)))
                guard let (el, r, f) = clickable(at: q) else { continue }
                // Never snap onto a window's close, minimize or full-screen button.
                if let sub = attr(el, kAXSubroleAttribute) as? String,
                   ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"].contains(sub) { continue }
                // Nearest point of that element to the tap, kept a little inside its edge.
                let inset = f.insetBy(dx: min(4, f.width / 3), dy: min(4, f.height / 3))
                var target = CGPoint(x: min(max(p.x, inset.minX), inset.maxX), y: min(max(p.y, inset.minY), inset.maxY))
                if !textRoles.contains(r) && f.width < 220 && f.height < 80 { target = CGPoint(x: f.midX, y: f.midY) }
                // How far the tap was from the element's edge. Links sit inside text you may have
                // meant to tap, so they only win when the tap was very close.
                let edge = hypot(max(f.minX - p.x, 0, p.x - f.maxX), max(f.minY - p.y, 0, p.y - f.maxY))
                if r == "AXLink" && edge > radius * 0.4 { continue }
                let d = hypot(target.x - p.x, target.y - p.y)
                if best == nil || d < best!.3 { best = (target, f, r, d) }
            }
            if best != nil { break }
        }
        if let b = best { return (b.0, b.1, b.2) }
        return (p, nil, nil)
    }

    /// Is a text box focused right now? Returns its frame if so.
    static func focusedText() -> CGRect? {
        guard AXIsProcessTrusted() else { return nil }
        let sys = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(sys, 0.1)
        guard let f = attr(sys, kAXFocusedUIElementAttribute) else { return nil }
        let el = f as! AXUIElement
        let r = role(el)
        // Web text boxes (contenteditable, as in Claude and Codex) report an editable ancestor.
        let editable = textRoles.contains(r) || attr(el, "AXEditableAncestor") != nil
        guard editable else { return nil }
        return frame(el)
    }
}
