/**
 * background.js —— Service Worker（MV3）
 *
 * 为什么网络请求放这里：
 *   内容脚本运行在页面的隔离世界里，fetch 会带上页面的 Origin，
 *   受 CORS 限制；Service Worker 有 host_permissions，可以跨域直连。
 *
 * 令牌也只存在这里：content script 只能通过消息让 background「代为调用」，
 * 拿不到令牌本身。
 */

const DEFAULTS = {
  server: 'http://150.158.49.37',
  token: '',
};

async function getConfig() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return {
    server: (s.server || DEFAULTS.server).replace(/\/+$/, ''),
    token: s.token || '',
  };
}

/** 带超时的 fetch */
async function fetchJSON(url, { method = 'GET', body, token, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: '服务端返回异常（HTTP ' + res.status + '）' }; }
    if (!res.ok && !data.error) data.error = 'HTTP ' + res.status;
    return data;
  } catch (e) {
    if (e.name === 'AbortError') return { error: '请求超时，检查网络或服务器地址' };
    return { error: '连不上服务器：' + e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ────────── 消息处理 ──────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const { server, token } = await getConfig();

    if (msg.type === 'PING') {
      if (!token) return sendResponse({ connected: false, reason: 'no-token' });
      const r = await fetchJSON(server + '/api/extension/status', { token, timeout: 8000 });
      return sendResponse({
        connected: Boolean(r && r.ok),
        user: r?.user?.name || '',
        hasResume: Boolean(r?.hasResume),
        error: r?.error || '',
      });
    }

    if (msg.type === 'ANALYZE') {
      if (!token) return sendResponse({ error: '还没配置令牌。点扩展图标，填服务器地址和令牌。' });

      const r = await fetchJSON(server + '/api/extension/analyze', {
        method: 'POST',
        token,
        body: {
          text: msg.payload.text,
          url: msg.payload.url,
          title: msg.payload.title || '',
          company: msg.payload.company || '',
          via: 'extension',
        },
        timeout: 30000,
      });

      if (r && r.ok) {
        // 补两个跳到网站深链的地址，省去用户自己翻列表
        r.link = server + '/#/jobs';
        r.prepLink = server + '/#/prep';
      }
      return sendResponse(r);
    }

    if (msg.type === 'STATUS') {
      if (!token) return sendResponse({ connected: false, reason: 'no-token' });
      const r = await fetchJSON(server + '/api/extension/status', { token, timeout: 8000 });
      return sendResponse({ ...r, connected: Boolean(r && r.ok) });
    }

    sendResponse({ error: '未知消息类型' });
  })();

  return true;   // 保持消息通道打开，异步回传
});

// 首次安装时给个默认服务器地址
chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.local.get(['server']);
  if (!s.server) await chrome.storage.local.set({ server: DEFAULTS.server });
});
