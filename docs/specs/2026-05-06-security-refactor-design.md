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

### 1.4 当前状态（截至 commit fa9305a，2026-05-06 完成）

**安全重构已完成。** 所有 8 项 checklist 已通过验证：

| 检查项 | 状态 | 验证 |
|--------|------|------|
| Migration `002_lock_down_anon.sql` 已在生产 Supabase 执行 | ✅ | 用户在 Supabase SQL Editor 中手动应用 |
| `prompts` 表已从 `supabase_realtime` publication 移除 | ✅ | 同上 |
| Supabase anon key 已轮换 | ⚠️ | **未轮换**。理由：`anon_select` RLS 策略已删除，旧 bundle 持有的 anon key 已无法读取数据；攻击面已闭合，轮换 key 只是理论上更彻底。当前规模下可接受这一已知差异 |
| Vercel 环境变量删除了 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY` | ✅ | 用户在 Vercel Dashboard 手动删除并重新部署 |
| 主分支上不存在 `src/lib/supabase.ts` 和 `src/hooks/useRealtimePrompts.ts` | ✅ | commit fa9305a |
| `api/prompts.ts` 用了 strict `PromptCreateSchema`/`PromptUpdateSchema`，POST/PUT 各自校验 | ✅ | commit fa9305a |
| `dev-server.ts` 使用 Vercel handler 适配层（`adapt(handler)` 形态） | ✅ | commit fa9305a |
| `api/lib/log.ts` 中的 `safeLog` 已落地，CI 中的 `lint:logs` 跑过且未报错 | ✅ | commit fa9305a，CI workflow `.github/workflows/ci.yml` |

**已知差异**：anon key 未轮换。在新前端不再使用 anon key 且 RLS `anon_select` 策略已删除的状态下，攻击面已闭合；该项保留作为遗留风险，未来若引入更敏感数据再做处理。

## 2. 重构内容

### 2.1 删除公开 SELECT 策略并切断 Realtime 发布

新增 SQL 迁移 `002_lock_down_anon.sql`（编号 002，因为 001 是建表，002-004 留给后续 feature spec 时按本 spec 实施完成后的实际顺序排）：

```sql
-- 删除 prompts 表的公开 SELECT 策略
drop policy if exists "anon_select" on prompts;

-- 防御性：把 prompts 从 Realtime 发布中移除（幂等）。
-- 如果 prompts 不在 publication 中（例如已被移除或自定义 publication），直接 alter 会报错。
do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'prompts'
  ) then
    alter publication supabase_realtime drop table prompts;
  end if;
end $$;

-- 注意：此时 examples 表还不存在（save-example spec 在本 spec 之后实施），
-- 因此本迁移不处理 examples。save-example spec 实施时其建表 SQL 中
-- 必须从一开始就不包含 anon_select_examples 策略，且不加入 supabase_realtime
```

**部署后必须立即在 Supabase Dashboard 中轮换 anon key**：删除环境变量并重新构建只防止"新打包的 bundle 携带 key"，但旧 bundle 缓存、CDN 缓存里的 key 仍然有效且 Supabase 仍会接受。轮换 key 是闭合此漏洞的唯一手段。

数据库回到"只有 service-role 能读写、Realtime 不发布 prompts 表"的状态。

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
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let lastFetchAt = 0;

    const tick = () => {
      // 仅在页面可见时拉取
      if (document.visibilityState !== "visible") return;
      lastFetchAt = Date.now();
      callbackRef.current();
    };

    const startInterval = () => {
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(tick, POLL_INTERVAL_MS);
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // 切回可见时立即拉一次，但避免与刚刚的轮询拉取重叠（< 5s 内不重复）
      if (Date.now() - lastFetchAt > 5_000) tick();
      // 重置定时器，确保下一次轮询从可见时刻起算 30s
      startInterval();
    };

    startInterval();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
```

### 2.4 后端字段 allowlist 与 Zod 校验

修改 `api/prompts.ts`：

- **POST/PUT 使用不同的 Zod schema，都启用 strict 模式**。这样 PUT body 带 `created_by` 会被 schema 直接拒绝（400），而不是依赖后续的 allowlist 偷偷剥离——保证拒绝信号在最前线，所有"试图改 owner"的请求都能被客户端立即看到：

