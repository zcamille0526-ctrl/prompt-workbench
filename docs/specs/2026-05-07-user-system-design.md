# Phase 2: 完整用户体系 — 设计规格文档

## 0. 决策汇总（实施前已锁定）

| # | 项 | 选择 |
|---|---|---|
| 1 | 注册方式 | **A**: Supabase Auth 邮箱 + 密码。用户在我们网站完成注册，不直接接触 Supabase 控制台 |
| 2 | 老数据 | **c**: 推倒重来。prompts / examples 表清空，所有人在新系统重新建 |
| 3 | 共享密码 | **保留** 作为注册门（注册时需要团队密码才能创建账号） |
| 4 | 用户字段 | `display_name`, `email`（后续按需加） |
| 5 | 管理员 | 加 `is_admin boolean`，可越权编辑/删除任何 prompt 和 example |
| 6 | 邮件验证 | **强制**：注册后必须点邮件链接才能登录 |
| 7 | 注册资格 | **共享密码门**：注册时必须先输入团队密码 |
| 8 | 初始管理员 | 邮箱 `19338106204@163.com` 在迁移脚本中预埋 `is_admin = true`（待该邮箱完成注册流程后自动生效） |

## 1. 产品定位

把"共享密码 + 浏览器名字"的轻量身份模型升级为**完整用户体系**：每人一个邮箱账号，所有 owner 字段从字符串 ID 化，权限规则不再依赖前端可篡改的 `sessionStorage` 名字。

引入管理员角色，用于将来不可避免的"清理失控草稿"、"删除离职同事的私货"等运维任务。

## 2. 安全模型变化

### 2.1 之前（Phase 1）

- 团队共享一个 `SHARED_PASSWORD`
- 用户进入后在 sessionStorage 里写一个 `user_name`（中文/英文，自定义）
- 所有权 = `created_by` 字符串 == `viewer` 字符串
- 已知风险：用户改自己的名字就能假冒别人，仅靠社会约定保护隐私

### 2.2 之后（Phase 2）

- 每人一个**邮箱账号**，Supabase Auth 管理
- 团队密码仅作为**注册门**：注册时校验，登录不再需要
- 登录后获得 Supabase 签发的 access_token（JWT），所有 API 请求带它
- 所有权 = `created_by_id UUID` == 当前 `auth.uid()`，前端无法伪造
- 管理员通过 `users.is_admin` 字段标识，可越过 owner 检查

## 3. 数据模型

### 3.1 新增 `users` 视图（基于 auth.users）

Supabase 的 `auth.users` 表受 schema 保护，不便直接 join 业务表。我们建一个 `public.profiles` 表作为业务侧的扩展：

```sql
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  email text not null unique,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create index profiles_email_idx on profiles(email);

alter table public.profiles enable row level security;

-- 任何已登录用户可以读所有 profile（用来显示"创建人：张三"）
create policy "authenticated_read_profiles" on public.profiles
  for select
  using (auth.role() = 'authenticated');

-- 用户只能改自己的 profile
create policy "users_update_own_profile" on public.profiles
  for update
  using (auth.uid() = id);

-- 服务端可以全权（后端代理用 service_role key）
create policy "service_role_all_profiles" on public.profiles
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
```

`profiles.id` = `auth.users.id`（外键级联删除）。注册流程会在用户验证邮箱后由触发器或后端代理同步插入这条 profile（详见 5.4）。

### 3.2 prompts 表改造

```sql
-- 在新建之前 truncate 掉旧数据（决策 c：推倒重来）
truncate table prompts cascade;

-- 把 created_by 从 text 改成 uuid 引用
alter table prompts drop column created_by;
alter table prompts add column created_by_id uuid not null
  references public.profiles(id) on delete cascade;

create index prompts_created_by_id_idx on prompts(created_by_id);
```

`on delete cascade`：用户被删除时其 prompt 一并删除（团队场景里离职就该清理）。如果以后想保留可改为 `on delete set null` 并允许 nullable。第一版选 cascade。

### 3.3 examples 表改造

```sql
truncate table examples cascade;

alter table examples drop column created_by;
alter table examples add column created_by_id uuid not null
  references public.profiles(id) on delete cascade;

create index examples_created_by_id_idx on examples(created_by_id);
```

