import {
  DEFAULT_ENGINE_PORT,
  NATIVE_HOST_NAME,
  isYouTubeUrl,
  type CookiePayloadItem,
  type ExtensionMessage,
  type NativeResponse,
} from '@tubevault/shared';

interface EngineConnection {
  ok: boolean;
  baseUrl?: string;
  token?: string;
  port?: number;
  via?: 'native' | 'dev';
  error?: string;
}

let cachedConn: { baseUrl: string; token: string; port: number; via: 'native' | 'dev' } | null = null;

// Open Side Panel when clicking the toolbar extension icon
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

// Register context menu on YouTube links & pages
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'tubevault-download-link',
      title: 'Tải bằng TubeVault',
      contexts: ['link', 'page'],
      documentUrlPatterns: ['*://*.youtube.com/*', '*://music.youtube.com/*', '*://youtu.be/*'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'tubevault-download-link') return;
  const targetUrl = info.linkUrl && isYouTubeUrl(info.linkUrl) ? info.linkUrl : info.pageUrl || tab?.url;
  if (!targetUrl) return;
  await openSidePanelWithUrl(targetUrl, tab?.windowId);
});

async function openSidePanelWithUrl(url: string, windowId?: number, forcePlaylist?: boolean): Promise<void> {
  await chrome.storage.session.set({
    pendingUrl: { url, forcePlaylist: Boolean(forcePlaylist), ts: Date.now() },
  });

  if (windowId != null && chrome.sidePanel?.open) {
    try {
      await chrome.sidePanel.open({ windowId });
    } catch {
      // Side panel may already be open or require direct user gesture
    }
  }

  chrome.runtime
    .sendMessage({ type: 'PENDING_URL_AVAILABLE', url, forcePlaylist } satisfies ExtensionMessage)
    .catch(() => {
      // Side panel not mounted yet; it will pick up pendingUrl from chrome.storage.session on mount
    });
}

async function verifyHealth(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`${baseUrl}/api/v1/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveEngineConnection(): Promise<EngineConnection> {
  if (cachedConn && (await verifyHealth(cachedConn.baseUrl))) {
    return { ok: true, ...cachedConn };
  }
  cachedConn = null;

  // 1. Primary path: Chrome Native Messaging Host auto-starts Engine securely & provides session token
  try {
    const nativeRes = await new Promise<NativeResponse>((resolve, reject) => {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'ensure_server' }, (response: NativeResponse) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });

    if (nativeRes?.ok && nativeRes.port && nativeRes.token) {
      cachedConn = {
        baseUrl: `http://127.0.0.1:${nativeRes.port}`,
        token: nativeRes.token,
        port: nativeRes.port,
        via: 'native',
      };
      return { ok: true, ...cachedConn };
    }
  } catch {
    // Fall through to dev handshake fallback if developer runs `npm run dev:engine` without Native Host
  }

  // 2. Dev fallback: connect to local engine running with --dev on default port
  try {
    const devBase = `http://127.0.0.1:${DEFAULT_ENGINE_PORT}`;
    const res = await fetch(`${devBase}/api/v1/dev/handshake`);
    if (res.ok) {
      const data = (await res.json()) as { port: number; token: string };
      if (data.token && data.port) {
        cachedConn = {
          baseUrl: `http://127.0.0.1:${data.port}`,
          token: data.token,
          port: data.port,
          via: 'dev',
        };
        return { ok: true, ...cachedConn };
      }
    }
  } catch {
    // Engine not running in dev mode either
  }

  return {
    ok: false,
    error:
      'Không kết nối được TubeVault Local Engine. Hãy cài đặt TubeVault Setup.exe hoặc chạy "npm run dev:engine" trên máy.',
  };
}

async function syncYouTubeCookies(): Promise<{ ok: boolean; count?: number; error?: string }> {
  const hasPerm = await chrome.permissions.contains({ permissions: ['cookies'] });
  if (!hasPerm) {
    return { ok: false, error: 'Chưa được cấp quyền đọc cookies Chrome.' };
  }

  const conn = await resolveEngineConnection();
  if (!conn.ok || !conn.baseUrl || !conn.token) {
    return { ok: false, error: conn.error || 'Engine chưa chạy.' };
  }

  const ytCookies = await chrome.cookies.getAll({ domain: 'youtube.com' });
  const googleCookies = await chrome.cookies.getAll({ domain: 'google.com' });

  const combined: CookiePayloadItem[] = [...ytCookies, ...googleCookies].map((c) => ({
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    expirationDate: c.expirationDate,
    name: c.name,
    value: c.value,
    hostOnly: c.hostOnly,
  }));

  const res = await fetch(`${conn.baseUrl}/api/v1/cookies/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': conn.token,
    },
    body: JSON.stringify({ cookies: combined }),
  });

  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: `Đồng bộ cookies thất bại: ${err}` };
  }
  const data = (await res.json()) as { count: number };
  return { ok: true, count: data.count };
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage | { type: 'UPDATE_BADGE'; count: number }, sender, sendResponse) => {
  if (message.type === 'OPEN_SIDEPANEL_WITH_URL') {
    void openSidePanelWithUrl(message.url, sender.tab?.windowId, message.forcePlaylist).then(() =>
      sendResponse({ ok: true })
    );
    return true;
  }

  if (message.type === 'GET_ENGINE_CONNECTION') {
    void resolveEngineConnection().then(sendResponse);
    return true;
  }

  if (message.type === 'CHECK_COOKIES_PERMISSION') {
    void chrome.permissions.contains({ permissions: ['cookies'] }).then((granted) => sendResponse({ granted }));
    return true;
  }

  if (message.type === 'SYNC_YOUTUBE_COOKIES') {
    void syncYouTubeCookies().then(sendResponse);
    return true;
  }

  if (message.type === 'GET_ACTIVE_TAB_URL') {
    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      sendResponse({ url: tabs[0]?.url || '' });
    });
    return true;
  }

  if (message.type === 'UPDATE_BADGE') {
    const count = message.count || 0;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#e11d48' }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
