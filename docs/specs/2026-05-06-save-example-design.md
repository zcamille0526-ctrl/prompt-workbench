# 保存示例输出 — 设计规格文档

## 1. 产品定位

试运行得到满意的对话后，让用户把这次对话保存为"示例输出"。其他同事打开这条提示词时，能直接看到示例的输入/输出，判断"这个 prompt 适不适合我用"。

把"试运行"从消费型动作变成生产型动作——每次有效的测试都为团队留下知识。

## 2. 依赖

依赖 `2026-05-06-llm-test-run-design.md`。本文档假设试运行功能已实现。

## 3. 核心功能

### 3.1 保存示例

试运行对话有内容（≥1 轮 user-assistant 交互）时，对话区下方显示"💾 保存为示例"按钮。点击后：

- 弹出确认对话框，预览要保存的内容
- 用户填写"示例标题"（可选，默认空，比如"使用场景：xxx"）
- 确认后写入数据库

### 3.2 示例展示

详情面板中，在 Markdown 内容预览下方加"📝 示例输出"折叠区域：

- 折叠状态下显示数量：`📝 3 个示例`
- 展开后显示每个示例：标题、变量值、对话内容（user/assistant 气泡）、创建人、创建时间
- **第一版任何登录用户都可删任何示例**（不做创建人校验，第二版加权限）
- **拉取时机**：打开提示词详情时自动 fetch 该 prompt 的所有 examples（首屏一次性加载，性能可接受因为每条最多 5 个）
- **不订阅 Realtime**：第一版不做实时同步，刷新或重新进入详情才能看到他人新增的示例

### 3.3 示例数量限制

每条提示词最多保存 5 个示例，超过提示用户先删除旧的。避免某条 prompt 积累几十个示例占据界面。

## 4. 数据模型

### 4.1 新增 examples 表

```sql
create table examples (
  id uuid primary key default uuid_generate_v4(),
  prompt_id uuid not null references prompts(id) on delete cascade,
  title text,
  variable_values jsonb not null default '{}',
  model text not null,
  messages jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create index examples_prompt_id_idx on examples(prompt_id);

alter table examples enable row level security;

create policy "service_role_all_examples" on examples
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "anon_select_examples" on examples
  for select
  using (true);
```

### 4.2 messages 字段格式

```json
[
  { "role": "user", "content": "..." },
  { "role": "assistant", "content": "..." },
  { "role": "user", "content": "..." },
  { "role": "assistant", "content": "..." }
]
```

不存 system prompt（system prompt 就是 prompt.content 本身，避免冗余）。

### 4.3 variable_values 字段

```json
{ "学科": "语文", "年级": "八年级" }
```

记录用户当时填的变量值，方便其他同事看到"在什么变量条件下产生了这个输出"。

## 5. 技术架构

### 5.1 后端

新增 `api/examples.ts`（serverless function）：
- GET `/api/examples?prompt_id=xxx` —— 列出某条提示词的所有示例（按 created_at desc）
- POST `/api/examples` —— 创建示例。**created_by 由前端传入并存储（信任前端）**。第一版的认证模式是共享密码，无独立用户身份，伪造 created_by 是已知风险但不阻塞团队内部使用。第二版若引入用户体系，则改为后端从认证上下文取
- DELETE `/api/examples?id=xxx` —— 删除示例。**任何登录用户均可删任何示例**（不做创建人校验）
- 鉴权：复用 `verifyToken`
- POST 时：`select count(*)` 检查 prompt_id 下是否已有 5 个示例，超过则返回 400。**已知问题**：5 个上限存在 TOCTOU 竞态（两个用户并发提交可能各看到 4 然后都成功），第一版接受这个 1-2 的偏差
- POST 用 Zod 校验请求体

新增 Zod schema in `src/lib/schemas.ts`：

```ts
export const ExampleSchema = z.object({
  prompt_id: z.string().uuid(),
  title: z.string().max(100).optional(),
  variable_values: z.record(z.string(), z.string()),
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })).min(2).max(40),
  created_by: z.string().min(1),
});

export type ExampleInput = z.infer<typeof ExampleSchema>;

export interface Example extends ExampleInput {
  id: string;
  created_at: string;
}
```

### 5.2 前端

新增 `src/hooks/useExamples.ts`：
- `examples`, `isLoading`, `fetchExamples(promptId)`, `createExample(input)`, `deleteExample(id)`

修改 `src/components/TestRunPanel.tsx`：
- 增加"保存为示例"按钮
- 点击后弹出 SaveExampleDialog

新增 `src/components/SaveExampleDialog.tsx`：
- 标题输入框
- 对话内容预览
- 保存/取消按钮

新增 `src/components/ExamplesList.tsx`：
- 折叠区域，挂在 PromptDetail 中
- 展示每个示例：变量值小卡片 + 对话气泡 + 元信息

修改 `src/components/PromptDetail.tsx`：
- 嵌入 ExamplesList

## 6. 数据迁移

新增 `supabase/migrations/003_create_examples.sql`，需要在 Supabase SQL Editor 中手动执行。

## 7. 界面设计

**ExamplesList 折叠状态：**

```
┌──────────────────────────────────┐
│ 📝 示例输出（3 个）            ▼ │
└──────────────────────────────────┘
```

**ExamplesList 展开状态（每个示例卡片）：**

```
┌──────────────────────────────────┐
│ "测试小学语文场景"     [删除]   │
│ 变量: 学科=语文, 年级=三年级      │
│ 模型: DeepSeek V4-Flash          │
│ ┌──────────────────────────┐    │
│ │ user: ...                 │    │
│ │ assistant: ...            │    │
│ └──────────────────────────┘    │
│ camille · 2026-05-06             │
└──────────────────────────────────┘
```

## 8. 错误场景

| 场景 | 行为 |
|------|------|
| 已有 5 个示例还要保存 | 提示"已达上限，请先删除旧示例" |
| 保存网络失败 | 提示重试，不清空对话 |
| 删除失败 | 提示重试 |

## 9. 不做的事情（第一版）

- 不做"将示例对话恢复到试运行面板继续聊"
- 不做示例的编辑（只能新建/删除）
- 不做示例的点赞或评分
- 不做"哪些示例最有帮助"统计
- 不做权限控制（任何登录用户都可删任何示例，第二版加权限）
- 不做导出（一并随提示词导出 JSON 时再加）

## 10. 工作量估算

约 3-4 小时。依赖：必须先完成 LLM 试运行（`2026-05-06-llm-test-run-design.md`）。