### 3.4 RLS 策略调整

`prompts` 和 `examples` 的 RLS 维持现状（`service_role only`）。所有读写继续走我们的后端代理 `api/*`，由代理层用 `auth.uid()` 做权限判断。这保持了 Phase 1 安全重构定下的边界。

## 4. 认证流程

### 4.1 注册（强制邮件验证 + 团队密码门）

```
用户填表（display_name + email + password + 团队密码）
    │
    ▼
POST /api/auth/signup
    │
    ├─ verify(team_password) ───── 错 → 400
    │
    ├─ 调 supabase.auth.signUp({ email, password,
    │                            email_confirm: false })
    │     上行：让 Supabase 发送验证邮件
    │     此时 auth.users 已创建，但 email_confirmed_at 为 null
    │
    └─ 暂不创建 profiles 行（等用户点完链接确认后）
    │
    ▼
后端返回 200 { message: "请到邮箱点击验证链接" }
```

**邮件验证回调**：

Supabase 默认会发邮件，链接形如 `https://<your>.supabase.co/auth/v1/verify?token=...&type=signup&redirect_to=...`。

`redirect_to` 配置为我们网站的 `/auth/callback` 页面。用户点击后：
1. Supabase 验证 token，把 `email_confirmed_at` 设为 now，重定向到回调页
2. 回调页带上 `access_token` 和 `refresh_token`（fragment）
3. 前端读取 token，调 `POST /api/auth/finalize` 让后端：
   - 校验 token
   - 创建对应的 `profiles` 行（display_name 从 user_metadata 取，注册时存的）
   - 若邮箱命中初始管理员邮箱（`19338106204@163.com`），设 `is_admin = true`
4. 跳转到主界面

### 4.2 登录

```
POST /api/auth/login { email, password }
    │
    └─ supabase.auth.signInWithPassword
       │
       ├─ 失败（密码错 / 邮箱未验证） → 401 with code
       │
       └─ 成功 → 返回 { access_token, refresh_token, expires_in }
```

前端把 `access_token` 存到 sessionStorage（与 Phase 1 一致：关闭标签页即清空）。`refresh_token` 也存 sessionStorage（用 secure cookie 更好但实现复杂度上升，当前规模不必要）。

### 4.3 token 刷新

`access_token` 默认 1 小时有效。前端在请求收到 401 时：
1. 调 `POST /api/auth/refresh { refresh_token }` → 拿新 token 对
2. 重新发一遍刚才失败的请求
3. 若 refresh 也 401 → 清空 token，跳登录页

第一版**不做主动后台刷新**，只在收到 401 时被动刷新。简单可靠。

### 4.4 登出

`POST /api/auth/logout` 清后端无状态，仅前端清 sessionStorage 即可。可选调 `supabase.auth.signOut` 让 refresh_token 失效（推荐做）。

### 4.5 忘记密码（第二版做）

第一版不实现密码重置流程，admin 可通过 Supabase 控制台手动操作。明确记入"不做的事情"。

## 5. 后端 API 改造

### 5.1 新增端点

**`api/auth/signup.ts`**
- POST 接收 `{ email, password, display_name, team_password }`
- Zod strict 校验，team_password 与 `SHARED_PASSWORD` 常量比对
- 调 `supabase.auth.signUp({ email, password, options: { data: { display_name } } })`
- 返回 `{ ok: true, message: "请到邮箱..." }` 或映射错误码

**`api/auth/finalize.ts`**
- POST 接收 `{ access_token }`
- 校验 token，从 token 拿 user_id, email, user_metadata.display_name
- 检查 profiles 是否已存在（防重复创建）
- 写入 profiles 行；命中初始管理员邮箱则 `is_admin = true`

**`api/auth/login.ts`**
- POST `{ email, password }`
- 调 `supabase.auth.signInWithPassword`
- 错误映射：邮箱未验证 → `EMAIL_NOT_VERIFIED`；密码错 → `INVALID_CREDENTIALS`

**`api/auth/refresh.ts`**
- POST `{ refresh_token }`
- 调 `supabase.auth.refreshSession`

