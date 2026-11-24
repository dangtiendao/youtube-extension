import path from 'node:path';
import {
  sanitizeSegment,
  type DownloadOptions,
  type DownloadTaskRecord,
  type VideoQuality,
} from '@tubevault/shared';

export function buildFormatSpec(options: DownloadOptions): { formatSpec: string; container: string } {
  if (options.mode === 'audio') {
    return {
      formatSpec: 'bestaudio/best',
      container: options.audioFormat || 'mp3',
    };
  }

  if (options.customFormatId) {
    return {
      formatSpec: options.customFormatId,
      container: options.videoContainer || 'mp4',
    };
  }

  const maxHeight = qualityToMaxHeight(options.videoQuality);
  const container = options.videoContainer || 'mp4';

  if (container === 'mp4') {
    const hFilter = maxHeight ? `[height<=${maxHeight}]` : '';
    return {
      formatSpec: `bestvideo${hFilter}[ext=mp4]+bestaudio[ext=m4a]/bestvideo${hFilter}+bestaudio/best${hFilter}/best`,
      container,
    };
  }

  const hFilter = maxHeight ? `[height<=${maxHeight}]` : '';
  return {
    formatSpec: `bestvideo${hFilter}+bestaudio/best${hFilter}/best`,
    container,
  };
}

function qualityToMaxHeight(q: VideoQuality): number | null {
  switch (q) {
    case '2160p':
      return 2160;
    case '1440p':
      return 1440;
    case '1080p':
      return 1080;
    case '720p':
      return 720;
    case '480p':
      return 480;
    case '360p':
      return 360;
    case 'best':
    default:
      return null;
  }
}

function audioBitrateToYtdlp(bitrate: string): string {
  switch (bitrate) {
    case '320k':
      return '320K';
    case '256k':
      return '256K';
    case '192k':
      return '192K';
    case '128k':
      return '128K';
    case 'best':
    default:
      return '0';
  }
}

export interface BuildDownloadArgsParams {
  task: DownloadTaskRecord;
  outputDir: string;
  ffmpegDir: string;
  nodePath: string;
  cookiesFilePath?: string | null;
}

export function buildDownloadArgs(params: BuildDownloadArgsParams): string[] {
  const { task, outputDir, ffmpegDir, nodePath, cookiesFilePath } = params;
  const opts = task.options;

  const prefix =
    opts.numberPrefix && task.playlistIndex != null
      ? `${String(task.playlistIndex).padStart(2, '0')} - `
      : '';
  const safeTitle = sanitizeSegment(task.title, task.videoId, 110);
  const outputTemplate = path.join(outputDir, `${prefix}${safeTitle}.%(ext)s`);

  const args: string[] = [
    '--no-playlist',
    '--continue',
    '--no-overwrites',
    '--newline',
    '--no-colors',
    '--ffmpeg-location',
    ffmpegDir,
    '--js-runtimes',
    `node:${nodePath}`,
    '--progress-template',
    'download:TVPROG|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.ext)s',
    '--progress-template',
    'postprocess:TVPOST|%(progress.status)s|%(progress.postprocessor)s',
    '--print',
    'after_move:TVFINAL|%(filepath)s',
    '-f',
    task.formatSpec,
    '-o',
    outputTemplate,
  ];

  if (opts.mode === 'audio') {
    args.push('-x', '--audio-format', opts.audioFormat || 'mp3', '--audio-quality', audioBitrateToYtdlp(opts.audioBitrate));
    if (opts.embedMetadata) {
      args.push('--embed-metadata');
      if (task.album) {
        args.push('--parse-metadata', `:(?P<meta_album>${task.album.replace(/%/g, '%%')})`);
      }
      if (task.playlistIndex != null) {
        args.push('--parse-metadata', `:(?P<meta_track>${task.playlistIndex})`);
      }
    }
    if (opts.embedThumbnail && (opts.audioFormat === 'mp3' || opts.audioFormat === 'm4a' || opts.audioFormat === 'flac')) {
      args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
      if (opts.squareAlbumCover) {
        args.push('--ppa', "ThumbnailsConvertor+ffmpeg_o:-c:v mjpeg -vf crop='min(iw,ih)':'min(iw,ih)'");
      }
    }
  } else {
    args.push('--merge-output-format', opts.videoContainer || 'mp4');
    if (opts.embedMetadata) {
      args.push('--embed-metadata');
    }
    if (opts.embedThumbnail && (opts.videoContainer === 'mp4' || opts.videoContainer === 'mkv')) {
      args.push('--embed-thumbnail');
    }
    if (opts.subtitleLangs && opts.subtitleLangs.length > 0) {
      args.push('--write-subs', '--write-auto-subs', '--sub-langs', opts.subtitleLangs.join(','), '--convert-subs', 'srt');
      if (opts.embedSubtitles) {
        args.push('--embed-subs');
      }
    }
  }

  if (opts.sponsorBlockRemove) {
    args.push('--sponsorblock-remove', 'default');
  }

  if (opts.startTime || opts.endTime) {
    const start = opts.startTime?.trim() || '00:00:00';
    const end = opts.endTime?.trim() || 'inf';
    args.push('--download-sections', `*${start}-${end}`, '--force-keyframes-at-cuts');
  }

  if (cookiesFilePath) {
    args.push('--cookies', cookiesFilePath);
  }

  args.push(task.url);
  return args;
}

export function buildCommonAnalyzeArgs(params: {
  ffmpegDir: string;
  nodePath: string;
  cookiesFilePath?: string | null;
}): string[] {
  const args = [
    '--no-warnings',
    '--ignore-errors',
    '--skip-download',
    '--ffmpeg-location',
    params.ffmpegDir,
    '--js-runtimes',
    `node:${params.nodePath}`,
  ];
  if (params.cookiesFilePath) {
    args.push('--cookies', params.cookiesFilePath);
  }
  return args;
}
