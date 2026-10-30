// Talks to the Node server over a private Unix socket in ~/Library/Application Support/Window Remote.
// Every message is: 4-byte big-endian length, 1-byte type, payload.
//   type 1: JSON (both directions)
//   type 2: encoded video (helper to server): VideoHeader + H.264 Annex B bytes
//   type 3: image (helper to server): 4-byte JSON length, JSON, JPEG bytes

import Foundation

enum MsgType: UInt8 { case json = 1, video = 2, image = 3 }

final class IPC {
    let path: String
    private var fd: Int32 = -1
    private let writeQueue = DispatchQueue(label: "ipc.write")
    private var readSource: DispatchSourceRead?
    private var buffer = Data()
    var onMessage: (([String: Any]) -> Void)?
    var onConnect: (() -> Void)?
    var connected: Bool { fd >= 0 }
    /// Bytes queued but not yet written; video is skipped while this is high so a slow reader never builds delay.
    private(set) var pendingBytes = 0
    private let lock = NSLock()

    init(path: String) { self.path = path }

    func start() { connect() }

    private func connect() {
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { retry(); return }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { close(s); return }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = b }
            raw[bytes.count] = 0
        }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        if ok != 0 { close(s); retry(); return }
        var on: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var sndbuf: Int32 = 4 << 20
        setsockopt(s, SOL_SOCKET, SO_SNDBUF, &sndbuf, socklen_t(MemoryLayout<Int32>.size))
        fd = s
        buffer = Data()
        let src = DispatchSource.makeReadSource(fileDescriptor: s, queue: .main)
        src.setEventHandler { [weak self] in self?.readAvailable() }
        src.resume()
        readSource = src
        Log.info("connected to server")
        onConnect?()
    }

    private func retry() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.connect() }
    }

    private func disconnected() {
        readSource?.cancel(); readSource = nil
        if fd >= 0 { close(fd) }
        fd = -1
        Log.info("server connection closed; reconnecting")
        NotificationCenter.default.post(name: .ipcDisconnected, object: nil)
        retry()
    }

    private func readAvailable() {
        var chunk = [UInt8](repeating: 0, count: 65536)
        let n = read(fd, &chunk, chunk.count)
        if n <= 0 { disconnected(); return }
        buffer.append(contentsOf: chunk[0..<n])
        while buffer.count >= 5 {
            let len = Int(buffer.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 0, as: UInt32.self).bigEndian })
            guard buffer.count >= 4 + len else { break }
            let type = buffer[buffer.startIndex + 4]
            let payload = buffer.subdata(in: (buffer.startIndex + 5)..<(buffer.startIndex + 4 + len))
            buffer.removeSubrange(buffer.startIndex..<(buffer.startIndex + 4 + len))
            if type == MsgType.json.rawValue,
               let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] {
                onMessage?(obj)
            }
        }
    }

    func send(type: MsgType, payload: Data) {
        guard fd >= 0 else { return }
        var header = Data(count: 5)
        let len = UInt32(payload.count + 1).bigEndian
        header.withUnsafeMutableBytes { $0.storeBytes(of: len, as: UInt32.self) }
        header[4] = type.rawValue
        lock.lock(); pendingBytes += header.count + payload.count; lock.unlock()
        let s = fd
        writeQueue.async { [weak self] in
            var ok = Self.writeAll(s, header)
            if ok { ok = Self.writeAll(s, payload) }
            guard let self else { return }
            self.lock.lock(); self.pendingBytes -= header.count + payload.count; self.lock.unlock()
            if !ok { DispatchQueue.main.async { if self.fd == s { self.disconnected() } } }
        }
    }

    private static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { raw -> Bool in
            var off = 0
            while off < raw.count {
                let n = write(fd, raw.baseAddress!.advanced(by: off), raw.count - off)
                if n < 0 { if errno == EINTR || errno == EAGAIN { continue }; return false }
                off += n
            }
            return true
        }
    }

    func sendJSON(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        send(type: .json, payload: data)
    }

    func sendImage(meta: [String: Any], jpeg: Data) {
        guard let json = try? JSONSerialization.data(withJSONObject: meta) else { return }
        var payload = Data(count: 4)
        let l = UInt32(json.count).bigEndian
        payload.withUnsafeMutableBytes { $0.storeBytes(of: l, as: UInt32.self) }
        payload.append(json); payload.append(jpeg)
        send(type: .image, payload: payload)
    }
}

extension Notification.Name { static let ipcDisconnected = Notification.Name("ipcDisconnected") }

enum Log {
    static func info(_ s: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) core: \(s)\n"
        FileHandle.standardError.write(line.data(using: .utf8)!)
    }
}
