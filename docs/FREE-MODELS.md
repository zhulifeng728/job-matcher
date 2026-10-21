# 免费模型获取指南

这个项目只在你点「生成打招呼语」和「投递建议」时才调用模型。这两件事对模型能力要求不高，**免费模型完全够用**。

下面按推荐顺序给出四种方案，从零成本到便宜付费。

> 各家的免费额度和限流规则会变，本文只保证「入口和配置方式」准确。具体额度请以官方页面为准，本文末尾给了自查方法。

---

## 方案一：OpenRouter（推荐，一个 Key 通吃多家）

**优点**：一个 API Key 就能调用几十家厂商的模型，其中带 `:free` 后缀的是免费额度。

### 1. 注册并拿 Key

1. 打开 https://openrouter.ai/
2. 用 Google / GitHub 账号登录
3. 进入 https://openrouter.ai/keys
4. 点 **Create Key**，起个名字（如 `job-matcher`）
5. 复制生成的 Key，形如 `sk-or-v1-xxxxxxxx`

> Key 只显示一次，先粘到临时文件再继续。

### 2. 找当前可用的免费模型

打开 https://openrouter.ai/models?max_price=0 查看所有免费模型。

模型名带 `:free` 后缀的就是免费的，例如：

```
meta-llama/llama-3.3-70b-instruct:free
google/gemini-2.0-flash-exp:free
qwen/qwen-2.5-72b-instruct:free
```

> 免费模型的**具体型号和可用性经常变动**，请以页面实时列表为准。如果没有你想要的，挑一个标着 `$0/M input tokens` 的即可。

### 3. 配置到本项目

```bash
JOB_MATCHER_PROVIDER=openrouter \
OPENROUTER_API_KEY=sk-or-v1-你的key \
JOB_MATCHER_MODEL=meta-llama/llama-3.3-70b-instruct:free \
node src/server.js
```

### 4. 关于限流

OpenRouter 的免费模型有**请求频率限制**（通常按分钟和按天双重计算）。如果遇到 `429` 错误：

- 本项目已内置重试 + 退避，会自动等一会儿再试
- 本项目默认并发是 2，批量生成时不会打爆接口
- 如需提升额度，OpenRouter 支持通过充值一定的额度来解锁更高的免费模型限额，具体见 https://openrouter.ai/docs

---

## 方案二：NVIDIA NIM（免费额度，模型质量好）

**优点**：可以免费用到 Llama 3.3 70B 这类较大模型，接口兼容 OpenAI 协议。

### 1. 注册并拿 Key

1. 打开 https://build.nvidia.com/
2. 用邮箱注册并登录（需要邮箱验证）
3. 打开任意一个模型页面，例如：
   https://build.nvidia.com/meta/llama-3.3-70b-instruct
4. 点右侧的 **Get API Key**（或 **View Code** 里的 API Key 区域）
5. 生成 Key，形如 `nvapi-xxxxxxxx`

### 2. 配置到本项目

```bash
JOB_MATCHER_PROVIDER=nvidia \
NVIDIA_API_KEY=nvapi-你的key \
node src/server.js
```

默认模型是 `meta/llama-3.3-70b-instruct`（**该模型已于 2026-08 下线**，实测返回 410，请先用上方自查命令换一个可用模型）。也可以直接指定：

```bash
JOB_MATCHER_PROVIDER=nvidia \
NVIDIA_API_KEY=nvapi-xxx \
JOB_MATCHER_MODEL=meta/llama-3.1-405b-instruct \
node src/server.js
```

### 3. 注意事项

- NVIDIA 的免费额度是**给开发者试用**的，有总量限制
- 接口地址固定为 `https://integrate.api.nvidia.com/v1`，不需要改
- 部分模型需要先在模型页面点 **Agree / Accept** 接受条款，否则会返回 `403`

---

## 方案三：本地 Ollama（完全免费，不联网）

