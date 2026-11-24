import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  isSafeSubpath,
  sanitizeSegment,
  type BatchRecord,
  type CreateDownloadRequest,
  type DownloadTaskRecord,
  type WsEvent,
} from '@tubevault/shared';
import type { EnginePaths } from '../config/paths.js';
import type { EngineStore } from '../db/repositories.js';
import type { DepsManager } from '../deps/manager.js';
import type { EngineLogger } from '../utils/logger.js';
import { killProcessTree } from '../utils/process-tree.js';
import { buildDownloadArgs, buildFormatSpec } from '../ytdlp/args-builder.js';
import type { CookiesStore } from '../ytdlp/cookies-store.js';
import { classifyYtdlpError, parseYtdlpStdoutLine } from '../ytdlp/progress-parser.js';

const MAX_AUTO_RETRIES = 2;

interface RunningTaskHandle {
  task: DownloadTaskRecord;
  child: ChildProcess;
  interruptedBy?: 'pause' | 'cancel';
  speedBps: number;
  lastProgressEmitAt: number;
  finalPath?: string;
}

export class DownloadQueueManager {
  private readonly running = new Map<string, RunningTaskHandle>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private pumping = false;
  private lastBatchLaunchAt = 0;

  constructor(
    private readonly paths: EnginePaths,
    private readonly store: EngineStore,
    private readonly deps: DepsManager,
    private readonly cookiesStore: CookiesStore,
    private readonly logger: EngineLogger,
    private readonly emitEvent: (event: WsEvent) => void
  ) {}

  enqueueBatch(req: CreateDownloadRequest): { batch: BatchRecord; tasks: DownloadTaskRecord[] } {
    const settings = this.store.getSettings();
    const baseDir = req.options.outputDir?.trim() || settings.downloadDir || this.paths.defaultDownloadDir;

    // Build clean organized output folder (Channel / Playlist / Custom subfolder)
    const dirSegments: string[] = [baseDir];
    if (req.options.subfolder && isSafeSubpath(req.options.subfolder)) {
      dirSegments.push(
        ...req.options.subfolder
          .split(/[\\/]+/)
          .filter(Boolean)
          .map((s) => sanitizeSegment(s))
      );
    } else {
      if (req.sourceType === 'channel' && settings.subfolderByChannel) {
        dirSegments.push(sanitizeSegment(req.title || req.uploader || 'Channel'));
      } else if ((req.sourceType === 'playlist' || req.sourceType === 'album') && settings.subfolderByPlaylist) {
        if (req.sourceType === 'album' && req.uploader) {
          dirSegments.push(sanitizeSegment(req.uploader));
        }
        dirSegments.push(sanitizeSegment(req.title || 'Playlist'));
      }
    }

    const outputDir = path.resolve(...dirSegments);
    fs.mkdirSync(outputDir, { recursive: true });

    let trackedSourceId: string | null = null;
    if (req.trackSource && (req.sourceType === 'channel' || req.sourceType === 'playlist' || req.sourceType === 'album')) {
      const tracked = this.store.upsertTrackedSource({
        sourceType: req.sourceType,
        sourceKey: req.sourceKey,
        title: req.title,
        url: req.sourceUrl,
        thumbnailUrl: req.thumbnailUrl,
        channelTabs: req.channelTabs,
        presetOptions: req.options,
      });
      trackedSourceId = tracked.id;
    }

    const { formatSpec, container } = buildFormatSpec(req.options);

    let skippedCount = 0;
    const prepared = req.items.map((item, idx) => {
      const alreadyDone = req.options.skipDownloaded && this.store.isVideoDownloaded(item.videoId, req.options.mode);
      if (alreadyDone) skippedCount++;
      return { item, idx, alreadyDone };
    });

    const batch = this.store.createBatch({
      sourceType: req.sourceType,
      trackedSourceId,
      sourceUrl: req.sourceUrl,
      title: req.title,
      outputDir,
      options: { ...req.options, outputDir },
      totalItems: prepared.length,
      skippedItems: skippedCount,
    });

    const tasks: DownloadTaskRecord[] = [];
    for (const entry of prepared) {
      const task = this.store.createTask({
        batchId: batch.id,
        videoId: entry.item.videoId,
        url: entry.item.url,
        title: entry.item.title,
        uploader: entry.item.uploader || req.uploader || null,
        album: entry.item.album || (req.sourceType === 'album' ? req.title : null),
        thumbnailUrl: entry.item.thumbnailUrl || null,
        durationSec: entry.item.durationSec ?? null,
        playlistIndex: entry.item.playlistIndex ?? (req.sourceType === 'single' ? null : entry.idx + 1),
        mode: req.options.mode,
        formatSpec,
        container,
        options: {
          ...req.options,
          outputDir,
          numberPrefix: req.options.numberPrefix ?? req.sourceType !== 'single',
        },
        status: entry.alreadyDone ? 'skipped' : 'queued',
      });
      tasks.push(task);
      this.emitEvent({ type: 'task:created', payload: { task } });
    }

    const updatedBatch = this.store.recomputeBatchStats(batch.id) || batch;
    this.emitBatchUpdate(updatedBatch);
    this.emitQueueSummary();
    void this.pump();

    return { batch: updatedBatch, tasks };
  }

