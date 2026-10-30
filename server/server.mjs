// Window Remote server: the phone app's web server.
//
// Listens only on 127.0.0.1 and on this Mac's Tailscale address (never 0.0.0.0, never the public
// internet). Every connection must come from this Mac or from a device signed in to the same
// Tailscale account as this Mac (tailscale whois), and every device must be paired once with a code
// shown on the Mac. The Swift helper (wr-core) does the screen capture, video encoding and mouse/keyboard; it
// connects to this server over a private Unix socket.

import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { CoreBridge } from './core.mjs';
import { Auth, TAILSCALE, cleanIp, isLoopback } from './auth.mjs';
import { RtcSession, RateController } from './rtc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.WR_PORT || 8765);
const TEST = process.env.WR_TEST === '1';
const DATA = process.env.WR_SUPPORT_DIR || path.join(os.homedir(), 'Library/Application Support/Window Remote');
const SOCKET = process.env.WR_SOCKET || path.join(DATA, 'core.sock');
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

const HTTPS_PORT = Number(process.env.WR_HTTPS_PORT || 8764);
const TLS_DIR = path.join(DATA, 'tls'); // filled by tls/setup-https.sh (optional)
const core = new CoreBridge(SOCKET);
// The Mac app (the Window Remote window) proves itself with this key, readable only by this Mac user.
const ADMIN_KEY_FILE = path.join(DATA, 'admin.key');
if (!fs.existsSync(ADMIN_KEY_FILE)) fs.writeFileSync(ADMIN_KEY_FILE, crypto.randomBytes(32).toString('base64url'), { mode: 0o600 });
const ADMIN_KEY = fs.readFileSync(ADMIN_KEY_FILE, 'utf8').trim();
const LAUNCH_AGENT = path.join(os.homedir(), 'Library/LaunchAgents/local.window-remote.plist');
const LAUNCHD_DIR = path.join(HERE, '..', 'launchd');
const auth = new Auth(DATA, { test: TEST });
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- addresses ----------

let tsIp = process.env.WR_BIND_IP || null;
let dnsNames = [];

function findTailscaleIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4') {
        const [p, q] = a.address.split('.').map(Number);
        if (p === 100 && q >= 64 && q <= 127) return a.address;
      }
    }
  }
  return null;
}

const servers = new Map(); // address -> http.Server

function allowedHosts() {
  const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  if (tsIp) { hosts.add(`${tsIp}:${PORT}`); hosts.add(`${tsIp}:${HTTPS_PORT}`); }
  for (const n of dnsNames) { hosts.add(`${n}:${PORT}`); hosts.add(`${n}:${HTTPS_PORT}`); }
  return hosts;
}

async function refreshAddresses() {
  let ip = process.env.WR_BIND_IP || null;
  if (!ip && !TEST) {
    try {
      const me = await auth.self();
      ip = me.ips.find((x) => x.includes('.')) || null;
      dnsNames = [me.dnsName, me.dnsName.split('.')[0]].filter(Boolean).map((s) => s.toLowerCase());
    } catch { ip = findTailscaleIp(); }
    if (ip && !findTailscaleIp()) ip = null; // Tailscale is installed but not connected
  }
  // A Tailscale blip (network change, reconnect) briefly removes the address. Keep listening on it:
  // the socket starts answering again by itself when the address comes back. Only a different
  // address replaces it.
  if (ip && ip !== tsIp) {
    if (tsIp && servers.has(tsIp)) { servers.get(tsIp).close(); servers.delete(tsIp); log(`stopped listening on ${tsIp} (Tailscale address changed)`); }
    tsIp = ip;
  }
  if (tsIp && !servers.has(tsIp) && findTailscaleIp() === tsIp) listenOn(tsIp);
  refreshTls();
}

function listenOn(address) {
  const s = http.createServer(handle);
  s.on('upgrade', upgrade);
  s.on('error', (e) => { log(`could not listen on ${address}:${PORT}: ${e.message}`); servers.delete(address); });
  s.listen(PORT, address, () => log(`listening on http://${address}:${PORT}/`));
  servers.set(address, s);
}