**`api/auth/logout.ts`**
- POST `{ refresh_token? }`
- 调 `supabase.auth.signOut(refresh_token)`，宽容失败

**`api/auth/me.ts`**
- GET，从 `Authorization: Bearer <token>` 取 user
- 返回 `{ id, email, display_name, is_admin }`
- 用于前端首屏拉当前用户信息

### 5.2 鉴权中间件改造

`api/verify.ts`（旧的共享密码鉴权）**保留但仅供注册接口使用**——不再为业务接口签发 token。

新增 `api/lib/auth.ts`：

```ts
export async function authenticate(req: VercelRequest):
  Promise<{ user: { id: string; email: string; is_admin: boolean } } | null>
{
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  // Pull is_admin from profiles (single round-trip, cached per request)
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin, display_name")
    .eq("id", data.user.id)
    .single();
  if (!profile) return null;

  return { user: { id: data.user.id, email: data.user.email!, is_admin: profile.is_admin } };
}
```

### 5.3 业务端点重构

**`api/prompts.ts`**:
- 删除原 `viewer` query 参数
- 改用 `authenticate()` 拿到 `{ id, is_admin }`
- GET：列出**全部已发布 + 自己的草稿**
- POST：忽略客户端的 `created_by`，直接写 `created_by_id = auth.uid()`
- PUT/DELETE：`existing.created_by_id === user.id || user.is_admin`，否则 403

**`api/examples.ts`** 同改造：
- POST 忽略客户端 `created_by`，写 `created_by_id`
- GET：跟随 prompt 的可见性（草稿 prompt 的 examples 仅 owner 或 admin 可见）
- DELETE：example 创建者 OR prompt 创建者 OR admin 可删

**`api/use-count.ts`**：仅需鉴权，逻辑不变（任何已登录用户可触发自增）。

**`api/chat.ts`**：仅需鉴权，逻辑不变。

### 5.4 PromptCreateSchema / ExampleCreateSchema 调整

```ts
// 删除 created_by 字段（后端从 token 注入）
export const PromptCreateSchema = z.object({
  title, content, category, tags, variables, is_draft
}).strict();
```

前端不再传 `created_by`，后端不接受 `created_by` 字段（strict schema 会 reject）。

### 5.5 全局响应字段调整

GET 返回的 prompt / example 增加 `created_by` 字段（display_name）便于前端展示，由后端 join 而来：

```ts
// 后端在序列化时 join profiles
const { data } = await supabase
  .from("prompts")
  .select("*, profile:profiles!created_by_id(display_name)");
// 然后 flatten 成 created_by_name
```

或者在响应里改名为 `created_by_name`，避免和老的 `created_by`（字符串名字）字段在前端混用导致历史代码出错。

**最终决定**：响应增加 `created_by_id` 和 `created_by_name`，去掉旧的 `created_by`。前端类型一并更新。

## 6. 前端改造

### 6.1 删除的代码

- `src/lib/userName.ts` — 整个文件
- `src/lib/userName.shared.ts` — 整个文件
- `src/components/UserNameDialog.tsx` — 整个文件
- `src/hooks/usePrompts.ts` 中的 `viewer` 拼接逻辑

### 6.2 新增的代码

**`src/lib/authClient.ts`**：
- `getSession()`, `setSession({access_token, refresh_token})`, `clearSession()`
- `getAccessToken()`：自动检查过期、自动 refresh
- 使用 `@supabase/supabase-js` 的客户端模式（公开 anon key）做 token 持久化和刷新

**`src/components/SignupForm.tsx`** + **`src/components/LoginForm.tsx`**：
- 替换原 `PasswordGate`
- 提供 sign in / sign up 切换
- Sign up 表单：display_name, email, password, team_password
- Sign in 表单：email, password
- 都做客户端校验

**`src/pages/AuthCallback.tsx`**（或路由级 component）：
- 处理 `/auth/callback` 路由
- 从 URL fragment 取 access_token，调 `/api/auth/finalize`
- 成功后跳主页

**`src/hooks/useCurrentUser.ts`**：
- 首屏拉 `/api/auth/me`，返回 `{ id, display_name, email, is_admin }`
- 替代 Phase 1 里到处用的 `getUserName()`

### 6.3 修改的代码

