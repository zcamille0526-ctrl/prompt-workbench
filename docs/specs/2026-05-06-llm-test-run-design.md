# LLM 试运行 — 设计规格文档

## 1. 产品定位

让用户在平台内直接用当前提示词作为 system prompt 跟 LLM 多轮对话，验证提示词效果，而不必切换到豆包/通义网页版。

## 2. 核心功能

### 2.1 触发入口

提示词详情面板增加"试运行"按钮（位于复制按钮旁边）。点击后在右下方展开试运行对话面板。

### 2.2 模型选择

- 仅接入 DeepSeek V4 系列（V4-Flash / V4-Pro）
- 用户在面板顶部下拉选择模型，默认 V4-Flash
- 模型常量保存在前端 `src/lib/models.ts`：

```ts
export const MODELS = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4-Flash（快速）" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4-Pro（推理强）" },
];
```

### 2.3 多轮对话

- System prompt 自动取当前提示词内容（含变量替换后的最终文本）
- 变量替换沿用现有的 `{{变量名}}` 语法和 `substituteVariables` 函数
- User 在输入框输入消息 → 显示在对话区 → 调用 API → assistant 回复显示在对话区
- 支持继续追问，保留历史
- "清空对话"按钮：清掉历史，但保留 system prompt
- **切换提示词或 prompt 内容变更时，对话历史自动清空**（system prompt 已变，旧对话失效）

### 2.4 变量处理

- 如果当前 prompt 包含未填写的变量，禁止开始对话，提示用户先填写变量
- 变量值通过现有的变量填写区填入，试运行用替换后的最终文本作为 system prompt

### 2.5 个人 API Key 管理

- 每个用户在浏览器本地（sessionStorage）保存自己的 DeepSeek API Key
- 平台 Sidebar 底部"导出数据"按钮上方加"⚙️ API 设置"按钮，点击弹出对话框输入 key
- key 仅保存在 sessionStorage，**关闭浏览器标签页后清空**（与现有共享密码一致）
- 未配置 key 时点击"试运行"会先弹出输入 key 的对话框

### 2.6 错误处理

- 401 / 余额不足 / 网络错误：在对话区显示友好的错误信息（红色文字）
- 错误不破坏对话历史，用户可以重试
- 不计入对话历史

## 3. 数据模型

无数据库改动。所有状态前端管理：
- API Key：sessionStorage 字符串
- 对话历史：React state，不持久化（关闭面板就清空）

## 4. 技术架构

### 4.1 后端

新增 `api/chat.ts`（serverless function）：
- 鉴权：复用 `verifyToken`
- 请求体：`{ apiKey, model, messages: [{role, content}] }`
- 后端代理调用 `https://api.deepseek.com/v1/chat/completions`（OpenAI 兼容 endpoint）
- **超时**：Vercel serverless 默认 10s，配置 `maxDuration: 30` 提升到 30s（**需 Vercel Pro 计划；当前项目为 Hobby 计划则降级为 10s 上限**，超时返回友好错误让用户重试）
- **payload 限制**：第一版不做对话长度截断。messages 数组超过 DeepSeek context 上限时由 DeepSeek 返回错误，后端原样转发。建议前端在 messages.length 超过 20 时给出"对话已较长，建议清空"提示（不强制）
- **响应格式**：后端只取 DeepSeek 响应中的 `choices[0].message.content`，加上统一错误格式后返回：
  - 成功：`{ content: "..." }`
  - 失败：`{ error: { code: "INVALID_KEY"|"INSUFFICIENT_BALANCE"|"NETWORK"|"OTHER", message: "..." } }`
  - 后端把 DeepSeek 返回的 401（key 错）、402（余额不足）、5xx 都映射到这个统一结构
- **第一版不做请求频控**：后端代理被滥用的风险由 verifyToken 兜底（必须登录），团队内部使用风险可控

```
前端 ──(token + 用户key)──> /api/chat ──(用户key)──> DeepSeek
                                               <──── response
        <──── response ──── 后端转发
```

为什么后端代理而不是前端直连：
- 解决 CORS 问题
- 后端可以验证用户已登录（防止未登录滥用平台计算资源）
- 后端不存 key，不增加合规负担

### 4.2 前端

新增 `src/components/TestRunPanel.tsx`：
- 折叠/展开面板（默认折叠）
- 模型选择下拉
- 对话区域（user/assistant 消息气泡）
- 输入框 + 发送按钮 + 清空按钮
- 加载状态显示

新增 `src/hooks/useChat.ts`：
- 管理对话历史 state
- 处理 API 调用和错误
- 暴露 `sendMessage`, `clearHistory`, `messages`, `isLoading`, `error`

新增 `src/lib/apiKey.ts`：
- `getApiKey()`, `setApiKey()`, `clearApiKey()` —— sessionStorage 包装

修改 `src/lib/api.ts`：
- 增加 `chat(apiKey, model, messages)` 方法

修改 `src/components/PromptDetail.tsx`：
- 集成 TestRunPanel
- 检查变量是否填完才允许试运行

新增 `src/components/ApiKeyDialog.tsx`：
- 弹窗输入并保存 key

修改 `src/components/Layout.tsx` 或 `src/App.tsx`：
- 在某个位置（比如 Sidebar 底部或顶部）放设置按钮，打开 ApiKeyDialog

### 4.3 流式响应（暂不做）

第一版用同步响应（用户发消息 → 等几秒 → 一次性显示完整回复）。
后续可优化为流式（SSE 或 ReadableStream），体验更好但实现复杂度翻倍。

## 5. 界面设计

**详情面板布局变化**：

```
┌──────────────────────────────────────┐
│ [标题] [分类]              [编辑][删除]│
│ [标签]                                │
│                                      │
│ 变量填写区（如有）                     │
│                                      │
│ [Markdown 内容预览]                   │
│                                      │
│ [复制提示词] [试运行 ▼]               │
│                                      │
│ ─────── 试运行（展开后）─────────       │
│ 模型：[DeepSeek V4-Flash ▼]  [清空]   │
│                                      │
│ 对话区域（可滚动）                     │
│   user: ...                          │
│   assistant: ...                     │
│                                      │
│ [输入消息...] [发送]                  │
└──────────────────────────────────────┘
```

## 6. 安全与合规

- API Key 永远不发到 Supabase
- API Key 永远不写入 cookie 或 localStorage（避免 XSS 风险）
- API Key 在浏览器关闭后即清空，每天首次使用需重新输入
- 后端 `/api/chat` 不记录 key，不记录对话内容到日志

## 7. 错误场景

| 场景 | 行为 |
|------|------|
| 未配置 API Key | 弹窗引导用户输入 |
| API Key 无效（401） | 错误信息提示"密钥无效，请检查"，不清空已存的 key |
| 余额不足 | 错误信息提示"余额不足，请到 DeepSeek 控制台充值" |
| 网络/超时 | 错误信息提示"请求失败，请重试" |
| 变量未填全 | 试运行按钮置灰，hover 提示"请先填写变量" |

## 8. 不做的事情（第一版）

- 不做流式响应
- 不做对话持久化（关闭面板就清空）
- 不做分享对话给同事
- 不做模型扩展（只 DeepSeek，第二版再加豆包/通义）
- 不做团队共享 API Key（每人自己配）
- 不做使用量统计/费用估算
- 不做提示词参数（temperature/top_p）调节

## 9. 工作量估算

约 4-5 小时。**依赖：使用次数统计设计独立无依赖；本设计独立。但保存示例输出（下一份设计）依赖本设计。**
