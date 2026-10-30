// Quick check of the web server's rules, with no Mac helper and no Tailscale needed.
// Starts a test copy of the server on a free port (127.0.0.1 only, temporary data folder) and checks
// pairing, the host and origin checks, and that unpaired devices get nothing.
// Usage: node test/smoke.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'server/package.json'));
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-smoke-'));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(ROOT, 'server/server.mjs')], {
  env: { ...process.env, WR_TEST: '1', WR_PORT: String(port), WR_HTTPS_PORT: String(port + 1), WR_SUPPORT_DIR: data, WR_BIND_IP: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
server.stdout.on('data', (d) => { out += d; });
server.stderr.on('data', (d) => { out += d; });

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${extra}`}`); if (!ok) failed++; };
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WR': '1', ...headers }, body: JSON.stringify(body) });

try {
  for (let i = 0; i < 50 && !/ready/.test(out); i++) await sleep(100);
  check('server starts', /ready/.test(out), out);

  let r = await fetch(base + '/');
  check('phone page loads', r.status === 200 && (await r.text()).includes('<title>Window Remote</title>'));
  check('page is locked down (CSP, no framing)', /default-src 'self'/.test(r.headers.get('content-security-policy') || '') && r.headers.get('x-frame-options') === 'DENY');

  const status = await new Promise((res) => http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: 'evil.example' } }, (x) => { x.resume(); res(x.statusCode); }).on('error', () => res(0)));
  check('wrong host name refused (blocks DNS tricks)', status === 421, String(status));

  r = await fetch(base + '/api/me');
  check('a new device starts unpaired', (await r.json()).paired === false);

  r = await fetch(base + '/api/thumb/1');
  check('unpaired device gets no window pictures', r.status === 401);

  r = await fetch(base + '/api/pair/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('a change without the app header is refused', r.status === 403);

  r = await post('/api/pair/start', {}, { Origin: 'https://evil.example' });
  check('a change from another website is refused', r.status === 403);

  r = await fetch(base + '/api/admin/state');
  check('Mac app controls need the admin key', r.status === 403);

  const ws0 = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: base } });
  const refused = await new Promise((res) => { ws0.on('open', () => res(false)); ws0.on('error', () => res(true)); ws0.on('unexpected-response', () => res(true)); });
  check('unpaired device cannot open the live connection', refused);

  r = await post('/api/pair/start', {});
  check('pairing code is made', (await r.json()).ok === true);
  const code = fs.readFileSync(path.join(data, 'test-pair-code.txt'), 'utf8').trim();

  r = await post('/api/pair/finish', { code: code === '000000' ? '111111' : '000000', name: 'Test' });
  check('a wrong code is refused', (await r.json()).ok === false);

  r = await post('/api/pair/finish', { code, name: 'Test' });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  check('the right code pairs the device', (await r.json()).ok === true && cookie.startsWith('wr_key='), cookie);

  r = await post('/api/pair/finish', { code, name: 'Again' });
  check('a code works only once', (await r.json()).ok === false);

  r = await fetch(base + '/api/me', { headers: { Cookie: cookie } });
  check('the paired device is recognized', (await r.json()).paired === true);

  const stored = JSON.parse(fs.readFileSync(path.join(data, 'devices.json'), 'utf8'));
  check('only a fingerprint of the key is stored', !JSON.stringify(stored).includes(cookie.slice('wr_key='.length)));

  r = await fetch(base + '/api/next', { headers: { Cookie: cookie } });
  check('nothing but the remote is served', r.status === 404);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: base, Cookie: cookie } });
  const first = await new Promise((res) => { ws.on('message', (d) => res(JSON.parse(d.toString()))); ws.on('error', (e) => res({ error: e.message })); setTimeout(() => res(null), 3000); });
  check('paired device gets the live connection', first?.t === 'status', JSON.stringify(first));
  ws.close();
} finally {
  server.kill();
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
