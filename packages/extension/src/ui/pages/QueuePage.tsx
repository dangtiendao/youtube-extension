import React, { useMemo, useState } from 'react';
import {
  formatBytes,
  formatDuration,
  type BatchRecord,
  type DownloadTaskRecord,
} from '@tubevault/shared';
import { client } from '../api/client.js';

interface Props {
  batches: BatchRecord[];
  tasks: DownloadTaskRecord[];
  summary: { activeCount: number; queuedCount: number; totalSpeedBps: number };
  onRefresh: () => void;
  onGoSettings: () => void;
}

const STATUS_LABELS: Record<string, { text: string; badge: string }> = {
  queued: { text: 'Đang chờ', badge: 'gray' },
  downloading: { text: 'Đang tải', badge: 'blue' },
  merging: { text: 'Đang ghép FFmpeg', badge: 'amber' },
  postprocessing: { text: 'Đang xử lý', badge: 'amber' },
  paused: { text: 'Tạm dừng', badge: 'gray' },
  completed: { text: 'Hoàn tất', badge: 'green' },
  failed: { text: 'Lỗi', badge: 'red' },
  cancelled: { text: 'Đã hủy', badge: 'gray' },
  skipped: { text: 'Đã có sẵn', badge: 'green' },
};

export const QueuePage: React.FC<Props> = ({ batches, tasks, summary, onRefresh, onGoSettings }) => {
  const [collapsedBatches, setCollapsedBatches] = useState<Set<string>>(new Set());

  const tasksByBatch = useMemo(() => {
    const map = new Map<string, DownloadTaskRecord[]>();
    for (const task of tasks) {
      const list = map.get(task.batchId) || [];
      list.push(task);
      map.set(task.batchId, list);
    }
    return map;
  }, [tasks]);

  const toggleBatch = (id: string) => {
    setCollapsedBatches((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleTaskAction = async (
    taskId: string,
    action: 'pause' | 'resume' | 'retry' | 'cancel' | 'open-folder'
  ) => {
    await client.taskAction(taskId, action);
    onRefresh();
  };

  const handleBatchAction = async (
    batchId: string,
    action: 'pause-all' | 'resume-all' | 'cancel-all' | 'retry-failed' | 'open-folder'
  ) => {
    await client.batchAction(batchId, action);
    onRefresh();
  };

  return (
    <div className="col" style={{ gap: 10 }}>
      {/* Live Queue Summary */}
      <div className="card row between wrap">
        <div className="row wrap" style={{ gap: 12 }}>
          <span>
            Đang tải: <strong>{summary.activeCount}</strong>
          </span>
          <span>
            Chờ: <strong>{summary.queuedCount}</strong>
          </span>
          <span>
            Tốc độ: <strong>{formatBytes(summary.totalSpeedBps)}/s</strong>
          </span>
        </div>
        <button className="btn sm" onClick={onRefresh}>
          Làm mới
        </button>
      </div>

      {batches.length === 0 && tasks.length === 0 ? (
        <div className="card empty-state">
          Hàng đợi đang trống. Hãy dán link ở tab <strong>Phân tích</strong> hoặc bấm nút tải trực tiếp trên YouTube.
        </div>
      ) : (
        batches.map((batch) => {
          const batchTasks = tasksByBatch.get(batch.id) || [];
          const collapsed = collapsedBatches.has(batch.id);
          const doneCount = batch.completedItems + batch.skippedItems;
          const batchPct = batch.totalItems > 0 ? Math.round((doneCount / batch.totalItems) * 100) : 0;

          return (
            <div key={batch.id} className="card col" style={{ gap: 8 }}>
              <div className="row between" style={{ gap: 8 }}>
                <div
                  style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                  onClick={() => toggleBatch(batch.id)}
                >
                  <div className="row" style={{ gap: 6 }}>
                    <span className="badge red">{batch.sourceType}</span>
                    <span style={{ fontWeight: 700 }} className="truncate" title={batch.title}>
                      {batch.title}
                    </span>
                  </div>
                  <div className="muted" style={{ marginTop: 2 }}>
                    {doneCount}/{batch.totalItems} xong
                    {batch.failedItems > 0 ? ` · ${batch.failedItems} lỗi` : ''} · {batchPct}%
                  </div>
                </div>

                <div className="row wrap" style={{ gap: 4 }}>
                  <button
                    className="btn sm"
                    title="Mở thư mục lưu"
                    onClick={() => void handleBatchAction(batch.id, 'open-folder')}
                  >
                    Thư mục
                  </button>
                  {batch.status === 'running' || batch.status === 'queued' ? (
                    <button
                      className="btn sm"
                      onClick={() => void handleBatchAction(batch.id, 'pause-all')}
                    >
                      Tạm dừng
                    </button>
                  ) : batch.status === 'paused' ? (
                    <button
                      className="btn sm primary"
                      onClick={() => void handleBatchAction(batch.id, 'resume-all')}
                    >
                      Tiếp tục
                    </button>
                  ) : null}
                  {batch.failedItems > 0 && (
                    <button
                      className="btn sm"
                      onClick={() => void handleBatchAction(batch.id, 'retry-failed')}
                    >
                      Thử lại lỗi
                    </button>
                  )}
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      await client.deleteBatch(batch.id);
                      onRefresh();
                    }}
                  >
                    Xóa
                  </button>
                </div>
              </div>

              {!collapsed && (
                <div className="col" style={{ gap: 6 }}>
                  {batchTasks.map((task) => {
                    const st = STATUS_LABELS[task.status] || { text: task.status, badge: 'gray' };
                    const isActive =
                      task.status === 'downloading' ||
                      task.status === 'merging' ||
                      task.status === 'postprocessing';
                    const needsCookies =
                      task.errorCode === 'BOT_CHECK' ||
                      task.errorCode === 'AGE_RESTRICTED' ||
                      task.errorCode === 'PRIVATE_VIDEO';

                    return (
                      <div key={task.id} className="item-row col" style={{ alignItems: 'stretch', gap: 6 }}>
                        <div className="row between" style={{ gap: 8 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="truncate" style={{ fontWeight: 600 }} title={task.title}>
                              {task.playlistIndex != null ? `${task.playlistIndex}. ` : ''}
                              {task.title}
                            </div>
                            <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
                              <span className={`badge ${st.badge}`}>{st.text}</span>
                              <span className="badge gray">
                                {task.mode === 'audio' ? task.container.toUpperCase() : `${task.options.videoQuality} ${task.container.toUpperCase()}`}
                              </span>
                              {isActive && task.speedBps ? (
                                <span className="muted">
                                  {formatBytes(task.speedBps)}/s
                                  {task.etaSec != null ? ` · ETA ${formatDuration(task.etaSec)}` : ''}
                                </span>
                              ) : null}
                              {task.totalBytes ? (
                                <span className="muted">
                                  {formatBytes(task.downloadedBytes)} / {formatBytes(task.totalBytes)}
                                </span>
                              ) : null}
                            </div>
                          </div>

                          <div className="row" style={{ gap: 4 }}>
                            {(isActive || task.status === 'queued') && (
                              <button
                                className="btn sm"
                                onClick={() => void handleTaskAction(task.id, 'pause')}
                              >
                                Dừng
                              </button>
                            )}
                            {task.status === 'paused' && (
                              <button
                                className="btn sm primary"
                                onClick={() => void handleTaskAction(task.id, 'resume')}
                              >
                                Tiếp
                              </button>
                            )}
                            {(task.status === 'failed' || task.status === 'cancelled') && (
                              <button
                                className="btn sm primary"
                                onClick={() => void handleTaskAction(task.id, 'retry')}
                              >
                                Thử lại
                              </button>
                            )}
                            {task.status === 'completed' && (
                              <button
                                className="btn sm"
                                onClick={() => void handleTaskAction(task.id, 'open-folder')}
                              >
                                Mở file
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="progress-track">
                          <div
                            className={`progress-fill ${task.status === 'completed' || task.status === 'skipped' ? 'done' : ''}`}
                            style={{ width: `${Math.min(100, Math.max(0, task.progressPct || 0))}%` }}
                          />
                        </div>

                        {task.errorMessage && (
                          <div className="row between wrap" style={{ gap: 6 }}>
                            <span style={{ color: '#fda4af', fontSize: 11 }}>{task.errorMessage}</span>
                            {needsCookies && (
                              <button className="btn sm" onClick={onGoSettings}>
                                Bật Cookies Chrome
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
};
