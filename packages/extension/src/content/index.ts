import { parseYouTubeUrl, type ExtensionMessage } from '@tubevault/shared';

const HOST_ID = 'tubevault-injected-btn-host';

let lastUrl = '';
let debounceTimer: number | null = null;

function isDarkMode(): boolean {
  return (
    document.documentElement.hasAttribute('dark') ||
    location.hostname === 'music.youtube.com' ||
    getComputedStyle(document.body).backgroundColor === 'rgb(15, 15, 15)'
  );
}

function getButtonLabel(url: string): { label: string; badge: string } | null {
  const parsed = parseYouTubeUrl(url);
  if (!parsed.valid) return null;

  if (parsed.sourceType === 'album') {
    return { label: 'Tải Album', badge: 'Album' };
  }
  if (parsed.sourceType === 'playlist') {
    return { label: 'Tải Playlist', badge: 'List' };
  }
  if (parsed.sourceType === 'channel') {
    return { label: 'Tải Kênh', badge: 'Channel' };
  }
  if (parsed.isShort) {
    return { label: 'Tải Short', badge: 'Short' };
  }
  return { label: 'Tải Video', badge: '4K/MP3' };
}

function findInlineMountPoint(sourceType: string): Element | null {
  if (location.hostname === 'music.youtube.com') return null;

  if (sourceType === 'single') {
    return (
      document.querySelector('ytd-watch-metadata #top-level-buttons-computed') ||
      document.querySelector('ytd-watch-metadata #actions-inner #menu')
    );
  }
  if (sourceType === 'playlist' || sourceType === 'album') {
    return (
      document.querySelector('ytd-playlist-header-renderer .metadata-buttons-wrapper') ||
      document.querySelector('yt-page-header-view-model .yt-flexible-actions-view-model-wiz__action-row')
    );
  }
  if (sourceType === 'channel') {
    return (
      document.querySelector('yt-page-header-view-model .yt-flexible-actions-view-model-wiz__action-row') ||
      document.querySelector('#channel-header #buttons')
    );
  }
  return null;
}

function removeExistingHost(): void {
  document.getElementById(HOST_ID)?.remove();
}

function renderButton(): void {
  const currentUrl = window.location.href;
  const parsed = parseYouTubeUrl(currentUrl);
  const info = getButtonLabel(currentUrl);

  if (!parsed.valid || !info) {
    removeExistingHost();
    return;
  }

  const inlineTarget = findInlineMountPoint(parsed.sourceType);
  const existing = document.getElementById(HOST_ID);

  // If already mounted in the right container and URL matches, skip re-render
  if (existing && existing.dataset.url === currentUrl) {
    if ((inlineTarget && existing.parentElement === inlineTarget) || (!inlineTarget && existing.dataset.mode === 'floating')) {
      return;
    }
  }

  removeExistingHost();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.dataset.url = currentUrl;
  host.dataset.mode = inlineTarget ? 'inline' : 'floating';

  if (inlineTarget) {
    host.style.display = 'inline-flex';
    host.style.alignItems = 'center';
    host.style.marginLeft = '8px';
    host.style.verticalAlign = 'middle';
  } else {
    host.style.position = 'fixed';
    host.style.right = '20px';
    host.style.bottom = '20px';
    host.style.zIndex = '2147483640';
  }

  const shadow = host.attachShadow({ mode: 'open' });
  const dark = isDarkMode();

  shadow.innerHTML = `
    <style>
      .tv-wrap {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-family: "Roboto", "Segoe UI", system-ui, sans-serif;
      }
      .tv-btn {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        height: 36px;
        padding: 0 14px;
        border: none;
        border-radius: 18px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        color: #ffffff;
        background: linear-gradient(135deg, #e11d48, #be123c);
        box-shadow: ${inlineTarget ? '0 1px 4px rgba(225,29,72,0.35)' : '0 6px 20px rgba(0,0,0,0.45)'};
        transition: transform 0.14s ease, filter 0.14s ease;
        white-space: nowrap;
      }
      .tv-btn:hover {
        filter: brightness(1.1);
        transform: translateY(-1px);
      }
      .tv-btn:active {
        transform: translateY(0);
      }
      .tv-btn-secondary {
        height: 36px;
        padding: 0 12px;
        border-radius: 18px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        border: 1px solid ${dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'};
        background: ${dark ? 'rgba(24,24,27,0.9)' : 'rgba(255,255,255,0.95)'};
        color: ${dark ? '#f8fafc' : '#0f172a'};
        transition: filter 0.14s ease;
      }
      .tv-btn-secondary:hover {
        filter: brightness(1.08);
      }
      svg {
        width: 15px;
        height: 15px;
        fill: currentColor;
        flex-shrink: 0;
      }
    </style>
    <div class="tv-wrap">
      <button class="tv-btn" id="tv-main-btn" title="Mở TubeVault để tải ${info.label}">
        <svg viewBox="0 0 24 24"><path d="M12 3a1 1 0 0 1 1 1v9.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42L11 13.59V4a1 1 0 0 1 1-1zm-7 15a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1z"/></svg>
        <span>${info.label}</span>
      </button>
      ${
        parsed.hasEmbeddedPlaylist
          ? `<button class="tv-btn-secondary" id="tv-playlist-btn" title="Quét toàn bộ Playlist chứa video này">Cả Playlist</button>`
          : ''
      }
    </div>
  `;

  shadow.getElementById('tv-main-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    chrome.runtime.sendMessage({
      type: 'OPEN_SIDEPANEL_WITH_URL',
      url: currentUrl,
      forcePlaylist: false,
    } satisfies ExtensionMessage);
  });

  shadow.getElementById('tv-playlist-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    chrome.runtime.sendMessage({
      type: 'OPEN_SIDEPANEL_WITH_URL',
      url: parsed.playlistUrl || currentUrl,
      forcePlaylist: true,
    } satisfies ExtensionMessage);
  });

  if (inlineTarget) {
    inlineTarget.appendChild(host);
  } else {
    document.body.appendChild(host);
  }
}

function scheduleRender(): void {
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
  }
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    renderButton();
  }, 350);
}

// Listen to YouTube SPA navigation & DOM mutations
window.addEventListener('yt-navigate-finish', scheduleRender);
window.addEventListener('popstate', scheduleRender);

const observer = new MutationObserver(() => {
  if (window.location.href !== lastUrl || !document.getElementById(HOST_ID)) {
    lastUrl = window.location.href;
    scheduleRender();
  }
});

observer.observe(document.documentElement, { childList: true, subtree: true });
scheduleRender();
