// Mouse and keyboard on the Mac, from the phone's touches (CGEvent; needs Accessibility permission).

import Foundation
import AppKit
import CoreGraphics
import IOKit.pwr_mgt

enum Input {
    static let source = CGEventSource(stateID: .hidSystemState)
    private static var buttonDown: CGMouseButton?
    private static var lastClick = (time: Date.distantPast, point: CGPoint.zero, count: 0)

    static func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

    static func move(_ p: CGPoint) {
        let type: CGEventType = buttonDown == .left ? .leftMouseDragged : buttonDown == .right ? .rightMouseDragged : .mouseMoved
        post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: buttonDown ?? .left))
    }

    /// Let go of a held mouse button (a drag cut off by a lost connection).
    static func releaseButton() {
        guard let b = buttonDown else { return }
        let p = CGEvent(source: nil)?.location ?? .zero
        let type: CGEventType = b == .right ? .rightMouseUp : .leftMouseUp
        post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: b))
        buttonDown = nil
    }

    static func click(_ p: CGPoint, right: Bool, count: Int) {
        releaseButton()
        let (downT, upT, btn): (CGEventType, CGEventType, CGMouseButton) = right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
        for e in [CGEvent(mouseEventSource: source, mouseType: downT, mouseCursorPosition: p, mouseButton: btn),
                  CGEvent(mouseEventSource: source, mouseType: upT, mouseCursorPosition: p, mouseButton: btn)] {
            e?.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, count)))
            post(e)
        }
    }

    static func down(_ p: CGPoint) {
        buttonDown = .left
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
        let e = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)
        e?.setIntegerValueField(.mouseEventClickState, value: 1)
        post(e)
    }

    static func up(_ p: CGPoint) {
        let e = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)
        e?.setIntegerValueField(.mouseEventClickState, value: 1)
        post(e)
        buttonDown = nil
    }

    static func scroll(_ p: CGPoint, dx: Int32, dy: Int32, phase: String?) {
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
        let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
        e?.location = p
        e?.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        if let phase {
            // Trackpad-style phases make apps scroll smoothly, glide after a flick and show scroll bars.
            // Finger phases: began 1, changed 2, ended 4. Glide (momentum) phases: begin 1, continue 2, end 3.
            switch phase {
            case "begin": e?.setIntegerValueField(.scrollWheelEventScrollPhase, value: 1)
            case "end": e?.setIntegerValueField(.scrollWheelEventScrollPhase, value: 4)
            case "mbegin": e?.setIntegerValueField(.scrollWheelEventMomentumPhase, value: 1)
            case "momentum": e?.setIntegerValueField(.scrollWheelEventMomentumPhase, value: 2)
            case "mend": e?.setIntegerValueField(.scrollWheelEventMomentumPhase, value: 3)
            default: e?.setIntegerValueField(.scrollWheelEventScrollPhase, value: 2)
            }
        }
        post(e)
    }

    static let keyCodes: [String: CGKeyCode] = [
        "Return": 36, "Enter": 76, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "Delete": 117,
        "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
        "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
        "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
        "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
        "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    ]

    static func flags(_ mods: [String]) -> CGEventFlags {
        var f = CGEventFlags()
        for m in mods {
            switch m {
            case "cmd": f.insert(.maskCommand)
            case "shift": f.insert(.maskShift)
            case "alt": f.insert(.maskAlternate)
            case "ctrl": f.insert(.maskControl)
            default: break
            }
        }
        return f
    }

    /// One key, optionally with modifiers (Command-C and so on). Returns false for an unknown key.
    @discardableResult
    static func key(_ name: String, mods: [String]) -> Bool {
        let lower = name.count == 1 ? name.lowercased() : name
        guard let code = keyCodes[lower] else {
            if mods.isEmpty { text(name); return true }
            return false
        }
        var f = flags(mods)
        if name.count == 1, name != lower { f.insert(.maskShift) }
        if code >= 123 && code <= 126 { f.insert(.maskNumericPad); f.insert(.maskSecondaryFn) }
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
            e?.flags = f
            post(e)
        }
        return true
    }

    /// Type text exactly as written (any language, emoji included).
    static func text(_ s: String) {
        let units = Array(s.utf16)
        var i = 0
        while i < units.count {
            if units[i] == 10 || units[i] == 13 { key("Return", mods: []); i += 1; continue }
            var j = i
            while j < units.count && j - i < 16 && units[j] != 10 && units[j] != 13 { j += 1 }
            // Don't split a surrogate pair across events.
            if j < units.count, j > i + 1, UTF16.isLeadSurrogate(units[j - 1]) { j -= 1 }
            var chunk = Array(units[i..<j])
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                e?.flags = []
                e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
                post(e)
            }
            i = j
        }
    }

    /// Put text on the Mac clipboard and press Command-V, then put the old clipboard back.
    static func paste(_ s: String) {
        let pb = NSPasteboard.general
        let old = pb.string(forType: .string)
        pb.clearContents()
        pb.setString(s, forType: .string)
        key("v", mods: ["cmd"])
        // Give the app a moment to read the clipboard before the next key (often Return) arrives.
        Thread.sleep(forTimeInterval: 0.12)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            guard pb.string(forType: .string) == s else { return }
            pb.clearContents()
            if let old { pb.setString(old, forType: .string) }
        }
    }

    static func wake() {
        var id: IOPMAssertionID = 0
        IOPMAssertionDeclareUserActivity("Window Remote" as CFString, kIOPMUserActiveLocal, &id)
    }
}
