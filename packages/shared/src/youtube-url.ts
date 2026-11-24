export type YouTubeSourceType = 'single' | 'playlist' | 'album' | 'channel';
export type ChannelTab = 'videos' | 'shorts' | 'streams';

export interface ParsedYouTubeUrl {
  valid: boolean;
  originalUrl: string;
  normalizedUrl: string;
  sourceType: YouTubeSourceType;
  isMusic: boolean;
  isShort: boolean;
  videoId?: string;
  playlistId?: string;
  channelIdentifier?: string;
  detectedTab?: ChannelTab;
  /** True when URL is a watch URL that also belongs to a playlist (e.g. watch?v=...&list=...) */
  hasEmbeddedPlaylist?: boolean;
  playlistUrl?: string;
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

export function parseYouTubeUrl(rawInput: string): ParsedYouTubeUrl {
  const trimmed = rawInput.trim();
  const invalid: ParsedYouTubeUrl = {
    valid: false,
    originalUrl: rawInput,
    normalizedUrl: trimmed,
    sourceType: 'single',
    isMusic: false,
    isShort: false,
  };

  if (!trimmed) return invalid;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return invalid;
  }

  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return invalid;

  const isMusic = host === 'music.youtube.com';
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const search = url.searchParams;

  // 1. youtu.be/<videoId>
  if (host === 'youtu.be') {
    const videoId = pathname.slice(1).split('/')[0];
    if (!videoId || videoId.length < 6) return invalid;
    const listId = search.get('list') || undefined;
    const isMix = listId ? /^RD/i.test(listId) : false;
    return {
      valid: true,
      originalUrl: rawInput,
      normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
      sourceType: 'single',
      isMusic: false,
      isShort: false,
      videoId,
      playlistId: !isMix ? listId : undefined,
      hasEmbeddedPlaylist: Boolean(listId && !isMix),
      playlistUrl: listId && !isMix ? `https://www.youtube.com/playlist?list=${listId}` : undefined,
    };
  }

  // 2. /shorts/<videoId>
  const shortsMatch = pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,})/);
  if (shortsMatch) {
    const videoId = shortsMatch[1];
    return {
      valid: true,
      originalUrl: rawInput,
      normalizedUrl: `https://www.youtube.com/shorts/${videoId}`,
      sourceType: 'single',
      isMusic,
      isShort: true,
      videoId,
    };
  }

  // 3. /watch?v=<videoId>(&list=<listId>)
  if (pathname === '/watch' || pathname === '/live') {
    const videoId = search.get('v') || undefined;
    const listId = search.get('list') || undefined;
    const isMix = listId ? /^RD/i.test(listId) : false;
    if (videoId) {
      const baseHost = isMusic ? 'https://music.youtube.com' : 'https://www.youtube.com';
      return {
        valid: true,
        originalUrl: rawInput,
        normalizedUrl: `${baseHost}/watch?v=${videoId}`,
        sourceType: 'single',
        isMusic,
        isShort: false,
        videoId,
        playlistId: !isMix ? listId : undefined,
        hasEmbeddedPlaylist: Boolean(listId && !isMix),
        playlistUrl: listId && !isMix ? `${baseHost}/playlist?list=${listId}` : undefined,
      };
    }
  }

  // 4. /live/<videoId>
  const liveMatch = pathname.match(/^\/live\/([A-Za-z0-9_-]{6,})/);
  if (liveMatch) {
    const videoId = liveMatch[1];
    return {
      valid: true,
      originalUrl: rawInput,
      normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
      sourceType: 'single',
      isMusic: false,
      isShort: false,
      videoId,
    };
  }

  // 5. /playlist?list=... or music.youtube.com/browse/MPREb_...
  if (pathname === '/playlist') {
    const listId = search.get('list');
    if (!listId) return invalid;
    const isAlbum = isMusic || listId.startsWith('OLAK5uy_');
    const baseHost = isMusic ? 'https://music.youtube.com' : 'https://www.youtube.com';
    return {
      valid: true,
      originalUrl: rawInput,
      normalizedUrl: `${baseHost}/playlist?list=${listId}`,
      sourceType: isAlbum ? 'album' : 'playlist',
      isMusic,
      isShort: false,
      playlistId: listId,
    };
  }

  if (isMusic && pathname.startsWith('/browse/')) {
    const browseId = pathname.slice('/browse/'.length).split('/')[0];
    if (!browseId) return invalid;
    return {
      valid: true,
      originalUrl: rawInput,
      normalizedUrl: `https://music.youtube.com/browse/${browseId}`,
      sourceType: 'album',
      isMusic: true,
      isShort: false,
      playlistId: browseId,
    };
  }

  // 6. Channel URLs: /@handle, /channel/UC..., /c/name, /user/name
  const channelMatch = pathname.match(
    /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(?:\/(videos|shorts|streams|playlists|featured|releases))?/i
  );
  if (channelMatch) {
    const channelId = channelMatch[1];
    const tabRaw = channelMatch[2]?.toLowerCase();
    let detectedTab: ChannelTab | undefined;
    if (tabRaw === 'videos' || tabRaw === 'shorts' || tabRaw === 'streams') {
      detectedTab = tabRaw;
    }
    const baseHost = isMusic ? 'https://music.youtube.com' : 'https://www.youtube.com';
    return {
      valid: true,
      originalUrl: rawInput,
      normalizedUrl: `${baseHost}/${channelId}`,
      sourceType: 'channel',
      isMusic,
      isShort: false,
      channelIdentifier: channelId,
      detectedTab,
    };
  }

  return invalid;
}

export function isYouTubeUrl(rawInput: string): boolean {
  return parseYouTubeUrl(rawInput).valid;
}
