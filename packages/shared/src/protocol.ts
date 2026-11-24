import type { BatchStatus, DownloadTaskRecord, TaskStatus } from './api-types.js';
import type { ChannelTab } from './youtube-url.js';

export const APP_NAME = 'TubeVault';
export const APP_VERSION = '1.0.0';
export const NATIVE_HOST_NAME = 'com.tubevault.host';
export const DEFAULT_ENGINE_PORT = 17890;

export type NativeRequest =
  | { action: 'ping' }
  | { action: 'ensure_server' }
  | { action: 'shutdown' };

export interface NativeResponse {
  ok: boolean;
  error?: string;
  port?: number;
  token?: string;
  pid?: number;
  running?: boolean;
  engineVersion?: string;
}

export type WsEvent =
  | {
      type: 'engine:ready';
      payload: {
        version: string;
        port: number;
        ytdlpInstalled: boolean;
        ffmpegInstalled: boolean;
      };
    }
  | {
      type: 'deps:progress';
      payload: {
        target: 'yt-dlp' | 'ffmpeg';
        status: 'downloading' | 'extracting' | 'done' | 'error';
        pct: number;
        downloadedBytes?: number;
        totalBytes?: number;
        message?: string;
      };
    }
  | {
      type: 'analyze:progress';
      payload: {
        jobId: string;
        tab?: ChannelTab;
        scannedCount: number;
        message: string;
      };
    }
  | {
      type: 'task:created';
      payload: {
        task: DownloadTaskRecord;
      };
    }
  | {
      type: 'task:progress';
      payload: {
        taskId: string;
        batchId: string;
        phase: string;
        progressPct: number;
        speedBps?: number;
        etaSec?: number;
        downloadedBytes?: number;
        totalBytes?: number;
      };
    }
  | {
      type: 'task:status';
      payload: {
        taskId: string;
        batchId: string;
        status: TaskStatus;
        phase?: string | null;
        outputPath?: string | null;
        errorCode?: string | null;
        errorMessage?: string | null;
      };
    }
  | {
      type: 'batch:updated';
      payload: {
        batchId: string;
        status: BatchStatus;
        completedItems: number;
        failedItems: number;
        skippedItems: number;
        totalItems: number;
      };
    }
  | {
      type: 'queue:summary';
      payload: {
        activeCount: number;
        queuedCount: number;
        totalSpeedBps: number;
      };
    };

export type ExtensionMessage =
  | { type: 'OPEN_SIDEPANEL_WITH_URL'; url: string; forcePlaylist?: boolean }
  | { type: 'GET_ENGINE_CONNECTION' }
  | { type: 'SYNC_YOUTUBE_COOKIES' }
  | { type: 'CHECK_COOKIES_PERMISSION' }
  | { type: 'GET_ACTIVE_TAB_URL' }
  | { type: 'PENDING_URL_AVAILABLE'; url: string; forcePlaylist?: boolean };
