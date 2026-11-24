import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  APP_NAME,
  APP_VERSION,
  FIXED_EXTENSION_ORIGIN,
  type AnalyzeRequest,
  type AppSettings,
  type BatchAnalyzeRequest,
  type CookiePayloadItem,
  type CreateDownloadRequest,
  type HealthResponse,
  type TaskStatus,
} from '@tubevault/shared';
import type { EnginePaths } from '../config/paths.js';
import type { EngineStore } from '../db/repositories.js';
import type { DepsManager } from '../deps/manager.js';
import type { DownloadQueueManager } from '../queue/manager.js';
import { openPathInExplorer, pickFolderWindows } from '../utils/folder-picker.js';
import type { EngineLogger } from '../utils/logger.js';
import type { LinkAnalyzer } from '../ytdlp/analyzer.js';
import type { CookiesStore } from '../ytdlp/cookies-store.js';
import { WsHub } from './ws-hub.js';

export interface EngineServerContext {
  paths: EnginePaths;
  store: EngineStore;
  deps: DepsManager;
  analyzer: LinkAnalyzer;
  queue: DownloadQueueManager;
  cookiesStore: CookiesStore;
  logger: EngineLogger;
  wsHub: WsHub;
  sessionToken: string;
  devMode: boolean;
  onShutdownRequest: () => Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function createEngineHttpServer(ctx: EngineServerContext): {
  server: http.Server;
  start: (preferredPort: number) => Promise<number>;
} {
  const startedAt = Date.now();
  let boundPort = 0;

  const isAllowedOrigin = (origin: string | undefined): boolean => {
    if (!origin) return true; // Direct non-browser / local curl / same-origin navigation
    if (origin === FIXED_EXTENSION_ORIGIN) return true;
    if (boundPort > 0 && (origin === `http://127.0.0.1:${boundPort}` || origin === `http://localhost:${boundPort}`)) {
      return true;
    }
    // In dev mode also allow Vite dev server origin
    if (ctx.devMode && /^https?:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
      return true;
    }
    return false;
  };

  const applyCors = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      sendJson(res, 403, { error: 'Forbidden origin' });
      return false;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token');
    return true;
  };

  const isAuthenticated = (req: http.IncomingMessage): boolean => {
    const headerToken = req.headers['x-auth-token'];
    return typeof headerToken === 'string' && headerToken === ctx.sessionToken;
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!applyCors(req, res)) return;

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://127.0.0.1:${boundPort || 80}`);
      const pathname = url.pathname;

      // ======================== STATIC WEB UI FALLBACK ========================
      if (!pathname.startsWith('/api/')) {
        serveWebUi(pathname, ctx.paths.webUiDir, ctx.sessionToken, res);
        return;
      }

      // ======================== PUBLIC HEALTH CHECK ========================
      if (req.method === 'GET' && pathname === '/api/v1/health') {
        const deps = await ctx.deps.getStatus();
        const body: HealthResponse = {
          ok: true,
          app: APP_NAME,
          version: APP_VERSION,
          port: boundPort,
          pid: process.pid,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          nodeVersion: process.version,
          deps,
        };
        sendJson(res, 200, body);
        return;
      }

      // Dev-only handshake strictly scoped to our fixed Chrome Extension ID (when running npm run dev:engine without Native Host)
      if (req.method === 'GET' && pathname === '/api/v1/dev/handshake') {
        const origin = req.headers.origin;
        if (!ctx.devMode || !origin || !isAllowedOrigin(origin)) {
          sendJson(res, 403, { error: 'Dev handshake disabled' });
          return;
        }
        sendJson(res, 200, { port: boundPort, token: ctx.sessionToken, version: APP_VERSION });
        return;
      }

      // ======================== AUTH REQUIRED ========================
      if (!isAuthenticated(req)) {
        sendJson(res, 401, { error: 'Unauthorized: missing or invalid X-Auth-Token' });
        return;
      }

      // --- System & Dependencies ---
      if (req.method === 'GET' && pathname === '/api/v1/deps/status') {
        const refresh = url.searchParams.get('refresh') === '1';
        sendJson(res, 200, await ctx.deps.getStatus(refresh));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/v1/deps/install') {
        const body = await readJsonBody<{ force?: boolean }>(req);
        const status = await ctx.deps.installMissing(Boolean(body?.force));
        sendJson(res, 200, status);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/v1/deps/update-ytdlp') {
        const result = await ctx.deps.updateYtdlp();
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/v1/system/shutdown') {
        sendJson(res, 200, { ok: true });
        setTimeout(() => void ctx.onShutdownRequest(), 100);
        return;
      }

