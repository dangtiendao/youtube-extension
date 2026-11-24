import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB rotation threshold

export class EngineLogger {
  private readonly logPath: string;
  private readonly rotatedPath: string;

  constructor(logsDir: string) {
    fs.mkdirSync(logsDir, { recursive: true });
    this.logPath = path.join(logsDir, 'engine.log');
    this.rotatedPath = path.join(logsDir, 'engine.log.1');
  }

  getLogFilePath(): string {
    return this.logPath;
  }

  info(scope: string, message: string): void {
    this.write('INFO', scope, message);
  }

  warn(scope: string, message: string): void {
    this.write('WARN', scope, message);
  }

  error(scope: string, message: string): void {
    this.write('ERROR', scope, message);
  }

  readTail(maxLines = 150): { logPath: string; lines: string[]; sizeBytes: number } {
    if (!fs.existsSync(this.logPath)) {
      return { logPath: this.logPath, lines: [], sizeBytes: 0 };
    }
    try {
      const stat = fs.statSync(this.logPath);
      // Read at most the last 128 KB so tail is always instant
      const readSize = Math.min(stat.size, 128 * 1024);
      const start = Math.max(0, stat.size - readSize);
      const fd = fs.openSync(this.logPath, 'r');
      const buf = Buffer.alloc(readSize);
      try {
        fs.readSync(fd, buf, 0, readSize, start);
      } finally {
        fs.closeSync(fd);
      }
      const text = buf.toString('utf8');
      const allLines = text.split(/\r?\n/).filter((l) => l.length > 0);
      return {
        logPath: this.logPath,
        lines: allLines.slice(-Math.max(1, Math.min(1000, maxLines))),
        sizeBytes: stat.size,
      };
    } catch {
      return { logPath: this.logPath, lines: [], sizeBytes: 0 };
    }
  }

  private write(level: LogLevel, scope: string, message: string): void {
    const ts = new Date().toISOString();
    const cleanMsg = String(message || '').replace(/\r?\n/g, ' | ');
    const line = `[${ts}] [${level}] [${scope}] ${cleanMsg}\n`;

    try {
      if (fs.existsSync(this.logPath)) {
        const size = fs.statSync(this.logPath).size;
        if (size >= MAX_LOG_BYTES) {
          fs.rmSync(this.rotatedPath, { force: true });
          fs.renameSync(this.logPath, this.rotatedPath);
        }
      }
      fs.appendFileSync(this.logPath, line, 'utf8');
    } catch {
      // Never crash the engine due to logging I/O
    }
  }
}
