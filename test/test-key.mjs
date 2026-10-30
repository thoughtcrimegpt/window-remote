// Creates (or reuses) a paired key for automated tests on this Mac (127.0.0.1 only; the key is
// tied to the "local" device, so it does not work from any other device). Prints the key.
// Remove it afterwards with:  node test/test-key.mjs --remove
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const DATA = process.env.WR_SUPPORT_DIR || path.join(os.homedir(), 'Library/Application Support/Window Remote');
const file = path.join(DATA, 'devices.json');
const keyFile = path.join(DATA, 'test-key.txt');
let devices = {};
try { devices = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const write = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(devices, null, 2), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
if (process.argv[2] === '--remove') {
  for (const [h, d] of Object.entries(devices)) if (d.test) delete devices[h];
  write();
  if (fs.existsSync(keyFile)) fs.renameSync(keyFile, keyFile + '.revoked');
  console.log('Test key revoked.');
} else {
  let key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '';
  if (!key || !devices[hash(key)]) {
    key = crypto.randomBytes(32).toString('base64url');
    devices[hash(key)] = { nodeId: 'local', name: 'Automated test (this Mac)', test: true, paired: new Date().toISOString() };
    write();
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
  }
  console.log(key);
}
