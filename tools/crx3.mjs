/** CRX3 developer signatures and ordinary ZIP archives, using only Node built-ins.
 * Format: https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx3.proto
 * RSA_PKCS1_SHA256 matches Chromium's components/crx_file/crx_creator.cc.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255]; return (value ^ 0xffffffff) >>> 0; }
function u32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; }
function varint(value) { const bytes = []; do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value); return Buffer.from(bytes); }
function field(number, bytes) { return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]); }
function fields(bytes) {
  let offset = 0;
  function read() { let value = 0, shift = 0, next; do { if (offset >= bytes.length || shift > 28) throw new Error('Invalid protobuf'); next = bytes[offset++]; value += (next & 127) * 2 ** shift; shift += 7; } while (next & 128); return value; }
  const out = new Map();
  while (offset < bytes.length) {
    const tag = read(); if ((tag & 7) !== 2) throw new Error('Unexpected protobuf wire type');
    const size = read(); if (offset + size > bytes.length) throw new Error('Truncated protobuf');
    out.set(Math.floor(tag / 8), bytes.subarray(offset, offset + size)); offset += size;
  }
  return out;
}
export function zipDirectory(directory) {
  const files = [];
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Release directory must not contain symlinks');
      if (entry.isDirectory()) walk(file); else if (entry.isFile()) files.push(file);
    }
  }
  walk(directory);
  const local = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(path.relative(directory, file).split(path.sep).join('/'));
    const data = fs.readFileSync(file), packed = deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); // Fixed 1980-01-01 for reproducible archives.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    local.push(header, name, packed); central.push(record, name); offset += header.length + name.length + packed.length;
  }
  const directoryBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}
export function packCrx(zip, privateKey) {
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const signed = field(1, crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16));
  const payload = Buffer.concat([Buffer.from('CRX3 SignedData\0'), u32(signed.length), signed, zip]);
  const signature = crypto.sign('RSA-SHA256', payload, privateKey);
  const header = Buffer.concat([field(2, Buffer.concat([field(1, publicKey), field(2, signature)])), field(10000, signed)]);
  return Buffer.concat([Buffer.from('Cr24'), u32(3), u32(header.length), header, zip]);
}
export function verifyCrx(crx) {
  if (crx.length < 12 || crx.toString('ascii', 0, 4) !== 'Cr24' || crx.readUInt32LE(4) !== 3) throw new Error('Invalid CRX3');
  const size = crx.readUInt32LE(8); if (size > crx.length - 12) throw new Error('Invalid CRX3 header length');
  const header = fields(crx.subarray(12, 12 + size)), signed = header.get(10000), proof = fields(header.get(2));
  const publicKey = proof.get(1), signature = proof.get(2), zip = crx.subarray(12 + size);
  const id = fields(signed).get(1), expectedId = crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16);
  if (!id.equals(expectedId) || !crypto.verify('RSA-SHA256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), u32(signed.length), signed, zip]),
    crypto.createPublicKey({ key: publicKey, type: 'spki', format: 'der' }), signature)) throw new Error('CRX3 signature verification failed');
  return { zip: zip, publicKey: publicKey, extensionId: id.toString('hex').replace(/[0-9a-f]/g, character => String.fromCharCode(97 + parseInt(character, 16))) };
}