// Optional secure version (https) on the Tailscale address, using a Tailscale certificate for this
// Mac's Tailscale name. It lets the phone app open its own "Mac offline" screen even when the Mac
// cannot be reached. Off until tls/setup-https.sh has been run.
let tls = null; // { server, mtime }
function tlsFiles() {
  const cert = path.join(TLS_DIR, 'cert.pem'), key = path.join(TLS_DIR, 'key.pem');
  try { return { cert, key, mtime: Math.max(fs.statSync(cert).mtimeMs, fs.statSync(key).mtimeMs) }; } catch { return null; }
}
function refreshTls() {
  const f = tlsFiles();
  if (!f || !tsIp) return;
  const opts = { cert: fs.readFileSync(f.cert), key: fs.readFileSync(f.key) };
  if (tls && tls.mtime === f.mtime) return;
  if (tls) { tls.server.setSecureContext(opts); tls.mtime = f.mtime; log('reloaded the https certificate'); return; }
  const s = https.createServer(opts, handle);
  s.on('upgrade', upgrade);
  s.on('error', (e) => { log(`could not listen on https ${tsIp}:${HTTPS_PORT}: ${e.message}`); tls = null; });
  s.listen(HTTPS_PORT, tsIp, () => log(`listening on https://${dnsNames[0] || tsIp}:${HTTPS_PORT}/`));
  tls = { server: s, mtime: f.mtime };
}
// Renew the certificate now and then (only when it was set up before).
setInterval(() => {
  if (!tlsFiles() || !dnsNames[0]) return;
  execFile(TAILSCALE, ['cert', '--cert-file', path.join(TLS_DIR, 'cert.pem'), '--key-file', path.join(TLS_DIR, 'key.pem'), dnsNames[0]], { timeout: 60_000 }, () => refreshTls());
}, 7 * 24 * 3600_000).unref();

// ---------- auth helpers ----------

function cookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

async function gate(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowedHosts().has(host)) return { ok: false, status: 421, why: 'wrong-host' };
  const who = await auth.identify(req.socket.remoteAddress);
  if (!who.ok) return { ok: false, status: 403, why: who.why };
  const device = auth.paired(cookie(req, 'wr_key'), who);
  return { ok: true, who, device, host };
}

function sameOrigin(req, host) {
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}` || origin === `https://${host}`;
}

// ---------- HTTP ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

function headers(host, extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self' ws://${host} wss://${host}; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    ...extra,
  };
}
function send(res, status, body, type, host, extra) { res.writeHead(status, headers(host, { 'Content-Type': type, ...extra })); res.end(body); }
const json = (res, status, obj, host, extra) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', host, extra);

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 200_000) throw new Error('too large'); chunks.push(c); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const thumbs = new Map(); // id -> { jpeg, v }
const icons = new Map();  // bundleId -> png
let pausedUntil = 0;

