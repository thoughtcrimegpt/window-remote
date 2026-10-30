// "Needs you": finds windows that are waiting on you, such as Claude or Codex asking for
// permission, or a macOS dialog. It reads the text in likely windows with on-device text
// recognition (Vision). Nothing leaves the Mac.

import Foundation
import Vision
import AppKit

enum Needs {
    /// Apps whose windows are worth reading.
    static let watchedApps = ["Claude", "Codex", "ChatGPT", "Terminal", "iTerm2", "Ghostty", "Warp", "Code", "Cursor",
                              "Xcode", "Installer", "Software Update"]

    static let questionPhrases = ["do you want", "would you like", "wants to", "would like to", "needs your", "need your",
                                  "requires your", "approve", "approval", "permission", "allow ", "confirm", "are you sure",
                                  "waiting for", "proceed?", "run this command", "make this edit", "continue?", "trust the files",
                                  "trust this folder", "press enter"]
    static let answerWords = ["allow", "deny", "approve", "reject", "yes", "no,", "don't allow", "always allow", "allow once",
                              "cancel", "continue", "accept", "decline", "1. yes", "ok", "trust", "run", "skip"]

    /// One answer you can give from the phone: a button to click, or a number key for terminal menus.
    struct Action { let label: String; let kind: String; let x: Double; let y: Double; let key: String }
    struct Hit { let id: UInt32; let app: String; let title: String; let reason: String; let score: Int; let actions: [Action] }
    struct Line { let text: String; let box: CGRect } // box: 0...1, top-left origin

    static let terminals: Set<String> = ["Terminal", "iTerm2", "Ghostty", "Warp"]
    static let buttonWords = ["allow once", "always allow", "allow", "don't allow", "deny", "approve", "reject", "yes", "no",
                              "ok", "cancel", "continue", "accept", "decline", "run", "skip", "trust", "open", "not now", "later", "install", "don\u{2019}t allow"]

    /// `extra`: more app names to read (the automated test adds its own test window).
    static func scan(windows: [[String: Any]], extra: [String] = []) async -> [Hit] {
        var hits: [Hit] = []
        let candidates = windows.filter { w in
            guard (w["onScreen"] as? Bool) == true else { return false }
            let app = w["app"] as? String ?? "", owner = w["owner"] as? String ?? ""
            return (w["dialog"] as? Bool) == true || watchedApps.contains(app) || watchedApps.contains(owner) || extra.contains(app) || extra.contains(owner)
        }.prefix(14)
        for w in candidates {
            guard let id = w["id"] as? UInt32 else { continue }
            guard let img = await Windows.snapshot(windowID: id, displayID: nil, maxW: 1400) else { continue }
            // Small windows and dialogs get the careful reading (small text); big windows get a quick
            // pass first and a careful one only when something looks like a question.
            let small = (w["dialog"] as? Bool) == true || img.width <= 900
            var hit = judge(lines: recognize(img, accurate: small), window: w, id: id)
            if hit != nil && !small { hit = judge(lines: recognize(img, accurate: true), window: w, id: id) ?? hit }
            if let hit { hits.append(hit) }
        }
        return hits.sorted { $0.score > $1.score }
    }

    static func recognize(_ img: CGImage, accurate: Bool = false) -> [Line] {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = accurate ? .accurate : .fast
        req.usesLanguageCorrection = accurate
        let handler = VNImageRequestHandler(cgImage: img, options: [:])
        try? handler.perform([req])
        return (req.results ?? []).compactMap { o in
            guard let t = o.topCandidates(1).first?.string else { return nil }
            let b = o.boundingBox
            return Line(text: t, box: CGRect(x: b.minX, y: 1 - b.maxY, width: b.width, height: b.height))
        }.sorted { abs($0.box.minY - $1.box.minY) < 0.004 ? $0.box.minX < $1.box.minX : $0.box.minY < $1.box.minY }
    }

