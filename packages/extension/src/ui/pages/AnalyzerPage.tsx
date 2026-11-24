import React, { useEffect, useMemo, useState } from 'react';
import {
  formatBytes,
  formatDuration,
  parseYouTubeUrl,
  type AnalyzeResult,
  type AppSettings,
  type AudioBitrate,
  type AudioFormat,
  type ChannelTab,
  type DownloadMode,
  type DownloadOptions,
  type VideoContainer,
  type VideoFormatOption,
  type VideoQuality,
} from '@tubevault/shared';
import { client, isExtensionContext } from '../api/client.js';

interface Props {
  settings: AppSettings | null;
  depsReady: boolean;
  incomingUrl?: { url: string; forcePlaylist?: boolean; nonce: number } | null;
  analyzeProgress: { jobId: string; scannedCount: number; message: string } | null;
  onEnqueued: () => void;
  onGoSettings: () => void;
}

function friendlyCodecName(codec?: string): string {
  if (!codec || codec === 'none') return '';
  const c = codec.toLowerCase();
  if (c.startsWith('av01')) return 'AV1';
  if (c.startsWith('vp09') || c.startsWith('vp9')) return 'VP9';
  if (c.startsWith('avc1') || c.startsWith('h264')) return 'H.264';
  if (c.startsWith('mp4a')) return 'AAC';
  if (c.startsWith('opus')) return 'Opus';
  return codec.split('.')[0].toUpperCase();
}

function formatStreamOptionLabel(f: VideoFormatOption): string {
  const parts: string[] = [];
  if (f.hasVideo && f.height) {
    parts.push(`${f.height}p${f.fps && f.fps >= 50 ? `${Math.round(f.fps)}fps` : ''}`);
  } else if (!f.hasVideo && f.hasAudio) {
    parts.push('Audio');
  }
  const codec = f.hasVideo ? friendlyCodecName(f.vcodec) : friendlyCodecName(f.acodec);
  if (codec) parts.push(codec);
  if (f.ext) parts.push(f.ext.toUpperCase());
  if (f.tbr) parts.push(`${Math.round(f.tbr)}k`);
  if (f.filesizeApprox) parts.push(`~${formatBytes(f.filesizeApprox)}`);
  parts.push(`[id:${f.formatId}]`);
  return parts.join(' · ');
}

function extractLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export const AnalyzerPage: React.FC<Props> = ({
  settings,
  depsReady,
  incomingUrl,
  analyzeProgress,
  onEnqueued,
  onGoSettings,
}) => {
  const [urlInput, setUrlInput] = useState('');
  const [multiMode, setMultiMode] = useState(false);
  const [channelTabs, setChannelTabs] = useState<ChannelTab[]>(['videos']);
  const [maxItems, setMaxItems] = useState<number>(200);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);

  // Selection & Filters for Playlist/Album/Channel
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [hideDownloaded, setHideDownloaded] = useState(false);
  const [minDurationMin, setMinDurationMin] = useState('');
  const [maxDurationMin, setMaxDurationMin] = useState('');
  const [rangeInput, setRangeInput] = useState('');

  // Download options
  const [mode, setMode] = useState<DownloadMode>('video');
  const [videoQuality, setVideoQuality] = useState<VideoQuality>(settings?.defaultVideoQuality || '1080p');
  const [videoContainer, setVideoContainer] = useState<VideoContainer>(settings?.defaultContainer || 'mp4');
  const [audioFormat, setAudioFormat] = useState<AudioFormat>(settings?.defaultAudioFormat || 'mp3');
  const [audioBitrate, setAudioBitrate] = useState<AudioBitrate>(settings?.defaultAudioBitrate || '320k');
  const [customFormatId, setCustomFormatId] = useState<string>('');
  const [showAdvancedFormats, setShowAdvancedFormats] = useState(false);
  const [selectedSubs, setSelectedSubs] = useState<string[]>([]);
  const [embedSubs, setEmbedSubs] = useState(false);
  const [embedMetadata, setEmbedMetadata] = useState(settings?.embedMetadata ?? true);
  const [embedThumbnail, setEmbedThumbnail] = useState(settings?.embedThumbnail ?? true);
  const [squareAlbumCover, setSquareAlbumCover] = useState(settings?.squareAlbumCover ?? true);
  const [sponsorBlock, setSponsorBlock] = useState(false);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [skipDownloaded, setSkipDownloaded] = useState(true);
  const [numberPrefix, setNumberPrefix] = useState(true);
  const [trackSource, setTrackSource] = useState(false);
  const [enqueueing, setEnqueueing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setVideoQuality(settings.defaultVideoQuality);
    setVideoContainer(settings.defaultContainer);
    setAudioFormat(settings.defaultAudioFormat);
    setAudioBitrate(settings.defaultAudioBitrate);
    setEmbedMetadata(settings.embedMetadata);
    setEmbedThumbnail(settings.embedThumbnail);
    setSquareAlbumCover(settings.squareAlbumCover);
  }, [settings]);

  const inputLines = useMemo(() => extractLines(urlInput), [urlInput]);
  const validMultiUrls = useMemo(
    () => inputLines.filter((line) => parseYouTubeUrl(line).valid),
    [inputLines]
  );
  const isBatchPaste = validMultiUrls.length > 1;
  const parsedInput = useMemo(() => parseYouTubeUrl(inputLines[0] || ''), [inputLines]);

  useEffect(() => {
    if (incomingUrl?.url) {
      setMultiMode(false);
      setUrlInput(incomingUrl.url);
      if (depsReady) {
        void runAnalyze(incomingUrl.url, incomingUrl.forcePlaylist);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingUrl?.nonce]);

  // Filter stream list according to active mode (Video vs Audio)
  const matchingFormats = useMemo(() => {
    if (!result?.formats) return [];
    return result.formats.filter((f) => (mode === 'video' ? f.hasVideo : !f.hasVideo && f.hasAudio));
  }, [result, mode]);

  const runAnalyze = async (targetUrl?: string, forcePlaylist = false) => {
    const raw = (targetUrl ?? urlInput).trim();
    if (!raw) return;
    if (!depsReady) {
      setError('Cần cài đặt yt-dlp & FFmpeg trước khi phân tích link.');
      return;
    }

    setError(null);
    setToast(null);
    setAnalyzing(true);
    setResult(null);
    setCustomFormatId('');
    setShowAdvancedFormats(false);

    try {
      const lines = extractLines(raw);
      const validLines = lines.filter((l) => parseYouTubeUrl(l).valid);

      let data: AnalyzeResult;
      if (validLines.length > 1 && !forcePlaylist) {
        data = await client.analyzeBatch({ urls: validLines });
      } else {
        const singleUrl = validLines[0] || raw;
        const parsed = parseYouTubeUrl(singleUrl);
        data = await client.analyze({
          url: singleUrl,
          channelTabs: parsed.sourceType === 'channel' ? channelTabs : undefined,
          maxItems: parsed.sourceType === 'single' && !forcePlaylist ? undefined : maxItems || undefined,
          forcePlaylist,
        });
      }

      setResult(data);
      if (data.sourceType === 'album' || data.isMusic) {
        setMode('audio');
      } else {
        setMode('video');
      }
      setTrackSource(data.sourceType === 'channel');
      setNumberPrefix(data.sourceType !== 'single');
      setSelectedSubs([]);
      setSearchTerm('');
      setSelectedIds(new Set(data.items.map((i) => i.videoId)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  };

  const grabCurrentTab = async () => {
    if (!isExtensionContext()) return;
    const res = await new Promise<{ url: string }>((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB_URL' }, (r) => resolve(r || { url: '' }));
    });
    if (res.url) {
      setMultiMode(false);
      setUrlInput(res.url);
      if (parseYouTubeUrl(res.url).valid && depsReady) {
        void runAnalyze(res.url);
      }
    }
  };

  const toggleChannelTab = (tab: ChannelTab) => {
    setChannelTabs((prev) => {
      if (prev.includes(tab)) {
        return prev.length > 1 ? prev.filter((t) => t !== tab) : prev;
      }
      return [...prev, tab];
    });
  };

  const filteredItems = useMemo(() => {
    if (!result) return [];
    const term = searchTerm.trim().toLowerCase();
    const minSec = minDurationMin ? Number(minDurationMin) * 60 : null;
    const maxSec = maxDurationMin ? Number(maxDurationMin) * 60 : null;

    return result.items.filter((item) => {
      if (term && !item.title.toLowerCase().includes(term) && !(item.uploader || '').toLowerCase().includes(term)) {
        return false;
      }
      const isDone = mode === 'audio' ? item.alreadyDownloadedAudio : item.alreadyDownloadedVideo;
      if (hideDownloaded && isDone) return false;
      if (minSec != null && item.durationSec != null && item.durationSec < minSec) return false;
      if (maxSec != null && item.durationSec != null && item.durationSec > maxSec) return false;
      return true;
    });
  }, [result, searchTerm, hideDownloaded, minDurationMin, maxDurationMin, mode]);

  const selectedItems = useMemo(() => {
    if (!result) return [];
    return result.items.filter((item) => selectedIds.has(item.videoId));
  }, [result, selectedIds]);

  const applyRangeSelect = () => {
    if (!result) return;
    const m = rangeInput.trim().match(/^(\d+)\s*[-:]\s*(\d+)$/);
    if (!m) return;
    const start = Math.max(1, Number(m[1]));
    const end = Math.min(result.items.length, Number(m[2]));
    const next = new Set<string>();
    for (let i = start - 1; i < end; i++) {
      const it = result.items[i];
      if (it) next.add(it.videoId);
    }
    setSelectedIds(next);
  };

  const selectTopN = (n: number) => {
    const next = new Set<string>();
    for (const item of filteredItems.slice(0, n)) {
      next.add(item.videoId);
    }
    setSelectedIds(next);
  };

  const resolveEffectiveCustomFormatId = (): string | undefined => {
    if (!customFormatId || result?.sourceType !== 'single') return undefined;
    const chosen = result.formats?.find((f) => f.formatId === customFormatId);
    if (!chosen) return undefined;
    if (mode === 'video' && chosen.hasVideo && !chosen.hasAudio) {
      return `${chosen.formatId}+bestaudio/best`;
    }
    return chosen.formatId;
  };

  const handleStartDownload = async () => {
    if (!result || selectedItems.length === 0) return;
    setEnqueueing(true);
    setError(null);

    try {
      const options: DownloadOptions = {
        mode,
        videoQuality,
        videoContainer,
        audioFormat,
        audioBitrate,
        customFormatId: resolveEffectiveCustomFormatId(),
        subtitleLangs: mode === 'video' && selectedSubs.length > 0 ? selectedSubs : undefined,
        embedSubtitles: mode === 'video' && embedSubs,
        embedMetadata,
        embedThumbnail,
        squareAlbumCover: mode === 'audio' && squareAlbumCover,
        sponsorBlockRemove: sponsorBlock,
        startTime: result.sourceType === 'single' && startTime.trim() ? startTime.trim() : undefined,
        endTime: result.sourceType === 'single' && endTime.trim() ? endTime.trim() : undefined,
        skipDownloaded,
        numberPrefix: result.sourceType !== 'single' && numberPrefix,
        useCookies: settings?.useCookies,
      };

      await client.createDownloads({
        sourceType: result.sourceType,
        sourceKey: result.sourceKey,
        sourceUrl: result.sourceUrl,
        title: result.title,
        uploader: result.uploader,
        thumbnailUrl: result.thumbnailUrl,
        channelTabs: result.sourceType === 'channel' ? channelTabs : undefined,
        items: selectedItems,
        options,
        trackSource: result.sourceType !== 'single' && !result.sourceKey.startsWith('batch:') && trackSource,
      });

      setToast(`Đã đưa ${selectedItems.length} mục vào hàng đợi tải!`);
      onEnqueued();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnqueueing(false);
    }
  };

  const showMultilineBox = multiMode || inputLines.length > 1;

  return (
    <div className="col" style={{ gap: 12 }}>
      {/* URL Input Card */}
      <div className="card col" style={{ gap: 8 }}>
        <div className="row between wrap">
          <span style={{ fontWeight: 700 }}>Dán link Video, Album/Playlist hoặc Kênh YouTube</span>
          <div className="row" style={{ gap: 6 }}>
            <button
              className={`btn sm ${showMultilineBox ? 'primary' : ''}`}
              onClick={() => setMultiMode((v) => !v)}
              disabled={analyzing}
              title="Dán nhiều đường dẫn YouTube cùng lúc (mỗi dòng 1 link)"
            >
              {showMultilineBox ? '1 link' : 'Dán nhiều link'}
            </button>
            {isExtensionContext() && (
              <button className="btn sm" onClick={grabCurrentTab} disabled={analyzing}>
                Lấy tab hiện tại
              </button>
            )}
          </div>
        </div>

        <div className="row" style={{ alignItems: 'flex-start' }}>
          <textarea
            className="textarea"
            rows={showMultilineBox ? 4 : 1}
            placeholder={
              showMultilineBox
                ? 'Dán mỗi dòng 1 đường dẫn YouTube (Video, Shorts hoặc Playlist)...\nhttps://www.youtube.com/watch?v=...\nhttps://youtu.be/...'
                : 'https://www.youtube.com/watch?v=... | /playlist?list=... | /@TenKenh'
            }
            value={urlInput}
            onChange={(e) => {
              const val = e.target.value;
              setUrlInput(val);
              if (val.includes('\n')) setMultiMode(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !showMultilineBox) {
                e.preventDefault();
                void runAnalyze();
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void runAnalyze();
              }
            }}
          />
          <button
            className="btn primary"
            style={{ height: 36 }}
            onClick={() => void runAnalyze()}
            disabled={analyzing || !urlInput.trim()}
          >
            {analyzing ? 'Đang quét...' : 'Phân tích'}
          </button>
        </div>

        {/* Dynamic hint for batch paste vs single URL */}
        {isBatchPaste ? (
          <div className="row between wrap">
            <span className="badge blue">
              Phát hiện {validMultiUrls.length} link YouTube hợp lệ (phân tích hàng loạt)
            </span>
            <span className="muted">Nhấn Ctrl+Enter hoặc bấm Phân tích</span>
          </div>
        ) : (
          urlInput.trim() &&
          parsedInput.valid && (
            <div className="row wrap between">
              <div className="row wrap">
                <span className="badge blue">
                  {parsedInput.sourceType === 'single'
                    ? parsedInput.isShort
                      ? 'YouTube Short'
                      : 'Video đơn'
                    : parsedInput.sourceType === 'album'
                      ? 'Album Nhạc'
                      : parsedInput.sourceType === 'playlist'
                        ? 'Playlist'
                        : 'Kênh YouTube'}
                </span>

                {parsedInput.sourceType === 'channel' && (
                  <>
                    {(['videos', 'shorts', 'streams'] as ChannelTab[]).map((tab) => (
                      <button
                        key={tab}
                        className={`chip ${channelTabs.includes(tab) ? 'active' : ''}`}
                        onClick={() => toggleChannelTab(tab)}
                      >
                        /{tab}
                      </button>
                    ))}
                  </>
                )}
              </div>

              {parsedInput.sourceType !== 'single' && (
                <div className="row" style={{ gap: 6 }}>
                  <span className="muted">Quét tối đa:</span>
                  <select
                    className="select"
                    style={{ width: 'auto', padding: '4px 8px', fontSize: 11 }}
                    value={maxItems}
                    onChange={(e) => setMaxItems(Number(e.target.value))}
                  >
                    <option value={50}>50 mục</option>
                    <option value={200}>200 mục</option>
                    <option value={500}>500 mục</option>
                    <option value={2000}>2.000 mục</option>
                    <option value={0}>Toàn bộ</option>
                  </select>
                </div>
              )}
            </div>
          )
        )}

        {analyzing && (
          <div className="banner info">
            <div>
              <strong>{analyzeProgress?.message || 'Đang kết nối YouTube phân tích dữ liệu...'}</strong>
              {analyzeProgress && analyzeProgress.scannedCount > 0 && (
                <div className="muted">Đã tìm thấy {analyzeProgress.scannedCount} mục</div>
              )}
            </div>
            {analyzeProgress?.jobId && (
              <button
                className="btn sm danger"
                onClick={() => void client.cancelAnalyze(analyzeProgress.jobId)}
              >
                Hủy quét
              </button>
            )}
          </div>
        )}

        {error && (
          <div className="banner err">
            <span>{error}</span>
            {!depsReady && (
              <button className="btn sm" onClick={onGoSettings}>
                Mở Cài đặt
              </button>
            )}
          </div>
        )}

        {toast && <div className="banner ok">{toast}</div>}
      </div>

      {/* Analysis Result */}
      {result && (
        <div className="card col" style={{ gap: 12 }}>
          <div className="media-preview">
            {result.thumbnailUrl && <img className="media-thumb" src={result.thumbnailUrl} alt="" />}
            <div className="col" style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="badge red">
                  {result.sourceType === 'single'
                    ? 'VIDEO'
                    : result.sourceType === 'album'
                      ? 'ALBUM'
                      : result.sourceType === 'playlist'
                        ? result.sourceKey.startsWith('batch:')
                          ? 'NHIỀU LINK'
                          : 'PLAYLIST'
                        : 'KÊNH'}
                </span>
                {result.items.length > 1 && <span className="badge gray">{result.items.length} mục</span>}
                {result.sourceType === 'single' && result.items[0]?.durationSec && (
                  <span className="badge gray">{formatDuration(result.items[0].durationSec)}</span>
                )}
              </div>
              <div style={{ fontWeight: 700, fontSize: 14 }} className="truncate" title={result.title}>
                {result.title}
              </div>
              {result.uploader && <div className="muted">{result.uploader}</div>}
            </div>
          </div>

          {result.sourceType === 'single' && result.hasEmbeddedPlaylist && result.embeddedPlaylistUrl && (
            <div className="banner info">
              <span>Video này đang nằm trong một danh sách phát (Playlist / Album).</span>
              <button
                className="btn sm primary"
                onClick={() => void runAnalyze(result.embeddedPlaylistUrl, true)}
              >
                Quét toàn bộ Playlist
              </button>
            </div>
          )}

          {/* Mode & Quality Options */}
          <div className="col" style={{ gap: 10 }}>
            <div className="row between wrap">
              <div className="segmented">
                <button
                  className={mode === 'video' ? 'active' : ''}
                  onClick={() => {
                    setMode('video');
                    setCustomFormatId('');
                  }}
                >
                  Video (MP4/MKV)
                </button>
                <button
                  className={mode === 'audio' ? 'active' : ''}
                  onClick={() => {
                    setMode('audio');
                    setCustomFormatId('');
                  }}
                >
                  Chỉ Âm thanh (MP3/M4A)
                </button>
              </div>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={skipDownloaded}
                  onChange={(e) => setSkipDownloaded(e.target.checked)}
                />
                Bỏ qua mục đã tải
              </label>
            </div>

            {mode === 'video' ? (
              <div className="grid-2">
                <div>
                  <label className="field-label">Chất lượng tối đa</label>
                  <select
                    className="select"
                    value={videoQuality}
                    disabled={Boolean(customFormatId)}
                    onChange={(e) => setVideoQuality(e.target.value as VideoQuality)}
                  >
                    {(result.availableQualities || ['best', '2160p', '1440p', '1080p', '720p', '480p', '360p']).map(
                      (q) => (
                        <option key={q} value={q}>
                          {q === 'best'
                            ? 'Tốt nhất (tự chọn 4K/8K)'
                            : q === '2160p'
                              ? '4K (2160p)'
                              : q === '1440p'
                                ? '2K (1440p)'
                                : q}
                        </option>
                      )
                    )}
                  </select>
                </div>
                <div>
                  <label className="field-label">Định dạng file</label>
                  <select
                    className="select"
                    value={videoContainer}
                    onChange={(e) => setVideoContainer(e.target.value as VideoContainer)}
                  >
                    <option value="mp4">MP4 (tương thích mọi máy)</option>
                    <option value="mkv">MKV (giữ nguyên codec gốc)</option>
                    <option value="webm">WebM</option>
                  </select>
                </div>
              </div>
            ) : (
              <div className="grid-2">
                <div>
                  <label className="field-label">Định dạng âm thanh</label>
                  <select
                    className="select"
                    value={audioFormat}
                    onChange={(e) => setAudioFormat(e.target.value as AudioFormat)}
                  >
                    <option value="mp3">MP3 (phổ biến nhất)</option>
                    <option value="m4a">M4A / AAC (nhẹ, Apple/Android)</option>
                    <option value="opus">Opus (chất lượng cao gốc YouTube)</option>
                    <option value="flac">FLAC (không nén)</option>
                  </select>
                </div>
                <div>
                  <label className="field-label">Bitrate</label>
                  <select
                    className="select"
                    value={audioBitrate}
                    onChange={(e) => setAudioBitrate(e.target.value as AudioBitrate)}
                  >
                    <option value="320k">320 kbps (cao nhất)</option>
                    <option value="256k">256 kbps</option>
                    <option value="192k">192 kbps</option>
                    <option value="128k">128 kbps</option>
                    <option value="best">Tự động tốt nhất</option>
                  </select>
                </div>
              </div>
            )}

            {/* Advanced Stream / Codec Picker (H.264 / VP9 / AV1 / 60fps) */}
            {result.sourceType === 'single' && matchingFormats.length > 0 && (
              <div className="col" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn sm"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => setShowAdvancedFormats((v) => !v)}
                >
                  {showAdvancedFormats
                    ? 'Ẩn chọn stream / codec nâng cao'
                    : `Nâng cao: Chọn stream / codec cụ thể (${matchingFormats.length} luồng)`}
                </button>

                {showAdvancedFormats && (
                  <div>
                    <label className="field-label">
                      Chọn luồng cụ thể (AV1 / VP9 / H.264 / 60fps — tự động ghép âm thanh tốt nhất nếu luồng chỉ có hình)
                    </label>
                    <select
                      className="select"
                      value={customFormatId}
                      onChange={(e) => setCustomFormatId(e.target.value)}
                    >
                      <option value="">Tự động theo chất lượng chọn ở trên (Khuyên dùng)</option>
                      {matchingFormats.map((f) => (
                        <option key={f.formatId} value={f.formatId}>
                          {formatStreamOptionLabel(f)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* Subtitles for Single Video */}
            {mode === 'video' && result.sourceType === 'single' && result.subtitles && result.subtitles.length > 0 && (
              <div className="col" style={{ gap: 6 }}>
                <div className="row between">
                  <span className="field-label" style={{ margin: 0 }}>
                    Phụ đề (tùy chọn)
                  </span>
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={embedSubs}
                      onChange={(e) => setEmbedSubs(e.target.checked)}
                    />
                    Nhúng thẳng vào video
                  </label>
                </div>
                <div className="row wrap">
                  {result.subtitles.slice(0, 10).map((sub) => {
                    const active = selectedSubs.includes(sub.lang);
                    return (
                      <button
                        key={`${sub.lang}-${sub.isAuto}`}
                        className={`chip ${active ? 'active' : ''}`}
                        onClick={() =>
                          setSelectedSubs((prev) =>
                            prev.includes(sub.lang) ? prev.filter((l) => l !== sub.lang) : [...prev, sub.lang]
                          )
                        }
                      >
                        {sub.lang}
                        {sub.isAuto ? ' (auto)' : ''}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Trim for Single Video */}
            {result.sourceType === 'single' && (
              <div className="grid-2">
                <div>
                  <label className="field-label">Cắt từ (tùy chọn, VD: 00:01:10)</label>
                  <input
                    className="input"
                    placeholder="00:00:00"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label">Đến (tùy chọn, VD: 00:03:45)</label>
                  <input
                    className="input"
                    placeholder="Hết video"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* Extra Metadata / Album / Channel options */}
            <div className="row wrap" style={{ gap: 12 }}>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={embedMetadata}
                  onChange={(e) => setEmbedMetadata(e.target.checked)}
                />
                Nhúng Metadata (Artist/Album)
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={embedThumbnail}
                  onChange={(e) => setEmbedThumbnail(e.target.checked)}
                />
                Nhúng ảnh bìa
              </label>
              {mode === 'audio' && (
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={squareAlbumCover}
                    onChange={(e) => setSquareAlbumCover(e.target.checked)}
                  />
                  Cắt vuông ảnh bìa Album
                </label>
              )}
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={sponsorBlock}
                  onChange={(e) => setSponsorBlock(e.target.checked)}
                />
                Bỏ quảng cáo (SponsorBlock)
              </label>
              {result.sourceType !== 'single' && (
                <>
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={numberPrefix}
                      onChange={(e) => setNumberPrefix(e.target.checked)}
                    />
                    Đánh số thứ tự (01 - ...)
                  </label>
                  {!result.sourceKey.startsWith('batch:') && (
                    <label className="toggle-label">
                      <input
                        type="checkbox"
                        checked={trackSource}
                        onChange={(e) => setTrackSource(e.target.checked)}
                      />
                      Lưu theo dõi để cập nhật video mới
                    </label>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Multi-item Picker for Playlist / Album / Channel / Batch Links */}
          {result.sourceType !== 'single' && (
            <div className="col" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div className="row wrap between">
                <strong>
                  Danh sách ({selectedItems.length} / {result.items.length} đã chọn)
                </strong>
                <div className="row wrap" style={{ gap: 4 }}>
                  <button
                    className="btn sm"
                    onClick={() => setSelectedIds(new Set(filteredItems.map((i) => i.videoId)))}
                  >
                    Chọn hết ({filteredItems.length})
                  </button>
                  <button className="btn sm" onClick={() => setSelectedIds(new Set())}>
                    Bỏ chọn
                  </button>
                  <button className="btn sm" onClick={() => selectTopN(10)}>
                    10 mới nhất
                  </button>
                  <button className="btn sm" onClick={() => selectTopN(50)}>
                    50 mới nhất
                  </button>
                </div>
              </div>

              <div className="row wrap">
                <input
                  className="input"
                  style={{ flex: 2, minWidth: 140 }}
                  placeholder="Lọc theo từ khóa tiêu đề..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <input
                  className="input"
                  style={{ width: 82 }}
                  type="number"
                  min={0}
                  placeholder="Min phút"
                  value={minDurationMin}
                  onChange={(e) => setMinDurationMin(e.target.value)}
                />
                <input
                  className="input"
                  style={{ width: 84 }}
                  type="number"
                  min={0}
                  placeholder="Max phút"
                  value={maxDurationMin}
                  onChange={(e) => setMaxDurationMin(e.target.value)}
                />
              </div>

              <div className="row wrap between">
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={hideDownloaded}
                    onChange={(e) => setHideDownloaded(e.target.checked)}
                  />
                  Ẩn video đã tải
                </label>

                <div className="row" style={{ gap: 4 }}>
                  <input
                    className="input"
                    style={{ width: 92, padding: '4px 8px', fontSize: 11 }}
                    placeholder="VD: 1-20"
                    value={rangeInput}
                    onChange={(e) => setRangeInput(e.target.value)}
                  />
                  <button className="btn sm" onClick={applyRangeSelect}>
                    Chọn khoảng
                  </button>
                </div>
              </div>

              <div className="item-list">
                {filteredItems.map((item) => {
                  const checked = selectedIds.has(item.videoId);
                  const alreadyDone =
                    mode === 'audio' ? item.alreadyDownloadedAudio : item.alreadyDownloadedVideo;

                  return (
                    <label
                      key={item.videoId}
                      className={`item-row ${checked ? 'selected' : ''}`}
                      style={{ cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.videoId)) next.delete(item.videoId);
                            else next.add(item.videoId);
                            return next;
                          });
                        }}
                      />
                      {item.thumbnailUrl && (
                        <img className="media-thumb sm" src={item.thumbnailUrl} alt="" loading="lazy" />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="truncate" style={{ fontWeight: 600 }} title={item.title}>
                          {item.playlistIndex != null ? `${item.playlistIndex}. ` : ''}
                          {item.title}
                        </div>
                        <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
                          <span className="muted">{formatDuration(item.durationSec)}</span>
                          {item.tab && <span className="badge gray">{item.tab}</span>}
                          {alreadyDone && <span className="badge green">Đã tải</span>}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <button
            className="btn primary"
            style={{ width: '100%', padding: '10px 14px', fontSize: 13 }}
            disabled={enqueueing || selectedItems.length === 0}
            onClick={() => void handleStartDownload()}
          >
            {enqueueing
              ? 'Đang thêm vào hàng đợi...'
              : result.sourceType === 'single'
                ? customFormatId
                  ? `Tải xuống (Stream #${customFormatId})`
                  : `Tải xuống (${mode === 'audio' ? audioFormat.toUpperCase() : `${videoQuality.toUpperCase()} ${videoContainer.toUpperCase()}`})`
                : `Bắt đầu tải ${selectedItems.length} mục đã chọn`}
          </button>
        </div>
      )}
    </div>
  );
};
