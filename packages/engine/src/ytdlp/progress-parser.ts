export interface ParsedProgressLine {
  kind: 'progress' | 'postprocess' | 'final';
  status?: string;
  phase?: string;
  progressPct?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBps?: number;
  etaSec?: number;
  finalPath?: string;
}

function parseOptionalNumber(raw?: string): number | undefined {
  if (!raw || raw === 'NA' || raw === 'None' || raw === 'null') return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

export function parseYtdlpStdoutLine(line: string): ParsedProgressLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('TVFINAL|')) {
    const finalPath = trimmed.slice('TVFINAL|'.length).trim();
    if (finalPath && finalPath !== 'NA') {
      return { kind: 'final', finalPath };
    }
    return null;
  }

  if (trimmed.startsWith('TVPOST|')) {
    const [, status, postprocessor] = trimmed.split('|');
    const pp = (postprocessor || '').toLowerCase();
    let phase = 'postprocessing';
    if (pp.includes('merger')) phase = 'merging';
    else if (pp.includes('extractaudio')) phase = 'audio_convert';
    else if (pp.includes('thumb')) phase = 'thumbnail';
    else if (pp.includes('meta')) phase = 'metadata';

    return {
      kind: 'postprocess',
      status: status || 'started',
      phase,
    };
  }

  if (trimmed.startsWith('TVPROG|')) {
    const [, status, dlRaw, totalRaw, estRaw, speedRaw, etaRaw, extRaw] = trimmed.split('|');
    const downloadedBytes = parseOptionalNumber(dlRaw) ?? 0;
    const totalBytes = parseOptionalNumber(totalRaw) ?? parseOptionalNumber(estRaw);
    const speedBps = parseOptionalNumber(speedRaw);
    const etaSec = parseOptionalNumber(etaRaw);
    const ext = (extRaw || '').toLowerCase();

    let progressPct = 0;
    if (status === 'finished') {
      progressPct = 100;
    } else if (totalBytes && totalBytes > 0) {
      progressPct = Math.min(99.9, Math.round((downloadedBytes / totalBytes) * 1000) / 10);
    }

    const isAudioStream = ext === 'm4a' || ext === 'webm' || ext === 'opus' || ext === 'mp3';
    return {
      kind: 'progress',
      status: status || 'downloading',
      phase: isAudioStream ? 'audio' : 'video',
      progressPct,
      downloadedBytes,
      totalBytes,
      speedBps,
      etaSec,
    };
  }

  return null;
}

export function classifyYtdlpError(stderr: string): { code: string; message: string } {
  const text = stderr || '';
  const lower = text.toLowerCase();

  if (lower.includes("confirm you're not a bot") || lower.includes('sign in to confirm')) {
    return {
      code: 'BOT_CHECK',
      message: 'YouTube yêu cầu xác minh không phải bot. Hãy bật "Dùng Cookies Chrome" trong Cài đặt và thử lại.',
    };
  }
  if (lower.includes('http error 429') || lower.includes('too many requests')) {
    return {
      code: 'RATE_LIMIT',
      message: 'YouTube đang giới hạn tần suất (429). Hãy tăng khoảng nghỉ hoặc giảm số luồng tải đồng thời.',
    };
  }
  if (lower.includes('sign in to confirm your age') || lower.includes('age-restricted')) {
    return {
      code: 'AGE_RESTRICTED',
      message: 'Video giới hạn độ tuổi. Hãy bật "Dùng Cookies Chrome" trong Cài đặt.',
    };
  }
  if (lower.includes('private video') || lower.includes('members-only') || lower.includes('join this channel')) {
    return {
      code: 'PRIVATE_VIDEO',
      message: 'Video riêng tư hoặc dành riêng cho hội viên. Cần đăng nhập tài khoản có quyền xem và bật Cookies Chrome.',
    };
  }
  if (lower.includes('video unavailable') || lower.includes('has been removed')) {
    return {
      code: 'UNAVAILABLE',
      message: 'Video không tồn tại hoặc đã bị gỡ khỏi YouTube.',
    };
  }
  if (lower.includes('ffmpeg') && lower.includes('not found')) {
    return {
      code: 'FFMPEG_MISSING',
      message: 'Chưa tìm thấy FFmpeg. Vào Cài đặt để tải FFmpeg tự động.',
    };
  }
  if (lower.includes('unable to download') || lower.includes('timed out') || lower.includes('getaddrinfo')) {
    return {
      code: 'NETWORK',
      message: 'Lỗi kết nối mạng khi tải từ YouTube. Hãy thử lại.',
    };
  }

  const lastErrorLine =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('ERROR:'))
      .pop() || text.trim().slice(-240);

  return {
    code: 'UNKNOWN',
    message: lastErrorLine || 'Tải thất bại với lỗi không xác định.',
  };
}
