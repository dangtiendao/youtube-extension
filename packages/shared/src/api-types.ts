import type { ChannelTab, YouTubeSourceType } from './youtube-url.js';

export type DownloadMode = 'video' | 'audio';
export type VideoQuality = 'best' | '2160p' | '1440p' | '1080p' | '720p' | '480p' | '360p';
export type VideoContainer = 'mp4' | 'mkv' | 'webm';
export type AudioFormat = 'mp3' | 'm4a' | 'opus' | 'flac';
export type AudioBitrate = 'best' | '320k' | '256k' | '192k' | '128k';

export type TaskStatus =
  | 'queued'
  | 'downloading'
  | 'merging'
  | 'postprocessing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type BatchStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'partial'
  | 'cancelled';

export interface AppSettings {
  downloadDir: string;
  maxConcurrency: number;
  sleepMinSec: number;
  sleepMaxSec: number;
  defaultVideoQuality: VideoQuality;
  defaultContainer: VideoContainer;
  defaultAudioFormat: AudioFormat;
  defaultAudioBitrate: AudioBitrate;
  embedMetadata: boolean;
  embedThumbnail: boolean;
  squareAlbumCover: boolean;
  subfolderByChannel: boolean;
  subfolderByPlaylist: boolean;
  useCookies: boolean;
  autoCheckYtdlpUpdate: boolean;
}

export interface DepsStatus {
  ytdlpInstalled: boolean;
  ytdlpVersion: string | null;
  ytdlpPath: string;
  ffmpegInstalled: boolean;
  ffmpegVersion: string | null;
  ffmpegPath: string;
  nodePath: string;
  installing: boolean;
  updating: boolean;
}

export interface HealthResponse {
  ok: boolean;
  app: string;
  version: string;
  port: number;
  pid: number;
  uptimeSec: number;
  nodeVersion: string;
  deps: DepsStatus;
}

export interface VideoFormatOption {
  formatId: string;
  ext: string;
  height?: number;
  width?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  filesizeApprox?: number;
  tbr?: number;
  label: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface SubtitleTrack {
  lang: string;
  name: string;
  isAuto: boolean;
}

export interface AnalyzedItem {
  videoId: string;
  url: string;
  title: string;
  uploader?: string;
  channelId?: string;
  album?: string;
  artist?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  uploadDate?: string; // YYYYMMDD
  viewCount?: number;
  playlistIndex?: number;
  tab?: ChannelTab;
  alreadyDownloadedVideo?: boolean;
  alreadyDownloadedAudio?: boolean;
}

export interface AnalyzeRequest {
  url: string;
  channelTabs?: ChannelTab[];
  maxItems?: number;
  useCookies?: boolean;
  /** Force treating watch?v=...&list=... as playlist instead of single video */
  forcePlaylist?: boolean;
}

export interface BatchAnalyzeRequest {
  urls: string[];
  useCookies?: boolean;
}

export interface LogsTailResponse {
  logPath: string;
  lines: string[];
  sizeBytes: number;
}

export interface AnalyzeResult {
  jobId: string;
  sourceType: YouTubeSourceType;
  sourceKey: string;
  sourceUrl: string;
  title: string;
  uploader?: string;
  channelId?: string;
  thumbnailUrl?: string;
  isMusic: boolean;
  hasEmbeddedPlaylist?: boolean;
  embeddedPlaylistUrl?: string;
  items: AnalyzedItem[];
  /** Present for single video analysis */
  formats?: VideoFormatOption[];
  subtitles?: SubtitleTrack[];
  availableQualities?: VideoQuality[];
}

export interface DownloadOptions {
  mode: DownloadMode;
  videoQuality: VideoQuality;
  videoContainer: VideoContainer;
  audioFormat: AudioFormat;
  audioBitrate: AudioBitrate;
  customFormatId?: string;
  subtitleLangs?: string[];
  embedSubtitles?: boolean;
  embedMetadata: boolean;
  embedThumbnail: boolean;
  squareAlbumCover: boolean;
  sponsorBlockRemove?: boolean;
  startTime?: string; // HH:MM:SS
  endTime?: string;   // HH:MM:SS
  skipDownloaded: boolean;
  outputDir?: string;
  subfolder?: string;
  numberPrefix?: boolean;
  useCookies?: boolean;
}

export interface CreateDownloadRequest {
  sourceType: YouTubeSourceType;
  sourceKey: string;
  sourceUrl: string;
  title: string;
  uploader?: string;
  thumbnailUrl?: string;
  channelTabs?: ChannelTab[];
  items: AnalyzedItem[];
  options: DownloadOptions;
  trackSource?: boolean;
}

export interface BatchRecord {
  id: string;
  sourceType: YouTubeSourceType;
  trackedSourceId?: string | null;
  sourceUrl: string;
  title: string;
  outputDir: string;
  options: DownloadOptions;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  skippedItems: number;
  status: BatchStatus;
  createdAt: number;
  updatedAt: number;
}

export interface DownloadTaskRecord {
  id: string;
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
  status: TaskStatus;
  phase?: string | null;
  progressPct: number;
  speedBps?: number | null;
  etaSec?: number | null;
  downloadedBytes: number;
  totalBytes?: number | null;
  outputPath?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  retryCount: number;
  priority: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
}

export interface TrackedSourceRecord {
  id: string;
  sourceType: 'channel' | 'playlist' | 'album';
  sourceKey: string;
  title: string;
  url: string;
  thumbnailUrl?: string | null;
  channelTabs?: ChannelTab[];
  presetOptions: DownloadOptions;
  totalSyncedCount: number;
  lastSyncedAt?: number | null;
  createdAt: number;
}

export interface ArchiveRecord {
  id: number;
  videoId: string;
  mode: DownloadMode;
  sourceKey?: string | null;
  title?: string | null;
  outputPath?: string | null;
  fileSizeBytes?: number | null;
  downloadedAt: number;
}

export interface CookiePayloadItem {
  domain: string;
  path: string;
  secure: boolean;
  expirationDate?: number;
  name: string;
  value: string;
  hostOnly?: boolean;
}
