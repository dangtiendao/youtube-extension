import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { FIXED_EXTENSION_ID, FIXED_EXTENSION_ORIGIN, parseYouTubeUrl, sanitizeSegment } from '../packages/shared/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const engineCjs = path.join(rootDir, 'packages', 'engine', 'dist', 'engine.cjs');
const hostExe = path.join(rootDir, 'installer', 'bin', 'ytdl-host.exe');
const trayExe = path.join(rootDir, 'installer', 'bin', 'TubeVault.exe');
const icoFile = path.join(rootDir, 'installer', 'assets', 'tubevault.ico');
const extManifestPath = path.join(rootDir, 'packages', 'extension', 'dist-ext', 'manifest.json');

function testUrlParserAndSanitizer() {
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'single', false],
    ['https://youtu.be/dQw4w9WgXcQ?list=PL1234567890', 'single', true],
    ['https://www.youtube.com/shorts/abcDEF12345', 'single', false],
    ['https://www.youtube.com/playlist?list=PL1234567890', 'playlist', false],
    ['https://music.youtube.com/playlist?list=OLAK5uy_k123456', 'album', false],
    ['https://www.youtube.com/@GoogleDevelopers/videos', 'channel', false],
    ['https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw/shorts', 'channel', false],
  ];

  for (const [url, expectedType, expectedHasList] of cases) {
    const res = parseYouTubeUrl(url);
    assert.equal(res.valid, true, `Expected valid URL: ${url}`);
    assert.equal(res.sourceType, expectedType, `Expected ${expectedType} for ${url}, got ${res.sourceType}`);
    assert.equal(Boolean(res.hasEmbeddedPlaylist), expectedHasList, `Embedded playlist check failed for ${url}`);
  }

  assert.equal(parseYouTubeUrl('https://example.com/watch?v=123').valid, false);
  assert.equal(sanitizeSegment('CON'), '_CON');
  assert.equal(sanitizeSegment('Bad:Name/With*?Chars.. '), 'Bad Name With Chars');
  console.log('✓ URL parser & Windows filename sanitizer passed');
}

function testExtensionManifest() {
  const manifest = JSON.parse(fs.readFileSync(extManifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.key && manifest.key.length > 100, 'Expected fixed RSA public key in manifest.json');
  assert.equal(manifest.side_panel?.default_path, 'sidepanel.html');
  for (const rel of ['background.js', 'content.js', 'sidepanel.html', 'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png']) {
    assert.ok(fs.existsSync(path.join(path.dirname(extManifestPath), rel)), `Missing built extension file: ${rel}`);
  }
  console.log(`✓ Extension manifest & artifacts verified (Fixed ID: ${FIXED_EXTENSION_ID})`);
}

function testIconAndWindowsExecutables() {
  assert.ok(fs.existsSync(icoFile), 'Missing installer/assets/tubevault.ico');
  const ico = fs.readFileSync(icoFile);
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved header must be 0');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO type header must be 1');
  assert.equal(ico.readUInt16LE(4), 4, 'Expected 4 multi-size frames (16, 32, 48, 256) in ICO');
  assert.ok(fs.existsSync(hostExe) && fs.statSync(hostExe).size > 5000, 'Missing or empty ytdl-host.exe');
  assert.ok(fs.existsSync(trayExe) && fs.statSync(trayExe).size > 5000, 'Missing or empty TubeVault.exe');
  console.log('✓ Multi-resolution .ico & Windows executables (ytdl-host.exe, TubeVault.exe) verified');
}

async function sendNativeHostMessage(dataDir, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(hostExe, [], {
      windowsHide: true,
      env: { ...process.env, TUBEVAULT_DATA_DIR: dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    child.on('error', reject);

    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(json.length, 0);
    child.stdin.write(Buffer.concat([hdr, json]));
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Native host timeout'));
    }, 8000);

    child.on('close', () => {
      clearTimeout(timer);
      const buf = Buffer.concat(outChunks);
      if (buf.length < 4) {
        reject(new Error(`Invalid native response (stderr: ${Buffer.concat(errChunks).toString('utf8')})`));
        return;
      }
      const len = buf.readUInt32LE(0);
      const body = buf.subarray(4, 4 + len).toString('utf8');
      resolve(JSON.parse(body));
    });
  });
}