```ts
// src/lib/schemas.ts

// 共享字段（POST/PUT 都允许修改的）
const PromptCommonShape = {
  title: z.string().min(1),
  content: z.string().min(1),
  category: z.string().min(1),
  tags: z.array(z.string()),
  variables: z.array(VariableSchema),
};

// POST schema：含 created_by（新建时由当前用户名字填充）
export const PromptCreateSchema = z.object({
  ...PromptCommonShape,
  created_by: z.string().min(1),
}).strict();

// PUT schema：不含 created_by（owner 不可被改写）
// strict 模式让 PUT 传 created_by/id/created_at/use_count/任意未知字段都返回 400
export const PromptUpdateSchema = z.object(PromptCommonShape).strict();

export type PromptCreateInput = z.infer<typeof PromptCreateSchema>;
export type PromptUpdateInput = z.infer<typeof PromptUpdateSchema>;
```

```ts
// api/prompts.ts 中的处理
// POST
const parsed = PromptCreateSchema.safeParse(req.body);
if (!parsed.success) {
  return res.status(400).json({
    error: "Invalid payload",
    details: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`),
  });
}

// PUT
const parsed = PromptUpdateSchema.safeParse(req.body);
if (!parsed.success) {
  return res.status(400).json({
    error: "Invalid payload",
    details: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`),
  });
}
```

**为什么 strict 而非静默剥离**：strict 让客户端能立即知道写错字段名；静默剥离会掩盖 bug，例如前端把 `is_private` 误写成 `private` 时，后端用静默剥离不会报错，但功能失效。

**仍然保留字段 allowlist 作为防御纵深**——即使将来 schema 被误改成非 strict 或漏掉某个字段，allowlist 仍然兜底（POST 与 PUT 字段允许列表不同）：

```ts
// POST 允许字段（与 PromptCreateSchema 对齐）
const POST_ALLOWED_FIELDS = ["title", "content", "category", "tags", "variables", "created_by"];

// PUT 允许字段（与 PromptUpdateSchema 对齐，不含 created_by）
const PUT_ALLOWED_FIELDS = ["title", "content", "category", "tags", "variables"];

function pickFields(data: object, allowed: string[]) {
  return Object.fromEntries(
    Object.entries(data).filter(([k]) => allowed.includes(k))
  );
}

// POST
const insertData = pickFields(parsed.data, POST_ALLOWED_FIELDS);
await supabase.from("prompts").insert(insertData);

// PUT
const updateData = pickFields(parsed.data, PUT_ALLOWED_FIELDS);
await supabase.from("prompts").update(updateData).eq("id", id);
```

**后续每个新 API 端点**（use-count、chat、examples）都遵循同样模式：先 strict Zod 校验、再字段 allowlist、再写入数据库。每个端点必须显式区分 POST/PUT 允许的字段。

### 2.5 工程改进

新增子 tsconfig，注意 `extends` 的相对路径必须指向**根**的 `tsconfig.json`，否则放在 `api/` 下的 `tsconfig.json` 会自引用：

`api/tsconfig.json`：
```json
{
  "extends": "../tsconfig.json",
  "include": ["./**/*.ts"]
}
```

`tests/tsconfig.json`：
```json
{
  "extends": "../tsconfig.json",
  "include": ["./**/*.ts", "../dev-server.ts"]
}
```

或者直接在根 `tsconfig.json` 里通过 `references` 把 `api/`、`tests/`、`dev-server.ts` 纳入项目引用，由实施者择一即可。在 CI/构建中跑 `tsc -b api tests` 让这些目录也被类型检查。

**测试框架**：项目已使用 Vitest（已经在 devDependencies 中）。所有新增测试文件都用 vitest，CI 中跑 `npm run test`（已在 package.json 中定义）。本 spec 落地后还需要在 GitHub Actions 中加一个最小 CI workflow，运行 `npm run lint:logs` 和 `npm run test`。

**审计 `dev-server.ts`**：实施前必须确认 `dev-server.ts` 只引用 `SUPABASE_SERVICE_ROLE_KEY`，绝不引用 `SUPABASE_ANON_KEY` 或 `VITE_SUPABASE_*`。grep 一遍即可。

### 2.6 统一 API handler 风格 + 修复 dev-server

**当前状态**：`api/verify.ts` 和 `api/prompts.ts` 已经迁移为 Vercel Node.js runtime 的 `(req: VercelRequest, res: VercelResponse)` + `default export`。但 `dev-server.ts` 仍然 `import { handler as ... }`（命名导入），并把 handler 当作 Web API 的 `(req: Request) => Promise<Response>` 调用。**这两边形态不一致，dev-server 当前已无法正常工作**——本节必须修。

**统一方案**：所有 `api/*.ts` 用 Vercel Node.js 形态：

```ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // 鉴权
  // 路由分发
  // 业务逻辑
}
```

**修改 `dev-server.ts`**：让它通过适配层把 Express 的 `req/res` 直接转交给 Vercel handler。Vercel handler 期望的 `req`/`res` 与 Express 的 `req`/`res` 大部分字段兼容（`method`、`headers`、`body`、`query`、`status()`、`json()`），可以直接转：

```ts
import express from "express";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import verifyHandler from "./api/verify.js";
import promptsHandler from "./api/prompts.js";

const app = express();
const PORT = 3001;

app.use(express.json({ limit: "100kb" })); // 与生产端 bodyParser.sizeLimit 对齐

const adapt = (handler: (req: VercelRequest, res: VercelResponse) => Promise<void> | void) =>
  async (req: express.Request, res: express.Response) => {
    await handler(req as unknown as VercelRequest, res as unknown as VercelResponse);
  };

app.post("/api/verify", adapt(verifyHandler));
app.all("/api/prompts", adapt(promptsHandler));

app.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`);
});
```

后续每加一个新 API 端点（chat、use-count、examples），都用 `adapt(handler)` 注册到 dev-server，无需在 dev-server 里写业务逻辑。

## 3. 不影响的部分

- 共享密码 + HMAC token 的鉴权方式不变（`api/verify.ts` 保留）
- 现有 14 条提示词数据不需要迁移
- UI 体验对最终用户基本无感（除了同事改 prompt 后等最多 30 秒才看到）

## 4. 部署顺序（必须严格按顺序）

错误的顺序会导致用户会话短时间内看到空数据或报错。正确顺序：

1. **deploy 新前端**（已删除 `src/lib/supabase.ts`、`useRealtimePrompts`，改为 `usePromptsPolling`）—— 此时新前端还能用旧 anon 策略读数据，无中断
2. **应用 SQL 迁移** `002_lock_down_anon.sql` —— 老 bundle 缓存的会话此刻读会失败，但只影响活跃中的旧标签页（用户刷新即可拉到新 bundle）
3. **删除 Vercel 环境变量** `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`，重新部署一次 —— 让新 bundle 不再携带这两个字符串
4. **在 Supabase Dashboard 中轮换 anon key** —— 关闭旧 key，使所有缓存中的旧 bundle 都无法再用（这一步是真正闭合漏洞的关键）
5. **更新 `.env.example`** 删除两项（如未在步骤 3 中一起改）

迁移文件 `supabase/migrations/002_lock_down_anon.sql` 需要在 Supabase SQL Editor 中手动执行。

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

`2026-05-06-llm-test-run-design.md` 需要补四件事：

### 8.1 Payload 大小限制（在解析前阻断）

后端 `api/chat.ts` 通过 Vercel route config 设定 body 上限，让请求在 body parse 前就被拒绝：

```ts
// api/chat.ts 顶部
export const config = {
  api: {
    bodyParser: { sizeLimit: "100kb" },
  },
};
```

超过自动返回 413（Payload Too Large），无需手动判断。如需在业务层补充检查（比如统计 messages 累计字符数），再单独做一次轻量校验。

### 8.2 简单请求频控

第一版用最朴素的内存计数（serverless 实例间不共享，但够用作粗粒度防滥用）：

```ts
// 同一 token 每分钟最多 30 次（每实例独立计数；Vercel 自动扩容时实际上限 = 30 × 实例数）
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

