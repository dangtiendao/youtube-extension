import React, { useEffect, useState } from 'react';
import {
  formatBytes,
  type AppSettings,
  type AudioBitrate,
  type AudioFormat,
  type DepsStatus,
  type LogsTailResponse,
  type VideoContainer,
  type VideoQuality,
} from '@tubevault/shared';
import { client, isExtensionContext } from '../api/client.js';

interface Props {
  settings: AppSettings | null;
  deps: DepsStatus | null;
  depsProgress: Record<string, { pct: number; status: string; message?: string }>;
  onSettingsUpdated: (s: AppSettings) => void;
  onDepsUpdated: (d: DepsStatus) => void;
}

export const SettingsPage: React.FC<Props> = ({
  settings,
  deps,
  depsProgress,
  onSettingsUpdated,
  onDepsUpdated,
}) => {
  const [installingDeps, setInstallingDeps] = useState(false);
  const [updatingYtdlp, setUpdatingYtdlp] = useState(false);
  const [cookieStatus, setCookieStatus] = useState<{ hasCookies: boolean; count: number; syncedAt: number | null }>({
    hasCookies: false,
    count: 0,
    syncedAt: null,
  });
  const [logs, setLogs] = useState<LogsTailResponse | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void client
      .getSettings()
      .then((res) => {
        onSettingsUpdated(res.settings);
        setCookieStatus(res.cookies);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchSetting = async (patch: Partial<AppSettings>) => {
    const res = await client.updateSettings(patch);
    onSettingsUpdated(res.settings);
  };

  const handleInstallDeps = async (force = false) => {
    setInstallingDeps(true);
    setNotice(null);
    try {
      const updated = await client.installDeps(force);
      onDepsUpdated(updated);
      setNotice('Đã cài đặt hoàn chỉnh yt-dlp.exe và FFmpeg!');
    } catch (err) {
      setNotice(`Lỗi cài đặt Engine: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setInstallingDeps(false);
    }
  };

  const handleUpdateYtdlp = async () => {
    setUpdatingYtdlp(true);
    setNotice(null);
    try {
      const res = await client.updateYtdlp();
      setNotice(res.ok ? `yt-dlp đã ở phiên bản mới nhất (${res.version || 'OK'})` : res.output);
      onDepsUpdated(await client.getDepsStatus(true));
    } finally {
      setUpdatingYtdlp(false);
    }
  };

  const handlePickFolder = async () => {
    const res = await client.pickFolder(settings?.downloadDir);
    if (res.path) {
      await patchSetting({ downloadDir: res.path });
    }
  };

  const handleSyncChromeCookies = async () => {
    if (!isExtensionContext()) {
      setNotice('Tính năng đọc Cookies Chrome chỉ khả dụng khi mở từ Chrome Extension.');
      return;
    }

    const granted = await chrome.permissions.request({ permissions: ['cookies'] });
    if (!granted) {
      setNotice('Bạn đã từ chối quyền đọc cookies Chrome.');
      return;
    }

    const res = await new Promise<{ ok: boolean; count?: number; error?: string }>((resolve) => {
      chrome.runtime.sendMessage({ type: 'SYNC_YOUTUBE_COOKIES' }, (r) => resolve(r || { ok: false }));
    });

    if (res.ok) {
      await patchSetting({ useCookies: true });
      const fresh = await client.getSettings();
      setCookieStatus(fresh.cookies);
      setNotice(`Đã đồng bộ ${res.count || 0} cookies YouTube vào bộ nhớ tạm của Engine.`);
    } else {
      setNotice(res.error || 'Đồng bộ cookies thất bại.');
    }
  };

  const handleClearCookies = async () => {
    await client.clearCookies();
    await patchSetting({ useCookies: false });
    setCookieStatus({ hasCookies: false, count: 0, syncedAt: null });
    setNotice('Đã xóa cookies phiên khỏi Local Engine.');
  };

  const handleToggleLogs = async () => {
    if (!showLogs) {
      const data = await client.getLogsTail(150);
      setLogs(data);
      setShowLogs(true);
    } else {
      setShowLogs(false);
    }
  };

  const handleOpenLogFile = async () => {
    const res = await client.openLogFile();
    if (!res.ok) {
      setNotice(`File log nằm tại: ${res.logPath}`);
    }
  };

  const handleCopyLogs = async () => {
    const data = logs || (await client.getLogsTail(150));
    setLogs(data);
    await navigator.clipboard.writeText(data.lines.join('\n') || '(Chưa có dòng log nào)');
    setNotice('Đã sao chép nhật ký log vào clipboard!');
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      {notice && <div className="banner info">{notice}</div>}

      {/* Engine Dependencies */}
      <div className="card col" style={{ gap: 8 }}>
        <div className="card-title">
          <span>Bộ máy tải (yt-dlp & FFmpeg)</span>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" disabled={updatingYtdlp} onClick={() => void handleUpdateYtdlp()}>
              {updatingYtdlp ? 'Đang cập nhật...' : 'Cập nhật yt-dlp'}
            </button>
            <button
              className="btn sm primary"
              disabled={installingDeps}
              onClick={() => void handleInstallDeps(false)}
            >
              {installingDeps ? 'Đang tải...' : deps?.ytdlpInstalled && deps?.ffmpegInstalled ? 'Kiểm tra lại' : 'Cài đặt tự động'}
            </button>
          </div>
        </div>

        <div className="grid-2">
          <div className="item-row between">
            <div>
              <div style={{ fontWeight: 600 }}>yt-dlp.exe</div>
              <div className="muted">{deps?.ytdlpVersion || (deps?.ytdlpInstalled ? 'Đã cài' : 'Chưa cài')}</div>
            </div>
            <span className={`badge ${deps?.ytdlpInstalled ? 'green' : 'red'}`}>
              {deps?.ytdlpInstalled ? 'Sẵn sàng' : 'Thiếu'}
            </span>
          </div>

          <div className="item-row between">
            <div>
              <div style={{ fontWeight: 600 }}>ffmpeg.exe</div>
              <div className="muted">{deps?.ffmpegVersion || (deps?.ffmpegInstalled ? 'Đã cài' : 'Chưa cài')}</div>
            </div>
            <span className={`badge ${deps?.ffmpegInstalled ? 'green' : 'red'}`}>
              {deps?.ffmpegInstalled ? 'Sẵn sàng' : 'Thiếu'}
            </span>
          </div>
        </div>

        {Object.entries(depsProgress).map(([target, info]) =>
          info.status === 'downloading' || info.status === 'extracting' ? (
            <div key={target} className="col" style={{ gap: 4 }}>
              <div className="row between muted">
                <span>{info.message || target}</span>
                <span>{info.pct}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${info.pct}%` }} />
              </div>
            </div>
          ) : null
        )}

        {settings && (
          <label className="toggle-label" style={{ marginTop: 2 }}>
            <input
              type="checkbox"
              checked={settings.autoCheckYtdlpUpdate}
              onChange={(e) => void patchSetting({ autoCheckYtdlpUpdate: e.target.checked })}
            />
            Tự động kiểm tra cập nhật yt-dlp khi khởi động (24 giờ/lần)
          </label>
        )}
      </div>

      {/* Folder & Organization */}
      {settings && (
        <>
          <div className="card col" style={{ gap: 8 }}>
            <div className="card-title">Thư mục lưu & Tổ chức file</div>
            <div className="row">
              <input className="input" value={settings.downloadDir} readOnly />
              <button className="btn" onClick={() => void handlePickFolder()}>
                Chọn...
              </button>
              <button className="btn" onClick={() => void client.openDir(settings.downloadDir)}>
                Mở
              </button>
            </div>
            <div className="row wrap" style={{ gap: 14 }}>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={settings.subfolderByChannel}
                  onChange={(e) => void patchSetting({ subfolderByChannel: e.target.checked })}
                />
                Tạo thư mục riêng theo tên Kênh
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={settings.subfolderByPlaylist}
                  onChange={(e) => void patchSetting({ subfolderByPlaylist: e.target.checked })}
                />
                Tạo thư mục riêng theo tên Playlist / Album
              </label>
            </div>
          </div>

          {/* Queue & Anti-Rate-Limit */}
          <div className="card col" style={{ gap: 8 }}>
            <div className="card-title">Hàng đợi & Chống chặn IP (Rate-Limit)</div>
            <div className="grid-2">
              <div>
                <label className="field-label">Số luồng tải đồng thời ({settings.maxConcurrency})</label>
                <input
                  type="range"
                  min={1}
                  max={5}
                  value={settings.maxConcurrency}
                  onChange={(e) => void patchSetting({ maxConcurrency: Number(e.target.value) })}
                  style={{ width: '100%' }}
                />
              </div>
              <div className="row">
                <div style={{ flex: 1 }}>
                  <label className="field-label">Nghỉ tối thiểu (giây)</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={30}
                    value={settings.sleepMinSec}
                    onChange={(e) => void patchSetting({ sleepMinSec: Math.max(0, Number(e.target.value)) })}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="field-label">Tối đa (giây)</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={60}
                    value={settings.sleepMaxSec}
                    onChange={(e) => void patchSetting({ sleepMaxSec: Math.max(0, Number(e.target.value)) })}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Default Formats */}
          <div className="card col" style={{ gap: 8 }}>
            <div className="card-title">Chất lượng mặc định</div>
            <div className="grid-2">
              <div>
                <label className="field-label">Video mặc định</label>
                <select
                  className="select"
                  value={settings.defaultVideoQuality}
                  onChange={(e) => void patchSetting({ defaultVideoQuality: e.target.value as VideoQuality })}
                >
                  <option value="best">Tốt nhất (4K/8K)</option>
                  <option value="2160p">4K (2160p)</option>
                  <option value="1440p">2K (1440p)</option>
                  <option value="1080p">1080p</option>
                  <option value="720p">720p</option>
                </select>
              </div>
              <div>
                <label className="field-label">Container Video</label>
                <select
                  className="select"
                  value={settings.defaultContainer}
                  onChange={(e) => void patchSetting({ defaultContainer: e.target.value as VideoContainer })}
                >
                  <option value="mp4">MP4</option>
                  <option value="mkv">MKV</option>
                  <option value="webm">WebM</option>
                </select>
              </div>
              <div>
                <label className="field-label">Âm thanh mặc định</label>
                <select
                  className="select"
                  value={settings.defaultAudioFormat}
                  onChange={(e) => void patchSetting({ defaultAudioFormat: e.target.value as AudioFormat })}
                >
                  <option value="mp3">MP3</option>
                  <option value="m4a">M4A</option>
                  <option value="opus">Opus</option>
                  <option value="flac">FLAC</option>
                </select>
              </div>
              <div>
                <label className="field-label">Bitrate âm thanh</label>
                <select
                  className="select"
                  value={settings.defaultAudioBitrate}
                  onChange={(e) => void patchSetting({ defaultAudioBitrate: e.target.value as AudioBitrate })}
                >
                  <option value="320k">320 kbps</option>
                  <option value="256k">256 kbps</option>
                  <option value="192k">192 kbps</option>
                  <option value="128k">128 kbps</option>
                </select>
              </div>
            </div>
          </div>

          {/* Chrome Cookies Bridge */}
          <div className="card col" style={{ gap: 8 }}>
            <div className="card-title">
              <span>Cookies Chrome Bridge (Vượt xác minh Bot / Giới hạn tuổi)</span>
              <span className={`badge ${cookieStatus.hasCookies ? 'green' : 'gray'}`}>
                {cookieStatus.hasCookies ? `${cookieStatus.count} cookies` : 'Chưa đồng bộ'}
              </span>
            </div>
            <div className="muted">
              Extension đọc cookies YouTube qua API chính thống của Chrome và truyền vào bộ nhớ tạm của Local Engine (tự
              xóa sau khi tải), tránh lỗi App-Bound Encryption trên Windows.
            </div>
            <div className="row wrap">
              <button className="btn primary" onClick={() => void handleSyncChromeCookies()}>
                Đồng bộ Cookies YouTube từ Chrome
              </button>
              {cookieStatus.hasCookies && (
                <button className="btn danger" onClick={() => void handleClearCookies()}>
                  Xóa Cookies tạm
                </button>
              )}
            </div>
          </div>

          {/* Diagnostic Logs */}
          <div className="card col" style={{ gap: 8 }}>
            <div className="card-title">
              <span>Nhật ký chẩn đoán (Logs)</span>
              {logs && <span className="muted">{formatBytes(logs.sizeBytes)}</span>}
            </div>
            <div className="muted">
              Tự động ghi nhật ký lỗi và tiến trình tải vào <code>logs/engine.log</code> (tự xoay vòng ở 5 MB) để hỗ
              trợ xử lý sự cố nhanh.
            </div>
            <div className="row wrap">
              <button className="btn primary" onClick={() => void handleOpenLogFile()}>
                Mở file Log
              </button>
              <button className="btn" onClick={() => void handleToggleLogs()}>
                {showLogs ? 'Ẩn log nhanh' : 'Xem nhanh log gần đây'}
              </button>
              <button className="btn" onClick={() => void handleCopyLogs()}>
                Sao chép Log
              </button>
            </div>
            {showLogs && (
              <div className="log-viewer">
                {logs && logs.lines.length > 0 ? logs.lines.join('\n') : 'Chưa có dữ liệu log.'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
