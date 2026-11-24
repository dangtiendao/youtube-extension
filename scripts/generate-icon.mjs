import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function createPngIcon(size) {
  const width = size;
  const height = size;
  const raw = Buffer.alloc((width * 4 + 1) * height);

  const cx = width / 2;
  const cy = height / 2;
  const radius = width * 0.22;

  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      const dx = Math.max(Math.abs(x + 0.5 - cx) - (width / 2 - radius), 0);
      const dy = Math.max(Math.abs(y + 0.5 - cy) - (height / 2 - radius), 0);
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > radius + 0.5) {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
        continue;
      }

      // Soft edge anti-aliasing
      const alpha = dist <= radius - 0.5 ? 255 : Math.max(0, Math.min(255, Math.round((radius + 0.5 - dist) * 255)));

      const nx = (x + 0.5) / width;
      const ny = (y + 0.5) / height;

      // Crisp white download arrow + tray bar
      const inStem = Math.abs(nx - 0.5) <= 0.105 && ny >= 0.21 && ny <= 0.56;
      const inHead = ny >= 0.46 && ny <= 0.72 && Math.abs(nx - 0.5) <= (0.72 - ny) * 1.12;
      const inTray = ny >= 0.75 && ny <= 0.83 && Math.abs(nx - 0.5) <= 0.28;

      if (inStem || inHead || inTray) {
        raw[px] = 255;
        raw[px + 1] = 255;
        raw[px + 2] = 255;
        raw[px + 3] = alpha;
      } else {
        // Rich crimson gradient (#f43f5e -> #be123c)
        const t = (x * 0.35 + y * 0.65) / width;
        raw[px] = Math.round(244 - t * 54);
        raw[px + 1] = Math.round(63 - t * 45);
        raw[px + 2] = Math.round(94 - t * 34);
        raw[px + 3] = alpha;
      }
    }
  }

  return encodePng(width, height, raw);
}

function encodePng(width, height, rawData) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(rawData, { level: 9 });
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Packages multiple PNG frames (16, 32, 48, 256) into a valid Windows .ICO container.
 */
function createIco(sizes) {
  const images = sizes.map((size) => ({ size, png: createPngIcon(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = ICO
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(images.length * 16);
  let offset = header.length + entries.length;

  images.forEach((img, idx) => {
    const base = idx * 16;
    entries[base] = img.size >= 256 ? 0 : img.size;
    entries[base + 1] = img.size >= 256 ? 0 : img.size;
    entries[base + 2] = 0;
    entries[base + 3] = 0;
    entries.writeUInt16LE(1, base + 4); // planes
    entries.writeUInt16LE(32, base + 6); // bpp
    entries.writeUInt32LE(img.png.length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += img.png.length;
  });

  return Buffer.concat([header, entries, ...images.map((i) => i.png)]);
}

const outPath = path.join(rootDir, 'installer', 'assets', 'tubevault.ico');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const icoBuf = createIco([16, 32, 48, 256]);
fs.writeFileSync(outPath, icoBuf);
console.log(`[TubeVault] Generated multi-resolution icon -> ${outPath} (${Math.round(icoBuf.length / 1024)} KB)`);
