/**
 * popup.js —— 设置界面
 *
 * CSP 要求：MV3 扩展页面禁止内联脚本和 eval，
 * 所以逻辑全放在这个外部文件里。
 */

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  server: 'http://150.158.49.37',
  token: '',
};

function setStatus(kind, text) {
  $('dot').className = 'dot ' + kind;
  $('statusText').textContent = text;
}

function showMsg(kind, html) {
  const el = $('msg');
  el.className = 'msg ' + kind;
  el.innerHTML = html;
  if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3500);
}

function hideMsg() {
  $('msg').classList.add('hidden');
}

/** 规范化服务器地址：去尾斜杠、补协议 */
function normalizeServer(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/+$/, '');
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  $('server').value = s.server || DEFAULTS.server;
  $('token').value = s.token || '';
  if (s.token) check();
  else setStatus('warn', '请先填入令牌');
}

/** 测试连接 */
async function check() {
  setStatus('warn', '检查中…');
  const r = await chrome.runtime.sendMessage({ type: 'STATUS' });

  if (r && r.connected) {
    const resume = r.hasResume ? '简历已导入' : '还没导入简历';
    setStatus('ok', r.user?.name ? `已连接 · ${r.user.name}` : '已连接');
    $('statusText').textContent = `已连接 · ${r.user?.name || ''}（${resume}）`;
    if (!r.hasResume) {
      showMsg('info', '账号还没导入简历，评分会不准。请先到网站「我的简历」导入。');
    } else {
      hideMsg();
    }
    return true;
  }

  const reason = r?.error || (r?.reason === 'no-token' ? '没填令牌' : '连接失败');
  setStatus('err', reason);
  return false;
}

$('save').addEventListener('click', async () => {
  const server = normalizeServer($('server').value);
  const token = $('token').value.trim();

  if (!server) return showMsg('err', '请填服务器地址');
  if (!token) return showMsg('err', '请填访问令牌');

  $('server').value = server;
  await chrome.storage.local.set({ server, token });

  $('save').disabled = true;
  $('save').textContent = '连接中…';

  const ok = await check();

  $('save').disabled = false;
  $('save').textContent = '保存并连接';

  if (ok) showMsg('ok', '连接成功。去招聘网站打开一个岗位试试。');
  else showMsg('err', '连接失败，检查地址和令牌是否正确。');
});

$('test').addEventListener('click', async () => {
  const server = normalizeServer($('server').value);
  const token = $('token').value.trim();
  if (!server || !token) return showMsg('err', '先把地址和令牌填上');

  // 先暂存，让 background 用新值测试
  await chrome.storage.local.set({ server, token });

  $('test').disabled = true;
  const ok = await check();
  $('test').disabled = false;
  showMsg(ok ? 'ok' : 'err', ok ? '连接正常' : '连不上，检查地址或令牌');
});

// 回车保存
for (const id of ['server', 'token']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('save').click();
  });
}

load();