async function handle(req, res) {
  let g;
  try { g = await gate(req); } catch (e) { res.writeHead(500); res.end('error'); return; }
  if (!g.ok) {
    res.writeHead(g.status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(g.why === 'not-yours' ? 'This device is not on your Tailscale account.' : 'Not allowed.');
    return;
  }
  const host = g.host;
  const url = new URL(req.url, `http://${host}`);
  const p = url.pathname;
  try {
    if (req.method === 'POST' && (!sameOrigin(req, host) || req.headers['x-wr'] !== '1')) return json(res, 403, { ok: false, message: 'Refused.' }, host);

    // Open to any of your own Tailscale devices: the page itself, and pairing.
    if (req.method === 'GET' && (p === '/' || /^\/[\w.-]+\.(js|css|svg|png|webmanifest)$/.test(p))) {
      const file = path.join(PUBLIC, p === '/' ? 'index.html' : p.slice(1));
      const data = await fsp.readFile(file).catch(() => null);
      if (!data) return send(res, 404, 'Not found.', 'text/plain', host);
      return send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream', host);
    }
    // The Mac app: this Mac only, with the admin key.
    if (p.startsWith('/api/admin/')) {
      const key = String(req.headers['x-wr-admin'] || '');
      if (!g.who.local || key.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY))) return json(res, 403, { ok: false, message: 'Refused.' }, host);
      return json(res, 200, await admin(p.slice('/api/admin/'.length), req.method === 'POST' ? await readBody(req) : {}), host);
    }
    if (p === '/api/me') {
      return json(res, 200, { paired: !!g.device, device: g.device?.name || g.who.name, local: g.who.local, helper: core.connected,
        paused: pausedUntil > Date.now(), mac: os.hostname().replace(/\.local$/, ''), tsIp,
        secureUrl: tls && dnsNames[0] ? `https://${dnsNames[0]}:${HTTPS_PORT}/` : null }, host);
    }
    if (p === '/api/pair/start' && req.method === 'POST') {
      if (!core.connected && !TEST) return json(res, 503, { ok: false, message: 'The Mac helper is not running, so the Mac cannot show a code yet.' }, host);
      const { code, seconds } = auth.startPairing(g.who);
      core.send({ cmd: 'showCode', code, seconds, device: g.who.local ? 'this Mac' : g.who.name });
      log(`pairing code shown for ${g.who.name}`);
      return json(res, 200, { ok: true, seconds }, host);
    }
    if (p === '/api/pair/finish' && req.method === 'POST') {
      const body = await readBody(req);
      const r = auth.finishPairing(g.who, body.code, String(body.name || '').slice(0, 60));
      if (!r.ok) return json(res, 200, r, host);
      core.send({ cmd: 'hideCode' });
      log(`paired ${g.who.name}`);
      const secure = req.socket.encrypted ? '; Secure' : '';
      return json(res, 200, { ok: true }, host, { 'Set-Cookie': `wr_key=${r.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000${secure}` });
    }

    // Everything else needs a paired device.
    if (!g.device) return json(res, 401, { ok: false, message: 'Pair this device first.', pair: true }, host);
    if (pausedUntil > Date.now()) return json(res, 423, { ok: false, message: 'Paused from the Mac.' }, host);

    if (p === '/api/pair/forget' && req.method === 'POST') {
      auth.forget(cookie(req, 'wr_key'));
      return json(res, 200, { ok: true }, host, { 'Set-Cookie': 'wr_key=; Path=/; Max-Age=0' });
    }
    let m;
    if ((m = p.match(/^\/api\/thumb\/(d?\d+)$/))) {
      const t = thumbs.get(m[1]);
      if (!t) return send(res, 404, '', 'text/plain', host);
      return send(res, 200, t.jpeg, 'image/jpeg', host, { 'Cache-Control': 'private, max-age=86400' }); // each new picture has a new address
    }
    if ((m = p.match(/^\/api\/icon\/([\w.-]+)\.png$/))) {
      const t = icons.get(m[1]);
      if (!t) return send(res, 404, '', 'text/plain', host);
      return send(res, 200, t, 'image/png', host, { 'Cache-Control': 'private, max-age=86400' });
    }
    return json(res, 404, { ok: false, message: 'Unknown.' }, host);
  } catch (e) {
    log('request error', p, e.message);
    return json(res, 500, { ok: false, message: e.message }, host);
  }
}

// ---------- the Mac app ----------

function estDelay(c) {
  const m = c.lastStats;
  if (!m) return null;
  return Math.round((c.lastFrameDelay ?? 6) + ((m.rtt ?? 0.02) * 1000) / 2 + (m.jitterBuffer ?? 0.015) * 1000 + (m.decodeMs ?? 3) + 8);
}

