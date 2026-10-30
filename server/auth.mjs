// Who may use Window Remote:
// 1. The connection must come from this Mac (127.0.0.1) or from a device signed in to the same
//    Tailscale account as this Mac (checked with `tailscale whois` against the Mac's own user).
// 2. The device must have been paired once with a one-time code shown only on the Mac. Pairing
//    gives the phone a long random key in a cookie; only a fingerprint of it is stored here, tied to
//    that Tailscale device, so a copied cookie does not work from another device.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TAILSCALE = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'].find((p) => fs.existsSync(p)) || 'tailscale';
const CODE_TTL_MS = 5 * 60_000;
const MAX_TRIES = 5;

function run(args, timeout = 4000) {
  return new Promise((resolve, reject) => {
    execFile(TAILSCALE, args, { timeout }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
export const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
export function isTailscaleIp(ip) {
  ip = cleanIp(ip);
  const m = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m) return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

export class Auth {
  constructor(dataDir, { test = false } = {}) {
    this.file = path.join(dataDir, 'devices.json');
    this.test = test;
    this.whoisCache = new Map();
    this.selfUser = null;
    this.selfInfo = null;
    this.code = null;
    this.devices = this.load();
  }

  load() {
    try { this.mtime = fs.statSync(this.file).mtimeMs; return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  /** Pick up changes made to devices.json outside the server (for example removing a device). */
  fresh() {
    let m = 0;
    try { m = fs.statSync(this.file).mtimeMs; } catch { /* no file yet */ }
    if (m !== this.mtime) this.devices = this.load();
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.mtime = fs.statSync(this.file).mtimeMs;
  }

  async self() {
    if (this.selfInfo && Date.now() - this.selfInfo.at < 60_000) return this.selfInfo;
    const s = JSON.parse(await run(['status', '--json']));
    this.selfInfo = {
      at: Date.now(),
      userId: String(s.Self?.UserID ?? ''),
      ips: s.Self?.TailscaleIPs || [],
      dnsName: String(s.Self?.DNSName || '').replace(/\.$/, ''),
      hostName: s.Self?.HostName || '',
      online: s.BackendState === 'Running',
    };
    return this.selfInfo;
  }

  /** Tailscale identity of a remote address, or null if it is not one of your own devices. */
  async whois(ip) {
    ip = cleanIp(ip);
    const hit = this.whoisCache.get(ip);
    if (hit && Date.now() - hit.at < (hit.sure ? 5 * 60_000 : 5_000)) return hit.value;
    let value = null;
    let sure = false; // a failed lookup (Tailscale starting up) is only remembered for 5 seconds
    try {
      const me = await this.self();
      const w = JSON.parse(await run(['whois', '--json', ip]));
      const userId = String(w.UserProfile?.ID ?? '');
      if (userId && userId === me.userId) {
        value = { nodeId: w.Node?.StableID || String(w.Node?.ID), name: w.Node?.ComputedName || w.Node?.Name || 'device', os: w.Node?.Hostinfo?.OS || '' };
      }
      sure = true;
    } catch { value = null; }
    this.whoisCache.set(ip, { at: Date.now(), value, sure });
    return value;
  }

  /** The device behind a connection: { ok, local, nodeId, name } or { ok: false, why }. */
  async identify(remoteAddress) {
    const ip = cleanIp(remoteAddress);
    if (isLoopback(ip)) return { ok: true, local: true, nodeId: 'local', name: 'this Mac' };
    if (!isTailscaleIp(ip)) return { ok: false, why: 'not-tailscale' };
    const who = await this.whois(ip);
    if (!who) return { ok: false, why: 'not-yours' };
    return { ok: true, local: false, ...who };
  }

  static hash(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

  /** Is this cookie a paired key for this same device? */
  paired(token, who) {
    if (!token || !who?.ok) return null;
    this.fresh();
    const d = this.devices[Auth.hash(token)];
    if (!d || d.nodeId !== who.nodeId) return null;
    if (Date.now() - (d.lastSeenSaved || 0) > 3600_000) { d.lastSeen = new Date().toISOString(); d.lastSeenSaved = Date.now(); try { this.save(); } catch { /* not critical */ } }
    return d;
  }

  startPairing(who) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    this.code = { code, nodeId: who.nodeId, name: who.name, expires: Date.now() + CODE_TTL_MS, tries: 0 };
    if (this.test) fs.writeFileSync(path.join(path.dirname(this.file), 'test-pair-code.txt'), code);
    return { code, seconds: CODE_TTL_MS / 1000 };
  }

  /** Mac menu "Pair an iPhone": a code any of your own devices can use once. */
  startPairingFromMac() {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    this.code = { code, nodeId: null, name: '', expires: Date.now() + CODE_TTL_MS, tries: 0 };
    return { code, seconds: CODE_TTL_MS / 1000 };
  }

  finishPairing(who, entered, label) {
    const c = this.code;
    if (!c || Date.now() > c.expires) return { ok: false, message: 'That code has expired. Ask for a new one.' };
    if (c.nodeId && c.nodeId !== who.nodeId) return { ok: false, message: 'That code was made for a different device.' };
    c.tries += 1;
    const good = crypto.timingSafeEqual(Buffer.from(String(entered).replace(/\D/g, '').padEnd(6, 'x').slice(0, 6)), Buffer.from(c.code));
    if (!good) {
      if (c.tries >= MAX_TRIES) this.code = null;
      return { ok: false, message: c.tries >= MAX_TRIES ? 'Too many tries. Ask for a new code.' : 'That code is not right. Try again.' };
    }
    this.code = null;
    const token = crypto.randomBytes(32).toString('base64url');
    this.devices[Auth.hash(token)] = { nodeId: who.nodeId, name: label || who.name, paired: new Date().toISOString(), lastSeen: new Date().toISOString() };
    this.save();
    return { ok: true, token };
  }

  /** Un-pair every device. The old list is kept beside it with the date (never deleted). */
  forgetAll() {
    if (fs.existsSync(this.file)) fs.renameSync(this.file, this.file.replace(/\.json$/, `-forgotten-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    this.devices = {};
    this.save();
  }

  forget(token) {
    delete this.devices[Auth.hash(token)];
    this.save();
  }
}
