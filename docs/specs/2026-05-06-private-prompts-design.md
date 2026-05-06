# 私人提示词 — 设计规格文档

## 1. 产品定位

允许用户标记某条提示词为"私人"，只有创建者本人能看到。让团队成员在公共平台里也能保存自己的草稿、未成熟的想法、尚未公开分享的 prompt。

## 2. 设计前提

第一版基于"轻量 owner"模型：
- 团队继续共享一个访问密码
- 每个用户在浏览器本地（sessionStorage）自己设一个名字
- 私有 prompt 通过名字匹配做"自觉的访问控制"
- 风险：理论上某用户可以改自己的名字来看别人的私人 prompt。在 10 人内部团队场景下接受这个风险

第二版若引入完整用户系统再升级。

## 3. 核心功能

### 3.1 用户名字管理

- **首次访问强制输入**：用户输入共享密码进入后，若 sessionStorage 没有名字，弹出"请输入你的名字"对话框，必填。
- 名字保存在 sessionStorage 的 `user_name` 键
- 关闭浏览器标签后清空（与共享密码、API Key 一致）
- Sidebar 底部增加"⚙️ 设置"区，包含：当前名字（可点击修改）、API Key 配置（来自试运行 spec）
- **名字校验规则**：1-32 字符，允许中文/英文/数字/空格/`_-`，前后端都校验：
  ```
  /^[\w一-龥 \-]{1,32}$/
  ```
- **改名前确认**：若用户改名前已有 N 个私人 prompt（按当前名字计），改名对话框要显示警告"改名后你将无法访问这 N 个私人提示词，需用旧名字才能再次访问"，要求二次确认

### 3.2 私人状态切换

- **新建提示词时**：表单中加"是否私人"开关，默认关闭（公开）
- **编辑提示词时**：同样的开关，可以随时切换公开/私人
- **详情面板**：私人提示词在标题旁加 `🔒 私人` 标识（仅自己看到的列表才会显示）

### 3.3 列表过滤逻辑

后端 GET `/api/prompts` 接受 `viewer` query 参数（前端从 sessionStorage 取并传过来）：

- 返回所有 `is_private = false` 的 prompt（公开的，所有人能看）
- 加上所有 `is_private = true AND created_by = viewer` 的 prompt（自己的私人）

如果 `viewer` 缺失，仅返回公开 prompt。

### 3.4 编辑/删除权限

- 任何用户都可编辑/删除任何**公开**提示词（沿用现状）
- 私人提示词只能由 created_by 与当前 viewer 匹配的用户编辑/删除
- 后端 PUT/DELETE 增加 viewer 校验

### 3.5 Realtime 同步

- **第一版改用"通知 + 重拉"模式，不直接订阅行内容**：
  - 前端继续订阅 prompts 表的 INSERT/UPDATE/DELETE 事件，但**只接收事件信号**（不依赖 payload 中的内容）
  - 收到事件后调用 `fetchPrompts()` 重新拉取，由后端按 viewer 过滤
- 这样私人 prompt 的内容永远不会出现在他人的 websocket 数据流里
- 代价：每次变更触发一次额外的 GET 请求，团队 10 人 + 数百条 prompt 的规模下完全可接受

## 4. 数据模型

### 4.1 prompts 表新增字段

```sql
alter table prompts add column is_private boolean not null default false;
create index prompts_private_created_by_idx on prompts(created_by) where is_private = true;
```

索引仅覆盖私人行（局部索引），保持表性能。

### 4.2 现有数据迁移

旧 prompt 没有 is_private 字段，default false 自动让所有现有 prompt 保持公开状态——预期行为。

## 5. 技术架构

### 5.1 后端

修改 `api/prompts.ts`：

- **GET**：新增 viewer 参数支持。**用两次查询合并避免 SQL 注入风险**：
  ```ts
  const viewer = url.searchParams.get("viewer") || "";
  // 校验 viewer 字符串
  if (viewer && !/^[\w一-龥 \-]{1,32}$/.test(viewer)) {
    return res.status(400).json({ error: "Invalid viewer" });
  }
  // 查询 1：所有公开 prompt
  const publicQ = supabase.from("prompts").select("*").eq("is_private", false);
  // 查询 2：viewer 自己的私人 prompt（viewer 为空则跳过）
  const privateQ = viewer
    ? supabase.from("prompts").select("*").eq("is_private", true).eq("created_by", viewer)
    : null;
  const [pub, priv] = await Promise.all([publicQ, privateQ ? privateQ : Promise.resolve({ data: [], error: null })]);
  if (pub.error || priv.error) return res.status(500).json({ error: "..." });
  // 合并并按 created_at desc 排序
  const merged = [...(pub.data ?? []), ...(priv.data ?? [])]
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return res.status(200).json(merged);
  ```
  这样 viewer 完全走参数化的 `.eq()`，无 SQL 注入风险