async function admin(action, body) {
  switch (action) {
    case 'state': {
      auth.fresh?.();
      const st = core.status || {};
      const devices = Object.entries(auth.devices).filter(([, d]) => !d.test).map(([k, d]) => ({
        id: k.slice(0, 16), name: d.name, paired: d.paired, lastSeen: d.lastSeen,
        online: [...clients].some((c) => c.deviceKey === k),
      }));
      return {
        ok: true,
        helper: core.connected, screen: st.screen ?? null, accessibility: st.accessibility ?? null, locked: !!st.locked, displayAsleep: !!st.displayAsleep,
        tailscale: !!tsIp, phoneUrl: tsIp ? `http://${tsIp}:${PORT}/` : null, secureUrl: tls && dnsNames[0] ? `https://${dnsNames[0]}:${HTTPS_PORT}/` : null,
        clients: [...clients].filter((c) => !c.local || !auth.devices[c.deviceKey]?.test).map((c) => ({
          device: c.device, viewing: viewer === c ? (c.view?.label || null) : null, basic: c.basic,
          fps: viewer === c ? c.lastStats?.fps ?? null : null, delayMs: viewer === c ? estDelay(c) : null,
          mbps: viewer === c ? Math.round(c.rate.bitrate / 1e5) / 10 : null,
        })),
        devices,
        pairing: auth.code && Date.now() < auth.code.expires ? { code: auth.code.code, seconds: Math.round((auth.code.expires - Date.now()) / 1000), forDevice: auth.code.name || '' } : null,
        pausedFor: pausedUntil > Date.now() ? Math.round((pausedUntil - Date.now()) / 1000) : 0,
        loginItem: fs.existsSync(LAUNCH_AGENT),
      };
    }
    case 'pair': {
      const { code, seconds } = auth.startPairingFromMac();
      return { ok: true, code, seconds };
    }
    case 'forget': {
      const k = Object.keys(auth.devices).find((x) => x.startsWith(String(body.id || '')) && String(body.id || '').length >= 8);
      if (!k) return { ok: false, message: 'That phone is not paired.' };
      delete auth.devices[k]; auth.save();
      for (const c of clients) if (c.deviceKey === k) { releaseDrag(c); c.rtc?.close(); c.ws.close(); }
      return { ok: true };
    }
    case 'pause': {
      const minutes = Math.max(0, Math.min(24 * 60, Number(body.minutes) || 0));
      pausedUntil = minutes ? Date.now() + minutes * 60_000 : 0;
      if (minutes) {
        for (const c of clients) { releaseDrag(c); wsSend(c.ws, { t: 'paused', minutes }); c.rtc?.close(); c.ws.close(); }
        core.send({ cmd: 'stopStream' });
      }
      return { ok: true };
    }
    case 'permissions':
      await core.request({ cmd: 'requestPermissions' }).catch(() => null);
      return { ok: true };
    case 'probe':
      return await core.request({ cmd: 'probeCapture' }, 10_000).catch((e) => ({ ok: false, message: e.message }));
    case 'loginItem': {
      const script = path.join(LAUNCHD_DIR, body.on ? 'install.sh' : 'uninstall.sh');
      const r = await new Promise((resolve) => execFile('/bin/zsh', [script], { timeout: 30_000 }, (e, out, err) => resolve({ ok: !e, message: (e ? err || e.message : out).trim().split('\n').pop() })));
      return { ...r, loginItem: fs.existsSync(LAUNCH_AGENT) };
    }
    default:
      return { ok: false, message: 'Unknown.' };
  }
}

// ---------- live connection (WebSocket) ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
const clients = new Set();
let viewer = null; // the client that owns the stream

async function upgrade(req, socket, head) {
  try {
    const g = await gate(req);
    if (!g.ok || !g.device || !sameOrigin(req, g.host) || new URL(req.url, 'http://x').pathname !== '/ws' || pausedUntil > Date.now()) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => connection(ws, req, g));
  } catch { socket.destroy(); }
}

function wsSend(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj) { for (const c of clients) wsSend(c.ws, obj); }

function macStatus() {
  const s = core.status || {};
  return { t: 'status', helper: core.connected, screen: s.screen ?? null, accessibility: s.accessibility ?? null, locked: !!s.locked,
    displayAsleep: !!s.displayAsleep, screensaver: !!s.screensaver, frontApp: s.frontApp || '', paused: pausedUntil > Date.now() };
}

function updateMacMenu() {
  const n = clients.size;
  const v = viewer?.view;
  const text = n === 0 ? 'No phone connected' : v ? `Phone viewing ${v.label || 'the Mac'}` : `${viewer?.device || 'Phone'} connected`;
  core.send({ cmd: 'uiStatus', text, active: n > 0 });
}

function connection(ws, req, g) {
  const c = { ws, ip: cleanIp(req.socket.remoteAddress), device: g.device.name, deviceKey: Object.keys(auth.devices).find((k) => auth.devices[k] === g.device), local: g.who.local, rtc: null, rate: new RateController(),
    view: null, basic: false, viewport: { w: 430, h: 932, dpr: 3 }, layoutId: null, alive: true };
  clients.add(c);
  log(`connected: ${c.device} (${c.ip})`);
  wsSend(ws, macStatus());
  updateMacMenu();
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    // While the helper restarts, the status line already says so: no extra notices.
    onClient(c, m).catch((e) => { if (core.connected) wsSend(ws, { t: 'error', message: e.message }); });
  });
  ws.on('close', () => {
    releaseDrag(c);
    clients.delete(c);
    log(`disconnected: ${c.device}`);
    c.rtc?.close();
    if (viewer === c) {
      viewer = null;
      // Give a phone that is switching networks a moment to come back before stopping.
      const layoutId = c.layoutId;
      setTimeout(() => {
        if (!viewer) { core.send({ cmd: 'stopStream' }); if (layoutId) core.send({ cmd: 'restore', id: layoutId }); }
      }, 45_000);
    }
    updateMacMenu();
  });
}