  private clearRetryTimer(taskId: string): void {
    const timer = this.retryTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(taskId);
    }
  }

  async pauseTask(taskId: string): Promise<DownloadTaskRecord | null> {
    this.clearRetryTimer(taskId);
    const handle = this.running.get(taskId);
    if (handle) {
      handle.interruptedBy = 'pause';
      if (handle.child.pid) {
        await killProcessTree(handle.child.pid);
      }
      return this.store.getTask(taskId);
    }

    const task = this.store.getTask(taskId);
    if (!task) return null;
    if (task.status === 'queued') {
      const updated = this.store.updateTaskStatus(taskId, 'paused');
      if (updated) {
        this.emitTaskStatus(updated);
        this.refreshBatch(updated.batchId);
        this.emitQueueSummary();
      }
      return updated;
    }
    return task;
  }

  resumeTask(taskId: string): DownloadTaskRecord | null {
    this.clearRetryTimer(taskId);
    const task = this.store.getTask(taskId);
    if (!task) return null;
    if (task.status === 'paused' || task.status === 'failed' || task.status === 'cancelled') {
      const updated = this.store.updateTaskStatus(taskId, 'queued', {
        errorCode: null,
        errorMessage: null,
      });
      if (updated) {
        this.emitTaskStatus(updated);
        this.refreshBatch(updated.batchId);
        this.emitQueueSummary();
        void this.pump();
      }
      return updated;
    }
    return task;
  }

  retryTask(taskId: string): DownloadTaskRecord | null {
    this.clearRetryTimer(taskId);
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const updated = this.store.updateTaskStatus(taskId, 'queued', {
      progressPct: 0,
      phase: null,
      errorCode: null,
      errorMessage: null,
      incrementRetry: true,
    });
    if (updated) {
      this.emitTaskStatus(updated);
      this.refreshBatch(updated.batchId);
      this.emitQueueSummary();
      void this.pump();
    }
    return updated;
  }

  async cancelTask(taskId: string): Promise<DownloadTaskRecord | null> {
    this.clearRetryTimer(taskId);
    const handle = this.running.get(taskId);
    if (handle) {
      handle.interruptedBy = 'cancel';
      if (handle.child.pid) {
        await killProcessTree(handle.child.pid);
      }
      return this.store.getTask(taskId);
    }

    const task = this.store.getTask(taskId);
    if (!task) return null;
    if (task.status !== 'completed') {
      const updated = this.store.updateTaskStatus(taskId, 'cancelled');
      if (updated) {
        this.emitTaskStatus(updated);
        this.refreshBatch(updated.batchId);
        this.emitQueueSummary();
      }
      return updated;
    }
    return task;
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const task = this.store.getTask(taskId);
    if (!task) return false;
    await this.cancelTask(taskId);
    const deleted = this.store.deleteTask(taskId);
    this.refreshBatch(task.batchId);
    this.emitQueueSummary();
    return deleted;
  }

  async pauseBatch(batchId: string): Promise<BatchRecord | null> {
    const tasks = this.store.listTasks({ batchId, limit: 10_000 });
    for (const t of tasks) {
      if (t.status === 'queued' || t.status === 'downloading' || t.status === 'merging' || t.status === 'postprocessing') {
        await this.pauseTask(t.id);
      }
    }
    return this.store.getBatch(batchId);
  }

  resumeBatch(batchId: string): BatchRecord | null {
    const tasks = this.store.listTasks({ batchId, limit: 10_000 });
    for (const t of tasks) {
      if (t.status === 'paused') {
        this.resumeTask(t.id);
      }
    }
    return this.store.getBatch(batchId);
  }

  retryFailedBatch(batchId: string): BatchRecord | null {
    const tasks = this.store.listTasks({ batchId, limit: 10_000 });
    for (const t of tasks) {
      if (t.status === 'failed' || t.status === 'cancelled') {
        this.retryTask(t.id);
      }
    }
    return this.store.getBatch(batchId);
  }

  async cancelBatch(batchId: string): Promise<BatchRecord | null> {
    const tasks = this.store.listTasks({ batchId, limit: 10_000 });
    for (const t of tasks) {
      if (t.status !== 'completed' && t.status !== 'skipped') {
        await this.cancelTask(t.id);
      }
    }
    return this.store.getBatch(batchId);
  }

  async shutdownAll(): Promise<void> {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    const handles = [...this.running.values()];
    for (const h of handles) {
      h.interruptedBy = 'pause';
      if (h.child.pid) {
        await killProcessTree(h.child.pid);
      }
    }
  }

  getSummary(): { activeCount: number; queuedCount: number; totalSpeedBps: number } {
    const queued = this.store.listTasks({ status: 'queued', limit: 10_000 }).length;
    let totalSpeedBps = 0;
    for (const h of this.running.values()) {
      totalSpeedBps += h.speedBps || 0;
    }
    return {
      activeCount: this.running.size,
      queuedCount: queued,
      totalSpeedBps,
    };
  }

  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;

    try {
      const settings = this.store.getSettings();
      const maxConcurrency = Math.max(1, Math.min(6, settings.maxConcurrency || 2));

      while (this.running.size < maxConcurrency) {
        const nextTasks = this.store.getNextQueuedTasks(1);
        const next = nextTasks[0];
        if (!next) break;

        // Randomized anti-rate-limit spacing for multi-item batches
        const batch = this.store.getBatch(next.batchId);
        if (batch && batch.totalItems > 1 && this.lastBatchLaunchAt > 0) {
          const minMs = Math.max(0, settings.sleepMinSec || 0) * 1000;
          const maxMs = Math.max(minMs, (settings.sleepMaxSec || 0) * 1000);
          if (maxMs > 0) {
            const delayMs = minMs + Math.random() * (maxMs - minMs);
            const elapsed = Date.now() - this.lastBatchLaunchAt;
            if (elapsed < delayMs) {
              await new Promise((r) => setTimeout(r, delayMs - elapsed));
            }
          }
        }

        // Re-check task status after sleep (user might have paused/cancelled it)
        const latest = this.store.getTask(next.id);
        if (!latest || latest.status !== 'queued') continue;

        this.lastBatchLaunchAt = Date.now();
        this.startTask(latest, batch);
      }
    } finally {
      this.pumping = false;
      this.emitQueueSummary();
    }
  }

  private startTask(task: DownloadTaskRecord, batch: BatchRecord | null): void {
    const ytdlpBin = this.deps.resolveYtdlpBinary();
    const ffmpegBin = this.deps.resolveFfmpegBinary();

    if (!ytdlpBin || !ffmpegBin) {
      const updated = this.store.updateTaskStatus(task.id, 'failed', {
        errorCode: 'FFMPEG_MISSING',
        errorMessage: 'Chưa cài đầy đủ yt-dlp.exe và ffmpeg.exe. Vào Cài đặt để tải tự động.',
      });
      if (updated) {
        this.emitTaskStatus(updated);
        this.refreshBatch(updated.batchId);
      }
      return;
    }

    const outputDir = task.options.outputDir || batch?.outputDir || this.paths.defaultDownloadDir;
    fs.mkdirSync(outputDir, { recursive: true });

    const useCookies = task.options.useCookies ?? this.store.getSettings().useCookies;
    const tempCookie = useCookies ? this.cookiesStore.acquireTempFile() : null;

    const args = buildDownloadArgs({
      task,
      outputDir,
      ffmpegDir: this.paths.binDir,
      nodePath: process.execPath,
      cookiesFilePath: tempCookie?.filePath,
    });

    const started = this.store.updateTaskStatus(task.id, 'downloading', {
      phase: task.mode === 'audio' ? 'audio' : 'video',
      errorCode: null,
      errorMessage: null,
    });
    if (started) {
      this.emitTaskStatus(started);
      this.refreshBatch(task.batchId);
    }

    const child = spawn(ytdlpBin, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const handle: RunningTaskHandle = {
      task,
      child,
      speedBps: 0,
      lastProgressEmitAt: 0,
    };
    this.running.set(task.id, handle);
    this.emitQueueSummary();

    let stdoutBuffer = '';
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const parsed = parseYtdlpStdoutLine(line);
        if (!parsed) continue;

        if (parsed.kind === 'final' && parsed.finalPath) {
          handle.finalPath = parsed.finalPath;
          continue;
        }

        if (parsed.kind === 'postprocess') {
          handle.speedBps = 0;
          const nextStatus = parsed.phase === 'merging' ? 'merging' : 'postprocessing';
          const updated = this.store.updateTaskStatus(task.id, nextStatus, {
            phase: parsed.phase || nextStatus,
            progressPct: 99,
          });
          if (updated) this.emitTaskStatus(updated);
          continue;
        }

        if (parsed.kind === 'progress') {
          handle.speedBps = parsed.speedBps || 0;
          const now = Date.now();
          if (now - handle.lastProgressEmitAt >= 250 || parsed.status === 'finished') {
            handle.lastProgressEmitAt = now;
            this.store.updateTaskProgress(task.id, {
              status: 'downloading',
              phase: parsed.phase || 'video',
              progressPct: parsed.progressPct ?? 0,
              speedBps: parsed.speedBps ?? null,
              etaSec: parsed.etaSec ?? null,
              downloadedBytes: parsed.downloadedBytes ?? 0,
              totalBytes: parsed.totalBytes ?? null,
            });
            this.emitEvent({
              type: 'task:progress',
              payload: {
                taskId: task.id,
                batchId: task.batchId,
                phase: parsed.phase || 'video',
                progressPct: parsed.progressPct ?? 0,
                speedBps: parsed.speedBps,
                etaSec: parsed.etaSec,
                downloadedBytes: parsed.downloadedBytes,
                totalBytes: parsed.totalBytes,
              },
            });
            this.emitQueueSummary();
          }
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      this.finishTask(task, handle, -1, err.message, tempCookie?.cleanup);
    });

    child.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      this.finishTask(task, handle, code ?? -1, stderr, tempCookie?.cleanup);
    });
  }

  private finishTask(
    task: DownloadTaskRecord,
    handle: RunningTaskHandle,
    exitCode: number,
    stderr: string,
    cleanupCookie?: () => void
  ): void {
    this.running.delete(task.id);
    cleanupCookie?.();

    if (handle.interruptedBy === 'pause') {
      const updated = this.store.updateTaskStatus(task.id, 'paused');
      if (updated) this.emitTaskStatus(updated);
      this.refreshBatch(task.batchId);
      this.emitQueueSummary();
      void this.pump();
      return;
    }

    if (handle.interruptedBy === 'cancel') {
      const updated = this.store.updateTaskStatus(task.id, 'cancelled');
      if (updated) this.emitTaskStatus(updated);
      this.refreshBatch(task.batchId);
      this.emitQueueSummary();
      void this.pump();
      return;
    }

    if (exitCode === 0) {
      const outputPath = handle.finalPath || null;
      let fileSizeBytes: number | null = null;
      if (outputPath && fs.existsSync(outputPath)) {
        try {
          fileSizeBytes = fs.statSync(outputPath).size;
        } catch {
          // ignore
        }
      }

      const batch = this.store.getBatch(task.batchId);
      this.store.recordArchive({
        videoId: task.videoId,
        mode: task.mode,
        sourceKey: batch?.trackedSourceId || null,
        title: task.title,
        outputPath,
        fileSizeBytes,
      });

      if (batch?.trackedSourceId) {
        this.store.touchTrackedSourceSynced(batch.trackedSourceId, 1);
      }

      const updated = this.store.updateTaskStatus(task.id, 'completed', {
        phase: 'done',
        progressPct: 100,
        outputPath,
        errorCode: null,
        errorMessage: null,
      });
      this.logger.info('queue', `Completed [${task.videoId}] "${task.title}" -> ${outputPath || '(unknown path)'}`);
      if (updated) this.emitTaskStatus(updated);
    } else {
      const classified = classifyYtdlpError(stderr);
      const latestTask = this.store.getTask(task.id) || task;
      const isTransient = classified.code === 'NETWORK' || classified.code === 'RATE_LIMIT';

      if (isTransient && latestTask.retryCount < MAX_AUTO_RETRIES) {
        const nextAttempt = latestTask.retryCount + 1;
        const delaySec =
          classified.code === 'RATE_LIMIT' ? (nextAttempt === 1 ? 15 : 45) : nextAttempt === 1 ? 5 : 15;

        this.logger.warn(
          'queue',
          `Transient error (${classified.code}) on [${task.videoId}] "${task.title}" — auto-retrying ${nextAttempt}/${MAX_AUTO_RETRIES} in ${delaySec}s`
        );

        const pausedForRetry = this.store.updateTaskStatus(task.id, 'paused', {
          errorCode: classified.code,
          errorMessage: `${classified.message} (Tự động thử lại lần ${nextAttempt}/${MAX_AUTO_RETRIES} sau ${delaySec} giây...)`,
          incrementRetry: true,
        });
        if (pausedForRetry) this.emitTaskStatus(pausedForRetry);

        const timer = setTimeout(() => {
          this.retryTimers.delete(task.id);
          const current = this.store.getTask(task.id);
          if (!current || current.status !== 'paused') return;
          const requeued = this.store.updateTaskStatus(task.id, 'queued', {
            errorCode: null,
            errorMessage: null,
          });
          if (requeued) {
            this.emitTaskStatus(requeued);
            this.refreshBatch(requeued.batchId);
            this.emitQueueSummary();
            void this.pump();
          }
        }, delaySec * 1000);
        this.retryTimers.set(task.id, timer);
      } else {
        this.logger.error('queue', `Failed [${task.videoId}] "${task.title}" (${classified.code}): ${classified.message}`);
        const updated = this.store.updateTaskStatus(task.id, 'failed', {
          errorCode: classified.code,
          errorMessage: classified.message,
        });
        if (updated) this.emitTaskStatus(updated);
      }
    }

    this.refreshBatch(task.batchId);
    this.emitQueueSummary();
    void this.pump();
  }

  private emitTaskStatus(task: DownloadTaskRecord): void {
    this.emitEvent({
      type: 'task:status',
      payload: {
        taskId: task.id,
        batchId: task.batchId,
        status: task.status,
        phase: task.phase,
        outputPath: task.outputPath,
        errorCode: task.errorCode,
        errorMessage: task.errorMessage,
      },
    });
  }

  private refreshBatch(batchId: string): void {
    const batch = this.store.recomputeBatchStats(batchId);
    if (batch) this.emitBatchUpdate(batch);
  }

  private emitBatchUpdate(batch: BatchRecord): void {
    this.emitEvent({
      type: 'batch:updated',
      payload: {
        batchId: batch.id,
        status: batch.status,
        completedItems: batch.completedItems,
        failedItems: batch.failedItems,
        skippedItems: batch.skippedItems,
        totalItems: batch.totalItems,
      },
    });
  }

  private emitQueueSummary(): void {
    this.emitEvent({
      type: 'queue:summary',
      payload: this.getSummary(),
    });
  }
}