- **POST**：Zod schema 增加 `is_private: z.boolean().default(false)`。created_by 仍由前端传入（未引入用户系统前的折中）
- **PUT**：先读 prompt 检查 `is_private` 和 `created_by`：
  - 公开 prompt：任何登录用户可改（沿用现状）
  - 私人 prompt：viewer 必须等于 created_by 才允许，否则 403。若 viewer 缺失也 403
  - **PUT 不修改 created_by 字段**（owner 不可被覆盖）
- **DELETE**：同 PUT 的权限规则

### 5.2 前端

新增 `src/lib/userName.ts`：
- `getUserName()` / `setUserName()` —— sessionStorage 包装

新增 `src/components/UserNameDialog.tsx`：
- 进入主界面时若 `getUserName()` 为空则弹窗强制输入
- 输入后保存并关闭

修改 `src/hooks/usePrompts.ts`：
- fetchPrompts 时从 sessionStorage 取 viewer 拼到 query

修改 `src/components/PromptForm.tsx`：
- 加"是否私人"开关（Radix Switch 或简单 checkbox）
- 保存时附带 `is_private` 字段
- created_by 字段从 sessionStorage 自动填充（不再让用户输入）

修改 `src/components/PromptDetail.tsx`：
- 私人 prompt 标题旁加 🔒 标识

修改 `src/components/Sidebar.tsx`：
- 底部"⚙️ 设置"按钮，打开设置弹窗显示当前名字（可改）和 API Key（与试运行 spec 共用）

修改 `src/lib/schemas.ts`：
- `Prompt` 接口和 `PromptInput` schema 增加 `is_private: boolean`

### 5.3 数据迁移

新增 `supabase/migrations/004_add_is_private.sql`，需要在 Supabase SQL Editor 中手动执行。

## 6. 与其他 spec 的协同

- **设置弹窗**：本 spec 负责创建 Sidebar 的"⚙️ 设置"按钮和设置弹窗骨架，弹窗内置"我的名字"字段。**LLM 试运行 spec 在此基础上扩展加入 API Key 字段**（同一个弹窗，两个字段）
- **使用次数**：私人 prompt 也计数，但只在自己看到时显示
- **试运行**：私人 prompt 也能试运行，使用自己的 API Key
- **保存示例**：私人 prompt 的示例也是私人的（自动），不需要额外字段——因为只有创建者能看到 prompt 本身。created_by 字段沿用本 spec 建立的 sessionStorage 名字
- **模板**：与本功能完全独立

## 7. 错误场景

| 场景 | 行为 |
|------|------|
| 用户没设名字就尝试访问 | UserNameDialog 强制弹出，无法跳过 |
| 用户改了名字（在设置里） | 立即重新拉取列表（视图变化：原来"自己的"变"别人的"） |
| 私人 prompt 的 viewer 不匹配 PUT/DELETE | 后端返回 403 |
| 列表过滤时 viewer 含特殊字符 | 后端做参数化处理，防止 SQL 注入 |

## 8. 不做的事情（第一版）

- 不做完整用户系统（账号/密码/认证）
- 不做"邀请同事查看某条私人 prompt"
- 不做"私人 prompt 数量统计/导出"
- 不做改名后的历史 prompt 归属迁移（用户改名 → 旧的私人 prompt 仍归属旧名字，相当于"隐藏"了）
- 不做名字唯一性校验（两个用户取相同名字 → 互相能看到对方的私人，已知风险）

## 9. 已知风险

- 任何用户改自己的名字为另一人的名字，可看到对方私人 prompt（社会约定层面的隐私）
- 同名冲突：两人名字相同 → 互相可见私人内容
- 名字保存在前端，可被开发者工具修改

第二版引入用户系统时这些都消失。

## 10. 工作量估算

约 **2.5-3 小时**。

依赖：与其他 4 份 spec 互相独立，但**强烈建议**先做本 spec，因为：
1. 它建立了"用户名字"机制，后续保存示例的 created_by 可以复用
2. 它把 Sidebar 设置按钮入口建好，试运行的 API Key 设置可以挂在同一个对话框里