- `src/lib/api.ts`：所有请求改用 `getAccessToken()` 而非 `getToken()`；401 时尝试 refresh 一次
- `src/components/Sidebar.tsx`：底部"⚙️ 设置"按钮内容简化（去掉"我的名字"，因为这是 profile 字段，不是 sessionStorage）
- `src/components/SettingsDialog.tsx`：保留 API Key 字段；display_name 改为只读展示，编辑跳到独立的 ProfileDialog
- `src/components/PromptDetail.tsx`：用 `currentUser.id` 比较 `prompt.created_by_id`，admin 也能看到编辑/删除按钮
- `src/components/ExamplesList.tsx`：删除规则改为 `viewer.id === ex.created_by_id || viewer.id === prompt.created_by_id || viewer.is_admin`
- `src/components/PromptForm.tsx`：删除 `created_by` 输入和 sessionStorage 读取，后端注入

### 6.4 路由

第一版前端没引入路由库；继续用条件渲染：

```tsx
<App>
  if (!session) return <AuthScreen />  // 内部含登录/注册切换
  if (window.location.pathname === '/auth/callback') return <AuthCallback />
  return <AuthenticatedApp />
</App>
```

`/auth/callback` 是 Supabase 回调用的路径，需在 `vercel.json` 加一个 rewrite 让所有路径都返回 `index.html`（SPA 通用做法）。

## 7. 数据迁移与新建管理员

### 7.1 迁移 SQL（Migration 006）

```sql
-- 1. 新建 profiles 表（见 3.1）
-- 2. truncate prompts 和 examples
truncate table prompts cascade;
truncate table examples cascade;
-- 3. 修改 created_by 列为 uuid（见 3.2 / 3.3）
-- 4. 不需要在 SQL 里硬编码管理员邮箱 —— 由 finalize 端点判断
```

迁移文件命名：`supabase/migrations/006_user_system.sql`

### 7.2 第一个管理员

`api/auth/finalize.ts` 里：

```ts
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",").map(s => s.trim()).filter(Boolean);

const isAdmin = ADMIN_EMAILS.includes(email);
```

Vercel 环境变量增加：

```
ADMIN_EMAILS=19338106204@163.com
```

需要时多个管理员逗号分隔。改环境变量不需要发版（下次 finalize 时生效；老 admin 已写入数据库，不会被回退）。

### 7.3 团队的迁移流程（用户视角）

部署完后：
1. 你（管理员）打开网站 → 注册页 → 填邮箱 + 密码 + display_name + 团队密码
2. 收邮件点验证 → 自动跳回，profile 创建，is_admin=true
3. 把团队密码和网站链接发给同事
4. 同事各自注册、验证、登录
5. 大家在新系统里重新建提示词

## 8. 错误场景

| 场景 | 行为 |
|---|---|
| 注册时团队密码错 | 400 `WRONG_TEAM_PASSWORD`，前端提示"团队密码错误" |
| 注册时邮箱已存在 | 400 `EMAIL_TAKEN`，提示"邮箱已注册，请直接登录" |
| 登录时邮箱未验证 | 401 `EMAIL_NOT_VERIFIED`，前端提示"请先到邮箱点击验证链接"，并显示"重新发送验证邮件"按钮 |
| 登录时密码错 | 401 `INVALID_CREDENTIALS` |
| access_token 过期 | 401 → 前端 refresh → 重试一次 |
| refresh_token 也无效 | 清 session → 跳登录页，提示"登录已过期" |
| 用户被管理员从 Supabase 控制台删除 | 任何后续 API 401（auth.getUser 失败） |
| `auth/callback` 没有 token（被复制到普通浏览器打开） | 前端提示"链接无效，请重新登录" |

## 9. 测试要求

后端测试（`tests/api/auth.test.ts` 新建）：
- signup：team_password 错 → 400；邮箱重复 → 400；正常 → 200
- login：未验证邮箱 → 401 with EMAIL_NOT_VERIFIED；密码错 → 401；正常 → 200
- finalize：token 无效 → 401；profile 已存在不重建；初始邮箱命中 → is_admin=true
- me：无 token → 401；有效 token → 返回 user info