// A small heartbeat, so phones can tell a live connection from a dead one even while the Mac
// helper is restarting.
setInterval(() => { for (const c of clients) wsSend(c.ws, { t: 'hb' }); }, 3000).unref();

setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch { /* closing */ }
  }
}, 15_000).unref();

/**
 * The Mac window size (points) for "Fit window to phone": the shape of the picture area on the
 * phone, one Mac point per phone point, so text shows at its normal size with no black bars.
 */
function phoneSize(c) {
  const fit = c.fit || { w: c.viewport.w, h: c.viewport.h - 120 };
  const w = Math.round(Math.max(400, Math.min(760, fit.w)));
  const h = Math.round(w * Math.max(1.2, fit.h / Math.max(1, fit.w)));
  return { w, h };
}

/** A drag that was cut off (network switch, phone closed) must not leave the Mac's button held. */
function releaseDrag(c) {
  if (!c.dragAt) return;
  core.send({ cmd: 'input', kind: 'up', ...c.dragAt });
  c.dragAt = null;
}

function streamParams(c) {
  const vw = Math.round(c.viewport.w * c.viewport.dpr), vh = Math.round(c.viewport.h * c.viewport.dpr);
  // Basic video sends still pictures, so keep them about half size to stay quick on cellular.
  const scale = c.basic ? 0.55 : c.rate.scale;
  return { maxW: Math.round(vw * scale), maxH: Math.round(vh * scale), fps: c.rate.fps, bitrate: c.rate.bitrate };
}

// A full picture is big; on a lossy link, asking for one after every loss makes things worse.
// So at most one every 800 ms (a request in between is answered when the wait is over).
function requestKeyframe(c) {
  const now = Date.now(), gap = 800;
  if (now - (c.lastKey || 0) >= gap) { c.lastKey = now; core.send({ cmd: 'keyframe' }); return; }
  if (!c.keyTimer) c.keyTimer = setTimeout(() => { c.keyTimer = null; c.lastKey = Date.now(); core.send({ cmd: 'keyframe' }); }, gap - (now - c.lastKey));
}

async function startRtc(c) {
  c.rtc?.close();
  const bindIp = c.local ? (tsIp || '127.0.0.1') : tsIp;
  if (!bindIp) throw new Error('Tailscale is not connected on the Mac.');
  const rtc = new RtcSession({
    remoteIp: c.ip, bindIp,
    onMessage: (m) => onClient(c, m).catch(() => {}),
    onState: (s) => { rtc.state = s; wsSend(c.ws, { t: 'rtcState', state: s }); if (s === 'connected') log(`video connected to ${c.device} in ${Date.now() - (c.rtc?.t0 || 0)} ms`); },
    onKeyframeNeeded: () => requestKeyframe(c),
    lossPct: c.local ? c.testLoss || 0 : 0,
  });
  c.rtc = rtc;
  const t0 = Date.now();
  rtc.t0 = t0;
  rtc.oid = (c.oid = (c.oid || 0) + 1);
  const sdp = await rtc.offer();
  if (c.rtc !== rtc) return; // a newer connection replaced this one meanwhile
  log(`video offer ready in ${Date.now() - t0} ms`);
  wsSend(c.ws, { t: 'offer', sdp, oid: rtc.oid });
}

