# Job Matcher · 求职岗位匹配分析器

把招聘网站上的 JD 变成一份**可排序、可追踪、可复盘**的投递计划。

不同于"自动投递"类工具，这个项目**不碰招聘平台的账号**，只处理你手动粘贴的 JD 文本。它的价值不在"投得快"，而在"投得准"和"投得明白"。

```
粘贴 JD  →  规则引擎评分  →  按匹配度排序  →  逐个推进状态  →  复盘转化率
```

---

## 为什么做这个

找工作真正的痛点不是"岗位不够多"，而是：

| 真实痛点 | 这个工具的答案 |
|---|---|
| 收藏了几十个岗位，不知道先投哪个 | **六维度加权评分**，直接给出 0-100 分和 S/A/B/C/D 评级 |
| 投了很多没回音，不知道为什么 | **每个人的短板和风险点都明确列出**（比如"要求 React 深度，你的主栈是 Vue"） |
| 不知道自己投递的转化率 | **投递漏斗统计**：回复率、面试率、offer 率 |
| 每次写打招呼语都要重新想 | **AI 生成个性化招呼语**（可选，支持免费模型） |
| 复盘时想不起当时为什么投它 | **Markdown 报告导出**，含完整评分依据 |

---

## 快速开始

**要求**：Node.js 18+（零第三方依赖，不需要 `npm install`）

```bash
git clone <your-repo-url> job-matcher
cd job-matcher

# 直接跑
node src/server.js
```

打开 http://127.0.0.1:7788 即可。

> 首次使用请先改 `data/presets/profile.json` 成你自己的画像，见下方「配置你的画像」。

---

## 核心功能

### 1. 六维度匹配评分

评分基于你的能力画像与 JD 文本的关键词重合度，加权计算：

| 维度 | 默认权重 | 说明 |
|---|---|---|
| 前端架构与工程化 | 25 | 模块化、Monorepo/多仓、构建发布、性能优化 |
| AI 应用落地 | 25 | 大模型对接、RAG、Prompt、Agent、端侧推理 |
| 小程序与多端 | 15 | 微信生态、Taro、uni-app、企业微信 |
| 后端与全栈 | 15 | Node/Python 服务端、数据库、容器化部署 |
| 系统设计与性能 | 10 | 权限体系、可视化、监控、稳定性 |
| 团队管理 | 10 | 带团队、需求评审、技术选型 |

**权重和关键词全部可改**，见 `data/presets/profile.json`。

评分不只算加法，还有三层修正：

- **行业加分**：命中你熟悉或目标行业（数据安全、金融、B 端等）
- **年限/层级校正**：JD 要求 1-3 年而你有 9 年，会明确扣分并提示 overqualified
- **减分红线**：如"外包驻场""非技术岗""React 深度要求"，直接压低总分并标注原因

### 2. 投递状态追踪

每个岗位有独立状态机，并记录完整的变更历史：

```
待投递 → 已投递 → 已查看 → 已回复 → 约面试 → 拿 offer
                                            ↘ 被拒 / 放弃
```

自动统计回复率、面试率、offer 率，用于判断自己的投递策略是否有效。

### 3. AI 增强（可选）

配置模型后可以：

- 生成**针对该岗位**的打招呼语（不是群发模板）
- 给出三条投递建议：突出什么 / 准备什么 / 风险在哪

**不配置也能用**，只是少了这两项。支持免费模型，见 [docs/FREE-MODELS.md](docs/FREE-MODELS.md)。

### 4. 报告导出

Markdown（可读、可存档）或 CSV（可导入表格）两种格式，含数据概览、岗位排序、维度得分、风险提示。

---

## 配置你的画像

编辑 `data/presets/profile.json`，这是整个评分的基准。结构如下：

```jsonc
{
  "profile": {
    "name": "你的名字",
    "headline": "前端负责人 / 高级前端工程师（Vue 技术栈）",
    "years": 9,
    "currentCity": "北京"
  },
  "dimensions": [
    {
      "id": "frontend_arch",
      "name": "前端架构与工程化",
      "weight": 25,              // 权重，总和不必等于 100
      "level": 5,                // 1-5，你的熟练度
      "description": "一句话说明",
      "keywords": {
        "架构": 3,               // 关键词: 权重（1-5）
        "Monorepo": 4,
        "Vue": 4
      }
    }
  ],
  "domains": [
    { "name": "金融", "keywords": ["银行", "保险"], "bonus": 4 }
  ],
  "negatives": [
    { "keywords": ["外包", "驻场"], "penalty": -15, "reason": "外包岗位" }
  ],
  "resumeText": "你的简历正文，AI 生成打招呼语时会用到"
}
```

**调参建议**：

1. 先按你的真实技术栈改 `dimensions` 的 `keywords`
2. 用 5-10 个你熟悉的真实 JD 试跑，看排序是否符合直觉
3. 排序反直觉时，优先调 `weight`，再调关键词权重
4. 改完回页面点「重新评分」，会自动备份旧数据

---

## 数据与隐私

| 项目 | 说明 |
|---|---|
| 数据存放 | 全部在本地 `data/` 目录，纯 JSON 文件 |
| 上传行为 | **不上传任何数据到第三方服务器** |
| 招聘平台账号 | **不接触**，不做登录、爬取、自动投递 |
| API Key | **只从环境变量读取**，不写数据库、不写文件、不返回给浏览器 |
| AI 调用 | 只在主动点「生成打招呼语」时发生，会把该岗位 JD 发给模型提供方 |

