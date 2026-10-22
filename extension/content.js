/**
 * content.js —— 页面内的交互层
 *
 * 职责：
 *   1. 在招聘页注入一个悬浮按钮
 *   2. 点击后调 extractor 提取 JD
 *   3. 通过 background 调服务端分析
 *   4. 把结果渲染成面板
 *
 * 所有 DOM 都塞进一个 Shadow Root —— 避免和页面样式互相污染
 * （招聘网站自己的 CSS 经常用标签选择器，直接插入会被改得面目全非）。
 */

(() => {
  const HOST_ID = '__jm_shadow_host__';
  let shadow = null;
  let panelOpen = false;

  // 已经注入过就不再重复（SPA 路由切换时会重复执行）
  if (document.getElementById(HOST_ID)) return;

  // ────────── 样式（写在 Shadow 内，与页面完全隔离）──────────

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .wrap {
      font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #0f172a;
    }

    /* 悬浮按钮 */
    .fab {
      position: fixed; right: 22px; bottom: 22px; z-index: 2147483647;
      width: 54px; height: 54px; border: none; border-radius: 50%;
      background: linear-gradient(135deg, #5B8DEF, #3669EC);
      color: #fff; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 6px 22px rgba(54,105,236,.42), 0 2px 6px rgba(0,0,0,.12);
      transition: transform .18s cubic-bezier(.2,.8,.3,1), box-shadow .18s;
    }
    .fab:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 10px 28px rgba(54,105,236,.5); }
    .fab:active { transform: scale(.96); }
    .fab svg { width: 24px; height: 24px; }
    .fab .dot {
      position: absolute; top: 4px; right: 4px; width: 9px; height: 9px;
      background: #22c55e; border: 2px solid #fff; border-radius: 50%;
    }
    .fab .dot.off { background: #f59e0b; }

    /* 面板 */
    .panel {
      position: fixed; right: 22px; bottom: 88px; z-index: 2147483647;
      width: 384px; max-height: calc(100vh - 130px); overflow: auto;
      background: #fff; border-radius: 16px;
      box-shadow: 0 16px 48px rgba(15,23,42,.2), 0 2px 8px rgba(15,23,42,.08);
      border: 1px solid rgba(54,105,236,.12);
      animation: pop .2s cubic-bezier(.2,.8,.3,1);
    }
    @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.98); } }

    .ph {
      padding: 16px 18px; border-bottom: 1px solid #eef2f9;
      display: flex; align-items: center; gap: 10px;
      position: sticky; top: 0; background: #fff; border-radius: 16px 16px 0 0; z-index: 2;
    }
    .ph .logo {
      width: 28px; height: 28px; border-radius: 8px; flex: none;
      background: linear-gradient(135deg, #5B8DEF, #3669EC);
      color: #fff; font-weight: 700; font-size: 13px;
      display: flex; align-items: center; justify-content: center;
    }
    .ph .ttl { font-weight: 600; font-size: 14px; flex: 1; }
    .ph .x {
      border: none; background: transparent; cursor: pointer; color: #94a3b8;
      font-size: 20px; line-height: 1; padding: 2px 6px; border-radius: 6px;
    }
    .ph .x:hover { background: #f1f5f9; color: #475569; }

    .pb { padding: 16px 18px 18px; }

    /* 分数 */
    .score-row { display: flex; align-items: center; gap: 16px; margin-bottom: 6px; }
    .ring { flex: none; position: relative; width: 76px; height: 76px; }
    .ring svg { transform: rotate(-90deg); }
    .ring .num {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
    }
    .ring .n { font-size: 22px; font-weight: 700; line-height: 1; }
    .ring .g { font-size: 10px; font-weight: 700; margin-top: 2px; opacity: .85; }
    .meta { flex: 1; min-width: 0; }
    .meta .pos { font-size: 15px; font-weight: 600; margin-bottom: 3px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta .co { font-size: 12.5px; color: #64748b;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta .tags { margin-top: 7px; display: flex; flex-wrap: wrap; gap: 5px; }
    .tag {
      font-size: 11px; padding: 2px 7px; border-radius: 5px;
      background: #f1f5f9; color: #475569; white-space: nowrap;
    }
    .tag.brand { background: rgba(54,105,236,.1); color: #3669EC; }
    .tag.warn { background: #fef3c7; color: #b45309; }
    .tag.ok { background: #dcfce7; color: #15803d; }

    /* 职级徽章 */
    .lvl {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
    }
    .lvl.up { background: #fee2e2; color: #b91c1c; }
    .lvl.same { background: #dcfce7; color: #15803d; }
    .lvl.down { background: #fef3c7; color: #b45309; }
    .lvl.unknown { background: #f1f5f9; color: #64748b; }
    .lvl-why {
      font-size: 12px; color: #64748b; line-height: 1.6; margin-top: 8px;
      padding: 9px 11px; background: #f8fafc; border-radius: 8px;
    }

    /* 学习成本 */
    .learn-row { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
    .learn-chip {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 11px; padding: 3px 8px; border-radius: 6px;
      background: #fef2f2; color: #b91c1c;
    }
    .learn-chip b { font-weight: 600; opacity: .75; }
    .learn-sum { font-size: 12px; color: #64748b; }
    .learn-sum b { color: #3669EC; }

    /* 维度条 */
    .sec-t { font-size: 11.5px; font-weight: 600; color: #94a3b8; letter-spacing: .04em;
      text-transform: uppercase; margin: 18px 0 9px; }
    .dim { margin-bottom: 9px; }
    .dim .l { display: flex; justify-content: space-between; font-size: 12.5px; margin-bottom: 4px; }
    .dim .l .nm { color: #334155; }
    .dim .l .pc { color: #94a3b8; font-variant-numeric: tabular-nums; }
    .dim .bar { height: 5px; background: #eef2f9; border-radius: 3px; overflow: hidden; }
    .dim .bar i { display: block; height: 100%; border-radius: 3px;
      background: linear-gradient(90deg, #5B8DEF, #3669EC); }

    /* 列表 */
    .li { display: flex; gap: 8px; font-size: 12.5px; line-height: 1.55; margin-bottom: 7px; color: #334155; }
    .li .b { flex: none; width: 4px; height: 4px; border-radius: 50%; margin-top: 7px; background: #3669EC; }
    .li .b.w { background: #f59e0b; }
    .li .txt { flex: 1; min-width: 0; }

    .kws { display: flex; flex-wrap: wrap; gap: 5px; }
    .kw { font-size: 11.5px; padding: 3px 8px; border-radius: 5px;
      background: #fef2f2; color: #b91c1c; }

    /* 按钮 */
    .acts { display: flex; gap: 8px; margin-top: 18px; }
    .btn {
      flex: 1; padding: 9px 0; border-radius: 9px; border: 1px solid #dbe3f0;
      background: #fff; color: #334155; font-size: 13px; font-weight: 500;
      cursor: pointer; text-align: center; text-decoration: none;
      transition: all .15s;
    }
    .btn:hover { border-color: #3669EC; color: #3669EC; }
    .btn.primary {
      background: linear-gradient(135deg, #5B8DEF, #3669EC); color: #fff; border-color: transparent;
    }
    .btn.primary:hover { filter: brightness(1.06); color: #fff; }

    /* 状态 */
    .state { padding: 34px 20px; text-align: center; color: #64748b; font-size: 13px; }
    .state .sp {
      width: 26px; height: 26px; margin: 0 auto 12px; border-radius: 50%;
      border: 2.5px solid #dbe3f0; border-top-color: #3669EC;
      animation: spin .7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .state .ic { font-size: 26px; margin-bottom: 8px; }
    .state .h { color: #0f172a; font-weight: 600; margin-bottom: 6px; font-size: 14px; }
    .hint { font-size: 11.5px; color: #94a3b8; margin-top: 14px; text-align: center; }
    .src { font-size: 11px; color: #94a3b8; margin-top: 12px; padding-top: 10px; border-top: 1px solid #f1f5f9; }
  `;

  // ────────── 构建 DOM ──────────

  const host = document.createElement('div');
  host.id = HOST_ID;
  // host 本身不占布局，避免影响页面
  host.style.cssText = 'all:initial;position:static';
  shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = CSS;

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const fab = document.createElement('button');
  fab.className = 'fab';
  fab.title = '分析这个岗位';
  fab.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 11l3 3L22 4"/>
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
    <span class="dot off"></span>`;

  wrap.append(fab);
  shadow.append(style, wrap);
  document.documentElement.append(host);

  // ────────── 工具 ──────────

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const gradeColor = (g) => ({
    S: '#15803d', A: '#3669EC', B: '#b45309', C: '#78716c', D: '#b91c1c',
  }[g] || '#64748b');

  function openPanel(html) {
    closePanel();
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = html;
    wrap.append(panel);
    panelOpen = true;
    panel.querySelector('.x')?.addEventListener('click', closePanel);
    return panel;
  }

  function closePanel() {
    wrap.querySelector('.panel')?.remove();
    panelOpen = false;
  }

  function stateUI(html) {
    return `<div class="ph">
        <div class="logo">AI</div><div class="ttl">求职助手</div>
        <button class="x" title="关闭">&times;</button>
      </div><div class="state">${html}</div>`;
  }

  // 点遮罩外或按 Esc 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) closePanel();
  }, true);

  // ────────── 主流程 ──────────

  async function analyze() {
    const p = openPanel(stateUI('<div class="sp"></div>正在识别这个页面的岗位描述…'));

    // 1. 提取
    let jd;
    try {
      jd = window.__JM_EXTRACTOR__?.extractJD?.();
    } catch (e) {
      jd = { error: '提取失败：' + e.message };
    }

    if (!jd || jd.error) {
      p.querySelector('.pb, .state').outerHTML = `
        <div class="state">
          <div class="ic">🤔</div>
          <div class="h">没识别到岗位描述</div>
          <div>可以用手动选择：点下面的按钮，再点页面上的 JD 区域。</div>
        </div>
        <div style="padding:0 18px 18px">
          <button class="btn primary" id="pick" style="width:100%">手动选择区域</button>
        </div>`;
      p.querySelector('#pick')?.addEventListener('click', manualPick);
      return;
    }

    // 2. 调接口
    p.querySelector('.state').innerHTML = '<div class="sp"></div>正在按你的简历评分…';

    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'ANALYZE',
        payload: { text: jd.text, url: jd.url, title: jd.title, company: jd.company },
      });
    } catch (e) {
      res = { error: '扩展通信失败，刷新页面重试' };
    }

    if (!res || res.error) {
      const needSetup = /令牌|登录|配置/.test(res?.error || '');
      p.querySelector('.ph').outerHTML = `
        <div class="ph"><div class="logo">AI</div><div class="ttl">求职助手</div>
        <button class="x">&times;</button></div>`;
      p.querySelector('.x')?.addEventListener('click', closePanel);
      p.querySelector('.state').innerHTML = `
        <div class="ic">${needSetup ? '🔑' : '⚠️'}</div>
        <div class="h">${esc(res?.error || '分析失败')}</div>
        <div>${needSetup ? '点浏览器工具栏的扩展图标，填入服务器地址和令牌。' : '稍后再试，或刷新页面。'}</div>`;
      return;
    }

    renderResult(p, res, jd);
  }

  async function manualPick() {
    const p = openPanel(stateUI('<div class="sp"></div>请在页面上点选 JD 区域…'));
    const jd = await window.__JM_EXTRACTOR__.extractByPicker();
    if (!jd || jd.error) {
      p.querySelector('.state').innerHTML = `
        <div class="ic">👆</div><div class="h">${esc(jd?.error || '没选中')}</div>`;
      return;
    }
    p.querySelector('.state').innerHTML = '<div class="sp"></div>正在分析…';
    const res = await chrome.runtime.sendMessage({
      type: 'ANALYZE',
      payload: { text: jd.text, url: jd.url, title: jd.title, company: jd.company },
    });
    if (!res || res.error) {
      p.querySelector('.state').innerHTML = `<div class="ic">⚠️</div><div class="h">${esc(res?.error || '失败')}</div>`;
      return;
    }
    renderResult(p, res, jd);
  }

  function renderResult(p, r, jd) {
    const j = r.job;
    const col = gradeColor(j.grade);
    const pct = Math.max(0, Math.min(100, j.total));
    const C = 2 * Math.PI * 32;

    const tags = [
      j.city ? `<span class="tag">${esc(j.city)}</span>` : '',
      j.salary ? `<span class="tag">${esc(j.salary)}</span>` : '',
      r.dimensions?.[0] ? `<span class="tag brand">${esc(r.dimensions[0].name)}</span>` : '',
      j.isNew ? '<span class="tag ok">已入库</span>' : '<span class="tag ok">已更新</span>',
    ].filter(Boolean).join('');

    const dims = (r.dimensions || []).slice(0, 5).map((d) => `
      <div class="dim">
        <div class="l"><span class="nm">${esc(d.name)}</span><span class="pc">${d.ratio}%</span></div>
        <div class="bar"><i style="width:${d.ratio}%"></i></div>
      </div>`).join('');

    const strong = (r.strong || []).map((s) => `
      <div class="li"><span class="b"></span><span class="txt">${esc(s)}</span></div>`).join('');

    const gaps = (r.gaps || []).map((g) => `
      <div class="li"><span class="b w"></span><span class="txt"><b>${esc(g.name)}</b> · ${esc(g.tip)}</span></div>`).join('');

    const missing = (r.missing || []).length
      ? `<div class="sec-t">JD 提到但简历没覆盖</div>
         <div class="kws">${r.missing.map((k) => `<span class="kw">${esc(k)}</span>`).join('')}</div>`
      : '';

    // 职级定位
  const lv = r.level;
  const lvCls = { 上浮: 'up', 平级: 'same', 降级: 'down' }[lv?.positioning] || 'unknown';
  const lvBlock = lv
    ? `<div class="sec-t">这个岗位对你的定位</div>
       <div style="margin-bottom:4px">
         <span class="lvl ${lvCls}">${esc(lv.positioning)}</span>
         ${lv.requiredYears ? `<span class="tag">要求 ${lv.requiredYears} 年 · 你 ${lv.myYears} 年</span>` : ''}
       </div>
       <div class="lvl-why">${esc(lv.reason)}</div>`
    : '';

  // 技能缺口 + 学习成本
  const ln = r.learn;
  const learnBlock = (ln && ln.items?.length)
    ? `<div class="sec-t">要补的技能</div>
       <div class="learn-row">
         ${ln.items.map((x) => `<span class="learn-chip">${esc(x.term)} <b>${x.hours}h</b></span>`).join('')}
       </div>
       <div class="learn-sum">合计 <b>${ln.totalHours} 小时</b>，每天 3 小时约 <b>${ln.days} 天</b>。
       <a href="${esc(r.learnLink || '#')}" target="_blank" rel="noopener" style="color:#3669EC">看怎么学</a></div>`
    : '';

  const srcLabel = {
      'json-ld': 'JSON-LD 结构化数据',
      'site-rule': '站点规则匹配',
      heuristic: '智能识别',
      'manual-pick': '手动选择',
      'body-fallback': '整页兜底',
    }[jd.source] || jd.source;

    p.innerHTML = `
      <div class="ph">
        <div class="logo">AI</div><div class="ttl">匹配分析</div>
        <button class="x" title="关闭">&times;</button>
      </div>
      <div class="pb">
        <div class="score-row">
          <div class="ring">
            <svg width="76" height="76">
              <circle cx="38" cy="38" r="32" fill="none" stroke="#eef2f9" stroke-width="7"/>
              <circle cx="38" cy="38" r="32" fill="none" stroke="${col}" stroke-width="7"
                      stroke-linecap="round" stroke-dasharray="${C}"
                      stroke-dashoffset="${C * (1 - pct / 100)}"/>
            </svg>
            <div class="num"><span class="n" style="color:${col}">${j.total}</span><span class="g" style="color:${col}">${esc(j.grade)}</span></div>
          </div>
          <div class="meta">
            <div class="pos" title="${esc(j.position)}">${esc(j.position)}</div>
            <div class="co" title="${esc(j.company)}">${esc(j.company) || '未识别公司'}</div>
            <div class="tags">${tags}</div>
          </div>
        </div>

        ${lvBlock}

        <div class="sec-t">能力维度</div>
        ${dims || '<div class="li"><span class="txt">未识别到维度</span></div>'}

        ${strong ? `<div class="sec-t">你的相关经历</div>${strong}` : ''}
        ${gaps ? `<div class="sec-t">维度短板</div>${gaps}` : ''}
        ${learnBlock}
        ${missing}

        <div class="acts">
          <a class="btn primary" href="${esc(r.resumeLink || r.link || '#')}" target="_blank" rel="noopener">生成简历</a>
          <a class="btn" href="${esc(r.prepLink || '#')}" target="_blank" rel="noopener">备面试</a>
        </div>
        <div class="src">识别方式：${esc(srcLabel)} · 正文 ${jd.length ? jd.length.toLocaleString() : '—'} 字</div>
      </div>`;

    p.querySelector('.x')?.addEventListener('click', closePanel);
  }

  fab.addEventListener('click', () => {
    if (panelOpen) closePanel();
    else analyze();
  });

  // 检查连接状态，决定小圆点颜色
  chrome.runtime.sendMessage({ type: 'PING' }).then((r) => {
    const dot = fab.querySelector('.dot');
    if (dot) dot.classList.toggle('off', !(r && r.connected));
  }).catch(() => {});
})();
