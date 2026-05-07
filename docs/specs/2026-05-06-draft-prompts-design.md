# 草稿提示词 — 设计规格文档

## 1. 产品定位

允许用户标记某条提示词为"草稿"，只有创建者本人能看到。让团队成员在公共平台里也能保存自己未发布的工作进行中的 prompt——尚在打磨、未成熟、不希望同事先看到的版本。

"草稿"语义比"私人"更贴近实际用法：私人意味着永远私人，草稿意味着工作进行中的临时态。

## 2. 设计前提

第一版基于"轻量 owner"模型：
- 团队继续共享一个访问密码
- 每个用户在浏览器本地（sessionStorage）自己设一个名字
- 草稿 prompt 通过名字匹配做"自觉的访问控制"
- 风险：理论上某用户可以改自己的名字来看别人的草稿。在 10 人内部团队场景下接受这个风险

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
- **改名前确认**：若用户改名前已有 N 个草稿 prompt（按当前名字计），改名对话框要显示警告"改名后你将无法访问这 N 个草稿提示词，需用旧名字才能再次访问"，要求二次确认

### 3.2 草稿状态切换

- **新建提示词时**：表单中加"保存为草稿"开关，默认关闭（直接发布）
- **编辑提示词时**：同样的开关，可以随时切换 已发布/草稿
- **详情面板**：草稿提示词在标题旁加 `📝 草稿` 标识（仅自己看到的列表才会显示）

### 3.3 列表过滤逻辑

后端 GET `/api/prompts` 接受 `viewer` query 参数（前端从 sessionStorage 取并传过来）：

- 返回所有 `is_draft = false` 的 prompt（已发布的，所有人能看）
- 加上所有 `is_draft = true AND created_by = viewer` 的 prompt（自己的草稿）

如果 `viewer` 缺失，仅返回已发布 prompt。

### 3.4 编辑/删除权限

- 任何用户都可编辑/删除任何**已发布**提示词（沿用现状）
- 草稿提示词只能由 created_by 与当前 viewer 匹配的用户编辑/删除
- 后端 PUT/DELETE 增加 viewer 校验

### 3.5 列表实时刷新

继续沿用 Step 0 已建立的 30 秒轮询 + 可见性感知机制（`usePromptsPolling`）。viewer 参数在每次 fetch 时从 sessionStorage 读取并附带到 query string；草稿 prompt 永远不会出现在他人的 GET 响应里——后端按 viewer 过滤。

## 4. 数据模型

### 4.1 prompts 表新增字段

```sql
alter table prompts add column if not exists is_draft boolean not null default false;
create index if not exists prompts_draft_created_by_idx
  on prompts(created_by) where is_draft = true;
```

索引仅覆盖草稿行（局部索引），保持表性能。

### 4.2 现有数据迁移

旧 prompt 没有 is_draft 字段，default false 自动让所有现有 prompt 保持已发布状态——预期行为。

## 5. 技术架构

### 5.1 后端

修改 `api/prompts.ts`：

- **GET**：新增 viewer 参数支持。**用两次查询合并避免 SQL 注入风险**：
  ```ts
  const viewer = (req.query.viewer as string | undefined) ?? "";
  if (viewer && !/^[\w一-龥 \-]{1,32}$/.test(viewer)) {
    return res.status(400).json({ error: "Invalid viewer" });
  }
  const publicQ = supabase.from("prompts").select("*").eq("is_draft", false);
  const draftQ = viewer
    ? supabase.from("prompts").select("*").eq("is_draft", true).eq("created_by", viewer)
    : null;
  const [pub, drafts] = await Promise.all([
    publicQ,
    draftQ ?? Promise.resolve({ data: [], error: null }),
  ]);
  if (pub.error || drafts.error) return res.status(500).json({ error: "..." });
  const merged = [...(pub.data ?? []), ...(drafts.data ?? [])]
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return res.status(200).json(merged);
  ```
- **POST**：Zod schema 增加 `is_draft: z.boolean().default(false)`
- **PUT**：先读 prompt 检查 `is_draft` 和 `created_by`：
  - 已发布 prompt：任何登录用户可改（沿用现状）
  - 草稿 prompt：viewer（来自 query 参数）必须等于 created_by 才允许，否则 403
  - **PUT 不修改 created_by 字段**（owner 不可被覆盖）
- **DELETE**：同 PUT 的权限规则
- **`POST_ALLOWED_FIELDS` / `PUT_ALLOWED_FIELDS` 增加 `is_draft`**

### 5.2 前端

