# 使用次数统计 — 设计规格文档

## 1. 产品定位

让团队成员看到哪些提示词被频繁使用，借此判断提示词的实际价值。零交互成本，数据自动沉淀。

## 2. 核心功能

### 2.1 计数触发

只在"复制提示词"按钮被点击时 +1。不在"查看详情"或"试运行"时计数（查看不代表用，试运行是开发性行为）。

### 2.2 展示位置

- **提示词列表**：每条卡片右下角显示 `↻ 12` （图标 + 数字），灰色小字
- **提示词详情**：在创建人/更新时间那行加 `· 使用 12 次`

### 2.3 计数语义

- 显示的是累计总次数（所有团队成员一起累计）
- 不显示"谁用过"——避免社交压力
- 数字 0 时不显示，避免视觉噪音
- **不做去重/防抖**：用户连续点 N 次复制，就 +N。这是预期行为
- **Realtime 推送以服务端值为准**：本地乐观更新后，若收到 Realtime 推送，直接以推送值覆盖本地

## 3. 数据模型

### 3.1 prompts 表新增字段

```sql
alter table prompts add column use_count integer not null default 0;
```

新增字段会自动包含在现有的 RLS 策略下，不需要修改策略。

### 3.2 计数 API

新增 `POST /api/use-count` 端点（前后端路径完全一致）：
- 请求体：`{ id: "uuid" }`
- 后端逻辑：`update prompts set use_count = use_count + 1 where id = ?`
- 返回：`{ success: true }`
- 不返回新值（前端乐观更新即可，数字偏差 1-2 无关紧要）

错误响应：

| 场景 | HTTP | 响应体 |
|------|------|--------|
| id 缺失或非 UUID | 400 | `{ error: "Invalid id" }` |
| prompt 不存在（影响 0 行） | 200 | `{ success: true }` —— 简单忽略，无副作用 |
| 鉴权失败 | 401 | `{ error: "Unauthorized" }` |

## 4. 技术架构

### 4.1 后端

新增 `api/use-count.ts`（独立的 serverless function）：
- 鉴权：复用 `verifyToken`
- 校验 id 格式（uuid）
- 直接 update，不需要 select

### 4.2 前端

修改 `src/lib/api.ts`：
- 增加 `incrementUseCount(id: string)` 方法

修改 `src/components/PromptDetail.tsx`：
- 复制按钮的 onClick 增加 `await api.incrementUseCount(prompt.id)`
- 失败不影响复制流程（fire-and-forget）
- 乐观更新本地 `prompt.use_count + 1`（依赖 Realtime 同步给其他人）

修改 `src/components/PromptList.tsx`：
- 卡片右下角加显示

修改 `src/lib/schemas.ts`：
- `Prompt` 接口增加 `use_count: number`

## 5. 数据迁移

新增 SQL 迁移文件 `supabase/migrations/002_add_use_count.sql`：

```sql
alter table prompts add column use_count integer not null default 0;
```

需要在 Supabase SQL Editor 中手动执行。

## 6. 界面设计

**列表卡片右下角样式**：

```
[标题]                    [生文]
[标签]
[内容预览...]              ↻ 12
```

字号 `text-xs`，颜色 `text-text-primary/60`，图标用 Solar 风格的轮廓刷新图标或简单的 `↻` 字符。

## 7. 不做的事情（第一版）

- 不做"按使用次数排序"
- 不做"谁用过"的列表
- 不做时间维度（最近 7 天使用次数等）
- 不做趋势图
- 不做减一/撤销

## 8. 工作量估算

约 1.5 小时。依赖：无（独立功能）。