超限返回 429。**已知局限**：Vercel autoscaling 时每个实例独立计数，实际上限 = 30 × 实例数。10 人团队 + Hobby 计划下实例通常不超过 2-3 个，可接受。下一节的全局预算上限作为最终兜底。

### 8.3 全局每日预算上限（成本兜底）

为防止 token 泄露 → 跑空账户余额，新增 Supabase 全局每日计数器：

```sql
-- 003_create_chat_budget.sql（在 chat 功能上线时同时执行）
create table chat_budget (
  date date primary key,
  call_count integer not null default 0
);

-- 原子 increment 函数。返回 increment 后的最新 count 值
-- 用单条 UPSERT + RETURNING 保证并发安全：多实例同时 +1 不会丢更新
create or replace function increment_chat_budget(p_date date)
returns integer
language sql
as $$
  insert into chat_budget(date, call_count)
  values (p_date, 1)
  on conflict (date) do update set call_count = chat_budget.call_count + 1
  returning call_count;
$$;
```

后端 `api/chat.ts` 用 RPC 调用，避免 select/update 之间的竞态：

```ts
const today = new Date().toISOString().slice(0, 10);
const DAILY_LIMIT = 500; // 全平台每日 500 次调用，10 人团队足够，超出则拒绝

const { data: newCount, error } = await supabase.rpc("increment_chat_budget", { p_date: today });
if (error) {
  return res.status(500).json({ error: "Budget check failed" });
}
if (newCount > DAILY_LIMIT) {
  // 已经 +1 了，记一笔但拒绝调用。下一次请求继续被拒，直到次日 0 点 date 切换。
  // 为什么不在前置检查：UPSERT...RETURNING 是单语句原子的，把"+1 + 检查"合并成一次往返。
  return res.status(429).json({ error: "Daily call limit reached" });
}
```