async function onClient(c, m) {
  switch (m.t) {
    case 'hello':
      if (m.viewport) c.viewport = { w: Math.max(200, Math.min(2000, m.viewport.w | 0)), h: Math.max(200, Math.min(3000, m.viewport.h | 0)), dpr: Math.max(1, Math.min(4, Number(m.viewport.dpr) || 2)) };
      wsSend(c.ws, macStatus());
      return;
    case 'list': {
      const r = await core.request({ cmd: 'list', icons: true });
      for (const w of r.windows) {
        if (w.icon && w.bundleId) icons.set(w.bundleId, Buffer.from(w.icon, 'base64'));
        delete w.icon;
        w.hasIcon = icons.has(w.bundleId);
      }
      wsSend(c.ws, { t: 'windows', windows: r.windows, displays: r.displays });
      return;
    }
    case 'thumbs':
      core.send({ cmd: 'thumbs', ids: (m.ids || []).slice(0, 40), displays: (m.displays || []).slice(0, 4), maxW: Math.min(720, m.maxW || 480), owner: true });
      return;
    case 'needs': {
      const extra = Array.isArray(m.extra) ? m.extra.filter((x) => typeof x === 'string').slice(0, 3) : [];
      const r = await core.request({ cmd: 'needs', extra }, 20_000).catch(() => null);
      if (r) wsSend(c.ws, { t: 'needs', hits: r.hits || [] });
      return;
    }
    case 'view': {
      if (viewer && viewer !== c) { releaseDrag(viewer); wsSend(viewer.ws, { t: 'taken', by: c.device }); viewer.rtc?.close(); viewer.rtc = null; }
      releaseDrag(c);
      viewer = c;
      if (c.layoutId && c.layoutId !== m.id) { core.send({ cmd: 'restore', id: c.layoutId }); c.layoutId = null; }
      c.view = { kind: m.kind === 'display' ? 'display' : 'window', id: Number(m.id), label: String(m.label || '').slice(0, 80) };
      if (m.fit) c.fit = { w: Number(m.fit.w) || c.viewport.w, h: Number(m.fit.h) || c.viewport.h };
      if (c.view.kind === 'window' && m.phoneLayout) {
        const r = await core.request({ cmd: 'phoneLayout', id: c.view.id, ...phoneSize(c) }).catch(() => null);
        if (r?.ok) c.layoutId = c.view.id;
      }
      c.basic = !!m.basic;
      core.send({ cmd: 'stream', kind: c.view.kind, id: c.view.id, crop: m.crop || { x: 0, y: 0, w: 1, h: 1 }, jpeg: c.basic, focus: true, ...streamParams(c) });
      // Keep a connection that is up or still coming up; start one only if there is none or it failed.
      const live = c.rtc && !['failed', 'closed', 'disconnected'].includes(c.rtc.state);
      if (!c.basic && !live) await startRtc(c);
      else core.send({ cmd: 'keyframe' });
      updateMacMenu();
      return;
    }
    case 'rtcAnswer': {
      // A late answer to an older offer (after a reconnect) is simply ignored.
      const rtc = c.rtc;
      if (!rtc || (m.oid !== undefined && m.oid !== rtc.oid)) return;
      try {
        const profile = await rtc.answer(m.sdp);
        core.send({ cmd: 'profile', value: profile });
        log(`answer applied at ${Date.now() - rtc.t0} ms (${profile})`);
      } catch (e) { log(`video answer not used: ${e.message}`); }
      return;
    }
    case 'restartVideo': if (viewer === c && !c.basic) await startRtc(c); return;
    case 'testNetwork':
      // Automated tests on this Mac only: imitate a lossy link on the next video connection.
      if (!c.local) return;
      c.testLoss = Math.max(0, Math.min(40, Number(m.loss) || 0));
      c.rate = new RateController();
      if (c.picture) c.rate.setPicture(c.picture.w, c.picture.h, 60);
      if (viewer === c && !c.basic) await startRtc(c);
      return;
    case 'basic':
      c.basic = !!m.on;
      if (viewer === c) { core.send({ cmd: 'jpeg', on: c.basic }); core.send({ cmd: 'update', ...streamParams(c) }); }
      if (c.basic) { c.rtc?.close(); c.rtc = null; }
      return;
    case 'crop':
      if (viewer !== c) return;
      core.send({ cmd: 'update', crop: m.crop, ...streamParams(c) });
      return;
    case 'viewport':
      c.viewport = { ...c.viewport, w: m.w | 0 || c.viewport.w, h: m.h | 0 || c.viewport.h };
      if (viewer === c) core.send({ cmd: 'update', ...streamParams(c) });
      return;
    case 'layout': {
      if (viewer !== c || c.view?.kind !== 'window') return;
      if (m.fit) c.fit = { w: Number(m.fit.w) || c.viewport.w, h: Number(m.fit.h) || c.viewport.h };
      if (m.on) {
        const r = await core.request({ cmd: 'phoneLayout', id: c.view.id, ...phoneSize(c) }).catch(() => null);
        if (r?.ok) c.layoutId = c.view.id;
        wsSend(c.ws, { t: 'layout', on: !!r?.ok });
      } else {
        core.send({ cmd: 'restore', id: c.view.id }); c.layoutId = null;
        wsSend(c.ws, { t: 'layout', on: false });
      }
      return;
    }
    case 'stop':
      releaseDrag(c);
      c.rtc?.close(); c.rtc = null;
      if (viewer === c) {
        viewer = null;
        core.send({ cmd: 'stopStream' });
        if (c.layoutId) { core.send({ cmd: 'restore', id: c.layoutId }); c.layoutId = null; }
        c.view = null;
        updateMacMenu();
      }
      return;
    case 'input':
      if (viewer !== c) return;
      core.send({ cmd: 'input', ...m.e });
      if (m.e?.kind === 'down') c.dragAt = { x: m.e.x, y: m.e.y };
      else if (m.e?.kind === 'move' && c.dragAt) c.dragAt = { x: m.e.x, y: m.e.y };
      else if (m.e?.kind === 'up') c.dragAt = null;
      // Remember a Copy from the phone (Command-C), so the copied text may be offered back to it.
      if (m.e?.kind === 'key' && String(m.e.key).toLowerCase() === 'c' && (m.e.mods || []).includes('cmd')) c.lastCopyAt = Date.now();
      return;
    case 'stats': {
      if (viewer !== c) return;
      const r = c.rtc?.stats() || {};
      c.lastStats = m;
      if (c.rate.update({ loss: m.loss, nackRate: m.nackRate, rtt: m.rtt, jitterBuffer: m.jitterBuffer, freezes: m.freezes, remb: r.remb })) {
        core.send({ cmd: 'update', ...streamParams(c) });
      }
      const serverDelay = c.lastFrameDelay != null ? Math.round(c.lastFrameDelay) : null;
      const reply = { t: 'quality', bitrate: c.rate.bitrate, fps: c.rate.fps, macDelayMs: serverDelay };
      if (!c.rtc?.send(reply)) wsSend(c.ws, reply);
      return;
    }
    case 'answer': {
      const r = await core.request({ cmd: 'answer', id: Number(m.id), action: m.action }, 15_000).catch((e) => ({ ok: false, message: e.message }));
      wsSend(c.ws, { t: 'answered', ok: r.ok, message: r.message, id: m.id });
      // Look again shortly, so the phone shows the window's next state.
      setTimeout(() => core.request({ cmd: 'needs' }, 20_000).then((n) => wsSend(c.ws, { t: 'needs', hits: n.hits || [] })).catch(() => {}), 1200);
      return;
    }
    case 'clipboard': {
      // Only right after a Copy made from this phone: a Mac clipboard can hold a just-copied password.
      if (!c.lastCopyAt || Date.now() - c.lastCopyAt > 5000) return;
      c.lastCopyAt = 0;
      const r = await core.request({ cmd: 'clipboard' }).catch(() => null);
      wsSend(c.ws, { t: 'clipboard', text: r?.text || '' });
      return;
    }
    case 'focus':
      // Long-press menu on the phone: bring a window to the front on the Mac.
      if (Number.isInteger(m.id)) core.send({ cmd: 'focus', id: m.id });
      return;
    case 'wake': {
      const r = await core.request({ cmd: 'wake' }).catch(() => null);
      wsSend(c.ws, macStatus());
      return r;
    }
    case 'ping':
      if (!c.rtc?.send({ t: 'pong', id: m.id })) wsSend(c.ws, { t: 'pong', id: m.id });
      return;
    case 'permissions':
      await core.request({ cmd: 'requestPermissions' }).catch(() => null);
      wsSend(c.ws, macStatus());
      return;
  }
}

