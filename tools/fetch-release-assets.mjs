/** Publish locally signed artifacts without transferring the private key to CI. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { verifyCrx } from './crx3.mjs';
const version = JSON.parse(fs.readFileSync('extension/manifest.json')).version;
const record = JSON.parse(fs.readFileSync('release-assets/v' + version + '.json'));
if (record.version !== version) throw new Error('Release version mismatch');
fs.mkdirSync('dist', { recursive: true });
for (const file of record.files) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/.test(file.name) || !/^[a-f0-9]{40}$/.test(file.blob)) throw new Error('Invalid artifact');
  const response = await fetch('https://api.github.com/repos/NekoYume517/auto-dati/git/blobs/' + file.blob, {
    headers: { Accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { Authorization: 'Bearer ' + process.env.GH_TOKEN } : {}) }
  });
  if (!response.ok) throw new Error('Artifact API HTTP ' + response.status);
  const blob = await response.json();
  const bytes = Buffer.from(blob.content, 'base64');
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Artifact checksum mismatch');
  fs.writeFileSync('dist/' + file.name, bytes);
}
const prefix = 'dist/auto-dati-v' + version;
const verified = verifyCrx(fs.readFileSync(prefix + '.crx'));
if (!verified.zip.equals(fs.readFileSync(prefix + '.zip'))) throw new Error('ZIP payload mismatch');
console.log('Verified signed release v' + version + ', extension ID ' + verified.extensionId);
