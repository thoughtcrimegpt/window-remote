// Live capture of one window or one display with ScreenCaptureKit, fed to the H.264 encoder.
// Region ("crop") and output size can change while streaming: zooming on the phone asks for a
// smaller region at full resolution, so small text stays sharp instead of being blown up.

import Foundation
import AppKit
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import VideoToolbox
import ImageIO
import UniformTypeIdentifiers

struct StreamRequest {
    var kind: String = "window"      // "window" or "display"
    var id: UInt32 = 0               // CGWindowID or CGDirectDisplayID
    var crop = CGRect(x: 0, y: 0, width: 1, height: 1)  // normalized 0...1 inside the target
    var maxW = 1290, maxH = 2796     // phone screen in device pixels (for the current orientation)
    var fps = 60
    var bitrate = 10_000_000
    var jpeg = false                 // basic mode: JPEG frames instead of H.264
}

// Thread safety is handled by hand: `stream` lives on the main thread, the encoder on `queue`, and the
// request behind `lock`. So it is marked @unchecked Sendable for the closures that hop between them.
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let ipc: IPC
    let encoder = H264Encoder()          // used only on `queue`
    private var stream: SCStream?        // main thread only
    private let lock = NSLock()          // guards _req and _activeStream (read from several threads)
    private var _req = StreamRequest()
    private var _activeStream: ObjectIdentifier?
    var req: StreamRequest {
        get { lock.lock(); defer { lock.unlock() }; return _req }
        set { lock.lock(); _req = newValue; lock.unlock() }
    }
    /// Safe to read from any thread.
    var streaming: Bool { lock.lock(); defer { lock.unlock() }; return _activeStream != nil }
    private func setActive(_ s: SCStream?) { lock.lock(); _activeStream = s.map(ObjectIdentifier.init); lock.unlock() }
    private func isActive(_ s: SCStream) -> Bool { lock.lock(); defer { lock.unlock() }; return _activeStream == ObjectIdentifier(s) }

    private(set) var targetFrame = CGRect.zero   // global points, top-left origin (main thread)
    private var pointScale: CGFloat = 2          // main thread
    private let queue = DispatchQueue(label: "capture", qos: .userInteractive)
    private var gen: UInt32 = 0                  // capture queue
    private var activeGen: UInt32 = 0            // capture queue
    private var lastBuffer: CVPixelBuffer?
    private var lastPTS = CMTime.zero
    private var refineCount = 0
    private var refineTimer: DispatchSourceTimer?
    private var trackTimer: Timer?
    private var jpegBusy = false
    private var lastJpeg = Date.distantPast
    private var framesSent = 0
    private var framesSkipped = 0
    private var logCaptured = 0, logEncoded = 0, logSkipped = 0, logAt = Date()
    private var startGen = 0                     // main thread: the newest start wins
    private var configChain: Task<Void, Never>?  // main thread: configuration changes, one at a time

    init(ipc: IPC) {
        self.ipc = ipc
        super.init()
        encoder.onFrame = { [weak self] data, key, epochUs in self?.sendVideo(data, key: key, epochUs: epochUs) }
    }

    // Encoder settings change on the capture queue, where frames are encoded.
    func keyframe() { queue.async { self.encoder.requestKeyframe() } }
    func setProfile(_ p: String) { queue.async { self.encoder.profile = p } }
    private func setRate(bitrate: Int, fps: Int) { queue.async { self.encoder.bitrate = bitrate; self.encoder.fps = fps } }

    // MARK: start / update / stop

    func start(_ r: StreamRequest) {
        startGen += 1
        let myGen = startGen
        Task { @MainActor in
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                guard myGen == self.startGen else { return } // a newer request came in meanwhile
                let filter: SCContentFilter
                var frame: CGRect
                var rr = r
                if r.kind == "display" {
                    guard let d = content.displays.first(where: { $0.displayID == r.id }) ?? content.displays.first else { throw err("No display found.") }
                    filter = SCContentFilter(display: d, excludingApplications: [], exceptingWindows: [])
                    frame = CGDisplayBounds(d.displayID)
                    rr.id = d.displayID
                } else {
                    guard let w = content.windows.first(where: { $0.windowID == r.id }) else { throw err("That window is closed.") }
                    filter = SCContentFilter(desktopIndependentWindow: w)
                    frame = Windows.bounds(of: w.windowID) ?? w.frame
                }
                self.pointScale = CGFloat(filter.pointPixelScale)
                self.targetFrame = frame
                let (cfg, size) = self.config(for: rr)
                let old = self.req
                if let s = self.stream, old.kind == rr.kind, old.id == rr.id {
                    self.req = rr
                    self.applyConfig(s, cfg, size: size, crop: rr.crop)
                } else {
                    await self.stopStream()
                    guard myGen == self.startGen else { return }
                    self.req = rr
                    let s = SCStream(filter: filter, configuration: cfg, delegate: self)
                    try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
                    self.stream = s
                    self.setActive(s)
                    try await s.startCapture()
                    // Superseded while starting (another window chosen, or stop): shut this one down.
                    if myGen != self.startGen || self.stream !== s {
                        try? await s.stopCapture()
                        return
                    }
                    self.queue.async { self.encoder.reset() }
                    self.bumpGen(size: size, crop: rr.crop)
                }
                self.setRate(bitrate: rr.bitrate, fps: rr.fps)
                self.keyframe()
                self.queue.async { self.lastBuffer = nil }
                self.startTracking()
                Log.info("streaming \(rr.kind) \(rr.id) at \(Int(size.width))x\(Int(size.height))")
            } catch {
                Log.info("capture start failed: \(error.localizedDescription)")
                self.ipc.sendJSON(["type": "streamError", "message": error.localizedDescription,
                                   "permission": !CGPreflightScreenCaptureAccess()])
            }
        }
    }

    func update(crop: CGRect?, maxW: Int?, maxH: Int?, fps: Int?, bitrate: Int?) {
        guard let s = stream else { return }
        let old = req
        var r = old
        if let c = crop { r.crop = Capture.clampCrop(c) }
        if let v = maxW { r.maxW = max(64, v) }
        if let v = maxH { r.maxH = max(64, v) }
        if let v = fps { r.fps = max(5, min(60, v)) }
        if let v = bitrate { r.bitrate = max(300_000, min(40_000_000, v)) }
        if r.bitrate != old.bitrate || r.fps != old.fps { setRate(bitrate: r.bitrate, fps: r.fps) }
        let geometryChanged = r.crop != old.crop || r.maxW != old.maxW || r.maxH != old.maxH || r.fps != old.fps
        req = r
        guard geometryChanged else { return }
        let (cfg, size) = config(for: r)
        applyConfig(s, cfg, size: size, crop: r.crop)
    }

    /// Configuration changes are applied one after another (never out of order); each one starts a
    /// new "generation", announced to the phone with its region and size.
    private func applyConfig(_ s: SCStream, _ cfg: SCStreamConfiguration, size: CGSize, crop: CGRect) {
        let prev = configChain
        configChain = Task { @MainActor in
            await prev?.value
            guard self.stream === s else { return }
            try? await s.updateConfiguration(cfg)
            self.bumpGen(size: size, crop: crop)
        }
    }

    /// Start a new generation on the capture queue (frames encoded from now on carry it), then tell the phone.
    private func bumpGen(size: CGSize, crop: CGRect) {
        queue.async {
            self.gen &+= 1
            let g = self.gen
            DispatchQueue.main.async { self.announce(gen: g, size: size, crop: crop) }
        }
    }

    func setJPEG(_ on: Bool) { var r = req; r.jpeg = on; req = r; if !on { keyframe() } }

    func stop() {
        startGen += 1 // cancels any start still in progress
        Task { await stopStream() }
    }

    @MainActor private func stopStream() async {
        trackTimer?.invalidate(); trackTimer = nil
        if let s = stream {
            stream = nil
            setActive(nil)
            try? await s.stopCapture()
        }
        queue.async { self.lastBuffer = nil; self.refineTimer?.cancel(); self.refineTimer = nil }
    }

    static func clampCrop(_ c: CGRect) -> CGRect {
        let w = min(1, max(0.02, c.width)), h = min(1, max(0.02, c.height))
        let x = min(1 - w, max(0, c.minX)), y = min(1 - h, max(0, c.minY))
        return CGRect(x: x, y: y, width: w, height: h)
    }

    private func config(for r: StreamRequest) -> (SCStreamConfiguration, CGSize) {
        let cfg = SCStreamConfiguration()
        let full = targetFrame.size
        let src = CGRect(x: r.crop.minX * full.width, y: r.crop.minY * full.height,
                         width: r.crop.width * full.width, height: r.crop.height * full.height)
        // Native pixels of the region, scaled down only as far as the phone can actually show.
        let nativeW = src.width * pointScale, nativeH = src.height * pointScale
        var k = min(1.0, Double(r.maxW) / Double(nativeW), Double(r.maxH) / Double(nativeH))
        let longSide = max(nativeW, nativeH) * k
        if longSide > 3840 { k *= 3840 / longSide }
        let w = max(64, Int((nativeW * k / 2).rounded()) * 2), h = max(64, Int((nativeH * k / 2).rounded()) * 2)
        cfg.width = w; cfg.height = h
        if r.crop != CGRect(x: 0, y: 0, width: 1, height: 1) { cfg.sourceRect = src }
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(r.fps))
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        cfg.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        cfg.colorSpaceName = CGColorSpace.sRGB
        cfg.showsCursor = true
        cfg.queueDepth = 5
        cfg.capturesAudio = false
        cfg.scalesToFit = true
        cfg.preservesAspectRatio = true
        if #available(macOS 14.0, *) {
            cfg.ignoreShadowsSingleWindow = true
            cfg.shouldBeOpaque = true
            cfg.captureResolution = .best
        }
        return (cfg, CGSize(width: w, height: h))
    }

    private var lastAnnounced: (size: CGSize, crop: CGRect, gen: UInt32) = (.zero, .zero, 0)

    /// Tell the server what is being streamed, so the phone can map touches to the right spot.
    private func announce(gen: UInt32, size: CGSize, crop: CGRect) {
        lastAnnounced = (size, crop, gen)
        let r = req
        ipc.sendJSON(["type": "streamInfo", "kind": r.kind, "id": r.id, "gen": gen,
                      "frame": ["x": targetFrame.minX, "y": targetFrame.minY, "w": targetFrame.width, "h": targetFrame.height],
                      "crop": ["x": crop.minX, "y": crop.minY, "w": crop.width, "h": crop.height],
                      "width": Int(size.width), "height": Int(size.height), "fps": r.fps,
                      "bitrate": r.bitrate, "scale": pointScale])
    }

    // Follow the window if it moves or changes size; stop cleanly if it closes.
    private func startTracking() {
        trackTimer?.invalidate()
        trackTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            guard let self, let s = self.stream else { return }
            let r = self.req
            let now: CGRect?
            if r.kind == "display" { now = CGDisplayBounds(r.id) } else { now = Windows.bounds(of: r.id) }
            guard let f = now else {
                self.ipc.sendJSON(["type": "targetGone", "id": r.id])
                self.stop()
                return
            }
            guard f != self.targetFrame else { return }
            var resized = f.size != self.targetFrame.size
            self.targetFrame = f
            // Moved to a screen with a different sharpness (Retina or not): capture at its scale.
            if r.kind == "window" {
                let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
                let mid = NSPoint(x: f.midX, y: primaryHeight - f.midY)
                if let scr = NSScreen.screens.first(where: { NSMouseInRect(mid, $0.frame, false) }), scr.backingScaleFactor != self.pointScale {
                    self.pointScale = scr.backingScaleFactor
                    resized = true
                }
            }
            if resized {
                let (cfg, size) = self.config(for: r)
                self.applyConfig(s, cfg, size: size, crop: r.crop)
            } else {
                // Only moved: same picture, new position for touches.
                self.announce(gen: self.lastAnnounced.gen, size: self.lastAnnounced.size, crop: self.lastAnnounced.crop)
            }
        }
    }

    // MARK: frames

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, isActive(stream), sample.isValid,
              let atts = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = atts.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let pb = CMSampleBufferGetImageBuffer(sample) else { return }
        var epochUs = nowUs()
        if let t = atts.first?[.displayTime] as? UInt64 { epochUs = machToEpochUs(t) }
        lastBuffer = pb
        logCaptured += 1
        if Date().timeIntervalSince(logAt) >= 5 {
            Log.info("last 5 s: captured \(logCaptured), encoded \(logEncoded), skipped \(logSkipped)")
            logCaptured = 0; logEncoded = 0; logSkipped = 0; logAt = Date()
        }
        lastPTS = CMSampleBufferGetPresentationTimeStamp(sample)
        refineCount = 0
        process(pb, pts: lastPTS, epochUs: epochUs)
        scheduleRefine()
    }

    private func process(_ pb: CVPixelBuffer, pts: CMTime, epochUs: UInt64) {
        if req.jpeg { sendJPEG(pb); return }
        // If the server is behind, skip this capture rather than queueing delay (the encoder never
        // sees it, so nothing downstream breaks).
        if ipc.pendingBytes > 3_000_000 { framesSkipped += 1; logSkipped += 1; return }
        activeGen = gen
        encoder.encode(pb, pts: pts, captureEpochUs: epochUs)
    }

    // A still screen gets re-encoded twice more, which sharpens text after scrolling stops.
    private func scheduleRefine() {
        refineTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .milliseconds(140), repeating: .milliseconds(160))
        t.setEventHandler { [weak self] in
            guard let self, let pb = self.lastBuffer, self.refineCount < 2, !self.req.jpeg else { self?.refineTimer?.cancel(); return }
            self.refineCount += 1
            self.lastPTS = CMTimeAdd(self.lastPTS, CMTime(value: 1, timescale: 600))
            self.process(pb, pts: self.lastPTS, epochUs: nowUs())
        }
        t.resume()
        refineTimer = t
    }

    private func sendVideo(_ data: Data, key: Bool, epochUs: UInt64) {
        var header = Data(count: 21)
        header.withUnsafeMutableBytes { p in
            p.storeBytes(of: UInt8(key ? 1 : 0), toByteOffset: 0, as: UInt8.self)
            p.storeBytes(of: activeGen.bigEndian, toByteOffset: 1, as: UInt32.self)
            p.storeBytes(of: epochUs.bigEndian, toByteOffset: 5, as: UInt64.self)
            p.storeBytes(of: nowUs().bigEndian, toByteOffset: 13, as: UInt64.self)
        }
        header.append(data)
        ipc.send(type: .video, payload: header)
        framesSent += 1
        logEncoded += 1
    }

    private func sendJPEG(_ pb: CVPixelBuffer) {
        guard !jpegBusy, Date().timeIntervalSince(lastJpeg) > 1.0 / 15 else { return }
        jpegBusy = true; lastJpeg = Date()
        let g = gen
        let crop = req.crop
        DispatchQueue.global(qos: .userInitiated).async {
            defer { self.jpegBusy = false }
            var img: CGImage?
            VTCreateCGImageFromCVPixelBuffer(pb, options: nil, imageOut: &img)
            guard let img, let jpeg = Images.jpeg(img, quality: 0.62) else { return }
            self.ipc.sendImage(meta: ["kind": "frame", "gen": g, "w": img.width, "h": img.height,
                                      "crop": ["x": crop.minX, "y": crop.minY, "w": crop.width, "h": crop.height]], jpeg: jpeg)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Log.info("stream stopped: \(error.localizedDescription)")
        DispatchQueue.main.async {
            guard self.stream === stream else { return } // an old stream we already replaced
            self.stream = nil; self.setActive(nil); self.trackTimer?.invalidate()
            self.ipc.sendJSON(["type": "streamError", "message": error.localizedDescription,
                               "permission": !CGPreflightScreenCaptureAccess()])
        }
    }

    func stats() -> [String: Any] {
        defer { framesSent = 0; framesSkipped = 0 }
        return ["sent": framesSent, "skipped": framesSkipped]
    }
}

func err(_ s: String) -> NSError { NSError(domain: "wr", code: 1, userInfo: [NSLocalizedDescriptionKey: s]) }

func nowUs() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1_000_000) }

private let timebase: mach_timebase_info_data_t = { var t = mach_timebase_info_data_t(); mach_timebase_info(&t); return t }()
func machToEpochUs(_ t: UInt64) -> UInt64 {
    let now = mach_absolute_time()
    let nowEpoch = nowUs()
    let diffTicks = Int64(bitPattern: now &- t)
    let diffUs = diffTicks * Int64(timebase.numer) / Int64(timebase.denom) / 1000
    return UInt64(Int64(nowEpoch) - diffUs)
}

enum Images {
    static func jpeg(_ img: CGImage, quality: Double) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }
    static func png(_ img: CGImage) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, img, nil)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }
}
