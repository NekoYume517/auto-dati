/** Package and verify a signed CRX3. The same payload is also published as ZIP. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { zipDirectory, packCrx, verifyCrx } from './crx3.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argument(name) { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1] || ''; }
const keyPath = path.resolve(argument('--key') || path.join(os.homedir(), '.config', 'auto-dati', 'release-signing.pem'));
if (args.includes('--init-key') && !fs.existsSync(keyPath) && !process.env.CRX_PRIVATE_KEY) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  fs.writeFileSync(keyPath, key.privateKey, { mode: 0o600, flag: 'wx' });
}
const privateKey = process.env.CRX_PRIVATE_KEY || (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, 'utf8') : '');
if (!privateKey) throw new Error('缺少签名私钥。首次本地打包用 --init-key，Actions 请配置 CRX_PRIVATE_KEY Secret。');
const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const extensionId = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, character => String.fromCharCode(97 + parseInt(character, 16)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
const tag = argument('--tag');
if (tag && tag !== 'v' + manifest.version) throw new Error('Tag 必须与 manifest.version 一致：v' + manifest.version);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-dati-release-'));
try {
  const staged = path.join(temp, 'extension');
  fs.cpSync(path.join(root, 'extension'), staged, { recursive: true });
  // Source development ID is preserved. Release ZIP and CRX share the signing-key ID.
  manifest.key = publicKey.toString('base64');
  fs.writeFileSync(path.join(staged, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const zip = zipDirectory(staged), crx = packCrx(zip, privateKey), verified = verifyCrx(crx);
  if (verified.extensionId !== extensionId || !verified.zip.equals(zip)) throw new Error('CRX3 验签失败');
  const out = path.resolve(argument('--out') || path.join(root, 'dist'));
  fs.mkdirSync(out, { recursive: true });
  const prefix = 'auto-dati-v' + manifest.version;
  const names = [prefix + '.crx', prefix + '.zip'];
  fs.writeFileSync(path.join(out, names[0]), crx);
  fs.writeFileSync(path.join(out, names[1]), zip);
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), names.map(name => crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(out, name))).digest('hex') + '  ' + name).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'release-info.json'), JSON.stringify({ version: manifest.version, extensionId: extensionId, files: names }, null, 2) + '\n');
  console.log(JSON.stringify({ version: manifest.version, extensionId: extensionId, output: out, files: names }));
} finally {
  if (path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('auto-dati-release-')) throw new Error('拒绝清理非打包临时目录');
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
