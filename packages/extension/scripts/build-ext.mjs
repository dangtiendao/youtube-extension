import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(__dirname, '..');
const distExt = path.join(extRoot, 'dist-ext');
const distWeb = path.join(extRoot, 'dist-web');

/**
 * Generates crisp solid PNG icons (crimson rounded square with white play/download emblem)
 * using zero external dependencies (pure PNG + zlib).
 */
function createPngIcon(size) {
  const width = size;
  const height = size;
  const raw = Buffer.alloc((width * 4 + 1) * height);

  const cx = width / 2;
  const cy = height / 2;
  const radius = width * 0.22;

  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;

      // Rounded rect distance check
      const dx = Math.max(Math.abs(x + 0.5 - cx) - (width / 2 - radius), 0);
      const dy = Math.max(Math.abs(y + 0.5 - cy) - (height / 2 - radius), 0);
      const inside = dx * dx + dy * dy <= radius * radius;

      if (!inside) {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
        continue;
      }

      // Draw white download arrow glyph inside
      const nx = (x + 0.5) / width;
      const ny = (y + 0.5) / height;
      const inStem = Math.abs(nx - 0.5) <= 0.11 && ny >= 0.22 && ny <= 0.56;
      const inHead = ny >= 0.48 && ny <= 0.72 && Math.abs(nx - 0.5) <= (0.72 - ny) * 1.15;
      const inTray = ny >= 0.75 && ny <= 0.83 && Math.abs(nx - 0.5) <= 0.28;

      if (inStem || inHead || inTray) {
        raw[px] = 255;
        raw[px + 1] = 255;
        raw[px + 2] = 255;
        raw[px + 3] = 255;
      } else {
        // Gradient crimson (#e11d48 -> #be123c)
        const t = y / height;
        raw[px] = Math.round(225 - t * 35);
        raw[px + 1] = Math.round(29 - t * 11);
        raw[px + 2] = Math.round(72 - t * 12);
        raw[px + 3] = 255;
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(rawData, { level: 9 });

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function run() {
  console.log('[TubeVault] Building Chrome Extension UI (dist-ext)...');
  execSync('npx vite build', {
    cwd: extRoot,
    stdio: 'inherit',
    env: { ...process.env, BUILD_TARGET: 'ext' },
  });

  console.log('[TubeVault] Building Engine Web UI fallback (dist-web)...');
  execSync('npx vite build', {
    cwd: extRoot,
    stdio: 'inherit',
    env: { ...process.env, BUILD_TARGET: 'web' },
  });

  console.log('[TubeVault] Bundling background.js & content.js...');
  await esbuild.build({
    entryPoints: [path.join(extRoot, 'src', 'background', 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    outfile: path.join(distExt, 'background.js'),
    sourcemap: false,
  });

  await esbuild.build({
    entryPoints: [path.join(extRoot, 'src', 'content', 'index.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    outfile: path.join(distExt, 'content.js'),
    sourcemap: false,
  });

  // Write icons to both dist-ext and dist-web
  const extIconsDir = path.join(distExt, 'icons');
  const webIconsDir = path.join(distWeb, 'icons');
  fs.mkdirSync(extIconsDir, { recursive: true });
  fs.mkdirSync(webIconsDir, { recursive: true });

  for (const size of [16, 48, 128]) {
    const png = createPngIcon(size);
    fs.writeFileSync(path.join(extIconsDir, `icon${size}.png`), png);
    fs.writeFileSync(path.join(webIconsDir, `icon${size}.png`), png);
  }

  // Assemble manifest.json with fixed RSA public key
  const manifest = JSON.parse(fs.readFileSync(path.join(extRoot, 'manifest.template.json'), 'utf8'));
  const pubKeyFile = path.join(extRoot, 'extension-key.public.json');
  if (fs.existsSync(pubKeyFile)) {
    const keyMeta = JSON.parse(fs.readFileSync(pubKeyFile, 'utf8'));
    if (keyMeta.publicKeyBase64) {
      manifest.key = keyMeta.publicKeyBase64;
    }
  }
  fs.writeFileSync(path.join(distExt, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log('[TubeVault] Extension & Web UI build complete!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
