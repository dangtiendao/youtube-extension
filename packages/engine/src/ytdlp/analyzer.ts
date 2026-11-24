import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import {
  parseYouTubeUrl,
  type AnalyzedItem,
  type AnalyzeRequest,
  type AnalyzeResult,
  type ChannelTab,
  type SubtitleTrack,
  type VideoFormatOption,
  type VideoQuality,
  type WsEvent,
} from '@tubevault/shared';
import type { EnginePaths } from '../config/paths.js';
import type { EngineStore } from '../db/repositories.js';
import type { DepsManager } from '../deps/manager.js';
import { killProcessTree } from '../utils/process-tree.js';
import { buildCommonAnalyzeArgs } from './args-builder.js';
import type { CookiesStore } from './cookies-store.js';
import { classifyYtdlpError } from './progress-parser.js';

export type AnalyzeEventEmitter = (event: Extract<WsEvent, { type: 'analyze:progress' }>) => void;

interface RawYtdlpJson {
  id?: string;
  title?: string;
  fulltitle?: string;
  uploader?: string;
  channel?: string;
  channel_id?: string;
  album?: string;
  artist?: string;
  creator?: string;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string; width?: number; height?: number }>;
  duration?: number;
  upload_date?: string;
  view_count?: number;
  webpage_url?: string;
  url?: string;
  entries?: RawYtdlpJson[];
  formats?: Array<{
    format_id?: string;
    ext?: string;
    height?: number;
    width?: number;
    fps?: number;
    vcodec?: string;
    acodec?: string;
    filesize?: number;
    filesize_approx?: number;
    tbr?: number;
    format_note?: string;
  }>;
  subtitles?: Record<string, Array<{ name?: string }>>;
  automatic_captions?: Record<string, Array<{ name?: string }>>;
}

export class LinkAnalyzer {
  private readonly activeJobs = new Map<string, ChildProcess>();

  constructor(
    private readonly paths: EnginePaths,
    private readonly deps: DepsManager,
    private readonly store: EngineStore,
    private readonly cookiesStore: CookiesStore,
    private readonly emitEvent: AnalyzeEventEmitter
  ) {}

  cancelJob(jobId: string): boolean {
    const child = this.activeJobs.get(jobId);
    if (!child) return false;
    this.activeJobs.delete(jobId);
    if (child.pid) {
      void killProcessTree(child.pid);
    }
    return true;
  }

  async analyze(req: AnalyzeRequest): Promise<AnalyzeResult> {
    const ytdlpBin = this.deps.resolveYtdlpBinary();
    if (!ytdlpBin) {
      throw new Error('Chưa cài đặt yt-dlp.exe. Hãy bấm "Cài đặt Engine" trước khi phân tích link.');
    }

    const parsed = parseYouTubeUrl(req.url);
    if (!parsed.valid) {
      throw new Error('Đường dẫn không phải là link YouTube hợp lệ (Video, Shorts, Playlist, Album hoặc Kênh).');
    }

    const jobId = crypto.randomUUID();
    const useCookies = req.useCookies ?? this.store.getSettings().useCookies;
    const tempCookie = useCookies ? this.cookiesStore.acquireTempFile() : null;

    try {
      const effectiveType =
        parsed.sourceType === 'single' && req.forcePlaylist && parsed.playlistUrl
          ? parsed.isMusic
            ? 'album'
            : 'playlist'
          : parsed.sourceType;

      if (effectiveType === 'single') {
        return await this.analyzeSingle(jobId, ytdlpBin, parsed, tempCookie?.filePath);
      }

      if (effectiveType === 'playlist' || effectiveType === 'album') {
        const targetUrl = req.forcePlaylist && parsed.playlistUrl ? parsed.playlistUrl : parsed.normalizedUrl;
        return await this.analyzePlaylist(
          jobId,
          ytdlpBin,
          targetUrl,
          effectiveType,
          parsed.isMusic,
          parsed.playlistId,
          req.maxItems,
          tempCookie?.filePath
        );
      }

      const tabs: ChannelTab[] =
        req.channelTabs && req.channelTabs.length > 0
          ? req.channelTabs
          : parsed.detectedTab
            ? [parsed.detectedTab]
            : ['videos'];

      return await this.analyzeChannel(
        jobId,
        ytdlpBin,
        parsed.normalizedUrl,
        parsed.channelIdentifier || parsed.normalizedUrl,
        tabs,
        req.maxItems,
        tempCookie?.filePath
      );
    } finally {
      this.activeJobs.delete(jobId);
      tempCookie?.cleanup();
    }
  }

