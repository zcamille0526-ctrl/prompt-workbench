# 安全模型重构 — 设计规格文档

## 1. 背景与目标

### 1.1 当前架构的安全漏洞

当前架构（参考 `2026-04-30-prompt-workbench-design.md` 第 3.4 节）有三处架构级泄露点：

1. **`anon_select` RLS 策略允许任何持有 anon key 的人直接读取整个 prompts 表**。anon key 被打包进前端 bundle，任何打开过本站的人扒源码就能拿到，相当于共享密码形同虚设。

2. **前端通过 Supabase JS 客户端（`src/lib/supabase.ts`）直连 Supabase Realtime**，使用同一个 anon key 订阅 `postgres_changes` 事件。每条 prompt 的完整内容（包括将来的私人 prompt）都通过 websocket 广播给所有订阅者。

3. **数据写入虽然走后端代理但缺少字段 allowlist 和 Zod 服务端校验**，恶意构造的 payload 可以写入预期外的字段或绕过约束。

这三个问题合起来意味着：当前平台**对外完全裸露**，密码保护只挡了登录界面，没挡数据访问。

### 1.2 重构目标

把数据访问收敛到后端代理层，实现真正的"密码门 = 唯一入口"。具体目标：

- 删除所有公开 SELECT 策略，Supabase 仅 service-role 可访问
- 前端不再持有任何 Supabase 凭据
- 所有数据流统一走 `/api/*` 端点
- 后端做字段 allowlist + Zod 校验，杜绝裸写入
- 工程层面把 `api/`、`tests/`、`dev-server.ts` 纳入类型检查

### 1.3 设计原则

**架构选择，不是妥协**：放弃 Realtime 改用 30 秒轮询，是当前 10 人团队 + 数百条 prompt 规模下的合理架构选择，理由：

- 实时性收益小（同事改 prompt 不需要秒级看到）
- 数据库不再向前端裸露，安全模型大幅简化
- 实施和审计成本低
- 团队规模扩大或确实需要实时时再升级（届时通过后端代理 SSE/WebSocket）

## 2. 重构内容

### 2.1 删除公开 SELECT 策略

新增 SQL 迁移 `005_lock_down_anon.sql`：

```sql
-- 删除 prompts 表的公开 SELECT 策略
drop policy if exists "anon_select" on prompts;

-- 如果将来 examples 表已上线，也要删除（依赖关系：本 spec 必须在
-- save-example spec 之前完成；若 save-example 已上线则一并删除）
drop policy if exists "anon_select_examples" on examples;
```

数据库回到"只有 service-role 能读写"的状态。

### 2.2 移除前端 Supabase 客户端

**删除文件**：
- `src/lib/supabase.ts`（前端 anon 客户端）
- `src/hooks/useRealtimePrompts.ts`（Realtime 订阅 hook）

**修改 `src/App.tsx`**：
- 移除 `useRealtimePrompts(fetchPrompts)` 调用
- 改为 `usePromptsPolling()`：每 30 秒触发 `fetchPrompts()`

**修改 `.env.example`** 和 **Vercel 环境变量**：
- 删除 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`（前端不再需要）
- 保留服务端的 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`

### 2.3 实现轮询 hook

新增 `src/hooks/usePromptsPolling.ts`：

```ts
import { useEffect, useRef } from "react";

const POLL_INTERVAL_MS = 30_000;

export function usePromptsPolling(onTick: () => void) {
  const callbackRef = useRef(onTick);
  callbackRef.current = onTick;

  useEffect(() => {
    const id = setInterval(() => {
      // 仅在页面可见时轮询，避免后台标签页持续请求
      if (document.visibilityState === "visible") {
        callbackRef.current();
      }
    }, POLL_INTERVAL_MS);

    // 标签页从隐藏切回可见时立即拉一次
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        callbackRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
```

### 2.4 后端字段 allowlist 与 Zod 校验

修改 `api/prompts.ts`：

- **POST/PUT** 必须用 `PromptSchema.safeParse()` 校验整个 body
- **写入数据库时只 pick 白名单字段**，避免恶意 payload 注入额外字段：

```ts
const ALLOWED_FIELDS = ["title", "content", "category", "tags", "variables", "created_by"];
const insertData = Object.fromEntries(
  Object.entries(parsed.data).filter(([k]) => ALLOWED_FIELDS.includes(k))
);
await supabase.from("prompts").insert(insertData);
```

**后续每个新 API 端点**（use-count、chat、examples）都遵循同样模式：先 Zod 校验、再字段 allowlist、再写入数据库。

### 2.5 工程改进

新增 `api/tsconfig.json` 和 `tests/tsconfig.json`（或扩展根 `tsconfig.json` 的 `include`）：

```json
{
  "extends": "./tsconfig.json",
  "include": ["api/**/*.ts", "tests/**/*.ts", "dev-server.ts"]
}
```

修改 root `tsconfig.json` 的 references 或单独跑 `tsc -p api/tsconfig.json`。在 CI/构建中加入此检查。

### 2.6 统一 API handler 风格

约定所有 `api/*.ts` 用 Vercel Node.js runtime 的 `(req: VercelRequest, res: VercelResponse)` 形态：

```ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 鉴权
  // 路由分发
  // 业务逻辑
}
```

不再混用 Web API `Request/Response` 和 Vercel 类型。`dev-server.ts` 中的 Express 适配层已经按此 dispatch，保持不变。

