import React, { useCallback, useEffect, useState } from 'react';
import type {
  AppSettings,
  BatchRecord,
  DepsStatus,
  DownloadTaskRecord,
  ExtensionMessage,
  WsEvent,
} from '@tubevault/shared';
import { client, isExtensionContext, type ConnectionState } from './api/client.js';
import { AnalyzerPage } from './pages/AnalyzerPage.js';
import { QueuePage } from './pages/QueuePage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { SyncPage } from './pages/SyncPage.js';

type ActiveTab = 'analyze' | 'queue' | 'sync' | 'settings';

export const App: React.FC = () => {
  const [tab, setTab] = useState<ActiveTab>('analyze');
  const [conn, setConn] = useState<ConnectionState>({
    connected: false,
    baseUrl: '',
    token: '',
    via: 'web',
  });
  const [connecting, setConnecting] = useState(true);
  const [deps, setDeps] = useState<DepsStatus | null>(null);
  const [depsProgress, setDepsProgress] = useState<Record<string, { pct: number; status: string; message?: string }>>({});
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [batches, setBatches] = useState<BatchRecord[]>([]);
  const [tasks, setTasks] = useState<DownloadTaskRecord[]>([]);
  const [summary, setSummary] = useState({ activeCount: 0, queuedCount: 0, totalSpeedBps: 0 });
  const [analyzeProgress, setAnalyzeProgress] = useState<{
    jobId: string;
    scannedCount: number;
    message: string;
  } | null>(null);
  const [incomingUrl, setIncomingUrl] = useState<{ url: string; forcePlaylist?: boolean; nonce: number } | null>(null);
  const [quickInstalling, setQuickInstalling] = useState(false);

  const refreshQueue = useCallback(async () => {
    try {
      const [dlRes, batchRes] = await Promise.all([client.listDownloads(250), client.listBatches(50)]);
      setTasks(dlRes.tasks);
      setSummary(dlRes.summary);
      setBatches(batchRes.batches);
    } catch {
      // ignore
    }
  }, []);

  const initConnection = useCallback(async () => {
    setConnecting(true);
    const state = await client.connect();
    setConn(state);
    setConnecting(false);

    if (state.connected) {
      try {
        const [health, settingsRes] = await Promise.all([client.getHealth(), client.getSettings()]);
        setDeps(health.deps);
        setSettings(settingsRes.settings);
        await refreshQueue();
      } catch {
        // ignore
      }
    }
  }, [refreshQueue]);

  useEffect(() => {
    void initConnection();

    const unsub = client.subscribe((event: WsEvent) => {
      if (event.type === 'deps:progress') {
        setDepsProgress((prev) => ({
          ...prev,
          [event.payload.target]: {
            pct: event.payload.pct,
            status: event.payload.status,
            message: event.payload.message,
          },
        }));
        if (event.payload.status === 'done') {
          void client.getDepsStatus(true).then(setDeps).catch(() => {});
        }
        return;
      }

      if (event.type === 'analyze:progress') {
        setAnalyzeProgress({
          jobId: event.payload.jobId,
          scannedCount: event.payload.scannedCount,
          message: event.payload.message,
        });
        return;
      }

      if (event.type === 'task:created') {
        setTasks((prev) => [event.payload.task, ...prev.filter((t) => t.id !== event.payload.task.id)]);
        return;
      }

      if (event.type === 'task:progress') {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === event.payload.taskId
              ? {
                  ...t,
                  phase: event.payload.phase,
                  progressPct: event.payload.progressPct,
                  speedBps: event.payload.speedBps ?? t.speedBps,
                  etaSec: event.payload.etaSec ?? t.etaSec,
                  downloadedBytes: event.payload.downloadedBytes ?? t.downloadedBytes,
                  totalBytes: event.payload.totalBytes ?? t.totalBytes,
                }
              : t
          )
        );
        return;
      }

      if (event.type === 'task:status') {
        setTasks((prev) =>
          prev.map((t) =>
            t.id === event.payload.taskId
              ? {
                  ...t,
                  status: event.payload.status,
                  phase: event.payload.phase ?? t.phase,
                  outputPath: event.payload.outputPath ?? t.outputPath,
                  errorCode: event.payload.errorCode ?? null,
                  errorMessage: event.payload.errorMessage ?? null,
                  progressPct: event.payload.status === 'completed' ? 100 : t.progressPct,
                }
              : t
          )
        );
        return;
      }

      if (event.type === 'batch:updated') {
        setBatches((prev) => {
          const exists = prev.some((b) => b.id === event.payload.batchId);
          if (!exists) {
            void refreshQueue();
            return prev;
          }
          return prev.map((b) =>
            b.id === event.payload.batchId
              ? {
                  ...b,
                  status: event.payload.status,
                  completedItems: event.payload.completedItems,
                  failedItems: event.payload.failedItems,
                  skippedItems: event.payload.skippedItems,
                  totalItems: event.payload.totalItems,
                }
              : b
          );
        });
        return;
      }

      if (event.type === 'queue:summary') {
        setSummary(event.payload);
        if (isExtensionContext()) {
          chrome.runtime
            .sendMessage({ type: 'UPDATE_BADGE', count: event.payload.activeCount + event.payload.queuedCount })
            .catch(() => {});
        }
      }
    });

    return () => {
      unsub();
      client.disconnect();
    };
  }, [initConnection, refreshQueue]);

  // Receive URLs triggered by YouTube Content Script button or Context Menu
  useEffect(() => {
    if (!isExtensionContext()) return;

    void chrome.storage.session?.get('pendingUrl').then((res) => {
      const pending = res?.pendingUrl as { url: string; forcePlaylist?: boolean; ts: number } | undefined;
      if (pending?.url && Date.now() - pending.ts < 30_000) {
        setTab('analyze');
        setIncomingUrl({ url: pending.url, forcePlaylist: pending.forcePlaylist, nonce: Date.now() });
        void chrome.storage.session.remove('pendingUrl');
      }
    });

    const listener = (msg: ExtensionMessage) => {
      if (msg.type === 'PENDING_URL_AVAILABLE' && msg.url) {
        setTab('analyze');
        setIncomingUrl({ url: msg.url, forcePlaylist: msg.forcePlaylist, nonce: Date.now() });
        void chrome.storage.session?.remove('pendingUrl');
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const depsReady = Boolean(deps?.ytdlpInstalled && deps?.ffmpegInstalled);
  const activeBadgeCount = summary.activeCount + summary.queuedCount;

  const handleQuickInstall = async () => {
    setQuickInstalling(true);
    try {
      const updated = await client.installDeps(false);
      setDeps(updated);
    } finally {
      setQuickInstalling(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-row">
          <div className="brand">
            <span className="brand-dot">T</span>
            <span>TubeVault</span>
            <span className="muted" style={{ fontWeight: 400 }}>
              {isExtensionContext() ? 'Extension' : 'Local Web UI'}
            </span>
          </div>

          <div className="status-pill">
            <span className={`dot ${conn.connected ? (depsReady ? 'ok' : 'warn') : 'err'}`} />
            <span>
              {connecting
                ? 'Đang kết nối...'
                : !conn.connected
                  ? 'Engine ngoại tuyến'
                  : depsReady
                    ? 'Engine sẵn sàng'
                    : 'Thiếu yt-dlp/FFmpeg'}
            </span>
          </div>
        </div>

        <nav className="tabs">
          <button className={`tab-btn ${tab === 'analyze' ? 'active' : ''}`} onClick={() => setTab('analyze')}>
            Phân tích
          </button>
          <button className={`tab-btn ${tab === 'queue' ? 'active' : ''}`} onClick={() => setTab('queue')}>
            Hàng đợi
            {activeBadgeCount > 0 && <span className="tab-badge">{activeBadgeCount}</span>}
          </button>
          <button className={`tab-btn ${tab === 'sync' ? 'active' : ''}`} onClick={() => setTab('sync')}>
            Kênh & Lịch sử
          </button>
          <button className={`tab-btn ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
            Cài đặt
          </button>
        </nav>
      </header>

      <main className="main-content">
        {/* Disconnected Engine Banner */}
        {!connecting && !conn.connected && (
          <div className="banner err">
            <div>
              <strong>Chưa kết nối được TubeVault Local Engine</strong>
              <div style={{ marginTop: 2 }}>{conn.error}</div>
            </div>
            <button className="btn sm primary" onClick={() => void initConnection()}>
              Thử kết nối lại
            </button>
          </div>
        )}

        {/* First-run Auto Dependency Setup Banner */}
        {conn.connected && deps && !depsReady && (
          <div className="banner warn">
            <div>
              <strong>Cài đặt lần đầu: Cần tải yt-dlp.exe & FFmpeg</strong>
              <div style={{ marginTop: 2 }}>
                Tự động tải bản chính chủ từ GitHub (~45 MB) để hỗ trợ ghép video 4K và chuyển đổi MP3.
              </div>
              {Object.entries(depsProgress).map(([k, v]) =>
                v.status === 'downloading' || v.status === 'extracting' ? (
                  <div key={k} style={{ marginTop: 4 }}>
                    {v.message} ({v.pct}%)
                  </div>
                ) : null
              )}
            </div>
            <button
              className="btn sm primary"
              disabled={quickInstalling}
              onClick={() => void handleQuickInstall()}
            >
              {quickInstalling ? 'Đang cài đặt...' : 'Cài đặt ngay'}
            </button>
          </div>
        )}

        {tab === 'analyze' && (
          <AnalyzerPage
            settings={settings}
            depsReady={depsReady}
            incomingUrl={incomingUrl}
            analyzeProgress={analyzeProgress}
            onEnqueued={() => {
              void refreshQueue();
              setTab('queue');
            }}
            onGoSettings={() => setTab('settings')}
          />
        )}

        {tab === 'queue' && (
          <QueuePage
            batches={batches}
            tasks={tasks}
            summary={summary}
            onRefresh={() => void refreshQueue()}
            onGoSettings={() => setTab('settings')}
          />
        )}

        {tab === 'sync' && (
          <SyncPage
            onEnqueued={() => {
              void refreshQueue();
              setTab('queue');
            }}
          />
        )}

        {tab === 'settings' && (
          <SettingsPage
            settings={settings}
            deps={deps}
            depsProgress={depsProgress}
            onSettingsUpdated={setSettings}
            onDepsUpdated={setDeps}
          />
        )}
      </main>
    </div>
  );
};
