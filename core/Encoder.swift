// Hardware H.264 encoder (VideoToolbox) tuned for low delay: no reordered frames, low-latency rate
// control, keyframes on request. Output is Annex B (start codes) with SPS/PPS before each keyframe.

import Foundation
import VideoToolbox
import CoreMedia

final class H264Encoder {
    private var session: VTCompressionSession?
    private(set) var width: Int32 = 0
    private(set) var height: Int32 = 0
    var bitrate: Int = 10_000_000 { didSet { applyRate() } }
    var fps: Int = 60 { didSet { applyRate() } }
    /// "high" (Constrained High) or "baseline" (Constrained Baseline), whichever the phone accepted.
    var profile = "high" { didSet { if profile != oldValue { reset() } } }
    private var forceKey = true
    /// Called on VideoToolbox's thread with (annexB, isKeyframe, captureEpochMicros).
    var onFrame: ((Data, Bool, UInt64) -> Void)?

    func requestKeyframe() { forceKey = true }

    func reset() {
        if let s = session { VTCompressionSessionInvalidate(s) }
        session = nil; width = 0; height = 0
    }

    private func create(width w: Int32, height h: Int32) -> Bool {
        reset()
        let spec: [CFString: Any] = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
        ]
        var s: VTCompressionSession?
        let st = VTCompressionSessionCreate(allocator: nil, width: w, height: h, codecType: kCMVideoCodecType_H264,
                                            encoderSpecification: spec as CFDictionary, imageBufferAttributes: nil,
                                            compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        guard st == noErr, let s else { Log.info("encoder create failed \(st)"); return false }
        func set(_ k: CFString, _ v: Any) {
            let r = VTSessionSetProperty(s, key: k, value: v as CFTypeRef)
            if r != noErr { Log.info("encoder property \(k) not set (\(r))") }
        }
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!)
        set(kVTCompressionPropertyKey_ProfileLevel, profile == "baseline" ? kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel : kVTProfileLevel_H264_ConstrainedHigh_AutoLevel)
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse!)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, 3600)
        set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 60)
        set(kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2)
        set(kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2)
        set(kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2)
        session = s; width = w; height = h
        applyRate()
        VTCompressionSessionPrepareToEncodeFrames(s)
        forceKey = true
        Log.info("encoder ready \(w)x\(h) \(profile)")
        return true
    }

    private func applyRate() {
        guard let s = session else { return }
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bitrate))
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
        // Cap bursts at 1.5x the average over a second so a big change does not flood a slow link.
        let limits = [NSNumber(value: bitrate * 3 / 16), NSNumber(value: 1)] as CFArray
        VTSessionSetProperty(s, key: kVTCompressionPropertyKey_DataRateLimits, value: limits)
    }

    func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime, captureEpochUs: UInt64) {
        let w = Int32(CVPixelBufferGetWidth(pixelBuffer)), h = Int32(CVPixelBufferGetHeight(pixelBuffer))
        if session == nil || w != width || h != height {
            guard create(width: w, height: h) else { return }
        }
        guard let s = session else { return }
        var props: CFDictionary?
        if forceKey {
            props = [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
            forceKey = false
        }
        VTCompressionSessionEncodeFrame(s, imageBuffer: pixelBuffer, presentationTimeStamp: pts, duration: .invalid,
                                        frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sample in
            guard status == noErr, let sample, let self else { return }
            self.emit(sample, captureEpochUs: captureEpochUs)
        }
    }

    private func emit(_ sample: CMSampleBuffer, captureEpochUs: UInt64) {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        var isKey = true
        if let atts = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]],
           let first = atts.first, let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
            isKey = !notSync
        }
        let start: [UInt8] = [0, 0, 0, 1]
        var out = Data()
        if isKey, let fmt = CMSampleBufferGetFormatDescription(sample) {
            var count = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                               parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
            for i in 0..<count {
                var ptr: UnsafePointer<UInt8>?; var size = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &ptr,
                                                                      parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let ptr {
                    out.append(contentsOf: start); out.append(ptr, count: size)
                }
            }
        }
        var total = 0; var dataPtr: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &total, dataPointerOut: &dataPtr) == noErr,
              let dataPtr else { return }
        let raw = UnsafeRawPointer(dataPtr)
        var off = 0
        while off + 4 <= total {
            let len = Int(raw.loadUnaligned(fromByteOffset: off, as: UInt32.self).bigEndian)
            off += 4
            guard len > 0, off + len <= total else { break }
            out.append(contentsOf: start)
            out.append(raw.advanced(by: off).assumingMemoryBound(to: UInt8.self), count: len)
            off += len
        }
        onFrame?(out, isKey, captureEpochUs)
    }
}