    static func judge(lines all: [Line], window w: [String: Any], id: UInt32) -> Hit? {
        let lines = all.map(\.text)
        let lower = lines.map { $0.lowercased() }
        let isDialog = (w["dialog"] as? Bool) == true
        let isTerminal = terminals.contains(w["owner"] as? String ?? "") || terminals.contains(w["app"] as? String ?? "")
        var reason: String?
        var reasonIndex = 0
        var score = 0
        // Prompts sit near the bottom of chat and terminal windows, so later lines count more.
        for (i, l) in lower.enumerated().reversed() {
            if questionPhrases.contains(where: { l.contains($0) }) && l.count < 220 {
                reason = lines[i]; reasonIndex = i; score += 2 + (i > lower.count / 2 ? 1 : 0); break
            }
        }
        let answers = Set(lower.flatMap { l in answerWords.filter { a in l == a || l.hasPrefix(a + " ") || l.hasPrefix(a) && l.count <= a.count + 18 } })
        score += min(3, answers.count)
        let needed = isDialog ? 2 : 4
        guard score >= needed, answers.count >= 1 || isDialog else { return nil }
        // System dialogs come from helper processes with odd names (UserNotificationCenter...).
        let app = isDialog && !watchedApps.contains(w["app"] as? String ?? "") ? "macOS" : (w["app"] as? String ?? "")
        // A dialog's headline (its first sentence) says best what it wants.
        if isDialog, let first = lines.firstIndex(where: { $0.count > 6 }) {
            var title = ""
            var i = first
            while i < lines.count && title.count < 160 {
                title += (title.isEmpty ? "" : " ") + lines[i]
                if lines[i].hasSuffix(".") || lines[i].hasSuffix("?") { break }
                i += 1
            }
            reason = title; reasonIndex = i
        }
        var text = (reason ?? lines.first(where: { $0.count > 8 }) ?? "Waiting for you").trimmingCharacters(in: .whitespaces)
        if text.count > 110 { text = String(text.prefix(107)) + "..." }
        return Hit(id: id, app: app, title: w["title"] as? String ?? "", reason: text, score: score + (isDialog ? 2 : 0),
                   actions: actions(all, after: reason == nil ? 0 : reasonIndex + 1, terminal: isTerminal))
    }

    /// The answers on screen below the question, at most four.
    static func actions(_ lines: [Line], after start: Int, terminal: Bool) -> [Action] {
        var out: [Action] = []
        var seen = Set<String>()
        let numbered = try! NSRegularExpression(pattern: "^\\W{0,3}([1-9])[.)]\\s+(.{1,60})$")
        for l in lines.dropFirst(min(start, lines.count)) {
            let t = l.text.trimmingCharacters(in: .whitespaces)
            let range = NSRange(t.startIndex..., in: t)
            if let m = numbered.firstMatch(in: t, range: range), let k = Range(m.range(at: 1), in: t), let lab = Range(m.range(at: 2), in: t) {
                // Menus like Claude Code's "1. Yes / 2. No": press the number in terminals, click it elsewhere.
                var label = String(t[lab]).trimmingCharacters(in: .whitespaces)
                if label.count > 34 { label = String(label.prefix(32)) + "…" }
                if seen.insert(label.lowercased()).inserted {
                    out.append(Action(label: label, kind: terminal ? "key" : "click", x: l.box.midX, y: l.box.midY, key: String(t[k])))
                }
            } else if !terminal, t.count <= 28 {
                let low = t.lowercased()
                if buttonWords.contains(where: { low == $0 || (low.hasPrefix($0 + " ") && low.count <= $0.count + 18) }), seen.insert(low).inserted {
                    out.append(Action(label: t, kind: "click", x: l.box.midX, y: l.box.midY, key: ""))
                }
            }
            if out.count >= 4 { break }
        }
        return out
    }

    /// Answer from the phone. For a click, first re-read the window to make sure that answer is
    /// still there (nearby), so a stale picture never clicks something else.
    static func answer(windowID: UInt32, action a: [String: Any]) async -> (Bool, String) {
        let kind = a["kind"] as? String ?? "", label = a["label"] as? String ?? ""
        let x = a["x"] as? Double ?? -1, y = a["y"] as? Double ?? -1
        guard let img = await Windows.snapshot(windowID: windowID, displayID: nil, maxW: 1400) else { return (false, "That window is gone.") }
        let lines = recognize(img, accurate: true)
        let match = lines.first { l in
            let t = l.text.lowercased()
            return t.contains(label.lowercased().replacingOccurrences(of: "…", with: "")) && hypot(l.box.midX - x, l.box.midY - y) < 0.08
        }
        guard let m = match else { return (false, "That question has changed. Open the window to see it.") }
        guard let f = Windows.bounds(of: windowID) else { return (false, "That window is gone.") }
        await MainActor.run {
            Windows.focus(windowID)
        }
        try? await Task.sleep(nanoseconds: 120_000_000)
        await MainActor.run {
            if kind == "key", let key = a["key"] as? String, !key.isEmpty {
                Input.key(key, mods: [])
            } else {
                Input.click(CGPoint(x: f.minX + m.box.midX * f.width, y: f.minY + m.box.midY * f.height), right: false, count: 1)
            }
        }
        return (true, "Answered \"\(label)\".")
    }
}