**优点**：零成本、数据不出本机、不依赖任何外部服务。
**缺点**：需要你自己的机器有足够内存/显存。

### 1. 安装并拉模型

```bash
# macOS
brew install ollama

# 或从官网下载：https://ollama.com/download
```

拉一个适合中文的模型：

```bash
# 7B 需要约 5GB 内存
ollama pull qwen2.5:7b

# 机器配置低可以用 3B（约 2.5GB）
ollama pull qwen2.5:3b

# 配置较高可以上 14B
ollama pull qwen2.5:14b
```

### 2. 配置到本项目

```bash
JOB_MATCHER_PROVIDER=ollama \
JOB_MATCHER_MODEL=qwen2.5:7b \
node src/server.js
```

Ollama 默认监听 `http://127.0.0.1:11434`，本项目已内置这个默认地址，不需要额外配置。

### 3. 验证

```bash
curl http://127.0.0.1:11434/api/tags
```

能看到模型列表就说明服可用了。

---

## 方案四：付费但便宜（如果免费额度不够用）

生成打招呼语这种任务，一次消耗几百 token，用便宜模型一个月几块钱。

| 供应商 | 接口地址 | 典型便宜模型 | 环境变量 |
|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | `DASHSCOPE_API_KEY` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | `MOONSHOT_API_KEY` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` |

配置方式：

```bash
JOB_MATCHER_PROVIDER=deepseek \
DEEPSEEK_API_KEY=sk-xxx \
node src/server.js
```

---

## 任意 OpenAI 兼容服务

本项目的 AI 模块只依赖 `/chat/completions` 这个标准接口。任何兼容 OpenAI 协议的服务都能接：

```bash
JOB_MATCHER_BASE_URL=https://your-service.com/v1 \
JOB_MATCHER_MODEL=your-model-name \
JOB_MATCHER_AI_KEY=your-key \
node src/server.js
```

比如：
- 公司内部的模型网关
- vLLM / SGLang / TGI 自建推理服务
- 其它聚合平台（接口兼容即可）

---

## ⚠️ 先确认你的 Key 能用哪些模型（重要）

**这是实测踩过的坑**：Key 有效 ≠ 模型可用。我们在 2026 年实测发现：

| 现象 | HTTP 码 | 含义 |
|---|---|---|
| 接口能返回模型列表，但调对话就失败 | `404 Function ... not found for account` | **该模型没有为你的账号开通**，需要先去控制台启用 |
| 模型明确报下线 | `410 Gone` + `has reached its end of life` | **模型已 EOL 下线**，必须换新模型 |
| 一切正常 | `200` | 可用 |

### 自查命令（推荐先跑这一步）

拿到 Key 后，**先列出你的账号实际可用的模型**：

```bash
# NVIDIA
curl -s https://integrate.api.nvidia.com/v1/models   -H "Authorization: Bearer $NVIDIA_API_KEY" | python3 -m json.tool | head -40

# OpenRouter
curl -s https://openrouter.ai/api/v1/models | python3 -m json.tool | head -40
```

然后**逐个试**（比看文档准）：

```bash
curl -s -w '\nHTTP %{http_code}\n' \
  https://integrate.api.nvidia.com/v1/chat/completions \
  -H "Authorization: Bearer $NVIDIA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"你的模型名","messages":[{"role":"user","content":"hi"}],"max_tokens":10}'