**为什么用 RPC 而非 select + upsert**：
- 两步操作存在 race：A 实例 select 看到 499，B 实例 select 看到 499，两边都通过检查、各 +1，结果 501（超额）
- RPC 内部是单条 SQL 语句，Postgres 保证原子性，无论多少实例并发都不会丢更新
- 代价：超限的请求也消耗了一次 budget 计数（已 +1），但这是对预算的"悲观"消费，更安全

最坏情况：DeepSeek V4-Pro 每次调用按 ~5K token 估算 ¥0.1，500 次/日 ≈ ¥50/日，月度封顶 ¥1500。这是"灾难情况"上限，正常使用远低于此。可在运营中根据实际用量调整。

### 8.4 日志脱敏（具体可执行的机制）

新增 `api/lib/log.ts`：

```ts
type LogContext = {
  endpoint: string;
  status: number;
  model?: string;
  tokenUsage?: { prompt_tokens: number; completion_tokens: number };
  errorCode?: string;
  // 注意：不接受 messages、apiKey、prompt content 等字段
};

export function safeLog(ctx: LogContext) {
  console.log(JSON.stringify(ctx));
}
```

约定所有 `api/*.ts` 必须用 `safeLog()` 写日志，不允许 `console.log(req.body)` 或类似裸打印。

CI 中加入 grep 规则禁止以下模式：

```bash
# package.json scripts.lint:logs
"lint:logs": "! grep -rE 'console\\.(log|info|warn|error)\\(req\\.|console\\.(log|info|warn|error)\\([^)]*messages' api/ src/lib/api.ts dev-server.ts"
```

CI 中跑这个脚本，不通过则构建失败。规则可以演进，但要有一个具体可执行的把关点。

## 9. 测试

### 9.1 验收测试

人工验证以下场景：

1. **anon key 失效验证**：用浏览器开发者工具尝试用旧的 anon key 直接访问 Supabase REST API，应返回 401 或空数组
2. **轮询基本功能**：A 用户新建 prompt → B 用户应该在 30 秒内看到（标签页保持可见）
3. **后台标签页不轮询**：B 切到其他标签页 → 网络面板不应再有 `/api/prompts` 请求；切回来立即触发一次
4. **strict schema 拒绝未知字段**：用 `curl` POST 一个包含 `id`、`created_at`、`use_count` 或任意未知字段的 payload → 后端立即返回 **400** 并附带 `details` 列出违规字段，**不写入数据库**。这是 strict Zod schema 的预期行为，allowlist 是防御纵深而非主防线。

### 9.2 自动化测试

测试框架沿用项目已有的 Vitest（无需新增依赖）。新增：

- `tests/api/prompts-strict-schema.test.ts`：测试 POST/PUT 携带未知字段（`id`、`created_at`、`use_count`、自造字段名）会返回 400 而非被静默接受
- `tests/api/prompts-put-no-owner-change.test.ts`：测试 PUT body 包含 `created_by` 时返回 400（被 `PromptUpdateSchema` 的 strict 拦截）；并测试即使绕过 schema，`PUT_ALLOWED_FIELDS` 兜底使数据库 `created_by` 列保持不变

CI 中跑 `npm run test`（已在 `package.json` 中定义为 `vitest run`）。本 spec 落地时一并新增 GitHub Actions workflow（`.github/workflows/ci.yml`），在每次 PR 上跑 `npm run lint:logs` + `npm run test` + `tsc -b`。

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
