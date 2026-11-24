import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CookiePayloadItem } from '@tubevault/shared';

/**
 * Holds YouTube cookies pushed from the Chrome Extension in memory and writes
 * short-lived Netscape cookies.txt files only for the lifetime of an active yt-dlp process.
 */
export class CookiesStore {
  private cookies: CookiePayloadItem[] = [];
  private syncedAt: number | null = null;

  constructor(private readonly tempDir: string) {}

  setCookies(items: CookiePayloadItem[]): { count: number; syncedAt: number } {
    // Only accept YouTube / Google domains strictly needed for YouTube auth
    const filtered = items.filter((c) => {
      const d = (c.domain || '').toLowerCase();
      return (
        d.endsWith('youtube.com') ||
        d.endsWith('youtu.be') ||
        d.endsWith('google.com') ||
        d.endsWith('googleusercontent.com')
      );
    });
    this.cookies = filtered;
    this.syncedAt = Date.now();
    return { count: filtered.length, syncedAt: this.syncedAt };
  }

  clear(): void {
    this.cookies = [];
    this.syncedAt = null;
  }

  getStatus(): { hasCookies: boolean; count: number; syncedAt: number | null } {
    return {
      hasCookies: this.cookies.length > 0,
      count: this.cookies.length,
      syncedAt: this.syncedAt,
    };
  }

  /**
   * Creates a temporary Netscape cookie file and returns its path + cleanup callback.
   */
  acquireTempFile(): { filePath: string; cleanup: () => void } | null {
    if (this.cookies.length === 0) return null;

    const lines = ['# Netscape HTTP Cookie File', '# Generated transiently by TubeVault'];
    for (const c of this.cookies) {
      const domain = c.domain.startsWith('.') ? c.domain : c.hostOnly ? c.domain : `.${c.domain}`;
      const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const cookiePath = c.path || '/';
      const secure = c.secure ? 'TRUE' : 'FALSE';
      const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
      const name = String(c.name || '').replace(/[\r\n\t]/g, '');
      const value = String(c.value || '').replace(/[\r\n\t]/g, '');
      if (!name) continue;
      lines.push(`${domain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expiry}\t${name}\t${value}`);
    }

    const filePath = path.join(this.tempDir, `ck-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(filePath, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });

    return {
      filePath,
      cleanup: () => {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {
          // ignore
        }
      },
    };
  }
}
