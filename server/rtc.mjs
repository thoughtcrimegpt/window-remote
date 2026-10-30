// WebRTC video to the phone (werift). The Mac offers one H.264 video track and one data channel
// for touches and stats. Only Tailscale addresses (and this Mac, for tests) are offered as
// candidates, and connectivity checks are answered only from the phone's own address.

import {
  RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, RtpPacket, RtpHeader,
  useTransportWideCC, useAbsSendTime,
} from 'werift';
import { cleanIp, isLoopback, isTailscaleIp } from './auth.mjs';

const MTU_PAYLOAD = 1150;

// ---------- H.264 to RTP (RFC 6184: single NAL units and FU-A fragments) ----------

export function splitAnnexB(buf) {
  const nals = [];
  let i = 0, start = -1;
  const n = buf.length;
  while (i + 3 <= n) {
    let sc = 0;
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) sc = 3;
    else if (i + 4 <= n && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) sc = 4;
    if (sc) {
      if (start >= 0) nals.push(buf.subarray(start, i));
      i += sc; start = i;
    } else i++;
  }
  if (start >= 0 && start < n) nals.push(buf.subarray(start));
  return nals.filter((x) => x.length > 0);
}

export function packetize(annexB) {
  const out = [];
  for (const nal of splitAnnexB(annexB)) {
    if (nal.length <= MTU_PAYLOAD) { out.push(Buffer.from(nal)); continue; }
    const hdr = nal[0];
    const fuIndicator = (hdr & 0xe0) | 28;
    const type = hdr & 0x1f;
    let off = 1;
    while (off < nal.length) {
      const end = Math.min(off + MTU_PAYLOAD - 2, nal.length);
      const fuHeader = (off === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0) | type;
      out.push(Buffer.concat([Buffer.from([fuIndicator, fuHeader]), nal.subarray(off, end)]));
      off = end;
    }
  }
  return out;
}

// ---------- one phone connection ----------

export class RtcSession {
  /**
   * @param {object} o
   * @param {string} o.remoteIp  the phone's address (from its WebSocket)
   * @param {string} o.bindIp  the one local address to offer (the Mac's Tailscale address)
   */
  constructor({ remoteIp, bindIp, onMessage, onState, onKeyframeNeeded, lossPct = 0 }) {
    this.remoteIp = cleanIp(remoteIp);
    this.onMessage = onMessage;
    this.onState = onState;
    this.onKeyframeNeeded = onKeyframeNeeded;
    this.seq = Math.floor(Math.random() * 65535);
    this.queue = [];
    this.sending = false;
    this.bytesSent = 0;
    this.connected = false;
    const allowed = (addr) => {
      const ip = cleanIp(addr?.[0] ?? addr);
      if (isLoopback(this.remoteIp)) return isLoopback(ip) || isTailscaleIp(ip);
      return ip === this.remoteIp;
    };
    // Constrained High first (sharper text for the same data; iPhone Safari takes it), then High and
    // Constrained Baseline for browsers that only take those. The encoder follows whichever is chosen.
    const fb = [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }, { type: 'goog-remb' }, { type: 'transport-cc' }];
    const h264 = [['640c1f', 102], ['64001f', 103], ['42e01f', 104]].map(([plid, pt]) => new RTCRtpCodecParameters({
      mimeType: 'video/H264', clockRate: 90000, payloadType: pt, rtcpFeedback: fb,
      parameters: `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${plid}`,
    }));
    this.pc = new RTCPeerConnection({
      iceServers: [],
      codecs: { video: h264 },
      headerExtensions: { video: [useTransportWideCC(), useAbsSendTime()] },
      // Offer exactly one address (the Tailscale one). Address discovery is off, so the library never
      // contacts an outside server, and ICE lite means the phone does the checking.
      iceLite: true,
      bundlePolicy: 'max-bundle',
      iceUseIpv4: false,
      iceUseIpv6: false,
      iceInterfaceAddresses: { udp4: bindIp },
      iceAdditionalHostAddresses: [bindIp],
      iceFilterStunResponse: (_msg, addr) => allowed(addr),
      iceFilterCandidatePair: (pair) => allowed([pair.remoteCandidate?.host]),
      // Test only: drop this share of outgoing packets to imitate a weak cellular link.
      // (werift's setting is inverted: it keeps that percentage, so ask it to keep 100 - loss.)
      ...(lossPct > 0 ? { debug: { outboundPacketLoss: 100 - lossPct } } : {}),
    });
    this.track = new MediaStreamTrack({ kind: 'video' });
    this.transceiver = this.pc.addTransceiver(this.track, { direction: 'sendonly' });
    this.sender = this.transceiver.sender;
    this.sender.onPictureLossIndication.subscribe(() => this.onKeyframeNeeded?.('pli'));
    this.sender.senderBWE?.onAvailableBitrate?.subscribe((bps) => { this.bweBps = bps; });
    this.channel = this.pc.createDataChannel('input', { ordered: true });
    this.channel.onopen = () => this.onState?.('channel-open');
    this.channel.onMessage.subscribe((data) => {
      try { this.onMessage?.(JSON.parse(data.toString())); } catch { /* ignore bad message */ }
    });
    this.pc.connectionStateChange.subscribe((s) => {
      this.connected = s === 'connected';
      if (s === 'connected') this.onKeyframeNeeded?.('connected');
      this.onState?.(s);
    });
  }

  async offer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    // Host-only gathering finishes quickly; wait for it so the offer carries every candidate.
    const deadline = Date.now() + 2500;
    while (this.pc.iceGatheringState !== 'complete' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    return this.pc.localDescription.sdp;
  }

  /** Apply the phone's answer; returns the H.264 profile it chose ("high" or "baseline"). */
  async answer(sdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    const codec = this.transceiver.codecs?.[0] || this.sender.codec;
    const plid = /profile-level-id=([0-9a-f]{6})/i.exec(codec?.parameters || '')?.[1] || '640c1f';
    this.profile = plid.toLowerCase().startsWith('42') ? 'baseline' : 'high';
    return this.profile;
  }

  send(msg) {
    if (this.channel?.readyState === 'open') { try { this.channel.send(JSON.stringify(msg)); return true; } catch { /* closed */ } }
    return false;
  }

  /** Send one encoded frame. Packets are paced so a big keyframe does not swamp a slow link. */
  sendFrame(frame, paceBps) {
    if (!this.connected) return;
    const ts = Number((BigInt(frame.captureUs) * 90n / 1000n) & 0xffffffffn);
    const payloads = packetize(frame.data);
    payloads.forEach((p, i) => {
      const header = new RtpHeader({ payloadType: 0, sequenceNumber: this.seq, timestamp: ts, marker: i === payloads.length - 1, ssrc: 0 });
      this.seq = (this.seq + 1) & 0xffff;
      this.queue.push(new RtpPacket(header, p));
    });
    this.paceBps = Math.max(20_000_000, (paceBps || 0) * 3);
    if (!this.sending) this.drain();
  }

  async drain() {
    this.sending = true;
    let budget = 0, last = performance.now();
    while (this.queue.length && this.connected) {
      const now = performance.now();
      budget = Math.min(budget + ((now - last) / 1000) * (this.paceBps / 8), 64_000);
      last = now;
      if (budget <= 0) { await new Promise((r) => setTimeout(r, 1)); continue; }
      const pkt = this.queue.shift();
      budget -= pkt.payload.length + 40;
      try { await this.sender.sendRtp(pkt); this.bytesSent += pkt.payload.length; } catch { /* transport closing */ }
    }
    this.sending = false;
  }

  stats() {
    return { fractionLost: this.sender.remoteFractionLost ?? null, remb: Number(this.sender.receiverEstimatedMaxBitrate || 0n) || null, bwe: this.bweBps ?? null };
  }

  close() {
    this.connected = false;
    this.queue = [];
    try { this.pc.close(); } catch { /* already closed */ }
  }
}