## 3. 不影响的部分

- 共享密码 + HMAC token 的鉴权方式不变（`api/verify.ts` 保留）
- 现有 14 条提示词数据不需要迁移
- UI 体验对最终用户基本无感（除了同事改 prompt 后等最多 30 秒才看到）

## 4. 数据迁移

新增 `supabase/migrations/005_lock_down_anon.sql`，需要在 Supabase SQL Editor 中手动执行。

Vercel 环境变量需要手动删除两项：
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

删除环境变量后需要重新部署一次让前端 bundle 不再包含这两个字符串。

## 5. 错误场景

| 场景 | 行为 |
|------|------|
| 旧版前端缓存仍在尝试连 Supabase Realtime | 失败静默（连接错误已经被 useRealtimePrompts 的 `if (!supabase) return` 兜底）。用户刷新页面后即拉到新版前端 |
| 轮询请求失败（网络/后端故障） | `usePrompts` 已有 error 处理，UI 显示错误信息，下一个轮询周期自动重试 |
| 后端 POST/PUT 收到包含未知字段的 payload | Zod 校验失败 400 + 错误信息（"unknown field xxx"） |

## 6. 不做的事情（本 spec 范围内）

- 不引入完整用户系统（沿用共享密码 + HMAC token）
- 不做 SSE/WebSocket 实时同步（轮询足够）
- 不做更细粒度的请求频控（在试运行 spec 里单独处理 LLM 调用频控）
- 不审计每条历史 prompt 的内容（只重构访问层，数据本身不动）

## 7. 对其他 spec 的影响

- **私人提示词 spec**（`2026-05-06-private-prompts-design.md`）：
  - 命名改为"草稿提示词"或"未公开提示词"，明确不是强隐私
  - Realtime 段落整段删除（本 spec 已统一改为轮询）
  - 文档显式声明：草稿对持有共享密码的同事不是强隔离，仅"默认不主动展示"

- **使用次数 spec**：Realtime 同步逻辑改为依赖轮询（无功能变化，仅说明字段更新通过 30s 轮询同步）

- **保存示例 spec**：
  - 删除 `anon_select_examples` 策略表述（与本 spec 协同的迁移已包含）
  - 例外删除策略保持"任何登录用户可删任何示例"，但在 spec 里增加"明确不适用于真正的多租户场景，仅适合可信小团队协作"

- **LLM 试运行 spec**（影响最大，单独 8 小节）

## 8. LLM 试运行的安全补充

`2026-05-06-llm-test-run-design.md` 需要补三件事：

### 8.1 Payload 大小限制

后端 `api/chat.ts` 进入业务前先校验：

```ts
const MAX_PAYLOAD_BYTES = 100 * 1024; // 100KB
const bodySize = Buffer.byteLength(JSON.stringify(req.body));
if (bodySize > MAX_PAYLOAD_BYTES) {
  return res.status(413).json({ error: "Payload too large (max 100KB)" });
}
```

### 8.2 简单请求频控

第一版用最朴素的内存计数（serverless 实例间不共享，但够用作粗粒度防滥用）：

```ts
// 同一 token 每分钟最多 30 次
const recent = new Map<string, number[]>(); // token -> timestamps[]
function rateLimit(token: string): boolean {
  const now = Date.now();
  const window = 60_000;
  const limit = 30;
  const ts = (recent.get(token) || []).filter(t => now - t < window);
  if (ts.length >= limit) return false;
  ts.push(now);
  recent.set(token, ts);
  return true;
}
```

超限返回 429。

### 8.3 日志脱敏

后端**不允许**将以下内容写入 Vercel 日志或任何持久化存储：
- 用户 API Key
- 完整 messages 内容
- prompt content

允许记录：HTTP 状态码、模型名、token usage、错误码（不带 message body）。这点写入团队约定，代码中通过 ESLint 规则或 code review 把关。

## 9. 测试

### 9.1 验收测试

人工验证以下场景：

1. **anon key 失效验证**：用浏览器开发者工具尝试用旧的 anon key 直接访问 Supabase REST API，应返回 401 或空数组
2. **轮询基本功能**：A 用户新建 prompt → B 用户应该在 30 秒内看到（标签页保持可见）
3. **后台标签页不轮询**：B 切到其他标签页 → 网络面板不应再有 `/api/prompts` 请求；切回来立即触发一次
4. **字段 allowlist**：用 `curl` POST 一个包含 `id` 或 `created_at` 字段的 payload → 写入数据库时这些字段被忽略，使用数据库默认值

### 9.2 自动化测试

新增 `tests/api/prompts-allowlist.test.ts`：测试 POST/PUT 时附加未知字段会被剥离。

## 10. 工作量估算

约 **3-4 小时**。

依赖关系：

- **必须先于其他 5 份 spec 实施**
- 任何前面 4 份功能 spec 中涉及 Realtime / anon 直连的描述需要在本 spec 完成后修订

## 11. 实施顺序

修订后 Phase 1 的整体实施顺序：

1. **安全模型重构（本 spec）** — 必须最先做
2. **修订私人 → 草稿提示词 spec** — 仅文档修订，无实施变化
3. **使用次数** — 低风险，可作为新安全模型下的第一个功能验证
4. **模板** — 完全独立，纯前端
5. **LLM 试运行** — 引入外部 API，需要先有安全基础和频控
6. **保存示例** — 依赖试运行