  /**
   * Analyzes a batch of multiple pasted YouTube URLs (one per line) and aggregates
   * them into a single selectable list.
   */
  async analyzeBatch(urls: string[], useCookiesOverride?: boolean): Promise<AnalyzeResult> {
    const ytdlpBin = this.deps.resolveYtdlpBinary();
    if (!ytdlpBin) {
      throw new Error('Chưa cài đặt yt-dlp.exe. Hãy bấm "Cài đặt Engine" trước khi phân tích link.');
    }

    const parsedList = urls
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => parseYouTubeUrl(u))
      .filter((p) => p.valid);

    if (parsedList.length === 0) {
      throw new Error('Không tìm thấy đường dẫn YouTube hợp lệ nào trong danh sách bạn dán.');
    }

    const jobId = crypto.randomUUID();
    const useCookies = useCookiesOverride ?? this.store.getSettings().useCookies;
    const tempCookie = useCookies ? this.cookiesStore.acquireTempFile() : null;

    const allItems: AnalyzedItem[] = [];
    const seenIds = new Set<string>();
    const cancelledCheck = () => !this.activeJobs.has(jobId) && allItems.length > 0;

    try {
      for (let idx = 0; idx < parsedList.length; idx++) {
        const parsed = parsedList[idx];
        this.emitEvent({
          type: 'analyze:progress',
          payload: {
            jobId,
            scannedCount: allItems.length,
            message: `Đang phân tích link ${idx + 1}/${parsedList.length}...`,
          },
        });

        try {
          if (parsed.sourceType === 'single') {
            const args = [
              ...buildCommonAnalyzeArgs({
                ffmpegDir: this.paths.binDir,
                nodePath: process.execPath,
                cookiesFilePath: tempCookie?.filePath,
              }),
              '--no-playlist',
              '--dump-single-json',
              parsed.normalizedUrl,
            ];
            const data = await this.execYtdlpJson(jobId, ytdlpBin, args);
            const videoId = data.id || parsed.videoId;
            if (videoId && !seenIds.has(videoId)) {
              seenIds.add(videoId);
              allItems.push({
                videoId,
                url: data.webpage_url || parsed.normalizedUrl,
                title: data.title || data.fulltitle || videoId,
                uploader: data.uploader || data.channel,
                channelId: data.channel_id,
                album: data.album,
                artist: data.artist || data.creator || data.uploader,
                thumbnailUrl: pickBestThumbnail(data) || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                durationSec: data.duration,
                uploadDate: data.upload_date,
                viewCount: data.view_count,
                playlistIndex: allItems.length + 1,
              });
            }
          } else {
            const args = [
              ...buildCommonAnalyzeArgs({
                ffmpegDir: this.paths.binDir,
                nodePath: process.execPath,
                cookiesFilePath: tempCookie?.filePath,
              }),
              '--flat-playlist',
              '--dump-single-json',
              '--playlist-end',
              '200',
              parsed.normalizedUrl,
            ];
            const data = await this.execYtdlpJson(jobId, ytdlpBin, args);
            for (const entry of flattenEntries(data.entries || [])) {
              if (!entry.id || seenIds.has(entry.id)) continue;
              if (entry.title === '[Deleted video]' || entry.title === '[Private video]') continue;
              seenIds.add(entry.id);
              allItems.push({
                videoId: entry.id,
                url: entry.url?.startsWith('http') ? entry.url : `https://www.youtube.com/watch?v=${entry.id}`,
                title: entry.title || entry.id,
                uploader: entry.uploader || entry.channel || data.uploader || data.channel,
                channelId: entry.channel_id || data.channel_id,
                thumbnailUrl: pickBestThumbnail(entry) || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
                durationSec: entry.duration,
                uploadDate: entry.upload_date,
                viewCount: entry.view_count,
                playlistIndex: allItems.length + 1,
              });
            }
          }
        } catch {
          // Continue scanning remaining pasted links even if one link is unavailable
          if (cancelledCheck()) break;
        }
      }

      if (allItems.length === 0) {
        throw new Error('Không thể đọc thông tin từ các link YouTube đã dán.');
      }

      this.annotateDownloadedFlags(allItems);

      this.emitEvent({
        type: 'analyze:progress',
        payload: { jobId, scannedCount: allItems.length, message: `Đã phân tích xong ${allItems.length} video` },
      });

      return {
        jobId,
        sourceType: 'playlist',
        sourceKey: `batch:${Date.now()}`,
        sourceUrl: parsedList[0].normalizedUrl,
        title: `Danh sách ${allItems.length} link đã dán`,
        uploader: parsedList.length === 1 ? allItems[0]?.uploader : `${parsedList.length} nguồn YouTube`,
        thumbnailUrl: allItems[0]?.thumbnailUrl,
        isMusic: parsedList.every((p) => p.isMusic),
        items: allItems,
      };
    } finally {
      this.activeJobs.delete(jobId);
      tempCookie?.cleanup();
    }
  }

  private async analyzeSingle(
    jobId: string,
    ytdlpBin: string,
    parsed: ReturnType<typeof parseYouTubeUrl>,
    cookiesFilePath?: string | null
  ): Promise<AnalyzeResult> {
    this.emitEvent({
      type: 'analyze:progress',
      payload: { jobId, scannedCount: 0, message: 'Đang đọc thông tin video & định dạng...' },
    });

    const args = [
      ...buildCommonAnalyzeArgs({
        ffmpegDir: this.paths.binDir,
        nodePath: process.execPath,
        cookiesFilePath,
      }),
      '--no-playlist',
      '--dump-single-json',
      parsed.normalizedUrl,
    ];

    const data = await this.execYtdlpJson(jobId, ytdlpBin, args);
    const videoId = data.id || parsed.videoId || crypto.randomUUID().slice(0, 11);
    const downloadedMap = this.store.getDownloadedMap([videoId]);
    const dlState = downloadedMap.get(videoId);

    const item: AnalyzedItem = {
      videoId,
      url: data.webpage_url || parsed.normalizedUrl,
      title: data.title || data.fulltitle || videoId,
      uploader: data.uploader || data.channel,
      channelId: data.channel_id,
      album: data.album,
      artist: data.artist || data.creator || data.uploader,
      thumbnailUrl: pickBestThumbnail(data),
      durationSec: data.duration,
      uploadDate: data.upload_date,
      viewCount: data.view_count,
      alreadyDownloadedVideo: dlState?.video ?? false,
      alreadyDownloadedAudio: dlState?.audio ?? false,
    };

    const formats = extractFormatOptions(data.formats || []);
    const availableQualities = extractAvailableQualities(data.formats || []);
    const subtitles = extractSubtitles(data);

    return {
      jobId,
      sourceType: 'single',
      sourceKey: `video:${videoId}`,
      sourceUrl: item.url,
      title: item.title,
      uploader: item.uploader,
      channelId: item.channelId,
      thumbnailUrl: item.thumbnailUrl,
      isMusic: parsed.isMusic,
      hasEmbeddedPlaylist: parsed.hasEmbeddedPlaylist,
      embeddedPlaylistUrl: parsed.playlistUrl,
      items: [item],
      formats,
      subtitles,
      availableQualities,
    };
  }

  private async analyzePlaylist(
    jobId: string,
    ytdlpBin: string,
    targetUrl: string,
    sourceType: 'playlist' | 'album',
    isMusic: boolean,
    playlistId?: string,
    maxItems?: number,
    cookiesFilePath?: string | null
  ): Promise<AnalyzeResult> {
    this.emitEvent({
      type: 'analyze:progress',
      payload: {
        jobId,
        scannedCount: 0,
        message: sourceType === 'album' ? 'Đang quét danh sách bài hát trong Album...' : 'Đang quét danh sách Playlist...',
      },
    });

    const args = [
      ...buildCommonAnalyzeArgs({
        ffmpegDir: this.paths.binDir,
        nodePath: process.execPath,
        cookiesFilePath,
      }),
      '--flat-playlist',
      '--dump-single-json',
    ];
    if (maxItems && maxItems > 0) {
      args.push('--playlist-end', String(maxItems));
    }
    args.push(targetUrl);

    const data = await this.execYtdlpJson(jobId, ytdlpBin, args);
    const rawEntries = (data.entries || []).filter((e) => e && e.id && e.title !== '[Deleted video]' && e.title !== '[Private video]');
    const listTitle = data.title || (sourceType === 'album' ? 'YouTube Album' : 'YouTube Playlist');
    const listUploader = data.uploader || data.channel;

    const items: AnalyzedItem[] = rawEntries.map((entry, idx) => ({
      videoId: entry.id!,
      url: entry.url?.startsWith('http')
        ? entry.url
        : `${isMusic ? 'https://music.youtube.com' : 'https://www.youtube.com'}/watch?v=${entry.id}`,
      title: entry.title || `Item ${idx + 1}`,
      uploader: entry.uploader || entry.channel || listUploader,
      channelId: entry.channel_id || data.channel_id,
      album: sourceType === 'album' ? listTitle : entry.album,
      artist: entry.artist || entry.uploader || listUploader,
      thumbnailUrl: pickBestThumbnail(entry) || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
      durationSec: entry.duration,
      uploadDate: entry.upload_date,
      viewCount: entry.view_count,
      playlistIndex: idx + 1,
    }));

    this.annotateDownloadedFlags(items);

    this.emitEvent({
      type: 'analyze:progress',
      payload: { jobId, scannedCount: items.length, message: `Đã quét xong ${items.length} mục` },
    });

    return {
      jobId,
      sourceType,
      sourceKey: `${sourceType}:${data.id || playlistId || targetUrl}`,
      sourceUrl: targetUrl,
      title: listTitle,
      uploader: listUploader,
      channelId: data.channel_id,
      thumbnailUrl: pickBestThumbnail(data) || items[0]?.thumbnailUrl,
      isMusic,
      items,
    };
  }

  private async analyzeChannel(
    jobId: string,
    ytdlpBin: string,
    baseChannelUrl: string,
    channelIdentifier: string,
    tabs: ChannelTab[],
    maxItems?: number,
    cookiesFilePath?: string | null
  ): Promise<AnalyzeResult> {
    const allItems: AnalyzedItem[] = [];
    const seenIds = new Set<string>();
    let channelTitle = channelIdentifier;
    let channelId: string | undefined;
    let channelThumb: string | undefined;

    for (const tab of tabs) {
      const tabUrl = `${baseChannelUrl.replace(/\/+$/, '')}/${tab}`;
      this.emitEvent({
        type: 'analyze:progress',
        payload: {
          jobId,
          tab,
          scannedCount: allItems.length,
          message: `Đang quét tab /${tab} của kênh...`,
        },
      });

      const args = [
        ...buildCommonAnalyzeArgs({
          ffmpegDir: this.paths.binDir,
          nodePath: process.execPath,
          cookiesFilePath,
        }),
        '--flat-playlist',
        '--dump-single-json',
      ];
      if (maxItems && maxItems > 0) {
        args.push('--playlist-end', String(maxItems));
      }
      args.push(tabUrl);

      let data: RawYtdlpJson;
      try {
        data = await this.execYtdlpJson(jobId, ytdlpBin, args);
      } catch (err) {
        // If channel has no Shorts or Streams tab, continue gracefully when multiple tabs requested
        if (tabs.length > 1) continue;
        throw err;
      }

      if (data.channel || data.uploader || data.title) {
        channelTitle = (data.channel || data.uploader || data.title || channelTitle).replace(/\s*-\s*(Videos|Shorts|Live)$/i, '');
      }
      if (!channelId && data.channel_id) channelId = data.channel_id;
      if (!channelThumb) channelThumb = pickBestThumbnail(data);

      const entries = flattenEntries(data.entries || []);
      for (const entry of entries) {
        if (!entry.id || seenIds.has(entry.id)) continue;
        if (entry.title === '[Deleted video]' || entry.title === '[Private video]') continue;
        seenIds.add(entry.id);

        allItems.push({
          videoId: entry.id,
          url: entry.url?.startsWith('http')
            ? entry.url
            : tab === 'shorts'
              ? `https://www.youtube.com/shorts/${entry.id}`
              : `https://www.youtube.com/watch?v=${entry.id}`,
          title: entry.title || entry.id,
          uploader: entry.uploader || entry.channel || channelTitle,
          channelId: entry.channel_id || channelId,
          thumbnailUrl: pickBestThumbnail(entry) || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
          durationSec: entry.duration,
          uploadDate: entry.upload_date,
          viewCount: entry.view_count,
          playlistIndex: allItems.length + 1,
          tab,
        });
      }

      this.emitEvent({
        type: 'analyze:progress',
        payload: {
          jobId,
          tab,
          scannedCount: allItems.length,
          message: `Đã quét tab /${tab} — tổng ${allItems.length} video`,
        },
      });
    }

    this.annotateDownloadedFlags(allItems);

    return {
      jobId,
      sourceType: 'channel',
      sourceKey: `channel:${channelId || channelIdentifier}`,
      sourceUrl: baseChannelUrl,
      title: channelTitle,
      uploader: channelTitle,
      channelId,
      thumbnailUrl: channelThumb || allItems[0]?.thumbnailUrl,
      isMusic: false,
      items: allItems,
    };
  }

  private annotateDownloadedFlags(items: AnalyzedItem[]): void {
    const map = this.store.getDownloadedMap(items.map((i) => i.videoId));
    for (const item of items) {
      const state = map.get(item.videoId);
      item.alreadyDownloadedVideo = state?.video ?? false;
      item.alreadyDownloadedAudio = state?.audio ?? false;
    }
  }

  private execYtdlpJson(jobId: string, ytdlpBin: string, args: string[]): Promise<RawYtdlpJson> {
    return new Promise((resolve, reject) => {
      const child = spawn(ytdlpBin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.activeJobs.set(jobId, child);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      child.on('error', (err) => {
        this.activeJobs.delete(jobId);
        reject(err);
      });

      child.on('close', (code) => {
        this.activeJobs.delete(jobId);
        const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        if (!stdout) {
          const classified = classifyYtdlpError(stderr);
          reject(new Error(classified.message));
          return;
        }

        // yt-dlp with --ignore-errors may emit warnings before JSON or multiple JSON lines; parse the last valid JSON object
        try {
          resolve(JSON.parse(stdout) as RawYtdlpJson);
        } catch {
          const lines = stdout.split(/\r?\n/).reverse();
          for (const line of lines) {
            if (line.trim().startsWith('{')) {
              try {
                resolve(JSON.parse(line) as RawYtdlpJson);
                return;
              } catch {
                // keep searching
              }
            }
          }
          const classified = classifyYtdlpError(stderr || `Exit code ${code}`);
          reject(new Error(classified.message));
        }
      });
    });
  }
}

