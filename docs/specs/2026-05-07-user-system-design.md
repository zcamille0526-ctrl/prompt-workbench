# Phase 2: 完整用户体系 — 设计规格文档

> **审核轮次**：本 spec 经过 codex 第 1/2/3 轮审核（2026-05-07），修订记录见末尾「附录 A / B / C」。Round 3 主要处理 setup-account 反向半成功窗口、同邮箱重复 signup 状态机、resend-invite 限流 + opaque 响应、profile/update strict reject 等 5 项。

## 0. 决策汇总（实施前已锁定）

| # | 项 | 选择 |
|---|---|---|
| 1 | 注册方式 | **A**: Supabase Auth 邮箱 + 密码。**Supabase 控制台需关闭 public signups**；用户创建只走后端 service_role 路径 |
| 2 | 老数据 | **c**: 推倒重来。prompts / examples 表清空，所有人在新系统重新建 |
| 3 | 共享密码 | **保留** 作为注册门（后端 `/api/auth/signup` 校验，绕过路径已被 P0#2 修复堵死） |
| 4 | 用户字段 | `display_name`, `email`（后续按需加） |
| 5 | 管理员 | 加 `is_admin boolean`，可越权编辑/删除任何 prompt 和 example |
| 6 | 邮件验证 | **强制**：通过 Supabase 内置的 **invite 流程**实现邀请邮件 + 用户点链接 + 在网站设置密码完成注册 |
| 7 | 注册资格 | **共享密码门**（详见 §4.1） |
| 8 | 初始管理员 | 邮箱 `19338106204@163.com` 由 `ADMIN_EMAILS` 环境变量注入，账户创建时自动 `is_admin = true` |

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
- 管理员通过 `profiles.is_admin` 字段标识，可越过 owner 检查

### 2.3 关键安全约束（P0 修复后）

1. **Supabase 项目必须关闭 "Allow new users to sign up"**（Auth → Providers → Email）。这切断了"前端拿到 anon key 直接 signUp 绕过团队密码门"的攻击路径。所有用户创建走后端 service_role 调用 `admin.inviteUserByEmail`。
2. **`profiles` 表对 authenticated 角色只允许 SELECT，不允许任何 UPDATE**。任何字段（特别是 `is_admin`）的修改都必须经 `/api/profile/*` 后端代理，由 service_role 执行。这切断了"前端拿 anon key 直接 update profile 把自己提权为管理员"的攻击路径。
3. `app_metadata.team_pass_verified` 是冗余防御：即使 (1) 配置遗漏，被创建的用户也会缺这个 service_role 写入的 flag，前端业务接口可拒绝服务（详见 §4.1）。

## 3. 数据模型

### 3.1 新增 `public.profiles` 表

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

-- 已登录用户可读所有 profile（用于显示"创建人：张三"和拼装 GET 响应）
create policy "authenticated_read_profiles" on public.profiles
  for select
  to authenticated
  using (true);

-- 服务端可全权（业务侧的所有写入路径都走它）
create policy "service_role_all_profiles" on public.profiles
  for all
  to service_role
  using (true)
  with check (true);