```

返回 `choices` 字段就是可用；返回 `title/detail` 就是不可用，看 `detail` 里的原因。

### 关于模型 EOL

各家会持续下线旧模型。我们实测时 `meta/llama-3.3-70b-instruct`、
`meta/llama-3.1-8b-instruct` 都已 EOL（返回 `410 Gone`）。

**结论**：不要把某个具体模型名当成永远有效。**每次部署前跑一遍上面的自查**，
或者直接在 OpenRouter 的免费模型列表页挑当前可用的。

### NVIDIA 的特殊要求

NVIDIA 的部分模型需要**在模型页面手动点同意/启用**，否则会返回 `404`：

1. 打开 https://build.nvidia.com/
2. 进入你想用的模型页面（如 https://build.nvidia.com/meta/llama-3.3-70b-instruct）
3. 页面右上角点 **Get API Key** 或 **View Code** 区块，确认账号已开通该模型
4. 如果显示需要同意条款，先点 Agree

---

## 验证配置是否生效

启动服务后看控制台输出：

```
   AI        ✅ OpenRouter（有免费模型） / meta-llama/llama-3.3-70b-instruct:free（来源：env）
   AI 配额   200 次/天
```

或者页面上「设置」标签页会显示：

- AI 状态：已就绪
- 当前模型
- 配置来源（环境变量 / 本地文件）
- 今日配额使用情况

也可以直接测接口：

```bash
curl -X POST http://127.0.0.1:7788/api/ai/test \
  -H "Authorization: Bearer $JOB_MATCHER_TOKEN"
```

成功会返回类似：

```json
{
  "ok": true,
  "message": "连接正常 ｜ 供应商：OpenRouter（有免费模型） ｜ 模型：... ｜ 回复：可用"
}
```

---

## 常见错误与解决

| 错误 | 原因 | 解决 |
|---|---|---|
| `401` | Key 无效或没读到 | 确认环境变量名拼写正确，`echo $OPENROUTER_API_KEY` 检查是否为空 |
| `402` | 余额不足或免费额度用完 | 换一个免费模型，或换供应商 |
| `403` | 模型需要先接受条款 | 去模型页面点 Agree |
| `404` | 模型名写错 | 检查模型名，注意 `:free` 后缀不能漏 |
| `429` | 请求太频繁 | 本项目自动重试；仍失败则降低 `n` 或稍后再试 |
| `AI 请求超时` | 免费模型响应慢 | 调大 `JOB_MATCHER_TIMEOUT_MS=120000` |
| 中文输出乱码 | 模型中文能力弱 | 换 Qwen 系列或中文优化过的模型 |

**建议**：给打招呼语生成这类任务，优先选**中文能力好**的模型（Qwen 系、DeepSeek、GLM），英文模型有时会输出夹生中文。

---

## 关于费用控制

即使配置了付费 Key，也建议开着几道闸：

| 措施 | 默认值 | 调整方式 |
|---|---|---|
| AI 每日调用上限 | 200 次 | `JOB_MATCHER_AI_DAILY_LIMIT` |
| AI 每分钟请求上限 | 20 次 | 内置，`RATE.aiMaxReq` |
| 全局每分钟请求上限 | 120 次 | `JOB_MATCHER_RATE_LIMIT` |
| 批量生成并发 | 2 | 内置 |
| 单次 JD 文本上限 | 80 万字 | 内置 `LIMITS.textChars` |

另外，**AI 功能默认关闭**：没配 Key 时所有规则评分、排序、导出功能照常工作，只是少了生成招呼语这一项。这是刻意的保守默认值。

---

## 官方入口汇总

| 平台 | 注册页 | Key 管理页 |
|---|---|---|
| OpenRouter | https://openrouter.ai/ | https://openrouter.ai/keys |
| OpenRouter 免费模型列表 | https://openrouter.ai/models?max_price=0 | |
| NVIDIA NIM | https://build.nvidia.com/ | 各模型页面内的 Get API Key |
| Ollama | https://ollama.com/download | 本地无需 Key |
| DeepSeek | https://platform.deepseek.com/ | https://platform.deepseek.com/api_keys |
| 通义千问 | https://dashscope.console.aliyun.com/ | 控制台内 API-KEY 管理 |
| Moonshot | https://platform.moonshot.cn/ | https://platform.moonshot.cn/console/api-keys |

> 这些入口和免费额度随时可能调整，遇到打不开或规则变化，以各家官方文档为准。