function flattenEntries(entries: RawYtdlpJson[]): RawYtdlpJson[] {
  const result: RawYtdlpJson[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (Array.isArray(e.entries) && e.entries.length > 0) {
      result.push(...flattenEntries(e.entries));
    } else {
      result.push(e);
    }
  }
  return result;
}

function pickBestThumbnail(data: RawYtdlpJson): string | undefined {
  if (data.thumbnail) return data.thumbnail;
  if (Array.isArray(data.thumbnails) && data.thumbnails.length > 0) {
    const sorted = [...data.thumbnails]
      .filter((t) => t.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0));
    return sorted[0]?.url;
  }
  return undefined;
}

function extractAvailableQualities(formats: NonNullable<RawYtdlpJson['formats']>): VideoQuality[] {
  const heights = new Set<number>();
  for (const f of formats) {
    if (f.vcodec && f.vcodec !== 'none' && f.height) {
      heights.add(f.height);
    }
  }
  const result: VideoQuality[] = ['best'];
  const thresholds: Array<[number, VideoQuality]> = [
    [2160, '2160p'],
    [1440, '1440p'],
    [1080, '1080p'],
    [720, '720p'],
    [480, '480p'],
    [360, '360p'],
  ];
  for (const [h, label] of thresholds) {
    if ([...heights].some((vh) => vh >= h - 40)) {
      result.push(label);
    }
  }
  return result;
}

