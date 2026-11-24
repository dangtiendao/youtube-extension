import React, { useEffect, useState } from 'react';
import {
  formatBytes,
  type ArchiveRecord,
  type TrackedSourceRecord,
} from '@tubevault/shared';
import { client } from '../api/client.js';

interface Props {
  onEnqueued: () => void;
}

export const SyncPage: React.FC<Props> = ({ onEnqueued }) => {
  const [subTab, setSubTab] = useState<'sources' | 'archive'>('sources');
  const [sources, setSources] = useState<TrackedSourceRecord[]>([]);
  const [archive, setArchive] = useState<ArchiveRecord[]>([]);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadData = async () => {
    try {
      const [sRes, aRes] = await Promise.all([client.listSources(), client.listArchive(100)]);
      setSources(sRes.sources);
      setArchive(aRes.items);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleCheckNew = async (source: TrackedSourceRecord, autoEnqueue: boolean) => {
    setCheckingId(source.id);
    setMessage(null);
    try {
      const res = await client.checkSourceNew(source.id, autoEnqueue);
      if (res.newItems.length === 0) {
        setMessage(`"${source.title}": Đã quét ${res.totalScanned} mục — chưa có video mới.`);
      } else if (autoEnqueue) {
        setMessage(`"${source.title}": Phát hiện ${res.newItems.length} video mới và đã đưa vào hàng đợi tải!`);
        onEnqueued();
      } else {
        setMessage(`"${source.title}": Phát hiện ${res.newItems.length} video mới chưa tải.`);
      }
      await loadData();
    } catch (err) {
      setMessage(`Lỗi kiểm tra "${source.title}": ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCheckingId(null);
    }
  };

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row between">
        <div className="segmented">
          <button className={subTab === 'sources' ? 'active' : ''} onClick={() => setSubTab('sources')}>
            Kênh / Playlist theo dõi ({sources.length})
          </button>
          <button className={subTab === 'archive' ? 'active' : ''} onClick={() => setSubTab('archive')}>
            Lịch sử đã tải ({archive.length})
          </button>
        </div>
        <button className="btn sm" onClick={() => void loadData()}>
          Làm mới
        </button>
      </div>

      {message && <div className="banner info">{message}</div>}

      {subTab === 'sources' ? (
        sources.length === 0 ? (
          <div className="card empty-state">
            Chưa có Kênh hoặc Playlist nào được theo dõi. Khi tải Kênh/Playlist ở tab <strong>Phân tích</strong>, tick
            chọn <em>"Lưu theo dõi để cập nhật video mới"</em>.
          </div>
        ) : (
          sources.map((src) => (
            <div key={src.id} className="card row between wrap" style={{ gap: 10 }}>
              <div className="row" style={{ flex: 1, minWidth: 0 }}>
                {src.thumbnailUrl && <img className="media-thumb sm" src={src.thumbnailUrl} alt="" />}
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="badge blue">{src.sourceType}</span>
                    <span style={{ fontWeight: 700 }} className="truncate">
                      {src.title}
                    </span>
                  </div>
                  <div className="muted">
                    Đã đồng bộ: {src.totalSyncedCount} mục
                    {src.lastSyncedAt ? ` · Kiểm tra lúc ${new Date(src.lastSyncedAt).toLocaleString('vi-VN')}` : ''}
                  </div>
                </div>
              </div>

              <div className="row wrap" style={{ gap: 6 }}>
                <button
                  className="btn sm primary"
                  disabled={checkingId === src.id}
                  onClick={() => void handleCheckNew(src, true)}
                >
                  {checkingId === src.id ? 'Đang quét...' : 'Quét & Tải mới'}
                </button>
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    await client.deleteSource(src.id);
                    await loadData();
                  }}
                >
                  Xóa
                </button>
              </div>
            </div>
          ))
        )
      ) : archive.length === 0 ? (
        <div className="card empty-state">Chưa có lịch sử tải nào.</div>
      ) : (
        <div className="card col" style={{ gap: 6 }}>
          {archive.map((item) => (
            <div key={item.id} className="item-row between">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 600 }}>
                  {item.title || item.videoId}
                </div>
                <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
                  <span className={`badge ${item.mode === 'audio' ? 'amber' : 'blue'}`}>{item.mode}</span>
                  {item.fileSizeBytes ? <span className="muted">{formatBytes(item.fileSizeBytes)}</span> : null}
                  <span className="muted">{new Date(item.downloadedAt).toLocaleString('vi-VN')}</span>
                </div>
              </div>
              {item.outputPath && (
                <button
                  className="btn sm"
                  onClick={() => void client.openDir(item.outputPath!)}
                >
                  Mở file
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