// ---------- helper events ----------

core.on('video', (f) => {
  const c = viewer;
  if (!c || c.basic || !c.rtc) return;
  // The first frame of a new zoom region: tell the phone, so it applies the new region in step.
  if (f.gen !== c.lastGen) { c.lastGen = f.gen; const msg = { t: 'frameGen', gen: f.gen }; if (!c.rtc.send(msg)) wsSend(c.ws, msg); }
  c.lastFrameDelay = (Date.now() * 1000 - f.captureUs) / 1000;
  c.rtc.sendFrame(f, c.rate.bitrate);
});

core.on('image', (meta, jpeg) => {
  if (meta.kind === 'thumb') {
    const id = String(meta.id);
    // A window that has not changed gives the same picture: do not make phones download it again.
    const prev = thumbs.get(id);
    if (prev && prev.jpeg.equals(jpeg)) { broadcast({ t: 'thumb', id, v: prev.v }); return; }
    const v = Date.now();
    thumbs.set(id, { jpeg: Buffer.from(jpeg), v });
    broadcast({ t: 'thumb', id, v });
  } else if (meta.kind === 'frame') {
    const c = viewer;
    if (!c || !c.basic || c.ws.readyState !== 1 || c.ws.bufferedAmount > 600_000) return;
    const mj = Buffer.from(JSON.stringify(meta));
    const head = Buffer.alloc(4); head.writeUInt32BE(mj.length, 0);
    c.ws.send(Buffer.concat([head, mj, jpeg]), { binary: true });
  }
});

