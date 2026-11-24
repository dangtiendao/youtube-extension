import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_NAME } from '@tubevault/shared';

export interface EnginePaths {
  appDataDir: string;
  binDir: string;
  dataDir: string;
  tempDir: string;
  logsDir: string;
  dbPath: string;
  runtimeLockPath: string;
  ytdlpPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  defaultDownloadDir: string;
  webUiDir: string;
}

export function resolveEnginePaths(): EnginePaths {
  const localAppData =
    process.env.TUBEVAULT_DATA_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), APP_NAME)
      : path.join(os.homedir(), `.${APP_NAME.toLowerCase()}`));

  const binDir = path.join(localAppData, 'bin');
  const dataDir = path.join(localAppData, 'data');
  const tempDir = path.join(localAppData, 'temp');
  const logsDir = path.join(localAppData, 'logs');

  for (const dir of [localAppData, binDir, dataDir, tempDir, logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const exeExt = process.platform === 'win32' ? '.exe' : '';
  const defaultDownloadDir = path.join(os.homedir(), 'Downloads', APP_NAME);

  // Locate Web UI directory (packaged next to engine.cjs or workspace dist-web)
  const candidateWebDirs = [
    process.env.TUBEVAULT_WEB_UI_DIR || '',
    path.resolve(path.dirname(process.execPath), 'web-ui'),
    path.resolve(path.dirname(process.argv[1] || process.cwd()), 'web-ui'),
    path.resolve(path.dirname(process.argv[1] || process.cwd()), '..', 'app', 'web-ui'),
    path.resolve(process.cwd(), 'packages', 'extension', 'dist-web'),
    path.resolve(process.cwd(), '..', 'extension', 'dist-web'),
  ].filter(Boolean);

  const webUiDir = candidateWebDirs.find((d) => fs.existsSync(path.join(d, 'index.html'))) || candidateWebDirs[0];

  return {
    appDataDir: localAppData,
    binDir,
    dataDir,
    tempDir,
    logsDir,
    dbPath: path.join(dataDir, 'tubevault.db'),
    runtimeLockPath: path.join(dataDir, 'runtime.json'),
    ytdlpPath: path.join(binDir, `yt-dlp${exeExt}`),
    ffmpegPath: path.join(binDir, `ffmpeg${exeExt}`),
    ffprobePath: path.join(binDir, `ffprobe${exeExt}`),
    defaultDownloadDir,
    webUiDir,
  };
}