      // --- Analyzer ---
      if (req.method === 'POST' && pathname === '/api/v1/analyze') {
        const body = await readJsonBody<AnalyzeRequest>(req);
        if (!body?.url) {
          sendJson(res, 400, { error: 'Thiếu trường url' });
          return;
        }
        ctx.logger.info('analyze', `Single/Source analyze: ${body.url}`);
        const result = await ctx.analyzer.analyze(body);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/v1/analyze/batch') {
        const body = await readJsonBody<BatchAnalyzeRequest>(req);
        if (!body?.urls || !Array.isArray(body.urls) || body.urls.length === 0) {
          sendJson(res, 400, { error: 'Danh sách link trống' });
          return;
        }
        ctx.logger.info('analyze', `Batch analyze: ${body.urls.length} URLs`);
        const result = await ctx.analyzer.analyzeBatch(body.urls, body.useCookies);
        sendJson(res, 200, result);
        return;
      }

      const cancelAnalyzeMatch = pathname.match(/^\/api\/v1\/analyze\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelAnalyzeMatch) {
        const cancelled = ctx.analyzer.cancelJob(cancelAnalyzeMatch[1]);
        sendJson(res, 200, { ok: cancelled });
        return;
      }

      // --- Downloads & Queue ---
      if (req.method === 'POST' && pathname === '/api/v1/downloads') {
        const body = await readJsonBody<CreateDownloadRequest>(req);
        if (!body?.items || !Array.isArray(body.items) || body.items.length === 0) {
          sendJson(res, 400, { error: 'Danh sách tải trống' });
          return;
        }
        const result = ctx.queue.enqueueBatch(body);
        sendJson(res, 201, result);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/downloads') {
        const status = (url.searchParams.get('status') || undefined) as TaskStatus | undefined;
        const batchId = url.searchParams.get('batchId') || undefined;
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 200)));
        const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
        const tasks = ctx.store.listTasks({ status, batchId, limit, offset });
        sendJson(res, 200, { tasks, summary: ctx.queue.getSummary() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/batches') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
        sendJson(res, 200, { batches: ctx.store.listBatches(limit) });
        return;
      }

      const taskActionMatch = pathname.match(/^\/api\/v1\/downloads\/([^/]+)\/(pause|resume|retry|cancel|open-folder)$/);
      if (req.method === 'POST' && taskActionMatch) {
        const [, taskId, action] = taskActionMatch;
        if (action === 'pause') {
          sendJson(res, 200, { task: await ctx.queue.pauseTask(taskId) });
          return;
        }
        if (action === 'resume') {
          sendJson(res, 200, { task: ctx.queue.resumeTask(taskId) });
          return;
        }
        if (action === 'retry') {
          sendJson(res, 200, { task: ctx.queue.retryTask(taskId) });
          return;
        }
        if (action === 'cancel') {
          sendJson(res, 200, { task: await ctx.queue.cancelTask(taskId) });
          return;
        }
        if (action === 'open-folder') {
          const task = ctx.store.getTask(taskId);
          const target = task?.outputPath || task?.options.outputDir || ctx.store.getSettings().downloadDir;
          const ok = openPathInExplorer(target);
          sendJson(res, 200, { ok });
          return;
        }
      }

      const deleteTaskMatch = pathname.match(/^\/api\/v1\/downloads\/([^/]+)$/);
      if (req.method === 'DELETE' && deleteTaskMatch) {
        const ok = await ctx.queue.deleteTask(deleteTaskMatch[1]);
        sendJson(res, 200, { ok });
        return;
      }

      const batchActionMatch = pathname.match(
        /^\/api\/v1\/batches\/([^/]+)\/(pause-all|resume-all|cancel-all|retry-failed|open-folder)$/
      );
      if (req.method === 'POST' && batchActionMatch) {
        const [, batchId, action] = batchActionMatch;
        if (action === 'pause-all') {
          sendJson(res, 200, { batch: await ctx.queue.pauseBatch(batchId) });
          return;
        }
        if (action === 'resume-all') {
          sendJson(res, 200, { batch: ctx.queue.resumeBatch(batchId) });
          return;
        }
        if (action === 'cancel-all') {
          sendJson(res, 200, { batch: await ctx.queue.cancelBatch(batchId) });
          return;
        }
        if (action === 'retry-failed') {
          sendJson(res, 200, { batch: ctx.queue.retryFailedBatch(batchId) });
          return;
        }
        if (action === 'open-folder') {
          const batch = ctx.store.getBatch(batchId);
          const ok = batch ? openPathInExplorer(batch.outputDir) : false;
          sendJson(res, 200, { ok });
          return;
        }
      }

      const deleteBatchMatch = pathname.match(/^\/api\/v1\/batches\/([^/]+)$/);
      if (req.method === 'DELETE' && deleteBatchMatch) {
        await ctx.queue.cancelBatch(deleteBatchMatch[1]);
        const ok = ctx.store.deleteBatch(deleteBatchMatch[1]);
        sendJson(res, 200, { ok });
        return;
      }

      // --- Archive & Tracked Sources (Incremental Sync) ---
      if (req.method === 'GET' && pathname === '/api/v1/archive') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
        const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
        sendJson(res, 200, { items: ctx.store.listArchive(limit, offset) });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/v1/sources') {
        sendJson(res, 200, { sources: ctx.store.listTrackedSources() });
        return;
      }

      const checkSourceMatch = pathname.match(/^\/api\/v1\/sources\/([^/]+)\/check-new$/);
      if (req.method === 'POST' && checkSourceMatch) {
        const source = ctx.store.getTrackedSource(checkSourceMatch[1]);
        if (!source) {
          sendJson(res, 404, { error: 'Không tìm thấy nguồn theo dõi' });
          return;
        }
        const body = await readJsonBody<{ autoEnqueue?: boolean; maxItems?: number }>(req);
        const analysis = await ctx.analyzer.analyze({
          url: source.url,
          channelTabs: source.channelTabs,
          maxItems: body?.maxItems ?? 200,
          useCookies: source.presetOptions.useCookies,
        });

        const mode = source.presetOptions.mode;
        const newItems = analysis.items.filter((item) =>
          mode === 'audio' ? !item.alreadyDownloadedAudio : !item.alreadyDownloadedVideo
        );

        let batchResult: { batch: unknown; tasks: unknown[] } | null = null;
        if (body?.autoEnqueue && newItems.length > 0) {
          batchResult = ctx.queue.enqueueBatch({
            sourceType: source.sourceType,
            sourceKey: source.sourceKey,
            sourceUrl: source.url,
            title: `${source.title} (Cập nhật mới)`,
            uploader: analysis.uploader,
            thumbnailUrl: source.thumbnailUrl || analysis.thumbnailUrl,
            channelTabs: source.channelTabs,
            items: newItems,
            options: { ...source.presetOptions, skipDownloaded: true },
            trackSource: true,
          });
        } else {
          ctx.store.touchTrackedSourceSynced(source.id, 0);
        }

        sendJson(res, 200, {
          source: ctx.store.getTrackedSource(source.id),
          totalScanned: analysis.items.length,
          newItems,
          enqueuedBatch: batchResult?.batch || null,
        });
        return;
      }

      const deleteSourceMatch = pathname.match(/^\/api\/v1\/sources\/([^/]+)$/);
      if (req.method === 'DELETE' && deleteSourceMatch) {
        sendJson(res, 200, { ok: ctx.store.deleteTrackedSource(deleteSourceMatch[1]) });
        return;
      }

      // --- Settings, Folder Picker & Cookies ---
      if (req.method === 'GET' && pathname === '/api/v1/settings') {
        sendJson(res, 200, {
          settings: ctx.store.getSettings(),
          cookies: ctx.cookiesStore.getStatus(),
        });
        return;
      }

      if (req.method === 'PATCH' && pathname === '/api/v1/settings') {
        const patch = await readJsonBody<Partial<AppSettings>>(req);
        const updated = ctx.store.updateSettings(patch || {});
        void ctx.queue.pump();
        sendJson(res, 200, { settings: updated });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/v1/fs/pick-folder') {
        const body = await readJsonBody<{ initialDir?: string }>(req);
        const selected = await pickFolderWindows(body?.initialDir || ctx.store.getSettings().downloadDir);
        sendJson(res, 200, { path: selected });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/v1/fs/open-dir') {
        const body = await readJsonBody<{ dirPath?: string }>(req);
        const target = body?.dirPath || ctx.store.getSettings().downloadDir;
        fs.mkdirSync(target, { recursive: true });
        sendJson(res, 200, { ok: openPathInExplorer(target) });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/v1/cookies/sync') {
        const body = await readJsonBody<{ cookies: CookiePayloadItem[] }>(req);
        if (!Array.isArray(body?.cookies)) {
          sendJson(res, 400, { error: 'Danh sách cookies không hợp lệ' });
          return;
        }
        const status = ctx.cookiesStore.setCookies(body.cookies);
        sendJson(res, 200, { ok: true, ...status });
        return;
      }

      if (req.method === 'DELETE' && pathname === '/api/v1/cookies/sync') {
        ctx.cookiesStore.clear();
        ctx.logger.info('cookies', 'Cleared session cookies from memory');
        sendJson(res, 200, { ok: true });
        return;
      }

      // --- Diagnostic Logs ---
      if (req.method === 'GET' && pathname === '/api/v1/logs/tail') {
        const lines = Math.min(500, Math.max(10, Number(url.searchParams.get('lines') || 150)));
        sendJson(res, 200, ctx.logger.readTail(lines));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/v1/logs/open') {
        const logPath = ctx.logger.getLogFilePath();
        if (!fs.existsSync(logPath)) {
          ctx.logger.info('system', 'Diagnostic log initialized');
        }
        const ok = openPathInExplorer(logPath);
        sendJson(res, 200, { ok, logPath });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.error('api', `${req.method} ${req.url} -> ${message}`);
      sendJson(res, 500, { error: message });
    }
  });

  // Attach WebSocket Hub with Origin + token validation
  ctx.wsHub.attach(
    server,
    (req, url) => {
      const origin = req.headers.origin;
      if (origin && !isAllowedOrigin(origin)) return false;
      const token = url.searchParams.get('token');
      return token === ctx.sessionToken;
    },
    async (ws) => {
      const deps = await ctx.deps.getStatus();
      ctx.wsHub.sendTo(ws, {
        type: 'engine:ready',
        payload: {
          version: APP_VERSION,
          port: boundPort,
          ytdlpInstalled: deps.ytdlpInstalled,
          ffmpegInstalled: deps.ffmpegInstalled,
        },
      });
      ctx.wsHub.sendTo(ws, {
        type: 'queue:summary',
        payload: ctx.queue.getSummary(),
      });
    }
  );

  const start = (preferredPort: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const tryListen = (port: number) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && port !== 0) {
            tryListen(0);
          } else {
            reject(err);
          }
        });
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          boundPort = typeof addr === 'object' && addr ? addr.port : port;
          resolve(boundPort);
        });
      };
      tryListen(preferredPort);
    });

  return { server, start };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody<T>(req: http.IncomingMessage): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const maxBytes = 10 * 1024 * 1024;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveWebUi(
  pathname: string,
  webUiDir: string,
  sessionToken: string,
  res: http.ServerResponse
): void {
  if (!webUiDir || !fs.existsSync(webUiDir)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html lang="vi"><body style="font-family:sans-serif;padding:32px;background:#0f172a;color:#e2e8f0">
      <h2>TubeVault Local Engine đang chạy</h2>
      <p>Web UI chưa được build. Hãy chạy <code>npm run build:ext</code> hoặc kết nối từ Chrome Extension.</p>
      </body></html>`
    );
    return;
  }

  const safeRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(webUiDir, safeRel);
  if (!resolved.startsWith(path.resolve(webUiDir))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const filePath = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
    ? resolved
    : path.join(webUiDir, 'index.html');

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  if (ext === '.html') {
    let html = fs.readFileSync(filePath, 'utf8');
    // Safely inject session token strictly for same-origin local Web UI
    const bootScript = `<script>window.__TUBEVAULT_WEB_TOKEN__=${JSON.stringify(sessionToken)};</script>`;
    html = html.includes('</head>') ? html.replace('</head>', `${bootScript}</head>`) : `${bootScript}${html}`;
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}
