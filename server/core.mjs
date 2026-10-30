// Bridge to the Swift helper (wr-core). The server listens on a private Unix socket; the helper
// connects to it. Frames: 4-byte big-endian length, 1-byte type, payload.
//   1 JSON (both ways), 2 H.264 video (helper -> server), 3 image (helper -> server)

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export class CoreBridge extends EventEmitter {
  constructor(socketPath) {
    super();
    this.socketPath = socketPath;
    this.sock = null;
    this.rid = 0;
    this.waiting = new Map();
    this.status = null;
  }

  get connected() { return !!this.sock; }

  listen() {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    // A socket file left from an earlier run is not data; it has to go before listening again.
    try { if (fs.lstatSync(this.socketPath).isSocket()) fs.unlinkSync(this.socketPath); } catch { /* none */ }
    const server = net.createServer((s) => this.attach(s));
    server.listen(this.socketPath, () => { try { fs.chmodSync(this.socketPath, 0o600); } catch (e) { console.error('core socket chmod failed', e.message); } });
    server.on('error', (e) => console.error('core socket error', e.message));
    this.server = server;
  }

  attach(s) {
    if (this.sock) this.sock.destroy();
    this.sock = s;
    s.setNoDelay(true);
    let buf = Buffer.alloc(0);
    s.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 5) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const type = buf[4];
        const payload = buf.subarray(5, 4 + len);
        buf = buf.subarray(4 + len);
        try { this.dispatch(type, payload); } catch (e) { console.error('core message error', e); }
      }
    });
    const gone = () => {
      if (this.sock !== s) return;
      this.sock = null;
      for (const [, w] of this.waiting) w.reject(new Error('The Mac helper restarted.'));
      this.waiting.clear();
      this.emit('disconnected');
    };
    s.on('close', gone);
    s.on('error', gone);
    this.emit('connected');
  }

  dispatch(type, payload) {
    if (type === 1) {
      const msg = JSON.parse(payload.toString('utf8'));
      if (msg.type === 'status') this.status = { ...msg, at: Date.now() };
      if (msg.re !== undefined && this.waiting.has(msg.re)) {
        const w = this.waiting.get(msg.re);
        this.waiting.delete(msg.re);
        w.resolve(msg);
      }
      this.emit('message', msg);
    } else if (type === 2) {
      const key = (payload[0] & 1) === 1;
      const gen = payload.readUInt32BE(1);
      const captureUs = Number(payload.readBigUInt64BE(5));
      const encodedUs = Number(payload.readBigUInt64BE(13));
      this.emit('video', { key, gen, captureUs, encodedUs, data: payload.subarray(21) });
    } else if (type === 3) {
      const jl = payload.readUInt32BE(0);
      const meta = JSON.parse(payload.subarray(4, 4 + jl).toString('utf8'));
      this.emit('image', meta, payload.subarray(4 + jl));
    }
  }

  send(obj) {
    if (!this.sock) return false;
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(5);
    head.writeUInt32BE(body.length + 1, 0);
    head[4] = 1;
    this.sock.write(Buffer.concat([head, body]));
    return true;
  }

  request(obj, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new Error('The Mac helper is not running.'));
      const rid = ++this.rid;
      const t = setTimeout(() => { this.waiting.delete(rid); reject(new Error('The Mac helper did not answer.')); }, timeoutMs);
      this.waiting.set(rid, { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.send({ ...obj, rid });
    });
  }
}