业务测试改造（`tests/api/prompts.test.ts` 等）：
- 删掉所有 viewer 查询参数相关测试
- mock `supabase.auth.getUser` 返回不同的 user
- 验证：非 owner 编辑 → 403；admin 编辑非自己的 → 200

`tests/api/examples.test.ts`：DELETE 权限新增 admin 可删的 case

## 10. 不做的事情（第二版再加）

- 忘记密码 / 邮件重置（admin 控制台手动）
- 修改邮箱
- 删除自己的账号（admin 通过 Supabase 控制台）
- SSO（飞书/钉钉/Google）
- 用户列表 / 邀请管理 UI（第一版只有自动注册）
- 二次验证（2FA）
- 头像、bio
- 用户活动审计日志

## 11. 工作量估算与拆分

约 **1.5-2 天**。建议拆为三步：

### Step 1（半天）：基础设施 + 注册登录骨架
- profiles 表 + 迁移
- 5 个 auth 端点
- AuthScreen + AuthCallback
- useCurrentUser hook

### Step 2（半天）：业务接口迁移
- prompts / examples / chat / use-count 全部接 `authenticate()`
- 删除 userName 系列代码
- 后端响应增加 `created_by_name`
- PromptDetail / ExamplesList 用 `currentUser.id` 判定

### Step 3（半天）：清理 + 测试 + admin 能力
- 测试套件全面调整
- admin 在 PromptDetail / ExamplesList 看到额外的删除按钮
- README 更新部署说明
- 端到端冒烟（用真邮箱注册 → 验证 → 登录 → 创建 prompt → 试运行 → 保存示例 → 改名失败 → 邮箱白名单未做）

## 12. 部署须知

### 12.1 Supabase 配置

需要在 Supabase Dashboard 做这些手动配置（第一版不写自动化脚本）：

1. **Auth → URL Configuration**：
   - Site URL = 部署 URL（例如 `https://prompt-workbench.vercel.app`）
   - Redirect URLs 添加 `https://prompt-workbench.vercel.app/auth/callback`
2. **Auth → Email Templates**（可选）：把 confirm signup 邮件改成中文模板
3. **Auth → Providers → Email**：确保 enabled，"Confirm email" 打开
4. **Project Settings → API**：复制 `anon` key（前端用，公开的）

### 12.2 Vercel 环境变量

新增：
- `SUPABASE_ANON_KEY` —— 前端用（已有的 `SUPABASE_URL` 配前端 + 后端共用）
- `ADMIN_EMAILS` —— 逗号分隔的初始管理员邮箱列表

`SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 已在用，无需改动。

### 12.3 Vite 构建配置

`SUPABASE_ANON_KEY` 暴露给前端，需在 `vite.config.ts` 中通过 `define` 或 `import.meta.env.VITE_*` 注入。把 Vercel 环境变量名改为 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`（前端可访问），同时保留 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 给后端 serverless 函数（不要前缀，避免泄露 service_role key）。

### 12.4 vercel.json

确保 SPA fallback：

```json
{
  "rewrites": [
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ]
}
```

API 路径不被 fallback，前端路径全部走 `index.html`。

## 13. 已知风险

1. **anon key 公开**：前端必须暴露 anon key，但配合 RLS（profiles 表的 service_role-only 写入策略）和后端代理，攻击面与 Phase 1 相当
2. **service_role key 泄露**：跟 Phase 1 风险相同，仅 serverless 函数环境变量可见，前端拿不到
3. **session token 存 sessionStorage**：若被 XSS 注入可被窃取。第一版接受（无外部脚本依赖，CSP 后续再加）
4. **同邮箱多设备**：登录在两设备 → 各自有独立 refresh_token；登出一处不影响另一处。预期行为
5. **离职用户**：管理员从 Supabase 控制台删除 auth.users 行 → cascade 删除 profile + 所有 prompt + examples。**不可逆**，要谨慎。第二版考虑"软删除/转移所有权"

## 14. 与 Phase 1 的不兼容

数据：清空（决策 c）。
前端 sessionStorage：旧的 `user_name` / `auth_token` 键废弃，新前端不读它们；老用户首次进入会被强制走登录流程。

部署后第一次访问就是登录页，没有"过渡期"。
