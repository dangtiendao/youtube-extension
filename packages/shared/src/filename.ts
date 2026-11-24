const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Sanitize a single path segment (file or folder name) safely for Windows NTFS.
 */
export function sanitizeSegment(input: string, fallback = 'untitled', maxLength = 120): string {
  let clean = (input || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');

  if (!clean || clean === '.' || clean === '..') {
    clean = fallback;
  }
  if (WINDOWS_RESERVED.test(clean)) {
    clean = `_${clean}`;
  }
  if (clean.length > maxLength) {
    clean = clean.slice(0, maxLength).trim().replace(/[. ]+$/g, '');
  }
  return clean || fallback;
}

/**
 * Verify a candidate path does not contain traversal segments.
 */
export function isSafeSubpath(subpath: string): boolean {
  if (!subpath) return true;
  if (subpath.includes('\0')) return false;
  const parts = subpath.split(/[\\/]+/);
  return parts.every((part) => part !== '..' && !/^[a-zA-Z]:/.test(part));
}

export function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function formatDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}