-- 注意：故意不创建 INSERT/UPDATE/DELETE 给 authenticated 的策略。
-- 任何 profile 的修改必须通过 /api/profile/* 后端代理（用 service_role
-- 写入），后端代理会显式排除 is_admin 字段。这样前端即便拿到 anon key
-- 也无法直连数据库改自己的 is_admin。
```

`profiles.id` 与 `auth.users.id` 一一对应，由后端创建（详见 §4.1 步骤 4）。

### 3.2 prompts 表改造

```sql
-- 决策 c：老数据清空
truncate table prompts cascade;

alter table prompts drop column created_by;
alter table prompts add column created_by_id uuid not null
  references public.profiles(id) on delete cascade;

create index prompts_created_by_id_idx on prompts(created_by_id);
```

### 3.3 examples 表改造

```sql
truncate table examples cascade;

alter table examples drop column created_by;
alter table examples add column created_by_id uuid not null
  references public.profiles(id) on delete cascade;

create index examples_created_by_id_idx on examples(created_by_id);
```

### 3.4 RLS 策略调整

`prompts` 和 `examples` 的 RLS 维持现状（`service_role only`）。所有读写继续走后端代理。

## 4. 认证流程

### 4.1 注册（邀请 + 设密码两段式）

P0#2 的修复要求 Supabase 项目关闭 public signups，因此用户创建只能由后端用 service_role 触发。我们采用 Supabase 的 invite 流程，由 Supabase 自身托管 SMTP 发送验证邮件（free tier 包含约 3 封/小时，10 人团队足够）：

```
[Step A] 用户填表（display_name + email + team_password）
    │
    ▼
POST /api/auth/signup
    │
    ├─ 校验 team_password 与 SHARED_PASSWORD 是否相等（timingSafeEqual）→ 错则 400
    │
    ├─ 调 supabase.auth.admin.inviteUserByEmail(email, {
    │     data: { display_name },               // 写入 user_metadata
    │     redirectTo: `${SITE_URL}/auth/callback`,
    │  })
    │     ↑ Supabase 创建 unconfirmed 用户 + 发送邀请邮件
    │
    ├─ 立即调 admin.updateUserById(newUser.id, {
    │     app_metadata: { team_pass_verified: true }
    │  })
    │
    └─ ⚠️ 原子性补偿（P2 修复）：若 updateUserById 抛错，同步调
       admin.deleteUser(newUser.id) 回滚刚创建的 auth.users 行，再返回 500
       INVITE_FAILED。否则会留下一个"被邀请但永远过不了 setup-account
       team_pass_verified 检查"的孤儿账号
    │
    ▼
返回 200 { message: "请到邮箱点击邀请链接以完成注册" }


[Step B] 用户点邮件链接 → 浏览器跳转到 /auth/callback#access_token=...&refresh_token=...
    │
    ▼
前端 AuthCallback 组件先检测 pathname 等于 /auth/callback（路由判断在 session 判断之前，详见 §6.4），
然后用 @supabase/supabase-js 客户端 setSession({access_token, refresh_token}) 接管会话
    │
    ▼
解析完 fragment 立即 history.replaceState({}, '', '/auth/callback') 清空地址栏 token
（无论后续成功失败，避免 token 留在浏览器历史/截图，详见 §4.4.1）
    │
    ▼
判断 user 是否还没设密码（user_metadata.password_set !== true）→ 跳转「设置密码」表单
    │
    ▼
用户填新密码并提交 → POST /api/auth/setup-account
    │
    ├─ 用请求头 access_token 校验出 user_id（supabase.auth.getUser）
    │
    ├─ 校验该 user 的 app_metadata.team_pass_verified===true（防止有人直接拿到 invite 链接绕过）
    │
    ├─ ⚠️ 顺序很重要（P1 修复）：先 UPSERT profile，再设密码
    │
    │   1) UPSERT profile（display_name 取自 user_metadata，is_admin 由 ADMIN_EMAILS 决定）
    │      INSERT INTO profiles (id, email, display_name, is_admin)
    │      VALUES (...) ON CONFLICT (id) DO NOTHING
    │
    │   2) 仅在 user.user_metadata.password_set !== true 时才设密码：
    │      admin.updateUserById(user.id, {
    │        password: <new>,
    │        user_metadata: { ...existing, password_set: true }
    │      })
    │
    │   两端都失败时的恢复路径（P1 round-3 修复）：
    │   - 步骤 1 成功、步骤 2 失败：profile 存在但 password_set=false。
    │     业务接口的 authenticate 强制要求 password_set===true（详见 §5.2），
    │     所以这种 user 不会被业务接口当成合法成员。用户重新点邀请链接（或
    │     走 resend-invite）→ setup-account 再跑：步骤 1 因 ON CONFLICT 跳过，
    │     步骤 2 重试成功 → 完成。
    │   - 反过来（先设密码再 UPSERT profile）则会形成"password_set=true 但
    │     profile 缺失"，且 setup-account 被自身的 password_set 检查挡住 →
    │     死锁。这正是当前顺序要避免的。
    │
    └─ 返回 200 { user_summary }
    │
    ▼
前端跳主界面
```

**幂等恢复**：setup-account 的逻辑显式允许"profile 缺失但 password_set=true"作为可恢复状态——此时跳过密码设置，仅 UPSERT profile。这种状态在正常流程下不该出现，仅作为旧 bug / 数据修复的安全网。

**为什么需要"两段式"**：`admin.inviteUserByEmail` API 不接收 password 参数（这是 Supabase 的设计——邀请的语义就是"待用户接受"）。所以密码必须在用户点击邀请链接确认身份后再设置。

**`team_pass_verified` flag 的边界**：service_role 在 signup 时写入此 flag，service_role 在 setup-account 时检查。Phase 2 的边界明确为：**绕过路径产生的账号永远拿不到 profile，因此永远过不了业务 `authenticate()`**（authenticate 强制要求 profile 存在 + password_set===true，详见 §5.2 修订）。`team_pass_verified` 不在每次业务请求中重复检查。

### 4.1.1 同邮箱重复 signup 的状态机（P1 round-3 修复）

repeat-signup 在 Supabase 默认行为下会"再次发送邀请"，可能覆盖 user_metadata 或被人滥用。需明确状态机：

| 既有用户状态 | signup 行为 | resend-invite 行为 |
|---|---|---|
| 不存在 | 正常流程：invite + 写 flag + 返回 200 | 400 `EMAIL_NOT_FOUND`（响应统一为 §4.7 opaque message） |
| 存在 / `password_set=false` / `team_pass_verified=true`（被邀请但未设密码，正常中间态） | 400 `EMAIL_PENDING`，前端提示"该邮箱已发出邀请，请去邮箱查收，或点'重发邀请'" | 受冷却时间约束，重发邀请；display_name 取自现有 user_metadata（不接受客户端覆写） |
| 存在 / `password_set=false` / `team_pass_verified=false`（孤儿账号，signup 第二步崩溃留下） | 400 `EMAIL_PENDING`（向用户呈现与上一行相同），后端日志记 `ORPHAN_DETECTED` 便于排查 | 重发时**顺手覆写 `team_pass_verified=true`**（兼任修复路径），display_name 不变 |
| 存在 / `password_set=true`（账号已完成设置） | 400 `EMAIL_TAKEN`，前端提示"邮箱已注册，请直接登录" | 400 `ALREADY_SETUP`（响应仍统一为 opaque message，详见 §4.7） |

关键不变量：
- **signup 永远不重新调用 `inviteUserByEmail`**——避免 display_name 被覆盖、邀请链接被多次签发供攻击者拼凑
- **display_name 只在首次 signup 时由客户端提供**——后续任何重发路径都从 `user_metadata` 读取
- 状态判定的源头是 `auth.users` 行（signup 前用 `admin.listUsers({ email })` 查询），不依赖 profiles（profiles 滞后）

### 4.2 登录

```
POST /api/auth/login { email, password }
    │
    ├─ supabase.auth.signInWithPassword
    │
    ├─ 失败映射：
    │     INVALID_CREDENTIALS（密码错或邮箱未注册）
    │     EMAIL_NOT_VERIFIED（未点邀请链接，或未走完 setup-account）
    │
    └─ 成功 → 返回 { access_token, refresh_token, expires_in, user_summary }
```

注意：本端点在登录后**不暴露 anon-key 客户端 supabase-js**，业务请求继续用 access_token 调我们自己的 `/api/*`。anon-key 只在 AuthCallback / 设密码这两步需要。

### 4.3 token 持久化

前端把 `access_token` 与 `refresh_token` 存到 **`window.sessionStorage`**（关闭标签页清空）。

实现要求（P1#6 修复）：使用 `@supabase/supabase-js` 创建客户端时**必须显式传 `auth.storage: window.sessionStorage`**：

```ts
createClient(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, {
  auth: {
    storage: window.sessionStorage,  // 显式 — 默认是 localStorage
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,        // 我们自己处理 /auth/callback fragment
    flowType: 'implicit',             // 锁定 fragment-token 流（详见 §4.4）
  },
});
```

不显式传 storage 时，supabase-js 默认使用 `localStorage`，会破坏"关闭标签页即清空"的安全语义。

### 4.4 邮件回调流（implicit flow，P1#5 修复）

Supabase 的 invite/recovery 链接根据项目配置可能返回两种回调：

| flow | 回调 URL 形态 | 处理方式 |
|---|---|---|
| **implicit**（default） | `#access_token=...&refresh_token=...&type=invite` | 前端解析 fragment，调 `setSession` |
| **PKCE** | `?code=...` | 前端调 `exchangeCodeForSession(code)` |

**本设计锁定 implicit flow**（`flowType: 'implicit'` 见 §4.3），原因：
1. 实现更直接（fragment 包含全套 token）
2. invite 流程不强需要 PKCE（PKCE 主要为单页应用 OAuth 防中间人，对 email 链接收益有限）
3. Supabase 默认即 implicit，无需控制台改动

`AuthCallback` 组件**必须同时支持 fragment token 解析**，并对 `?code` 形态返回错误"链接格式不识别，请重发邀请"，避免在 Supabase 默认变更后悄悄崩溃。

### 4.4.1 立即清空 URL fragment（P1 修复）

implicit flow 把 `access_token` / `refresh_token` 直接放进 URL fragment。fragment 不会随 HTTP 请求发到服务器，但仍然可见于：

- 浏览器地址栏
- 浏览器历史记录
- 用户截图、屏幕共享、错误报告
- 同页内的任何脚本（包括第三方分析、扩展等）

**强制要求**：AuthCallback 在解析完 fragment 取出 token 后，**无论后续 setSession 成功或失败，第一时间**调用：

```ts
window.history.replaceState({}, "", window.location.pathname);
```

清空地址栏的 token。setSession 即便失败也不要把 token 留在 URL（用户截图发反馈时的隐患）。

理论上更彻底的方案是切到 PKCE flow（token 不会出现在 fragment），但 PKCE 在 Supabase 邀请邮件流程中的实现路径目前仍在演进，第一版选择"implicit + 立即 replaceState"作为实用平衡。第二版若 PKCE 与 magic-link 流程在 Supabase 侧成熟，再切。

### 4.5 token 刷新

`access_token` 默认 1 小时。前端被动刷新策略：

1. 业务请求收到 401 → 调 `POST /api/auth/refresh { refresh_token }`
2. 拿新 token 对 → 重发原请求
3. refresh 也 401 → 清 sessionStorage，跳登录页

不做主动后台刷新。

### 4.6 登出

`POST /api/auth/logout`：
- 调 `supabase.auth.admin.signOut(refresh_token)`（service_role 可使任何 token 失效）
- 前端清 sessionStorage

### 4.7 重发邀请邮件（P2#8 修复 + round-3 限流加固）

错误场景里"邮箱未验证"会展示"重新发送验证邮件"按钮，需要后端端点支撑：

**`POST /api/auth/resend-invite`**：
- 接收 `{ email, team_password }`（**不接收 display_name**——见下文）
- 校验 `team_password`（防止变成开放的邮件喷射器）
- **限流**（round-3 加固）：
  - 每邮箱冷却 60 秒（`auth.users.last_sign_in_at` / 自建 `invite_throttle` 表追踪上次发送时间）
  - 每 IP 每小时最多 10 次
  - 第一版用一张 `invite_throttle (email text primary, last_sent_at timestamptz)` 表，service_role-only RLS；超限返回 429 `THROTTLED`
- **响应统一 opaque**（round-3 加固）：除了团队密码错（400 `WRONG_TEAM_PASSWORD`）和限流（429）以外，**无论内部状态如何，统一返回 200 `{ message: "如果该邮箱可重发，我们已发送邀请" }`**——不暴露邮箱是否已注册、是否已 setup
- 内部分支处理：
  - 用 service_role 查 `auth.admin.listUsers` 找出该 email 对应用户：
    - 不存在 → 内部记 `EMAIL_NOT_FOUND`，对外 200 opaque
    - `user_metadata.password_set === true` → 内部记 `ALREADY_SETUP`，对外 200 opaque
    - 否则继续
  - `display_name` 从已存在的 `user_metadata.display_name` 取，**不接受客户端传入**
  - 调 `admin.inviteUserByEmail(email, { data: { display_name }, redirectTo: ${SITE_URL}/auth/callback })`
  - **重新覆写** `app_metadata.team_pass_verified=true`（兼任孤儿账号修复路径）
  - 写入 invite_throttle.last_sent_at = now
  - 返回 200 opaque

**为什么对已 setup 用户也 opaque**：避免成为邮箱探测器（"输入邮箱看返回不同 → 推断该邮箱是否注册"）。10 人内部团队这层泄漏低危，但成本几乎为零。
**为什么不允许已 setup 用户实际重发**：邀请链接包含一个有效的 access_token，对已设密码的账户发等于绕过密码登录。维持只对 password_set=false 的用户实际重发的语义，opaque 响应只是把这个分支隐藏起来。

## 5. 后端 API 改造

### 5.1 新增端点

**`api/auth/signup.ts`**
- POST `{ email, display_name, team_password }`（password 不在此处）
- Zod strict 校验
- timingSafeEqual 比较 team_password 与 `SHARED_PASSWORD`
- 用 service_role 查 `admin.listUsers({ email })` 应用 §4.1.1 状态机：
  - 已存在 / `password_set=true` → 400 `EMAIL_TAKEN`
  - 已存在 / `password_set=false`（任一 flag 状态）→ 400 `EMAIL_PENDING`，引导前端走 resend-invite
  - 不存在 → 走下面的创建流程
- `admin.inviteUserByEmail(email, { data: { display_name }, redirectTo: ${SITE_URL}/auth/callback })`
- 立即 `admin.updateUserById(newUser.id, { app_metadata: { team_pass_verified: true } })`
- **若 updateUserById 失败：调 `admin.deleteUser(newUser.id)` 回滚，返回 500 `INVITE_FAILED`**（避免留下"被邀请但永远 setup 不通"的孤儿账号）
- 返回 200 `{ message }` 或上面映射的错误

**`api/auth/setup-account.ts`**（替代原 spec 的 finalize；P1 修复后顺序敏感）
- POST `{ password }`，需要 `Authorization: Bearer <invite-access-token>`
- 校验 token，拿 user
- 校验 `user.app_metadata.team_pass_verified === true`，否则 403 `BYPASS_ATTEMPT`
- **顺序固定**（防半成功状态死锁）：
  1. UPSERT profile：`INSERT INTO profiles (id, email, display_name, is_admin) VALUES (...) ON CONFLICT (id) DO NOTHING`
     - `display_name` 从 `user.user_metadata.display_name` 取
     - `is_admin = ADMIN_EMAILS.includes(email)`
  2. 仅当 `user.user_metadata.password_set !== true` 时，才调
     `admin.updateUserById(user.id, { password, user_metadata: { ...existing, password_set: true } })`
- 返回 200 `{ user_summary }`
- **幂等性**：若用户因任何原因已有 `password_set=true` 但缺 profile，第 1 步补齐 profile，第 2 步跳过；后续 login 即可正常使用

**`api/auth/login.ts`**
- POST `{ email, password }`
- `supabase.auth.signInWithPassword`
- 错误映射：401 INVALID_CREDENTIALS / EMAIL_NOT_VERIFIED

**`api/auth/refresh.ts`**
- POST `{ refresh_token }`
- `supabase.auth.refreshSession`

**`api/auth/logout.ts`**
- POST `{ refresh_token? }`
- `admin.signOut(refresh_token)`，宽容失败

**`api/auth/me.ts`**
- GET，header `Authorization: Bearer <token>`
- 返回 `{ id, email, display_name, is_admin }`

**`api/auth/resend-invite.ts`**（详见 §4.7）

**`api/profile/update.ts`**（P0#1 必需，round-3 严格化）
- PATCH，需要 token
- **Zod strict schema 只允许 `display_name`**：

  ```ts
  export const ProfileUpdateSchema = z.object({
    display_name: z.string().min(1).max(64),
  }).strict();
  ```

  携带任何其他字段（`is_admin` / `email` / `id` / 任意未知字段）→ **400 `Invalid payload`**（不静默忽略）。这与 Phase 1 的 prompts/examples strict schema 行为一致，让攻击尝试和前端 bug 都暴露在错误响应里而不是被掩盖
- 后端用 service_role 执行 `UPDATE profiles SET display_name=$1 WHERE id=auth.uid()`
- 测试覆盖：传 `is_admin` 必须 400，且 `is_admin` 在数据库保持原值不变

### 5.2 鉴权中间件（`api/lib/auth.ts`）

**安全边界**（P1 round-2/round-3 修订）：业务接口的"已认证用户"等价于：
1. `auth.getUser(token)` 成功
2. `profiles` 行存在（已经过 setup-account 写入）
3. `user.user_metadata.password_set === true`（已完成设密码）

(2) 蕴含 `team_pass_verified===true`（profile 只能由 setup-account 创建，setup-account 强制 check 此 flag），所以业务接口不再单独 check `team_pass_verified`。
(3) 关闭"profile 已存在但密码未设"的反向半成功窗口——这种 user 在数据库里看似合法，但 authenticate 仍拒绝服务，强制走完密码设置流程。

```ts
export async function authenticate(req: VercelRequest):
  Promise<{ user: { id: string; email: string; display_name: string; is_admin: boolean } } | null>
{
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  // 关闭反向半成功窗口（P1 round-3）：要求 password_set===true。
  // setup-account 第 2 步成功后才会写入；半成功状态用户在此被挡住，
  // 强制走完邀请链接 → 设密码 → 完成 三步流程。
  if (data.user.user_metadata?.password_set !== true) return null;

  // profile 缺失即拒绝。setup-account 是 profile 唯一写入入口，且要求
  // team_pass_verified===true，所以 profile 的存在性蕴含"该 user 走过
  // 完整团队密码门 + 邮件验证流程"。
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, is_admin")
    .eq("id", data.user.id)
    .single();
  if (!profile) return null;

  return {
    user: {
      id: data.user.id,
      email: data.user.email!,
      display_name: profile.display_name,
      is_admin: profile.is_admin,
    },
  };
}
```

`api/verify.ts`（旧的共享密码鉴权 + JWT 签发）**整体删除**。Phase 2 之后所有业务接口走 `authenticate()`，`team_password` 仅在 `/api/auth/signup` 与 `/api/auth/resend-invite` 中校验，不再签发 token。

### 5.3 业务端点重构

**`api/prompts.ts`**：
- 删除 `viewer` query 参数
- 用 `authenticate()` 拿 `{ id, is_admin }`
- GET：列出**全部 `is_draft=false` + `is_draft=true AND created_by_id = user.id`**
- POST：忽略客户端的 `created_by` / `created_by_id`，写 `created_by_id = user.id`
- PUT/DELETE：`existing.created_by_id === user.id || user.is_admin`，否则 403

**`api/examples.ts`**：
- POST 忽略客户端 `created_by`，写 `created_by_id = user.id`
- GET：跟随 prompt 的可见性
- DELETE：example 创建者 OR prompt 创建者 OR admin 可删

**`api/use-count.ts`**：仅鉴权，逻辑不变

**`api/chat.ts`**：仅鉴权，逻辑不变

### 5.4 Schema 变化

```ts
// PromptCreateSchema 删除 created_by 字段
export const PromptCreateSchema = z.object({
  title, content, category, tags, variables, is_draft
}).strict();

// ExampleCreateSchema 同样删除 created_by
export const ExampleCreateSchema = z.object({
  prompt_id, title?, variable_values, model, messages
}).strict();
```

### 5.5 GET 响应字段调整

prompt / example 响应去掉旧的 `created_by`（字符串），新增：
- `created_by_id: string`（UUID）
- `created_by_name: string`（display_name，由后端 join profiles）

后端用 supabase 的嵌套查询 `select("*, creator:profiles!created_by_id(display_name)")`，序列化前 flatten 到顶层。

## 6. 前端改造

### 6.1 删除

- `src/lib/userName.ts`、`src/lib/userName.shared.ts` 整个文件
- `src/components/UserNameDialog.tsx`
- `src/hooks/usePrompts.ts` 中所有 viewer 拼接逻辑
- `src/components/PasswordGate.tsx`（被 LoginForm/SignupForm 替代）

### 6.2 新增

**`src/lib/supabaseClient.ts`** — 单例 supabase-js 客户端，按 §4.3 配置 storage:sessionStorage、flowType:implicit。

**`src/lib/authClient.ts`** — 在 supabaseClient 上的语义包装：`getSession()`、`getAccessToken()`（自带过期检查与刷新）、`clearSession()`。

**`src/components/AuthScreen.tsx`** — 包含登录/注册切换 tab。
- `LoginForm`: email + password
- `SignupForm`: display_name + email + team_password（不收 password，密码在邀请回调里设）
- "重新发送验证邮件"按钮调 `/api/auth/resend-invite`

**`src/components/AuthCallback.tsx`**：
- 第一行就解析 `window.location.hash`（fragment token）
- 解析后**立即** `window.history.replaceState({}, "", window.location.pathname)` 清空地址栏（详见 §4.4.1）
- 调 `supabase.auth.setSession({access_token, refresh_token})`
- 检查 `user_metadata.password_set`：未设过 → 渲染设密码表单 → 提交到 `/api/auth/setup-account`
- 已设过 → 直接跳主界面
- 若 fragment 不存在但 query 存在 `?code=`：渲染"链接格式不识别，请联系管理员重发邀请"
- 若 fragment 存在但解析失败 / setSession 失败：清空 sessionStorage 并显示错误，依然要先 replaceState 清地址栏

**`src/hooks/useCurrentUser.ts`** — 首屏调 `/api/auth/me` 并在 React context 内分发给所有组件。

### 6.3 修改

- `src/lib/api.ts`：所有请求改用 `getAccessToken()`；401 时尝试 refresh 一次
- `src/components/SettingsDialog.tsx`：`display_name` 字段编辑时调 `/api/profile/update`；保留 API Key 字段
- `src/components/PromptDetail.tsx`：`isOwner = currentUser.id === prompt.created_by_id || currentUser.is_admin`
- `src/components/ExamplesList.tsx`：`canDelete = viewer.id === ex.created_by_id || viewer.id === prompt.created_by_id || viewer.is_admin`
- `src/components/PromptForm.tsx`：删除 `created_by` 字段（后端注入）

### 6.4 路由判定顺序（P1#4 修复）

**关键：pathname 检查必须在 session 检查之前**：

```tsx
function App() {
  // 1) 优先识别 /auth/callback。从邮件链接进入时 sessionStorage 还没 session，
  //    若先判 !session 会被 AuthScreen 吞掉，邮件验证永远走不通。
  if (window.location.pathname === '/auth/callback') {
    return <AuthCallback />;
  }
  // 2) 没有 session → 登录/注册
  if (!session) {
    return <AuthScreen />;
  }
  // 3) 主界面
  return <AuthenticatedApp />;
}
```

`/auth/callback` 是 Supabase 邀请邮件配置的回调路径，需在 `vercel.json` 加 SPA fallback 让该路径能加载到 `index.html`（详见 §12.4）。

## 7. 数据迁移与初始管理员

### 7.1 迁移 SQL（Migration 006）

```sql
-- 1) profiles 表（见 §3.1）
-- 2) truncate prompts 和 examples（决策 c）
truncate table prompts cascade;
truncate table examples cascade;
-- 3) prompts.created_by → created_by_id（见 §3.2）
-- 4) examples.created_by → created_by_id（见 §3.3）
-- 5) invite_throttle（resend-invite 限流，见 §4.7）
create table if not exists public.invite_throttle (
  email text primary key,
  last_sent_at timestamptz not null default now()
);
alter table public.invite_throttle enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='invite_throttle'
      and policyname='service_role_all_invite_throttle'
  ) then
    create policy "service_role_all_invite_throttle" on public.invite_throttle
      for all to service_role using (true) with check (true);
  end if;
end $$;
-- 不在 SQL 里硬编码管理员邮箱，由 setup-account 端点判断
```

### 7.2 初始管理员

`api/auth/setup-account.ts` 的 INSERT profile 步骤：

```ts
const adminEmails = (process.env.ADMIN_EMAILS ?? "")
  .split(",").map(s => s.trim()).filter(Boolean);

const isAdmin = adminEmails.includes(email);
```

Vercel 环境变量：`ADMIN_EMAILS=19338106204@163.com`（多个用逗号分隔）。

### 7.3 团队迁移流程（用户视角）

1. 你（管理员）打开网站 → "注册" → 填邮箱 + display_name + 团队密码
2. 收邀请邮件 → 点链接 → 跳到设密码页 → 设密码 → 进入主界面（profile 自动写入 `is_admin=true`）
3. 把团队密码和网站链接发给同事
4. 同事各自走流程
5. 大家在新系统里重新建提示词

## 8. 错误场景

| 场景 | 行为 |
|---|---|
| 注册时 team_password 错 | 400 `WRONG_TEAM_PASSWORD` |
| 注册时邮箱已存在 | 400 `EMAIL_TAKEN`，提示"邮箱已注册，请直接登录或重发邀请" |
| 登录时邮箱未验证 | 401 `EMAIL_NOT_VERIFIED`，UI 显示"重新发送验证邮件"按钮（调 §4.7） |
| 登录时密码错 | 401 `INVALID_CREDENTIALS` |
| access_token 过期 | 401 → 前端 refresh → 重试一次 |
| refresh_token 失效 | 清 session → 跳登录页，提示"登录已过期" |
| 用户被从 Supabase 控制台删除 | 后续 API 401 |
| /auth/callback 没有 fragment token | 提示"链接无效，请重新登录" |
| /auth/callback 收到 ?code=（PKCE 形态） | 提示"链接格式不识别，请联系管理员重发邀请" |
| setup-account 时 token 缺 team_pass_verified | 403 `BYPASS_ATTEMPT`（理论不该触发，纵深防御） |

## 9. 测试要求

后端测试（`tests/api/auth.test.ts` 新建）：
- signup：team_password 错 → 400；邮箱已存在 → 400；正常 → 200 + admin.inviteUserByEmail 被调用 + app_metadata 写入
- setup-account：缺 team_pass_verified → 403；token 无效 → 401；正常 → 200 + 创建 profile + ADMIN_EMAILS 命中 → is_admin=true
- login：未验证邮箱 → 401 `EMAIL_NOT_VERIFIED`；密码错 → 401；正常 → 200
- me：无 token → 401；有 token → 返回 user info
- resend-invite：team_password 错 → 400；正常 → 200

业务测试改造：
- 删除所有 viewer query 参数测试
- mock `supabase.auth.getUser` 返回不同 user
- 非 owner 编辑 → 403；admin 编辑非自己 → 200
- examples DELETE 新增 admin 可删 case

profile 测试：
- profile/update 试图传 is_admin → 后端忽略，is_admin 字段保持原值

## 10. 不做的事情（第二版再加）

- 忘记密码 / 邮件重置（admin 通过 Supabase 控制台手动 `auth.admin.updateUserById`）
- 修改邮箱
- 用户主动删除自己的账号
- SSO（飞书/钉钉/Google）
- 用户列表 / 邀请管理 UI
- 二次验证（2FA）
- 头像、bio
- 用户活动审计日志

## 11. 部署节奏（P1#3 修复）

> **关键修订**：原 spec 把"三步"列为可分别部署的迭代，但因为 Migration 006 会 truncate prompts/examples 并改列结构，**任何"先部署一部分"的中间态都会让线上不可用**。修订后明确为：
>
> - **三步是开发任务的拆分，不是生产部署的节拍**
> - 全部三步在一个 feature 分支上完成、本地通过所有测试、跑通端到端冒烟
> - 一次性合并到 main → 触发一次 Vercel 部署 → 同时在 Supabase 跑迁移 SQL
> - 部署窗口期：跑 SQL 前 push 代码 → Vercel 部署期间业务接口暂时不可用约 1-2 分钟，可接受

### 11.1 Step 1（半天）：基础设施
- profiles 表 + 迁移 006
- supabaseClient + authClient
- 5 个 auth 端点（signup, setup-account, login, refresh, logout, me, resend-invite）
- AuthScreen + AuthCallback + 设密码流
- useCurrentUser hook + context

### 11.2 Step 2（半天）：业务接口迁移
- prompts / examples / chat / use-count 全部接 `authenticate()`
- 删除 userName 系列代码 + verify.ts
- 后端响应增加 `created_by_id` 与 `created_by_name`
- PromptDetail / ExamplesList 用 `currentUser.id` 判定

### 11.3 Step 3（半天）：清理 + 测试 + admin
- 测试套件全面调整
- profile/update 端点 + Settings 改为只更新 display_name
- admin 在 PromptDetail / ExamplesList 看到额外的删除按钮
- 端到端冒烟（用真邮箱注册 → 邀请 → 设密码 → 创建 prompt → 试运行 → 保存示例）
- README 与部署须知更新

## 12. 部署须知

### 12.1 Supabase 配置

1. **Auth → Providers → Email**：
   - **关闭 "Allow new users to sign up"**（关键：P0#2）
   - 保持 "Confirm email" 打开
   - 确认 SMTP 默认开启（free tier 内置）
2. **Auth → URL Configuration**：
   - Site URL = 部署 URL（例 `https://prompt-workbench.vercel.app`）
   - Redirect URLs 添加 `https://prompt-workbench.vercel.app/auth/callback`
3. **Auth → Email Templates**（可选）：把 Invite User 邮件文案改成中文
4. **Project Settings → API**：复制 `anon` key 和 `service_role` key

### 12.2 Vercel 环境变量（P2#7 修复后命名一致）

**前端可见**（必须 `VITE_` 前缀，否则 Vite 不会注入）：
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

**仅后端 serverless 函数可见**（无前缀）：
- `SUPABASE_URL`（与 VITE_ 同值，方便后端 import）
- `SUPABASE_SERVICE_ROLE_KEY`
- `SHARED_PASSWORD`
- `ADMIN_EMAILS`
- `SITE_URL`（用于 inviteUserByEmail 的 redirectTo，例 `https://prompt-workbench.vercel.app`）

> ⚠️ 实施时必须确认前端代码中**永远不读** `SUPABASE_SERVICE_ROLE_KEY` 或非 `VITE_` 变量；如果 import.meta.env.SUPABASE_X 出现在 src/，构建期就要 fail 一个 grep-based lint。

### 12.3 vercel.json（SPA fallback，P2 修复）

不依赖 path-to-regexp 的负向前瞻——用显式顺序更可靠：先放 `/api/(.*)` 让 serverless 函数走原路，再放 catch-all 把所有非 API 请求 fallback 到 `index.html`：

```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

第一条是 no-op（让 `/api/*` 显式由 Vercel serverless 处理而非被第二条吞掉）。第二条把 `/auth/callback`、`/login` 这种前端路径都指向 `index.html`，由 React 内部决定渲染什么。

### 12.4 安全加固 lint（P2 修复，覆盖更全）

`npm run lint:env`：

```bash
#!/usr/bin/env bash
set -e

# 1) 禁止前端代码字面量中出现 service_role / shared_password / admin_emails 这类
#    服务端独有的 env 名（无论怎么访问）
if grep -rE 'SUPABASE_SERVICE_ROLE_KEY|SHARED_PASSWORD|ADMIN_EMAILS' src/; then
  echo 'Forbidden: server-only env name appears in client code (src/).'
  exit 1
fi

# 2) 禁止前端用任何方式访问非 VITE_ 前缀的 supabase / admin / shared 变量。
#    覆盖 process.env.X / process.env["X"] / process.env['X'] /
#         import.meta.env.X 形态。
if grep -rE '(process\.env|import\.meta\.env)(\.|\[\s*["'\''])(?!VITE_)(SUPABASE|ADMIN|SHARED|SITE_URL)' src/; then
  echo 'Forbidden: client must read only VITE_-prefixed env (src/).'
  exit 1
fi

# 3) 禁止解构形态泄漏：const { SUPABASE_SERVICE_ROLE_KEY } = process.env
if grep -rE '\{\s*[^}]*\b(SUPABASE_SERVICE_ROLE_KEY|SHARED_PASSWORD|ADMIN_EMAILS)\b[^}]*\}\s*=\s*(process\.env|import\.meta\.env)' src/; then
  echo 'Forbidden: destructured server-only env in client code.'
  exit 1
fi
```

接入 `package.json` 的 `lint:env` 脚本，CI 在 `lint:logs` 之后运行。三条规则覆盖：
- 任何字面量出现服务端独有 env 名 → fail（最强约束，包括字符串注释和 dynamic 访问）
- 客户端用非 `VITE_` 前缀访问 `process.env` / `import.meta.env` → fail（点访问 + 字符串索引）
- 解构形态从 env 对象中解出敏感 key → fail

### 12.4.1 lint:env 的 residual risk（P2 round-3 明确化）

上述 grep 是 best-effort 文本检查，**不能挡住**：

- 字符串拼接：`process.env['SUPABASE' + '_' + 'SERVICE_ROLE_KEY']`
- 间接访问：`globalThis['process']?.env`、`window['__env__']`
- `eval('process.env.SUPABASE_SERVICE_ROLE_KEY')`
- 把敏感 key 写在拆分字符串里（`'SUPABASE_SERVICE' + '_ROLE_KEY'`）

第一版接受这些 residual risk，依据：
1. 这些都是有意为之的混淆访问，不是无心之失；CI lint 主要防"无心 leak"
2. 前端 bundle 在 Vercel 构建期由 Vite 生成，只有 `VITE_*` 变量被注入；上面这些访问在客户端运行时实际拿到的是 `undefined`
3. 真正能让服务端 env 进入前端 bundle 的路径只有"Vite 把变量替换进 bundle"，而 Vite 默认只处理 `VITE_*` 前缀

**第二版升级路径**：把 lint:env 升级为 ESLint custom rule（基于 AST 而非字符串），约束 src/ 中：
- 仅允许 `import.meta.env.VITE_*` 形态访问 env
- 禁止 `process.env`、`globalThis['process']`、`eval` 调用

升级到 AST lint 后，上面三条 residual risk 就能在静态层面挡住。当前优先级低于实施 Phase 2 主功能。

## 13. 已知风险

1. **anon key 暴露**：必要的（前端 supabase-js 需要）。配合 §2.3 的关闭 public signup + profiles 无 anon update policy + 业务表 service_role-only RLS，攻击面已收敛
2. **service_role key 泄露**：与 Phase 1 同等风险。仅 Vercel 函数环境变量
3. **session token 在 sessionStorage**：XSS 可窃取。第一版无外部脚本依赖，CSP 后续加
4. **多设备登录**：各自独立 refresh_token；登出一处不影响另一处。预期行为
5. **离职用户**：admin 从 Supabase 控制台删除 auth.users → cascade 删除 profile + prompts + examples。**不可逆**。第二版考虑软删除/转移所有权
6. **Supabase 邮件投递**：free tier 限速 3 封/小时项目级。10 人团队足够，但若大量 resend-invite 可能被限流（向用户友好提示"请稍后再试"）
7. **invite 链接被分享**：邀请链接在 24 小时内任何持有者均可登录。建议 UI 提示"请勿分享邀请邮件"

## 14. 与 Phase 1 的不兼容

- **数据**：清空（决策 c）
- **前端 sessionStorage**：旧的 `user_name` / `auth_token` / `deepseek_api_key` 键废弃
  - `user_name` / `auth_token` 完全不读
  - `deepseek_api_key` 保留语义（API Key 仍 sessionStorage 存，与 user system 独立）
- **API 路由**：旧 `/api/verify` 删除；前端不再调用
- 部署后第一次访问就是登录页，没有过渡期

---

## 附录 A：codex 第 1 轮反馈处理记录

| # | 优先级 | 反馈 | 处理 |
|---|---|---|---|
| 1 | P0 | 公开 anon key + profiles update policy 可自提权为管理员 | §3.1 删除 `users_update_own_profile` 策略；§5.1 新增 `/api/profile/update` 端点（service_role + 字段允许列表）；§2.3 新增"profiles 对 authenticated 仅 SELECT"约束；§9 增加测试用例验证 is_admin 不可被前端写入 |
| 2 | P0 | 团队密码门可被 Supabase 直连注册绕过 | §0 决策 1 改为"关闭 Supabase public signups"；§4.1 重写为 invite + 设密码两段式；§5.1 删除 finalize，改为 `setup-account` 并加 `team_pass_verified` 防御；§12.1 明确 Supabase 控制台需关闭 public signups |
| 3 | P1 | 三步部署中间态不兼容 | §11 重写：三步是开发任务拆分，不是部署节拍；feature 分支完成后一次性合并部署 |
| 4 | P1 | AuthCallback 渲染顺序错误 | §6.4 显式说明 pathname 检查必须先于 session 检查，给出代码示例与原因 |
| 5 | P1 | 回调 token 形态未锁定 | §4.4 新增小节，锁定 implicit flow，AuthCallback 同时识别 fragment 与 ?code 形态（后者给出友好错误） |
| 6 | P1 | sessionStorage 实现可能漂到 localStorage | §4.3 给出 supabase-js 显式配置 `storage: window.sessionStorage`；§9 测试覆盖 |
| 7 | P2 | env 命名自相矛盾 | §12.2 重写：前端只 VITE_ 前缀，后端无前缀，互不重叠；§12.4 新增 lint:env 脚本防泄漏 |
| 8 | P2 | resend-verification UI 没有后端 | §4.7 新增 `/api/auth/resend-invite` 端点；§5.1 列入新增端点 |

## 附录 B：codex 第 2 轮反馈处理记录

| # | 优先级 | 反馈 | 处理 |
|---|---|---|---|
| 1 | P1 | setup-account 半成功状态死锁（先设密码再插 profile，第二步失败用户卡死） | §4.1 / §5.1 反转顺序：**先 UPSERT profile，再设密码**；setup-account 显式允许"`password_set=true` 但 profile 缺失"作为可恢复状态（补 profile，跳过密码） |
| 2 | P1 | team_pass_verified 没纳入业务 authenticate，纵深防御覆盖错位 | §2.3 / §5.2 修订：明确"profile 存在性"是业务认证的单一可信源——绕过路径产生的 auth.users 永远拿不到 profile，因此过不了 authenticate。`team_pass_verified` 仅在 setup-account 检查（不在每次业务请求重复 check），spec 措辞统一 |
| 3 | P1 | resend-invite 可能重置已 setup 用户 / 接受客户端 display_name | §4.7 加固：拒绝 `password_set===true` 的用户（返回 `ALREADY_SETUP`）；display_name 强制取自现有 `user_metadata`，不接受客户端传入；重发时顺手覆写 `team_pass_verified=true` |
| 4 | P1 | implicit flow token 留 URL fragment 未要求清理 | §4.4.1 新增小节：AuthCallback 解析完 fragment 必须**立即** `history.replaceState` 清地址栏，无论后续 setSession 成败；§6.2 AuthCallback 设计列入此约束 |
| 5 | P2 | vercel rewrite 负向前瞻不可靠 | §12.3 改为显式两条规则：先 `/api/(.*)` no-op 让 serverless 函数走原路，再 `/(.*)` catch-all 到 index.html |
| 6 | P2 | lint:env grep 覆盖不全（漏字符串索引、import.meta.env、解构形态） | §12.4 重写：三条规则——禁止任何字面量出现服务端 env 名；禁止前端访问非 VITE_ 前缀的 SUPABASE/ADMIN/SHARED；禁止解构 process.env / import.meta.env |
| 7 | P2 | signup 的 invite + flag 写入非原子，第二步失败留孤儿账号 | §4.1 / §5.1 加补偿：updateUserById 抛错时调 `admin.deleteUser` 回滚；resend-invite 路径也会顺手补写 flag，作为第二条恢复路径 |

## 附录 C：codex 第 3 轮反馈处理记录

| # | 优先级 | 反馈 | 处理 |
|---|---|---|---|
| 1 | P1 | setup-account 反向半成功窗口（profile 已建但 password 未设的 user 仍被当合法成员） | §5.2 收紧 authenticate：profile 存在 **AND** `password_set===true` 才放行；§4.1 流程图标注此恢复路径——半成功 user 在业务接口被 401，强制走完邀请链接重新设密码 |
| 2 | P1 | 同邮箱重复 signup 状态机未定义 | §4.1.1 新增完整状态机表（4 种既有状态 × 2 个端点行为）；signup 在调 inviteUserByEmail 之前先 `admin.listUsers({email})` 应用状态机；display_name 永不被重发覆盖 |
| 3 | P1 | resend-invite 缺限流 + 内部状态从响应泄漏 | §4.7 加每邮箱 60s 冷却 + 每 IP 每小时 10 次上限（`invite_throttle` 表追踪）；响应统一 opaque 200 message，内部分支 EMAIL_NOT_FOUND / ALREADY_SETUP 不暴露给客户端；§7.1 在 Migration 006 加 invite_throttle 表 |
| 4 | P2 | lint:env grep 仍挡不住动态拼接 | §12.4.1 新增 residual risk 段落，明确接受这些极端形态作为 best-effort 边界；指出第二版升级到 ESLint AST custom rule（仅允许 `import.meta.env.VITE_*`，禁 `process.env` / `eval`）作为静态拦截 |
| 5 | P2 | profile/update 静默忽略敏感字段不如 strict reject | §5.1 改为 Zod strict schema 仅允许 `display_name`，携带 `is_admin/email/id` / 任意未知字段返回 400 `Invalid payload`；与 Phase 1 prompts/examples strict 风格一致 |
