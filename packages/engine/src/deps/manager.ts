import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { DepsStatus, WsEvent } from '@tubevault/shared';
import type { EnginePaths } from '../config/paths.js';

const execFileAsync = promisify(execFile);

const YTDLP_WIN_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_WIN_URLS = [
  'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
];

export type DepsEventEmitter = (event: Extract<WsEvent, { type: 'deps:progress' }>) => void;

export class DepsManager {
  private installing = false;
  private updating = false;
  private cachedYtdlpVersion: string | null = null;
  private cachedFfmpegVersion: string | null = null;

  constructor(
    private readonly paths: EnginePaths,
    private readonly emitEvent: DepsEventEmitter
  ) {}

  resolveYtdlpBinary(): string | null {
    if (fs.existsSync(this.paths.ytdlpPath)) return this.paths.ytdlpPath;
    return null;
  }

  resolveFfmpegBinary(): string | null {
    if (fs.existsSync(this.paths.ffmpegPath)) return this.paths.ffmpegPath;
    return null;
  }

  async getStatus(refreshVersions = false): Promise<DepsStatus> {
    const ytdlpInstalled = fs.existsSync(this.paths.ytdlpPath);
    const ffmpegInstalled = fs.existsSync(this.paths.ffmpegPath);

    if (ytdlpInstalled && (refreshVersions || !this.cachedYtdlpVersion)) {
      this.cachedYtdlpVersion = await this.probeVersion(this.paths.ytdlpPath, ['--version']);
    } else if (!ytdlpInstalled) {
      this.cachedYtdlpVersion = null;
    }

    if (ffmpegInstalled && (refreshVersions || !this.cachedFfmpegVersion)) {
      const raw = await this.probeVersion(this.paths.ffmpegPath, ['-version']);
      this.cachedFfmpegVersion = raw ? raw.split('\n')[0]?.replace(/^ffmpeg version\s+/i, '').split(' ')[0] || raw : null;
    } else if (!ffmpegInstalled) {
      this.cachedFfmpegVersion = null;
    }

    return {
      ytdlpInstalled,
      ytdlpVersion: this.cachedYtdlpVersion,
      ytdlpPath: this.paths.ytdlpPath,
      ffmpegInstalled,
      ffmpegVersion: this.cachedFfmpegVersion,
      ffmpegPath: this.paths.ffmpegPath,
      nodePath: process.execPath,
      installing: this.installing,
      updating: this.updating,
    };
  }

  async installMissing(force = false): Promise<DepsStatus> {
    if (this.installing) {
      return this.getStatus();
    }
    this.installing = true;
    try {
      if (force || !fs.existsSync(this.paths.ytdlpPath)) {
        await this.downloadYtdlp();
      }
      if (force || !fs.existsSync(this.paths.ffmpegPath)) {
        await this.downloadFfmpeg();
      }
      return await this.getStatus(true);
    } finally {
      this.installing = false;
    }
  }

  async updateYtdlp(): Promise<{ ok: boolean; output: string; version: string | null }> {
    if (!fs.existsSync(this.paths.ytdlpPath)) {
      await this.installMissing();
      return { ok: true, output: 'Installed latest yt-dlp', version: this.cachedYtdlpVersion };
    }
    if (this.updating) {
      return { ok: false, output: 'Update already in progress', version: this.cachedYtdlpVersion };
    }

    this.updating = true;
    try {
      const { stdout, stderr } = await execFileAsync(this.paths.ytdlpPath, ['-U'], {
        windowsHide: true,
        timeout: 120_000,
      });
      this.cachedYtdlpVersion = await this.probeVersion(this.paths.ytdlpPath, ['--version']);
      return {
        ok: true,
        output: `${stdout}\n${stderr}`.trim(),
        version: this.cachedYtdlpVersion,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, output: message, version: this.cachedYtdlpVersion };
    } finally {
      this.updating = false;
    }
  }