async function testEngineAndNativeHost() {
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tubevault-e2e-'));
  const port = 17912;

  const engine = spawn(process.execPath, [engineCjs, '--server', '--port', String(port)], {
    windowsHide: true,
    env: { ...process.env, TUBEVAULT_DATA_DIR: tempDataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let lock = null;

  try {
    // Wait for engine healthy
    const lockPath = path.join(tempDataDir, 'data', 'runtime.json');
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(lockPath)) {
        try {
          const r = await fetch(`${baseUrl}/api/v1/health`);
          if (r.ok) {
            lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            break;
          }
        } catch {
          // retry
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(lock && lock.token, 'Engine failed to start or write runtime.json');
    console.log(`✓ Local Engine booted cleanly on port ${lock.port} (PID ${lock.pid})`);

    // 1. Public health check
    const healthRes = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.port, port);

    // 2. Security: reject missing token (401)
    const noAuthRes = await fetch(`${baseUrl}/api/v1/settings`);
    assert.equal(noAuthRes.status, 401);

    // 3. Security: reject evil Origin (403)
    const evilOriginRes = await fetch(`${baseUrl}/api/v1/settings`, {
      headers: { Origin: 'https://evil.example.com', 'X-Auth-Token': lock.token },
    });
    assert.equal(evilOriginRes.status, 403);
    console.log('✓ Localhost security verified (401 no-token, 403 foreign Origin)');

    // 4. Web UI fallback serves HTML with injected session token
    const webUiRes = await fetch(`${baseUrl}/`);
    assert.equal(webUiRes.status, 200);
    const webHtml = await webUiRes.text();
    assert.ok(webHtml.includes('__TUBEVAULT_WEB_TOKEN__'), 'Web UI missing injected token');
    console.log('✓ Engine Web UI fallback verified');

    // 5. Authorized Extension Origin + Token settings CRUD & SQLite persistence
    const headers = {
      Origin: FIXED_EXTENSION_ORIGIN,
      'X-Auth-Token': lock.token,
      'Content-Type': 'application/json',
    };
    const settingsRes = await fetch(`${baseUrl}/api/v1/settings`, { headers });
    assert.equal(settingsRes.status, 200);
    const patchRes = await fetch(`${baseUrl}/api/v1/settings`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ maxConcurrency: 3, sleepMinSec: 3, defaultVideoQuality: '2160p' }),
    });
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.equal(patched.settings.maxConcurrency, 3);
    assert.equal(patched.settings.defaultVideoQuality, '2160p');

    // 6. Cookies bridge domain filtering
    const ckRes = await fetch(`${baseUrl}/api/v1/cookies/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cookies: [
          { domain: '.youtube.com', path: '/', secure: true, name: 'SID', value: 'demo' },
          { domain: '.unrelated.com', path: '/', secure: true, name: 'LEAK', value: 'no' },
        ],
      }),
    });
    assert.equal(ckRes.status, 200);
    const ckJson = await ckRes.json();
    assert.equal(ckJson.count, 1, 'Expected only youtube.com cookie to be accepted');
    console.log('✓ Settings persistence (node:sqlite) & Cookies domain filter verified');

    // 7. WebSocket authentication & initial events
    const wsEvents = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(lock.token)}`, {
        headers: { Origin: FIXED_EXTENSION_ORIGIN },
      });
      const received = [];
      const timer = setTimeout(() => reject(new Error('WS timeout')), 5000);
      ws.on('message', (data) => {
        received.push(JSON.parse(data.toString('utf8')));
        if (received.length >= 2) {
          clearTimeout(timer);
          ws.close();
          resolve(received);
        }
      });
      ws.on('error', reject);
    });
    assert.equal(wsEvents[0].type, 'engine:ready');
    assert.equal(wsEvents[1].type, 'queue:summary');
    console.log('✓ WebSocket realtime hub verified');

    // 8. Diagnostic rolling log file & tail API
    const logRes = await fetch(`${baseUrl}/api/v1/logs/tail?lines=50`, { headers });
    assert.equal(logRes.status, 200);
    const logJson = await logRes.json();
    assert.ok(logJson.logPath.endsWith('engine.log'), 'Expected engine.log path');
    assert.ok(Array.isArray(logJson.lines) && logJson.lines.length >= 1, 'Expected startup log entries in engine.log');
    assert.ok(logJson.lines.some((l) => l.includes('Engine v1.0.0 started')), 'Expected startup line in log');
    console.log('✓ Rolling diagnostic file logger (logs/engine.log) & tail API verified');

    // 9. Batch URL analyze validation
    const emptyBatchRes = await fetch(`${baseUrl}/api/v1/analyze/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ urls: [] }),
    });
    assert.equal(emptyBatchRes.status, 400);
    console.log('✓ Batch URL analyzer endpoint validation verified');

    // 10. Native Messaging Host executable (ytdl-host.exe) stdio protocol test
    const nativePing = await sendNativeHostMessage(tempDataDir, { action: 'ping' });
    assert.equal(nativePing.ok, true);
    assert.equal(nativePing.running, true);
    assert.equal(nativePing.port, port);
    console.log('✓ Windows Native Messaging Launcher (ytdl-host.exe) stdio verified');

    // 11. Graceful shutdown removes lockfile
    const shutRes = await fetch(`${baseUrl}/api/v1/system/shutdown`, { method: 'POST', headers });
    assert.equal(shutRes.status, 200);
    await new Promise((r) => engine.once('close', r));
    assert.equal(fs.existsSync(lockPath), false, 'Expected runtime.json to be cleaned up on shutdown');
    console.log('✓ Graceful shutdown & lockfile cleanup verified');
  } finally {
    try {
      engine.kill();
    } catch {
      // ignore
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
}

async function main() {
  testUrlParserAndSanitizer();
  testExtensionManifest();
  testIconAndWindowsExecutables();
  await testEngineAndNativeHost();
  console.log('\nALL E2E VERIFICATION CHECKS PASSED!');
}

main().catch((err) => {
  console.error('\nE2E VERIFICATION FAILED:', err);
  process.exit(1);
});
