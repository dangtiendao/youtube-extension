import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME, APP_VERSION, DEFAULT_ENGINE_PORT } from '@tubevault/shared';
import { createEngineHttpServer } from './api/server.js';
import { WsHub } from './api/ws-hub.js';
import { resolveEnginePaths } from './config/paths.js';
import { openDatabase } from './db/connection.js';
import { EngineStore } from './db/repositories.js';
import { DepsManager } from './deps/manager.js';
import {
  registerWindowsNativeHost,
  removeRuntimeLock,
  runNativeMessagingHost,
  writeRuntimeLock,
} from './native-host/bootstrap.js';
import { DownloadQueueManager } from './queue/manager.js';
import { EngineLogger } from './utils/logger.js';
import { LinkAnalyzer } from './ytdlp/analyzer.js';
import { CookiesStore } from './ytdlp/cookies-store.js';

const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const paths = resolveEnginePaths();

  // Mode 1: Chrome Native Messaging Host (stdio bridge)
  if (args.has('--native-host')) {
    runNativeMessagingHost(paths);
    return;
  }

  // Mode 2: Register Native Messaging Host in Windows HKCU Registry
  if (args.has('--register')) {
    const customHostIdx = process.argv.indexOf('--host-exe');
    const hostExe =
      customHostIdx !== -1 && process.argv[customHostIdx + 1]
        ? process.argv[customHostIdx + 1]
        : path.resolve(process.cwd(), 'installer', 'bin', 'ytdl-host.exe');

    if (!fs.existsSync(hostExe)) {
      console.error(`[TubeVault] Host launcher not found at: ${hostExe}`);
      console.error('Run "npm run build:launcher" first.');
      process.exit(1);
    }

    const res = await registerWindowsNativeHost(paths, hostExe);
    console.log(`[TubeVault] Registered Chrome Native Messaging Host:`);
    console.log(`  Manifest: ${res.manifestPath}`);
    console.log(`  Registry: ${res.regKey}`);
    return;
  }

  // Mode 3: Local HTTP + WebSocket Server Daemon
  const logger = new EngineLogger(paths.logsDir);
  process.on('uncaughtException', (err) => {
    logger.error('fatal', `Uncaught exception: ${err.stack || err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('fatal', `Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
  });

  const devMode = args.has('--dev') || process.env.TUBEVAULT_DEV === '1';
  const portArgIdx = process.argv.indexOf('--port');
  const preferredPort =
    portArgIdx !== -1 && Number(process.argv[portArgIdx + 1])
      ? Number(process.argv[portArgIdx + 1])
      : Number(process.env.TUBEVAULT_PORT || DEFAULT_ENGINE_PORT);

  const sessionToken = crypto.randomBytes(24).toString('hex');
  const db = openDatabase(paths.dbPath);
  const store = new EngineStore(db, paths.defaultDownloadDir);
  const wsHub = new WsHub();
  const cookiesStore = new CookiesStore(paths.tempDir);
  const deps = new DepsManager(paths, (ev) => wsHub.broadcast(ev));
  const analyzer = new LinkAnalyzer(paths, deps, store, cookiesStore, (ev) => wsHub.broadcast(ev));
  const queue = new DownloadQueueManager(paths, store, deps, cookiesStore, logger, (ev) => wsHub.broadcast(ev));

  let shuttingDown = false;
  let httpServerRef: { close: (cb?: () => void) => void } | null = null;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('system', 'Shutting down TubeVault Local Engine...');
    await queue.shutdownAll();
    wsHub.close();
    httpServerRef?.close();
    removeRuntimeLock(paths.runtimeLockPath, process.pid);
    try {
      db.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  const { server, start } = createEngineHttpServer({
    paths,
    store,
    deps,
    analyzer,
    queue,
    cookiesStore,
    logger,
    wsHub,
    sessionToken,
    devMode,
    onShutdownRequest: shutdown,
  });
  httpServerRef = server;

  const boundPort = await start(preferredPort);

  writeRuntimeLock(paths.runtimeLockPath, {
    port: boundPort,
    token: sessionToken,
    pid: process.pid,
    startedAt: Date.now(),
    version: APP_VERSION,
  });

  logger.info('system', `${APP_NAME} Engine v${APP_VERSION} started on 127.0.0.1:${boundPort} (Node ${process.version}, PID ${process.pid})`);
  console.log(`[${APP_NAME}] Local Engine v${APP_VERSION} listening on http://127.0.0.1:${boundPort}`);
  console.log(`[${APP_NAME}] Data directory: ${paths.appDataDir}`);
  console.log(`[${APP_NAME}] Log file: ${logger.getLogFilePath()}`);
  if (devMode) {
    console.log(`[${APP_NAME}] Dev mode enabled (token: ${sessionToken})`);
  }

  const depStatus = await deps.getStatus();
  if (depStatus.ytdlpInstalled && depStatus.ffmpegInstalled) {
    void queue.pump();
  }

  // Non-blocking background yt-dlp auto-update (at most once per 24 hours when enabled)
  const settings = store.getSettings();
  if (
    settings.autoCheckYtdlpUpdate &&
    depStatus.ytdlpInstalled &&
    process.env.TUBEVAULT_SKIP_AUTO_UPDATE !== '1'
  ) {
    const lastCheck = store.getMeta<number>('lastYtdlpAutoUpdateAt') || 0;
    if (Date.now() - lastCheck >= AUTO_UPDATE_INTERVAL_MS) {
      store.setMeta('lastYtdlpAutoUpdateAt', Date.now());
      setTimeout(() => {
        logger.info('updater', 'Running scheduled background yt-dlp update check...');
        void deps.updateYtdlp().then((res) => {
          if (res.ok) {
            logger.info('updater', `yt-dlp check complete (version: ${res.version || 'unknown'})`);
          } else {
            logger.warn('updater', `yt-dlp background update skipped/failed: ${res.output}`);
          }
        });
      }, 4000).unref();
    }
  }
}

void main().catch((err) => {
  console.error('[TubeVault Engine Fatal]', err);
  process.exit(1);
});