function extractFormatOptions(formats: NonNullable<RawYtdlpJson['formats']>): VideoFormatOption[] {
  const mapped: VideoFormatOption[] = [];
  for (const f of formats) {
    if (!f.format_id) continue;
    const hasVideo = Boolean(f.vcodec && f.vcodec !== 'none');
    const hasAudio = Boolean(f.acodec && f.acodec !== 'none');
    if (!hasVideo && !hasAudio) continue;

    const labelParts: string[] = [];
    if (hasVideo && f.height) {
      labelParts.push(`${f.height}p${f.fps && f.fps >= 50 ? `${Math.round(f.fps)}` : ''}`);
    } else if (!hasVideo && hasAudio) {
      labelParts.push('Audio');
    }
    if (f.ext) labelParts.push(f.ext.toUpperCase());
    if (f.tbr) labelParts.push(`${Math.round(f.tbr)}k`);
    if (hasVideo && !hasAudio) labelParts.push('(video only)');

    mapped.push({
      formatId: f.format_id,
      ext: f.ext || 'mp4',
      height: f.height,
      width: f.width,
      fps: f.fps,
      vcodec: f.vcodec,
      acodec: f.acodec,
      filesizeApprox: f.filesize || f.filesize_approx,
      tbr: f.tbr,
      label: labelParts.join(' · '),
      hasVideo,
      hasAudio,
    });
  }

  return mapped
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))
    .slice(0, 30);
}

function extractSubtitles(data: RawYtdlpJson): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  const seen = new Set<string>();

  const addSource = (dict: Record<string, Array<{ name?: string }>> | undefined, isAuto: boolean) => {
    if (!dict) return;
    for (const [lang, list] of Object.entries(dict)) {
      if (lang === 'live_chat') continue;
      const key = `${lang}:${isAuto}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push({
        lang,
        name: list?.[0]?.name || lang,
        isAuto,
      });
    }
  };

  addSource(data.subtitles, false);
  addSource(data.automatic_captions, true);

  // Prioritize Vietnamese & English at the top
  const rank = (lang: string) => {
    if (lang.startsWith('vi')) return 0;
    if (lang.startsWith('en')) return 1;
    return 2;
  };

  return tracks
    .sort((a, b) => Number(a.isAuto) - Number(b.isAuto) || rank(a.lang) - rank(b.lang) || a.lang.localeCompare(b.lang))
    .slice(0, 40);
}
