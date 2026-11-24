import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AppSettings,
  ArchiveRecord,
  BatchRecord,
  BatchStatus,
  ChannelTab,
  DownloadMode,
  DownloadOptions,
  DownloadTaskRecord,
  TaskStatus,
  TrackedSourceRecord,
  YouTubeSourceType,
} from '@tubevault/shared';

export function getDefaultSettings(defaultDownloadDir: string): AppSettings {
  return {
    downloadDir: defaultDownloadDir,
    maxConcurrency: 2,
    sleepMinSec: 2,
    sleepMaxSec: 5,
    defaultVideoQuality: '1080p',
    defaultContainer: 'mp4',
    defaultAudioFormat: 'mp3',
    defaultAudioBitrate: '320k',
    embedMetadata: true,
    embedThumbnail: true,
    squareAlbumCover: true,
    subfolderByChannel: true,
    subfolderByPlaylist: true,
    useCookies: false,
    autoCheckYtdlpUpdate: true,
  };
}

export class EngineStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly defaultDownloadDir: string
  ) {}

  // ======================== SETTINGS ========================

  getSettings(): AppSettings {
    const defaults = getDefaultSettings(this.defaultDownloadDir);
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as Array<{
      key: string;
      value_json: string;
    }>;
    const merged: Record<string, unknown> = { ...defaults };
    for (const row of rows) {
      if (row.key in defaults) {
        try {
          merged[row.key] = JSON.parse(row.value_json);
        } catch {
          // ignore malformed setting
        }
      }
    }
    return merged as unknown as AppSettings;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const defaults = getDefaultSettings(this.defaultDownloadDir);
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    );
    for (const [key, val] of Object.entries(patch)) {
      if (key in defaults && val !== undefined) {
        stmt.run(key, JSON.stringify(val), now);
      }
    }
    return this.getSettings();
  }

  getMeta<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(`_meta:${key}`) as
      | { value_json: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  setMeta(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(`_meta:${key}`, JSON.stringify(value), Date.now());
  }

  // ======================== ARCHIVE ========================

  isVideoDownloaded(videoId: string, mode: DownloadMode): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM downloaded_archive WHERE video_id = ? AND mode = ? LIMIT 1')
      .get(videoId, mode);
    return Boolean(row);
  }

  getDownloadedMap(videoIds: string[]): Map<string, { video: boolean; audio: boolean }> {
    const map = new Map<string, { video: boolean; audio: boolean }>();
    if (videoIds.length === 0) return map;

    const chunkSize = 400;
    for (let i = 0; i < videoIds.length; i += chunkSize) {
      const slice = videoIds.slice(i, i + chunkSize);
      const placeholders = slice.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT video_id, mode FROM downloaded_archive WHERE video_id IN (${placeholders})`)
        .all(...slice) as Array<{ video_id: string; mode: DownloadMode }>;

      for (const r of rows) {
        const entry = map.get(r.video_id) || { video: false, audio: false };
        if (r.mode === 'video') entry.video = true;
        if (r.mode === 'audio') entry.audio = true;
        map.set(r.video_id, entry);
      }
    }
    return map;
  }

  recordArchive(params: {
    videoId: string;
    mode: DownloadMode;
    sourceKey?: string | null;
    title?: string | null;
    outputPath?: string | null;
    fileSizeBytes?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO downloaded_archive (video_id, mode, source_key, title, output_path, file_size_bytes, downloaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(video_id, mode) DO UPDATE SET
           output_path = excluded.output_path,
           file_size_bytes = excluded.file_size_bytes,
           downloaded_at = excluded.downloaded_at`
      )
      .run(
        params.videoId,
        params.mode,
        params.sourceKey ?? null,
        params.title ?? null,
        params.outputPath ?? null,
        params.fileSizeBytes ?? null,
        Date.now()
      );
  }

  listArchive(limit = 100, offset = 0): ArchiveRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, video_id, mode, source_key, title, output_path, file_size_bytes, downloaded_at
         FROM downloaded_archive ORDER BY downloaded_at DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: Number(r.id),
      videoId: String(r.video_id),
      mode: r.mode as DownloadMode,
      sourceKey: (r.source_key as string) ?? null,
      title: (r.title as string) ?? null,
      outputPath: (r.output_path as string) ?? null,
      fileSizeBytes: r.file_size_bytes != null ? Number(r.file_size_bytes) : null,
      downloadedAt: Number(r.downloaded_at),
    }));
  }

  // ======================== TRACKED SOURCES ========================

  upsertTrackedSource(params: {
    sourceType: 'channel' | 'playlist' | 'album';
    sourceKey: string;
    title: string;
    url: string;
    thumbnailUrl?: string | null;
    channelTabs?: ChannelTab[];
    presetOptions: DownloadOptions;
  }): TrackedSourceRecord {
    const existing = this.db
      .prepare('SELECT id FROM tracked_sources WHERE source_key = ?')
      .get(params.sourceKey) as { id: string } | undefined;

    const now = Date.now();
    const id = existing?.id || crypto.randomUUID();

    if (existing) {
      this.db
        .prepare(
          `UPDATE tracked_sources
           SET title = ?, url = ?, thumbnail_url = ?, channel_tabs_json = ?, preset_options_json = ?, last_synced_at = ?
           WHERE id = ?`
        )
        .run(
          params.title,
          params.url,
          params.thumbnailUrl ?? null,
          params.channelTabs ? JSON.stringify(params.channelTabs) : null,
          JSON.stringify(params.presetOptions),
          now,
          id
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO tracked_sources (id, source_type, source_key, title, url, thumbnail_url, channel_tabs_json, preset_options_json, total_synced_count, last_synced_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .run(
          id,
          params.sourceType,
          params.sourceKey,
          params.title,
          params.url,
          params.thumbnailUrl ?? null,
          params.channelTabs ? JSON.stringify(params.channelTabs) : null,
          JSON.stringify(params.presetOptions),
          now,
          now
        );
    }

    return this.getTrackedSource(id)!;
  }

  getTrackedSource(id: string): TrackedSourceRecord | null {
    const row = this.db.prepare('SELECT * FROM tracked_sources WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapTrackedSource(row) : null;
  }

  listTrackedSources(): TrackedSourceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tracked_sources ORDER BY COALESCE(last_synced_at, created_at) DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTrackedSource(r));
  }

  touchTrackedSourceSynced(id: string, addedCount: number): void {
    this.db
      .prepare(
        `UPDATE tracked_sources
         SET total_synced_count = total_synced_count + ?, last_synced_at = ?
         WHERE id = ?`
      )
      .run(addedCount, Date.now(), id);
  }

  deleteTrackedSource(id: string): boolean {
    const res = this.db.prepare('DELETE FROM tracked_sources WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  private mapTrackedSource(r: Record<string, unknown>): TrackedSourceRecord {
    return {
      id: String(r.id),
      sourceType: r.source_type as 'channel' | 'playlist' | 'album',
      sourceKey: String(r.source_key),
      title: String(r.title),
      url: String(r.url),
      thumbnailUrl: (r.thumbnail_url as string) ?? null,
      channelTabs: r.channel_tabs_json ? (JSON.parse(String(r.channel_tabs_json)) as ChannelTab[]) : undefined,
      presetOptions: JSON.parse(String(r.preset_options_json)) as DownloadOptions,
      totalSyncedCount: Number(r.total_synced_count),
      lastSyncedAt: r.last_synced_at != null ? Number(r.last_synced_at) : null,
      createdAt: Number(r.created_at),
    };
  }

  // ======================== BATCHES ========================

  createBatch(params: {
    sourceType: YouTubeSourceType;
    trackedSourceId?: string | null;
    sourceUrl: string;
    title: string;
    outputDir: string;
    options: DownloadOptions;
    totalItems: number;
    skippedItems: number;
  }): BatchRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    const status: BatchStatus =
      params.totalItems > 0 && params.totalItems === params.skippedItems ? 'completed' : 'queued';

    this.db
      .prepare(
        `INSERT INTO batches (id, source_type, tracked_source_id, source_url, title, output_dir, options_json, total_items, completed_items, failed_items, skipped_items, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.sourceType,
        params.trackedSourceId ?? null,
        params.sourceUrl,
        params.title,
        params.outputDir,
        JSON.stringify(params.options),
        params.totalItems,
        params.skippedItems,
        status,
        now,
        now
      );

    return this.getBatch(id)!;
  }

  getBatch(id: string): BatchRecord | null {
    const r = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapBatch(r) : null;
  }

  listBatches(limit = 50): BatchRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM batches ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapBatch(r));
  }

  recomputeBatchStats(batchId: string): BatchRecord | null {
    const counts = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
           SUM(CASE WHEN status IN ('downloading', 'merging', 'postprocessing') THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
         FROM download_tasks WHERE batch_id = ?`
      )
      .get(batchId) as Record<string, number | null> | undefined;

    if (!counts) return null;

    const total = Number(counts.total || 0);
    const completed = Number(counts.completed || 0);
    const failed = Number(counts.failed || 0);
    const skipped = Number(counts.skipped || 0);
    const active = Number(counts.active || 0);
    const queued = Number(counts.queued || 0);
    const paused = Number(counts.paused || 0);
    const cancelled = Number(counts.cancelled || 0);

    let status: BatchStatus = 'queued';
    if (active > 0) status = 'running';
    else if (queued > 0) status = 'queued';
    else if (paused > 0) status = 'paused';
    else if (total > 0 && cancelled === total) status = 'cancelled';
    else if (completed + skipped === total) status = 'completed';
    else if (failed > 0 || cancelled > 0) status = 'partial';

    this.db
      .prepare(
        `UPDATE batches
         SET total_items = ?, completed_items = ?, failed_items = ?, skipped_items = ?, status = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(total, completed, failed, skipped, status, Date.now(), batchId);

    return this.getBatch(batchId);
  }

  deleteBatch(batchId: string): boolean {
    const res = this.db.prepare('DELETE FROM batches WHERE id = ?').run(batchId);
    return Number(res.changes) > 0;
  }

  private mapBatch(r: Record<string, unknown>): BatchRecord {
    return {
      id: String(r.id),
      sourceType: r.source_type as YouTubeSourceType,
      trackedSourceId: (r.tracked_source_id as string) ?? null,
      sourceUrl: String(r.source_url),
      title: String(r.title),
      outputDir: String(r.output_dir),
      options: JSON.parse(String(r.options_json)) as DownloadOptions,
      totalItems: Number(r.total_items),
      completedItems: Number(r.completed_items),
      failedItems: Number(r.failed_items),
      skippedItems: Number(r.skipped_items),
      status: r.status as BatchStatus,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  // ======================== DOWNLOAD TASKS ========================

  createTask(params: {
    batchId: string;
    videoId: string;
    url: string;
    title: string;
    uploader?: string | null;
    album?: string | null;
    thumbnailUrl?: string | null;
    durationSec?: number | null;
    playlistIndex?: number | null;
    mode: DownloadMode;
    formatSpec: string;
    container: string;
    options: DownloadOptions;
    status?: TaskStatus;
    priority?: number;
  }): DownloadTaskRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    const status: TaskStatus = params.status || 'queued';

    this.db
      .prepare(
        `INSERT INTO download_tasks (
           id, batch_id, video_id, url, title, uploader, album, thumbnail_url,
           duration_sec, playlist_index, mode, format_spec, container, options_json,
           status, progress_pct, downloaded_bytes, retry_count, priority, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.batchId,
        params.videoId,
        params.url,
        params.title,
        params.uploader ?? null,
        params.album ?? null,
        params.thumbnailUrl ?? null,
        params.durationSec ?? null,
        params.playlistIndex ?? null,
        params.mode,
        params.formatSpec,
        params.container,
        JSON.stringify(params.options),
        status,
        status === 'skipped' ? 100 : 0,
        params.priority ?? 0,
        now,
        now,
        status === 'skipped' ? now : null
      );

    return this.getTask(id)!;
  }

  getTask(id: string): DownloadTaskRecord | null {
    const r = this.db.prepare('SELECT * FROM download_tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapTask(r) : null;
  }

  listTasks(filters?: { status?: TaskStatus; batchId?: string; limit?: number; offset?: number }): DownloadTaskRecord[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];

    if (filters?.status) {
      clauses.push('status = ?');
      args.push(filters.status);
    }
    if (filters?.batchId) {
      clauses.push('batch_id = ?');
      args.push(filters.batchId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filters?.limit ?? 200;
    const offset = filters?.offset ?? 0;

    const rows = this.db
      .prepare(
        `SELECT * FROM download_tasks ${where}
         ORDER BY
           CASE status
             WHEN 'downloading' THEN 0
             WHEN 'merging' THEN 1
             WHEN 'postprocessing' THEN 2
             WHEN 'queued' THEN 3
             WHEN 'paused' THEN 4
             WHEN 'failed' THEN 5
             ELSE 6
           END ASC,
           created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...args, limit, offset) as Array<Record<string, unknown>>;

    return rows.map((r) => this.mapTask(r));
  }

  getNextQueuedTasks(limit: number): DownloadTaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM download_tasks
         WHERE status = 'queued'
         ORDER BY priority DESC, created_at ASC
         LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTask(r));
  }

  updateTaskProgress(
    id: string,
    patch: {
      status?: TaskStatus;
      phase?: string | null;
      progressPct?: number;
      speedBps?: number | null;
      etaSec?: number | null;
      downloadedBytes?: number;
      totalBytes?: number | null;
    }
  ): void {
    const sets: string[] = ['updated_at = ?'];
    const args: Array<string | number | null> = [Date.now()];

    if (patch.status !== undefined) {
      sets.push('status = ?');
      args.push(patch.status);
    }
    if (patch.phase !== undefined) {
      sets.push('phase = ?');
      args.push(patch.phase);
    }
    if (patch.progressPct !== undefined) {
      sets.push('progress_pct = ?');
      args.push(patch.progressPct);
    }
    if (patch.speedBps !== undefined) {
      sets.push('speed_bps = ?');
      args.push(patch.speedBps);
    }
    if (patch.etaSec !== undefined) {
      sets.push('eta_sec = ?');
      args.push(patch.etaSec);
    }
    if (patch.downloadedBytes !== undefined) {
      sets.push('downloaded_bytes = ?');
      args.push(patch.downloadedBytes);
    }
    if (patch.totalBytes !== undefined) {
      sets.push('total_bytes = ?');
      args.push(patch.totalBytes);
    }

    args.push(id);
    this.db.prepare(`UPDATE download_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  updateTaskStatus(
    id: string,
    status: TaskStatus,
    extra?: {
      phase?: string | null;
      progressPct?: number;
      outputPath?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      incrementRetry?: boolean;
    }
  ): DownloadTaskRecord | null {
    const now = Date.now();
    const sets = ['status = ?', 'updated_at = ?'];
    const args: Array<string | number | null> = [status, now];

    if (extra?.phase !== undefined) {
      sets.push('phase = ?');
      args.push(extra.phase);
    }
    if (extra?.progressPct !== undefined) {
      sets.push('progress_pct = ?');
      args.push(extra.progressPct);
    }
    if (extra?.outputPath !== undefined) {
      sets.push('output_path = ?');
      args.push(extra.outputPath);
    }
    if (extra?.errorCode !== undefined) {
      sets.push('error_code = ?');
      args.push(extra.errorCode);
    }
    if (extra?.errorMessage !== undefined) {
      sets.push('error_message = ?');
      args.push(extra.errorMessage);
    }
    if (extra?.incrementRetry) {
      sets.push('retry_count = retry_count + 1');
    }
    if (status === 'completed') {
      sets.push('completed_at = ?', 'progress_pct = 100', 'speed_bps = NULL', 'eta_sec = 0');
      args.push(now);
    } else if (status === 'paused' || status === 'cancelled' || status === 'failed') {
      sets.push('speed_bps = NULL', 'eta_sec = NULL');
    }

    args.push(id);
    this.db.prepare(`UPDATE download_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    const res = this.db.prepare('DELETE FROM download_tasks WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  private mapTask(r: Record<string, unknown>): DownloadTaskRecord {
    return {
      id: String(r.id),
      batchId: String(r.batch_id),
      videoId: String(r.video_id),
      url: String(r.url),
      title: String(r.title),
      uploader: (r.uploader as string) ?? null,
      album: (r.album as string) ?? null,
      thumbnailUrl: (r.thumbnail_url as string) ?? null,
      durationSec: r.duration_sec != null ? Number(r.duration_sec) : null,
      playlistIndex: r.playlist_index != null ? Number(r.playlist_index) : null,
      mode: r.mode as DownloadMode,
      formatSpec: String(r.format_spec),
      container: String(r.container),
      options: JSON.parse(String(r.options_json)) as DownloadOptions,
      status: r.status as TaskStatus,
      phase: (r.phase as string) ?? null,
      progressPct: Number(r.progress_pct || 0),
      speedBps: r.speed_bps != null ? Number(r.speed_bps) : null,
      etaSec: r.eta_sec != null ? Number(r.eta_sec) : null,
      downloadedBytes: Number(r.downloaded_bytes || 0),
      totalBytes: r.total_bytes != null ? Number(r.total_bytes) : null,
      outputPath: (r.output_path as string) ?? null,
      errorCode: (r.error_code as string) ?? null,
      errorMessage: (r.error_message as string) ?? null,
      retryCount: Number(r.retry_count || 0),
      priority: Number(r.priority || 0),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      completedAt: r.completed_at != null ? Number(r.completed_at) : null,
    };
  }
}
