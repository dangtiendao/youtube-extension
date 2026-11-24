import type {
  AnalyzeRequest,
  AnalyzeResult,
  AppSettings,
  ArchiveRecord,
  BatchAnalyzeRequest,
  BatchRecord,
  CreateDownloadRequest,
  DepsStatus,
  DownloadTaskRecord,
  HealthResponse,
  LogsTailResponse,
  TrackedSourceRecord,
  WsEvent,
} from '@tubevault/shared';

declare global {
  interface Window {
    __TUBEVAULT_WEB_TOKEN__?: string;
  }
}

export function isExtensionContext(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
}

export interface ConnectionState {
  connected: boolean;
  baseUrl: string;
  token: string;
  via: 'native' | 'dev' | 'web';
  error?: string;
}

export class TubeVaultClient {
  private baseUrl = '';
  private token = '';
  private via: 'native' | 'dev' | 'web' = 'web';
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private listeners = new Set<(event: WsEvent) => void>();

  async connect(): Promise<ConnectionState> {
    // Case 1: Served directly from Engine Web UI (http://127.0.0.1:PORT/)
    if (!isExtensionContext()) {
      const injectedToken = window.__TUBEVAULT_WEB_TOKEN__ || '';
      const baseUrl = window.location.origin;
      if (injectedToken) {
        this.baseUrl = baseUrl;
        this.token = injectedToken;
        this.via = 'web';
        this.openWebSocket();
        return { connected: true, baseUrl, token: injectedToken, via: 'web' };
      }

      // Dev Vite server talking to local dev engine
      try {
        const devBase = 'http://127.0.0.1:17890';
        const res = await fetch(`${devBase}/api/v1/dev/handshake`);
        if (res.ok) {
          const data = (await res.json()) as { port: number; token: string };
          this.baseUrl = `http://127.0.0.1:${data.port}`;
          this.token = data.token;
          this.via = 'dev';
          this.openWebSocket();
          return { connected: true, baseUrl: this.baseUrl, token: this.token, via: 'dev' };
        }
      } catch {
        // ignore
      }

      return {
        connected: false,
        baseUrl: '',
        token: '',
        via: 'web',
        error: 'Không kết nối được TubeVault Local Engine.',
      };
    }

    // Case 2: Running inside Chrome Extension Side Panel
    const conn = await new Promise<{
      ok: boolean;
      baseUrl?: string;
      token?: string;
      via?: 'native' | 'dev';
      error?: string;
    }>((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_ENGINE_CONNECTION' }, (res) => {
        if (chrome.runtime.lastError || !res) {
          resolve({ ok: false, error: chrome.runtime.lastError?.message || 'Background worker không phản hồi' });
          return;
        }
        resolve(res);
      });
    });

    if (!conn.ok || !conn.baseUrl || !conn.token) {
      return {
        connected: false,
        baseUrl: '',
        token: '',
        via: 'native',
        error: conn.error || 'Chưa kết nối được Local Engine.',
      };
    }

    this.baseUrl = conn.baseUrl;
    this.token = conn.token;
    this.via = conn.via || 'native';
    this.openWebSocket();
    return { connected: true, baseUrl: this.baseUrl, token: this.token, via: this.via };
  }

  subscribe(fn: (event: WsEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  disconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private openWebSocket(): void {
    if (!this.baseUrl || !this.token) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data)) as WsEvent;
        for (const fn of this.listeners) fn(parsed);
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        this.openWebSocket();
      }, 2500);
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.baseUrl || !this.token) {
      const state = await this.connect();
      if (!state.connected) throw new Error(state.error || 'Chưa kết nối Engine');
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': this.token,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    }
    return data as T;
  }

  getHealth(): Promise<HealthResponse> {
    return this.request('GET', '/api/v1/health');
  }

  getDepsStatus(refresh = false): Promise<DepsStatus> {
    return this.request('GET', `/api/v1/deps/status${refresh ? '?refresh=1' : ''}`);
  }

  installDeps(force = false): Promise<DepsStatus> {
    return this.request('POST', '/api/v1/deps/install', { force });
  }

  updateYtdlp(): Promise<{ ok: boolean; output: string; version: string | null }> {
    return this.request('POST', '/api/v1/deps/update-ytdlp');
  }

  analyze(req: AnalyzeRequest): Promise<AnalyzeResult> {
    return this.request('POST', '/api/v1/analyze', req);
  }

  analyzeBatch(req: BatchAnalyzeRequest): Promise<AnalyzeResult> {
    return this.request('POST', '/api/v1/analyze/batch', req);
  }

  cancelAnalyze(jobId: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/api/v1/analyze/${encodeURIComponent(jobId)}/cancel`);
  }

  createDownloads(req: CreateDownloadRequest): Promise<{ batch: BatchRecord; tasks: DownloadTaskRecord[] }> {
    return this.request('POST', '/api/v1/downloads', req);
  }

  listDownloads(limit = 200): Promise<{
    tasks: DownloadTaskRecord[];
    summary: { activeCount: number; queuedCount: number; totalSpeedBps: number };
  }> {
    return this.request('GET', `/api/v1/downloads?limit=${limit}`);
  }

  listBatches(limit = 50): Promise<{ batches: BatchRecord[] }> {
    return this.request('GET', `/api/v1/batches?limit=${limit}`);
  }

  taskAction(taskId: string, action: 'pause' | 'resume' | 'retry' | 'cancel' | 'open-folder'): Promise<unknown> {
    return this.request('POST', `/api/v1/downloads/${encodeURIComponent(taskId)}/${action}`);
  }

  deleteTask(taskId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/api/v1/downloads/${encodeURIComponent(taskId)}`);
  }

  batchAction(
    batchId: string,
    action: 'pause-all' | 'resume-all' | 'cancel-all' | 'retry-failed' | 'open-folder'
  ): Promise<unknown> {
    return this.request('POST', `/api/v1/batches/${encodeURIComponent(batchId)}/${action}`);
  }

  deleteBatch(batchId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/api/v1/batches/${encodeURIComponent(batchId)}`);
  }

  listArchive(limit = 100): Promise<{ items: ArchiveRecord[] }> {
    return this.request('GET', `/api/v1/archive?limit=${limit}`);
  }

  listSources(): Promise<{ sources: TrackedSourceRecord[] }> {
    return this.request('GET', '/api/v1/sources');
  }

  checkSourceNew(
    sourceId: string,
    autoEnqueue = false
  ): Promise<{
    source: TrackedSourceRecord;
    totalScanned: number;
    newItems: AnalyzeResult['items'];
    enqueuedBatch: BatchRecord | null;
  }> {
    return this.request('POST', `/api/v1/sources/${encodeURIComponent(sourceId)}/check-new`, { autoEnqueue });
  }

  deleteSource(sourceId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/api/v1/sources/${encodeURIComponent(sourceId)}`);
  }

  getSettings(): Promise<{
    settings: AppSettings;
    cookies: { hasCookies: boolean; count: number; syncedAt: number | null };
  }> {
    return this.request('GET', '/api/v1/settings');
  }

  updateSettings(patch: Partial<AppSettings>): Promise<{ settings: AppSettings }> {
    return this.request('PATCH', '/api/v1/settings', patch);
  }

  pickFolder(initialDir?: string): Promise<{ path: string | null }> {
    return this.request('POST', '/api/v1/fs/pick-folder', { initialDir });
  }

  openDir(dirPath?: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/v1/fs/open-dir', { dirPath });
  }

  clearCookies(): Promise<{ ok: boolean }> {
    return this.request('DELETE', '/api/v1/cookies/sync');
  }

  getLogsTail(lines = 150): Promise<LogsTailResponse> {
    return this.request('GET', `/api/v1/logs/tail?lines=${lines}`);
  }

  openLogFile(): Promise<{ ok: boolean; logPath: string }> {
    return this.request('POST', '/api/v1/logs/open');
  }
}

export const client = new TubeVaultClient();
