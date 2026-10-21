# 浏览器扩展

在招聘网站看岗位时，右下角一键算出「这个岗位和我的简历有多匹配」。

## 为什么做扩展

复制 JD 再粘贴到网站里，这个流程太重了 —— 真实场景下你一天要翻几十个岗位，不可能每个都复制一遍。

扩展把这一步省掉：你正常浏览，点一下按钮就出结果。

**而且它绕开了爬虫的所有问题**：

| 爬虫 | 扩展 |
|---|---|
| 批量请求平台接口 | 只读你**正打开**的那个页面 |
| 需要登录态 / Cookie | 不需要 |
| 违反平台条款风险 | 用户自己的浏览器、自己的浏览行为 |
| 平台改版就废 | 四层降级，改版仍能识别 |

## 支持站点

| 站点 | 域名 |
|---|---|
| BOSS 直聘 | `zhipin.com` / `bosszhipin.com` |
| 智联招聘 | `zhaopin.com` |
| 猎聘 | `liepin.com` |
| 拉勾 | `lagou.com` |
| 前程无忧 | `51job.com` |
| LinkedIn | `linkedin.com` |
| 牛客 | `nowcoder.com` |

## 安装

1. 到网站「浏览器扩展」页下载 zip（或 `cd extension && zip -r ../ext.zip .`）
2. 解压到一个固定目录
3. Chrome 打开 `chrome://extensions`，开启右上角「开发者模式」
4. 点「加载已解压的扩展程序」，选中解压出来的文件夹
5. 点工具栏的扩展图标，填服务器地址 + 令牌（在网站「浏览器扩展」页生成）

## JD 提取：四层降级策略

**不硬编码选择器。** 招聘网站改版很频繁，写死 `.job-detail .text` 这种选择器，一次改版就失效。

```
① JSON-LD（schema.org/JobPosting）
     很多站为 SEO 会输出结构化数据 —— 最可靠
        ↓ 没有
② 站点快速通道
     对已知站点用已知选择器，命中就用
        ↓ 没有
③ 启发式容器评分
     找「像 JD」的容器：正文长度 + JD 关键词密度
     JD 关键词：岗位职责/任职要求/职责描述/responsibilities/…
        ↓ 分数太低
④ 整页兜底
     main / article / body，剔除 nav/footer/script
        ↓ 还不行
⑤ 手动选择
     用户点页面上的 JD 区域，实时高亮预览
```

面板底部会显示实际用了哪一层（`识别方式：智能识别`），方便排查。

### 公司名识别的坑

从页面猜公司名很容易猜成岗位名（很多站 `document.title` 是「前端负责人招聘-BOSS直聘」）。

所以 `guessCompany()` 做了五级过滤，并且**用岗位名做排除**：

1. 结构化元素（`[class*="company-name"]` 等）
2. 正文里的「公司：XXX」行
3. `og:site_name`
4. 标题里的「XX招聘」
5. 域名反推（`careers.n-ix.com` → `n-ix`）—— 排除已知招聘站

还会剥掉 `Careers at ` / `Jobs at ` 这类前缀。

## 架构

```
┌─────────────────────────────────────────────┐
│ 招聘网站页面                                  │
│  ┌───────────────────────────────────────┐  │
│  │ content.js（隔离世界）                  │  │
│  │  · Shadow DOM 注入悬浮按钮和面板         │  │
│  │  · 用 Shadow Root 是为了不被页面 CSS 污染 │  │
│  │  · 只能访问 runtime/storage/i18n/dom    │  │
│  └───────────────┬───────────────────────┘  │
└──────────────────┼──────────────────────────┘
                   │ chrome.runtime.sendMessage
┌──────────────────▼──────────────────────────┐
│ background.js（Service Worker）              │
│  · 令牌存在这里，内容脚本拿不到                │
│  · 有 host_permissions，请求不受 CORS 限制    │
└──────────────────┬──────────────────────────┘
                   │ HTTPS + Bearer
┌──────────────────▼──────────────────────────┐
│ 服务端 /api/extension/analyze                │
│  · 评分 → 落库 → 返回摘要                     │
└─────────────────────────────────────────────┘
```

### 为什么网络请求必须放 background

内容脚本运行在页面的隔离世界里，`fetch` 会带上页面的 `Origin`，受 **CORS 限制**。

Service Worker 有 `host_permissions`，可以跨域直连 —— 这是 MV3 的规定做法。

代价是内容脚本不能直接拿令牌，只能通过消息让 background 代为调用。这反而是好事：**令牌不暴露给页面**。

## 令牌设计

| 项 | 做法 |
|---|---|
| 格式 | `jme_` + 24 字节随机（base64url） |
| 存储 | **只存 SHA-256 哈希**，明文只在创建时返回一次 |
| 识别 | 列表只显示前 12 位，便于用户认出是哪一个 |
| 上限 | 每人最多 10 个，超出删最旧的 |
| 使用记录 | 记录 `lastUsedAt`，节流 1 分钟写一次 |
| 撤销 | 用户可随时撤销，立即失效 |

即使数据库泄漏，也拿不到可用的令牌。

## 安全边界

| 检查项 | 实现 |
|---|---|
| CORS | 只允许 `chrome-extension://` / `moz-extension://` / localhost 来源 |
| 鉴权 | Bearer 令牌，与 Cookie 会话并行（Cookie 优先） |
| 限流 | 每用户 60 次/分钟 |
| 输入长度 | JD 文本最多 60,000 字符 |
| XSS | 面板内所有文本经 `esc()` 转义 |
| 样式隔离 | Shadow DOM（`mode: 'closed'`） |
| 权限 | 只申请 `storage` + `activeTab` + 具体站点，不要 `<all_urls>` |

## 文件

```
extension/
├── manifest.json     MV3 配置
├── background.js     Service Worker：令牌 + API 调用
├── content.js        页面内 UI（Shadow DOM）
├── extractor.js      JD 提取（四层降级）
├── popup.html/.js    设置界面
└── icons/            16/32/48/128
```

打包：`node scripts/build-extension.js` → `public/download/job-matcher-extension.zip`

## 调试

在招聘页打开 DevTools：

```js
// 手动跑一次提取，看命中哪一层
window.__JM_EXTRACTOR__.extractJD()
// → { title, company, text, source, length }

// 看令牌和连接状态
chrome.runtime.sendMessage({type:'PING'})
```

`source` 是 `json-ld` / `site-rule` / `heuristic` / `manual-pick` / `body-fallback`。

如果某站点识别不准：先看 `source` 是哪一层，再决定是补 `SITE_RULES` 还是调 `jdScore()` 的阈值。