core.on('message', (m) => {
  if (m.type === 'status') {
    broadcast(macStatus());
    // A small status file for troubleshooting (no secrets).
    const st = { at: new Date().toISOString(), ...macStatus(), clients: clients.size, viewing: viewer?.view?.label || null, tailscale: tsIp };
    fs.writeFile(path.join(DATA, 'state.json'), JSON.stringify(st, null, 2), () => {});
  }
  else if (m.type === 'streamInfo') {
    if (!viewer) return;
    wsSend(viewer.ws, { t: 'streamInfo', ...m });
    viewer.picture = { w: m.width, h: m.height };
    if (viewer.rate.setPicture(m.width, m.height, 60)) core.send({ cmd: 'update', bitrate: viewer.rate.bitrate });
  }
  else if (m.type === 'clicked' || m.type === 'textFocus') { if (viewer) { const msg = { t: m.type, ...m }; delete msg.type; if (!viewer.rtc?.send(msg)) wsSend(viewer.ws, msg); } }
  else if (m.type === 'targetGone') { if (viewer) wsSend(viewer.ws, { t: 'targetGone' }); }
  else if (m.type === 'streamError') { if (viewer) wsSend(viewer.ws, { t: 'streamError', message: m.message, permission: m.permission }); }
  else if (m.type === 'pairRequestFromMac') {
    const { code, seconds } = auth.startPairingFromMac();
    core.send({ cmd: 'showCode', code, seconds, device: '' });
  } else if (m.type === 'forgetAllFromMac') {
    auth.forgetAll();
    for (const c of clients) { releaseDrag(c); c.rtc?.close(); c.ws.close(); }
    core.send({ cmd: 'stopStream' });
    log('all paired devices forgotten from the Mac menu');
  } else if (m.type === 'disconnectFromMac') {
    pausedUntil = Date.now() + 10 * 60_000;
    for (const c of clients) { wsSend(c.ws, { t: 'paused', minutes: 10 }); c.rtc?.close(); c.ws.close(); }
    core.send({ cmd: 'stopStream' });
    log('paused for 10 minutes from the Mac menu');
  }
});
core.on('connected', () => {
  log('helper connected');
  updateMacMenu();
  broadcast(macStatus());
  // A phone that reconnected before the helper did is still waiting for its picture: ask again.
  const c = viewer;
  if (c?.view) {
    core.send({ cmd: 'stream', kind: c.view.kind, id: c.view.id, crop: { x: 0, y: 0, w: 1, h: 1 }, jpeg: c.basic, focus: false, ...streamParams(c) });
    if (c.layoutId) core.request({ cmd: 'phoneLayout', id: c.layoutId, ...phoneSize(c) }).catch(() => {});
    setTimeout(() => requestKeyframe(c), 300);
  }
});
core.on('disconnected', () => { log('helper disconnected'); broadcast(macStatus()); });

// ---------- start ----------

core.listen();
listenOn('127.0.0.1');
await refreshAddresses();
// Check often, so a listener that could not start (Tailscale still connecting) comes up within seconds.
setInterval(() => refreshAddresses().catch(() => {}), 4_000).unref();
log(`Window Remote server ready (data: ${DATA}${TEST ? ', TEST MODE' : ''})`);
process.on('SIGTERM', () => { core.send({ cmd: 'stopStream' }); core.send({ cmd: 'restore' }); setTimeout(() => process.exit(0), 200); });