// ---------- quality control ----------

/** Adjusts bitrate and frame rate from what the phone reports once a second (loss, delay, freezes). */
export class RateController {
  constructor() {
    this.min = 400_000;
    this.max = 24_000_000;
    this.bitrate = 10_000_000;
    this.fps = 60;
    this.scale = 1;
    this.baseRtt = null;
    this.goodStreak = 0;
    this.cap = 24_000_000;
  }

  /** Screen content needs about 0.12 bits per pixel per frame to keep text crisp; more only adds delay. */
  setPicture(w, h, fps) {
    this.cap = Math.max(3_000_000, Math.min(this.max, Math.round(w * h * fps * 0.12)));
    if (this.bitrate > this.cap) { this.bitrate = this.cap; return true; }
    return false;
  }

  update(s) {
    // Lost packets that were sent again do not show as lost, so heavy resending counts too.
    const loss = Math.max(0, Math.min(1, Math.max(s.loss ?? 0, (s.nackRate ?? 0) * 0.8)));
    const rtt = s.rtt ?? null;
    if (rtt != null) this.baseRtt = this.baseRtt == null ? rtt : Math.min(this.baseRtt * 1.002 + 0.0005, rtt, this.baseRtt + 0.05);
    // Growing delay means the link is full: back off firmly. Packet loss alone is often just a noisy
    // cellular link, where sending less does not help, so it only nudges the rate down a little,
    // and never below a floor that still gives a smooth picture.
    const queueing = rtt != null && this.baseRtt != null && rtt - this.baseRtt > 0.08;
    const late = (s.jitterBuffer ?? 0) > 0.15;
    const floor = 1_200_000;
    let changed = false;
    if (queueing || late) {
      this.bitrate = Math.max(this.min, Math.round(this.bitrate * 0.7));
      this.goodStreak = 0; changed = true;
    } else if (loss > 0.12) {
      const next = Math.max(Math.min(floor, this.bitrate), Math.round(this.bitrate * 0.88));
      if (next !== this.bitrate) { this.bitrate = next; changed = true; }
      this.goodStreak = 0;
    } else if (loss < 0.04) {
      this.goodStreak++;
      if (this.goodStreak >= 2 && this.bitrate < this.cap) {
        this.bitrate = Math.min(this.cap, Math.round(this.bitrate * 1.12 + 250_000)); changed = true;
      }
    }
    if (s.remb && s.remb > 100_000 && this.bitrate > s.remb * 1.1) { this.bitrate = Math.max(this.min, Math.round(s.remb * 0.9)); changed = true; }
    const fps = this.bitrate < 700_000 ? 20 : this.bitrate < 2_000_000 ? 30 : 60;
    const scale = this.bitrate < 600_000 ? 0.6 : this.bitrate < 1_500_000 ? 0.8 : 1;
    if (fps !== this.fps || scale !== this.scale) changed = true;
    this.fps = fps; this.scale = scale;
    return changed;
  }

}