  private async downloadYtdlp(): Promise<void> {
    const tmpPath = `${this.paths.ytdlpPath}.part`;
    try {
      this.emitEvent({
        type: 'deps:progress',
        payload: { target: 'yt-dlp', status: 'downloading', pct: 0, message: 'Đang tải yt-dlp.exe...' },
      });

      await this.streamDownload(YTDLP_WIN_URL, tmpPath, (downloaded, total) => {
        const pct = total ? Math.min(99, Math.round((downloaded / total) * 100)) : 0;
        this.emitEvent({
          type: 'deps:progress',
          payload: {
            target: 'yt-dlp',
            status: 'downloading',
            pct,
            downloadedBytes: downloaded,
            totalBytes: total,
            message: 'Đang tải yt-dlp.exe...',
          },
        });
      });

      fs.renameSync(tmpPath, this.paths.ytdlpPath);
      this.emitEvent({
        type: 'deps:progress',
        payload: { target: 'yt-dlp', status: 'done', pct: 100, message: 'Đã cài yt-dlp.exe thành công' },
      });
    } catch (err) {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
      this.emitEvent({
        type: 'deps:progress',
        payload: {
          target: 'yt-dlp',
          status: 'error',
          pct: 0,
          message: `Lỗi tải yt-dlp: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      throw err;
    }
  }

  private async downloadFfmpeg(): Promise<void> {
    const zipPath = path.join(this.paths.tempDir, 'ffmpeg-download.zip');
    const extractDir = path.join(this.paths.tempDir, 'ffmpeg-extract');

    try {
      let downloadedOk = false;
      let lastError: unknown;

      for (const url of FFMPEG_WIN_URLS) {
        try {
          this.emitEvent({
            type: 'deps:progress',
            payload: { target: 'ffmpeg', status: 'downloading', pct: 0, message: 'Đang tải FFmpeg...' },
          });

          await this.streamDownload(url, zipPath, (downloaded, total) => {
            const pct = total ? Math.min(85, Math.round((downloaded / total) * 85)) : 0;
            this.emitEvent({
              type: 'deps:progress',
              payload: {
                target: 'ffmpeg',
                status: 'downloading',
                pct,
                downloadedBytes: downloaded,
                totalBytes: total,
                message: 'Đang tải FFmpeg...',
              },
            });
          });
          downloadedOk = true;
          break;
        } catch (err) {
          lastError = err;
        }
      }

      if (!downloadedOk) {
        throw lastError || new Error('Failed to download FFmpeg');
      }

      this.emitEvent({
        type: 'deps:progress',
        payload: { target: 'ffmpeg', status: 'extracting', pct: 90, message: 'Đang giải nén ffmpeg.exe & ffprobe.exe...' },
      });

      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });

      // Extract only ffmpeg.exe and ffprobe.exe cleanly via .NET ZipFile (built into Windows PowerShell)
      const psScript = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')
try {
  foreach ($entry in $zip.Entries) {
    if ($entry.Name -eq 'ffmpeg.exe' -or $entry.Name -eq 'ffprobe.exe') {
      $dest = Join-Path '${this.paths.binDir.replace(/'/g, "''")}' $entry.Name
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
    }
  }
} finally {
  $zip.Dispose()
}
`;

      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        windowsHide: true,
        timeout: 180_000,
      });

      if (!fs.existsSync(this.paths.ffmpegPath)) {
        throw new Error('Không tìm thấy ffmpeg.exe trong gói giải nén');
      }

      this.emitEvent({
        type: 'deps:progress',
        payload: { target: 'ffmpeg', status: 'done', pct: 100, message: 'Đã cài FFmpeg thành công' },
      });
    } catch (err) {
      this.emitEvent({
        type: 'deps:progress',
        payload: {
          target: 'ffmpeg',
          status: 'error',
          pct: 0,
          message: `Lỗi cài FFmpeg: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      throw err;
    } finally {
      fs.rmSync(zipPath, { force: true });
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }

  private async streamDownload(
    url: string,
    destPath: string,
    onProgress: (downloaded: number, total: number) => void
  ): Promise<void> {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'TubeVault/1.0' },
    });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} downloading ${url}`);
    }

    const total = Number(res.headers.get('content-length') || 0);
    let downloaded = 0;
    let lastReport = 0;

    const out = fs.createWriteStream(destPath);
    const nodeStream = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);

    await new Promise<void>((resolve, reject) => {
      nodeStream.on('data', (chunk: Buffer) => {
        downloaded += chunk.length;
        const now = Date.now();
        if (now - lastReport >= 200) {
          lastReport = now;
          onProgress(downloaded, total);
        }
      });
      nodeStream.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => {
        onProgress(downloaded, total);
        resolve();
      });
      nodeStream.pipe(out);
    });
  }

  private async probeVersion(binPath: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(binPath, args, {
        windowsHide: true,
        timeout: 10_000,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}
