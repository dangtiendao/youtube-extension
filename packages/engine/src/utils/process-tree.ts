import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Terminates a process and all its child processes (e.g., yt-dlp -> ffmpeg) cleanly.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (!pid || pid <= 0) return;

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
      });
    } catch {
      // Process may have already exited
    }
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore
  }
}