详细安全设计见 [SECURITY.md](SECURITY.md)。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `JOB_MATCHER_PORT` | `7788` | 监听端口 |
| `JOB_MATCHER_HOST` | `127.0.0.1` | 监听地址，公网部署建议保持默认并用 Nginx 反代 |
| `JOB_MATCHER_TOKEN` | 空 | 访问口令。**公网部署必须设置** |
| `JOB_MATCHER_PROVIDER` | 自动探测 | 指定 AI 供应商：`openrouter` / `nvidia` / `deepseek` / `openai` / `qwen` / `moonshot` / `ollama` |
| `JOB_MATCHER_MODEL` | 供应商默认 | 覆盖模型名 |
| `JOB_MATCHER_BASE_URL` | 供应商默认 | 覆盖接口地址 |
| `JOB_MATCHER_AI_KEY` | 空 | 通用 Key（不指定 provider 时使用） |
| `JOB_MATCHER_AI_DAILY_LIMIT` | `200` | AI 每日调用上限 |
| `JOB_MATCHER_RATE_LIMIT` | `120` | 每 IP 每分钟请求上限 |
| `JOB_MATCHER_TIMEOUT_MS` | `60000` | AI 请求超时 |

示例：

```bash
# 用 OpenRouter 的免费模型
JOB_MATCHER_PROVIDER=openrouter \
OPENROUTER_API_KEY=sk-or-v1-xxx \
JOB_MATCHER_TOKEN=$(openssl rand -hex 16) \
node src/server.js
```

---

## 项目结构

```
job-matcher/
├── src/
│   ├── server.js      HTTP 服务、鉴权、限流、路由
│   ├── scoring.js     评分引擎（纯函数，可单独测试）
│   ├── parser.js      JD 解析（标签正则 + 启发式兜底）
│   ├── ai.js          多供应商 AI 调用（环境变量优先）
│   └── store.js       数据层（JSON 原子写 + 状态机 + 统计）
├── public/
│   └── index.html     单文件前端（零构建）
├── data/
│   ├── presets/
│   │   └── profile.json   能力画像（评分基准）
│   ├── jobs.json          你的岗位数据（git 忽略）
│   └── ai-config.json     AI 配置（git 忽略）
├── docs/
│   ├── FREE-MODELS.md     免费模型获取指南
│   └── DEPLOY.md          部署指南
├── SECURITY.md
└── package.json
```

---

## 为什么不用数据库

这是刻意的设计：

1. **单人使用场景**，数据量在几百条量级
2. **零依赖**，clone 下来就能跑，不需要装 MySQL/Postgres
3. **数据可读可改**，出问题可以直接看 JSON
4. **便于备份和版本管理**

数据层集中在 `src/store.js`，要换成 SQLite 或 Postgres 只需替换这个文件。

写入使用「临时文件 + 原子 rename」，避免进程中断写坏数据。

---

## API

所有 `/api/*` 在设置了 `JOB_MATCHER_TOKEN` 时需要鉴权（`Authorization: Bearer <token>` 或登录 Cookie）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（无需鉴权） |
| GET | `/api/status` | 运行状态（AI 状态已脱敏） |
| GET | `/api/profile` | 读取能力画像 |
| POST | `/api/parse` | 解析 JD 预览（不落库） |
| POST | `/api/jobs` | 导入 JD 并评分 |
| GET | `/api/jobs` | 列表（支持排序/筛选/搜索） |
| GET | `/api/jobs/:id` | 详情 |
| PATCH | `/api/jobs/:id` | 更新状态或备注 |
| DELETE | `/api/jobs/:id` | 删除 |
| POST | `/api/rescore` | 按最新画像重新评分 |
| POST | `/api/ai/generate` | 生成打招呼语与建议 |
| POST | `/api/ai/generate-top` | 批量生成 Top N |
| GET | `/api/export?min=65&format=md` | 导出报告 |

---

## 已知边界

诚实说明，避免误解：

- **评分是关键词启发式的**，不理解语义。同义改写会漏判（如"前端基建"与"前端基础设施"）。它做的是**相对排序**，不是绝对判定。
- **不是投递工具**。投递动作仍然要你手动完成，这是刻意设计（见下节）。
- **不判断公司好坏**。只看 JD 文本匹配度，不知道公司是否靠谱、是否加班。
- **AI 建议仅供参考**。模型会犯错，不要盲信它说"这个岗位很适合你"。
- **单用户设计**。没有多租户隔离，不适合多人共用一套部署。

---

## 为什么不自动投递

这是本项目最重要的设计决策。

技术上，用 Puppeteer 模拟登录 BOSS 直聘批量投递是可以做到的。但：

1. **违反平台用户协议**，账号绑定实名，风险不可逆
2. **平台有风控**，异常投递行为会导致账号受限
3. **每日沟通额度有限**，自动化会把额度烧在不匹配的岗位上，反而降低回复率
4. **群发消息一眼可见**，你的招呼语立刻失去说服力

**结论**：把力气花在"筛选和策略"上，比"投递速度"回报高得多。这个工具做的是前者。

---

## License

MIT
