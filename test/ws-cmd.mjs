// Sends one message to the running server as the local test device and prints replies for a few seconds.
// Usage: node test/ws-cmd.mjs '{"t":"list"}' [seconds]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const WebSocket = require('ws');
const key = execFileSync(process.execPath, [fileURLToPath(new URL('./test-key.mjs', import.meta.url))]).toString().trim();
const port = process.env.WR_PORT || 8765;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: `wr_key=${key}`, Origin: `http://127.0.0.1:${port}` } });
ws.on('open', () => { for (const m of process.argv.slice(2, 3)) ws.send(m); });
ws.on('message', (d, bin) => { if (!bin) console.log(d.toString().slice(0, 20000)); else console.log('[binary', d.length, 'bytes]'); });
ws.on('error', (e) => console.log('error', e.message));
setTimeout(() => process.exit(0), Number(process.argv[3] || 3) * 1000);