新增 `src/lib/userName.ts`：
- `getUserName()` / `setUserName()` —— sessionStorage 包装
- `validateUserName(name)` —— 与后端共用同一正则

新增 `src/components/UserNameDialog.tsx`：
- 进入主界面时若 `getUserName()` 为空则弹窗强制输入
- 输入后保存并关闭

新增 `src/components/SettingsDialog.tsx`：
- Sidebar 底部"⚙️ 设置"按钮触发
- 显示当前名字 + 修改入口
- 改名前若用户已有草稿，二次确认
- 留好 API Key 字段位置（试运行 spec 接续）

修改 `src/hooks/usePrompts.ts`：
- fetchPrompts 时从 sessionStorage 取 viewer 拼到 query

修改 `src/components/PromptForm.tsx`：
- 加"保存为草稿"开关
- 保存时附带 `is_draft` 字段
- created_by 字段从 sessionStorage 自动填充（不再让用户输入）

修改 `src/components/PromptDetail.tsx`：
- 草稿 prompt 标题旁加 📝 标识

修改 `src/components/Sidebar.tsx`：
- 底部"⚙️ 设置"按钮，打开 SettingsDialog

修改 `src/lib/schemas.ts`：
- `Prompt` 接口增加 `is_draft: boolean`
- `PromptCreateSchema` / `PromptUpdateSchema` 增加 `is_draft: z.boolean().default(false)`

### 5.3 数据迁移

新增 `supabase/migrations/004_add_is_draft.sql`，需要在 Supabase SQL Editor 中手动执行。

## 6. 与其他 spec 的协同

- **设置弹窗**：本 spec 负责创建 Sidebar 的"⚙️ 设置"按钮和设置弹窗骨架，弹窗内置"我的名字"字段。**LLM 试运行 spec 在此基础上扩展加入 API Key 字段**（同一个弹窗，两个字段）
- **使用次数**：草稿 prompt 也计数，但只在自己看到时显示
- **试运行**：草稿 prompt 也能试运行，使用自己的 API Key
- **保存示例**：草稿 prompt 的示例也是私有的（自动），不需要额外字段——因为只有创建者能看到 prompt 本身
- **模板**：与本功能完全独立

## 7. 错误场景

| 场景 | 行为 |
|------|------|
| 用户没设名字就尝试访问 | UserNameDialog 强制弹出，无法跳过 |
| 用户改了名字（在设置里） | 立即重新拉取列表（视图变化：原来"自己的"变"别人的"） |
| 草稿 prompt 的 viewer 不匹配 PUT/DELETE | 后端返回 403 |
| 列表过滤时 viewer 含特殊字符 | 后端返回 400 (Invalid viewer) |
| viewer 缺失时尝试编辑/删除草稿 | 后端返回 403 |

## 8. 不做的事情（第一版）

- 不做完整用户系统（账号/密码/认证）
- 不做"邀请同事查看某条草稿 prompt"
- 不做"草稿 prompt 数量统计/导出"
- 不做改名后的历史 prompt 归属迁移（用户改名 → 旧的草稿 prompt 仍归属旧名字，相当于"隐藏"了）
- 不做名字唯一性校验（两个用户取相同名字 → 互相能看到对方的草稿，已知风险）

## 9. 已知风险

- 任何用户改自己的名字为另一人的名字，可看到对方草稿 prompt（社会约定层面的隐私）
- 同名冲突：两人名字相同 → 互相可见草稿内容
- 名字保存在前端，可被开发者工具修改

第二版引入用户系统时这些都消失。

## 10. 测试要求

后端单元测试 (`tests/api/prompts.test.ts` 扩展):
- GET 不带 viewer：仅返回已发布 prompt
- GET 带 viewer：返回已发布 + viewer 自己的草稿
- GET 带非法 viewer (含特殊字符)：400
- POST is_draft=true 时正常落库
- POST 携带未知字段（如 `private`）：400 strict
- PUT 草稿且 viewer ≠ created_by：403
- PUT 草稿且 viewer 缺失：403
- PUT 已发布 prompt：任何 viewer 都允许（沿用现状）
- DELETE 草稿且 viewer ≠ created_by：403
- DELETE 草稿且 viewer 缺失：403

## 11. 工作量估算

约 **2.5-3 小时**。

依赖：与其他 4 份 spec 互相独立，但**强烈建议**先做本 spec，因为：
1. 它建立了"用户名字"机制，后续保存示例的 created_by 可以复用
2. 它把 Sidebar 设置按钮入口建好，试运行的 API Key 设置可以挂在同一个对话框里
