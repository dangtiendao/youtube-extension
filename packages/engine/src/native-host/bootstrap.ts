import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  APP_VERSION,
  FIXED_EXTENSION_ORIGIN,
  NATIVE_HOST_NAME,
  type NativeRequest,
} from '@tubevault/shared';
import type { EnginePaths } from '../config/paths.js';
import { listenNativeMessages, writeNativeMessage } from './protocol.js';

const execFileAsync = promisify(execFile);

export interface RuntimeLockInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
  version: string;
}

export function readRuntimeLock(lockPath: string): RuntimeLockInfo | null {
  if (!fs.existsSync(lockPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as RuntimeLockInfo;
  } catch {
    return null;
  }
}

export function writeRuntimeLock(lockPath: string, info: RuntimeLockInfo): void {
  fs.writeFileSync(lockPath, JSON.stringify(info, null, 2), 'utf8');
}

export function removeRuntimeLock(lockPath: string, expectedPid?: number): void {
  try {
    if (expectedPid !== undefined) {
      const current = readRuntimeLock(lockPath);
      if (current && current.pid !== expectedPid) return;
    }
    fs.rmSync(lockPath, { force: true });
  } catch {
    // ignore
  }
}

async function isEngineHealthy(lock: RuntimeLockInfo): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/v1/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean; pid?: number };
    return Boolean(data.ok);
  } catch {
    return false;
  }
}

async function spawnDetachedEngine(): Promise<void> {
  const scriptPath = process.argv[1];
  const isSea = !scriptPath || path.extname(process.execPath).toLowerCase() === '.exe' && !scriptPath.endsWith('.cjs') && !scriptPath.endsWith('.js') && !scriptPath.endsWith('.ts');
  const args = isSea ? ['--server'] : [scriptPath, '--server'];

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();
}

async function ensureServerRunning(paths: EnginePaths): Promise<RuntimeLockInfo> {
  const existing = readRuntimeLock(paths.runtimeLockPath);
  if (existing && (await isEngineHealthy(existing))) {
    return existing;
  }

  removeRuntimeLock(paths.runtimeLockPath);
  await spawnDetachedEngine();

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const fresh = readRuntimeLock(paths.runtimeLockPath);
    if (fresh && (await isEngineHealthy(fresh))) {
      return fresh;
    }
  }

  throw new Error('Engine did not start within 12 seconds');
}

export function runNativeMessagingHost(paths: EnginePaths): void {
  listenNativeMessages(async (req: NativeRequest) => {
    if (req.action === 'ping') {
      const lock = readRuntimeLock(paths.runtimeLockPath);
      const running = lock ? await isEngineHealthy(lock) : false;
      writeNativeMessage({
        ok: true,
        running,
        pid: running ? lock?.pid : undefined,
        port: running ? lock?.port : undefined,
        engineVersion: APP_VERSION,
      });
      return;
    }

    if (req.action === 'ensure_server') {
      const lock = await ensureServerRunning(paths);
      writeNativeMessage({
        ok: true,
        port: lock.port,
        token: lock.token,
        pid: lock.pid,
        running: true,
        engineVersion: lock.version,
      });
      return;
    }

    if (req.action === 'shutdown') {
      const lock = readRuntimeLock(paths.runtimeLockPath);
      if (lock) {
        try {
          await fetch(`http://127.0.0.1:${lock.port}/api/v1/system/shutdown`, {
            method: 'POST',
            headers: {
              'X-Auth-Token': lock.token,
              Origin: FIXED_EXTENSION_ORIGIN,
            },
          });
        } catch {
          // ignore if already stopped
        }
      }
      writeNativeMessage({ ok: true });
      return;
    }

    writeNativeMessage({ ok: false, error: 'Unknown native action' });
  });
}

/**
 * Registers the Chrome Native Messaging Host manifest in HKCU (no admin required) for Windows dev/install.
 */
export async function registerWindowsNativeHost(
  paths: EnginePaths,
  hostExecutablePath: string
): Promise<{ manifestPath: string; regKey: string }> {
  const nativeDir = path.join(paths.appDataDir, 'native-host');
  fs.mkdirSync(nativeDir, { recursive: true });
  const manifestPath = path.join(nativeDir, `${NATIVE_HOST_NAME}.json`);

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'TubeVault Local Companion Native Host',
    path: path.resolve(hostExecutablePath),
    type: 'stdio',
    allowed_origins: [`${FIXED_EXTENSION_ORIGIN}/`],
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
  if (process.platform === 'win32') {
    await execFileAsync('reg.exe', ['add', regKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
      windowsHide: true,
    });
  }

  return { manifestPath, regKey };
}
