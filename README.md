# 提示词工作台 Prompt Workbench

多人协作的提示词管理工具。集中存储、分类、搜索、试运行 AI 提示词模板。

线上地址：https://prompt-workbench-three.vercel.app

## 功能

- 邮箱账号 + 密码登录，每个用户独立身份（Phase 2 用户体系）
- 提示词增删改查，支持 Markdown 与变量模板
- 按分类筛选 + 标签过滤 + 关键词搜索（分类由管理员在「设置 → 分类管理」中维护）
- 草稿机制：保存为草稿仅自己可见，发布后全员可见
- 内置 DeepSeek 试运行：在线测试提示词效果，可保存示例对话
- 管理员（`is_admin`）可清理任意用户的已发布提示词与示例，并管理分类（新建 / 重命名 / 上下移动 / 删除）
- 导出全部提示词为 JSON
- 团队级共享密码作为**注册门**：拿到密码才能注册，登录不需要

## 技术栈

- React 19 + TypeScript
- Radix UI + Tailwind CSS
- Zod 4（数据校验）
- Supabase Auth + PostgreSQL（用户体系 + 数据存储）
- Vercel（部署 + Serverless Functions）
- DeepSeek API（试运行后端）

## 本地开发

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env.local` 并填入你的值：

```bash
cp .env.example .env.local
```

| 变量 | 用途 | 暴露面 |
|---|---|---|
| `SHARED_PASSWORD` | 团队注册密码（仅在 `/api/auth/signup` 与 `/api/auth/resend-invite` 校验） | 服务端独占 |
| `SUPABASE_URL` | Supabase 项目 URL | 服务端 |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role 密钥（**必须保密**） | 服务端独占 |
| `ADMIN_EMAILS` | 逗号分隔的管理员邮箱列表，新账号 setup-account 时根据此列表写入 `is_admin` | 服务端 |
| `SITE_URL` | 邀请邮件回调链接的站点根（生产环境的 `https://...vercel.app`） | 服务端 |
| `VITE_SUPABASE_URL` | 同 `SUPABASE_URL`，前端 supabase-js 用 | **前端 bundle 内** |
| `VITE_SUPABASE_ANON_KEY` | publishable / anon key（`sb_publishable_xxx`） | **前端 bundle 内** |
| `VITE_API_BASE_URL` | 留空即可（本地与生产都用相对路径） | 前端 |

> ⚠️ **不要把 `SUPABASE_SERVICE_ROLE_KEY` 或 `SHARED_PASSWORD` 加 `VITE_` 前缀**，CI 会跑 `npm run lint:env` 拦截这种泄漏（spec §12.4）。

### 3. 配置 Supabase 项目

#### 3.1 关闭公开注册（**P0 安全前提**）

`Auth → Providers → Email` 把 **Allow new users to sign up** 关掉。
这样前端拿到 anon key 也无法直接 `signUp` 绕过团队密码门。所有用户创建只能由后端用 service-role 调用 `inviteUserByEmail` 完成。

#### 3.2 配置回调 URL

`Auth → URL Configuration`：

- **Site URL** = 生产域名，例如 `https://prompt-workbench-three.vercel.app`
- **Redirect URLs** 加入：
  - `https://your-domain.vercel.app/auth/callback`
  - `https://*.vercel.app/auth/callback`（覆盖预览部署）

#### 3.3 跑 migrations

按顺序在 `Supabase SQL Editor` 执行 `supabase/migrations/` 下的 8 个文件：

```
001_create_prompts.sql        prompts 表 + RLS
002_lock_down_anon.sql        撤销 anon 角色权限
003_add_use_count.sql         use_count 列 + RPC
004_add_is_draft.sql          草稿支持
005_create_examples.sql       examples 表
006_user_system.sql           profiles 表 + invite_throttle RPC + Phase 2 列重命名
007_category_management.sql   categories 表 + 软 FK trigger + 5 个预填分类
008_category_rpc.sql          create/rename/move/delete RPC（含行锁与 REVOKE EXECUTE）
```

**顺序不能错**——006 依赖前面 5 个里的 prompts/examples 表结构，007/008 依赖 prompts 表存在。

### 4. 启动开发服务器

```bash
# API 服务（端口 3001）
npx tsx --env-file=.env.local dev-server.ts &

# 前端（端口 5173，自动代理 /api → 3001）
npm run dev
```

打开 http://localhost:5173 → 注册邮箱 → 收到邀请邮件 → 点链接设置密码 → 进入主界面。

### 5. 运行测试 / 类型检查 / lint

```bash
npm test               # vitest 运行测试套件
npm run typecheck      # tsc 类型检查
npm run lint:logs      # 禁止把请求体写入日志
npm run lint:env       # 禁止服务端 env 泄漏到前端 bundle
npm run build          # 生产构建（验证 vite 编译）
```

## 部署到 Vercel

### 1. Fork + 导入

Fork 本仓库，在 Vercel 控制台导入。Vercel 会自动识别 React + Vite 项目。

### 2. 环境变量

在 Vercel `Settings → Environment Variables` 配置上面表格里的所有变量：

- 7 条服务端变量（`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SHARED_PASSWORD` / `ADMIN_EMAILS` / `SITE_URL` / `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`）应用到 **All Environments**
- `SHARED_PASSWORD` 建议同时建一条 **Production Sensitive** 标记，预览环境可以共用同一份或换不同密码

### 3. 部署

`git push` 触发部署。首次部署后端到端验证：

1. 访问站点，看到登录/注册界面
2. 用管理员邮箱（`ADMIN_EMAILS` 里列出的那个）注册，填团队密码
3. 收到邀请邮件，点链接设密码
4. 登录进主界面，创建一条提示词
5. 试运行（需要 DeepSeek API Key，在 Settings 填）
6. 保存示例对话

### 4. Migration 顺序（**部署窗口期**）

新建 Supabase 项目时按 `001 → 008` 跑 migrations。
**升级 Phase 1 → Phase 2 时**：先合并代码到 `main`、Vercel 部署完成、然后立刻在 Supabase 跑 `006_user_system.sql`（这一步会 `truncate prompts/examples` —— Phase 2 决策 c：旧数据不保留，所有人在新身份系统重建提示词）。期间业务接口不可用约 1-2 分钟。

**增量升级到 Category Management（007/008）**：可在生产代码部署后直接跑，无业务中断。回滚需先 revert 前端再 drop 数据库对象，见 `docs/specs/2026-05-12-category-management-design.md` §6.2。

## 批量导入提示词

将提示词整理为 Markdown 文件，用 `# ==标题==` 分隔每条，修改 `scripts/import-prompts.py` 中的分类/标签映射后执行：

```bash
SUPABASE_SERVICE_ROLE_KEY="your-key" python3 scripts/import-prompts.py
```

注意 Phase 2 之后该脚本需要按 `created_by_id` UUID 写入，运行前先用一个真实账号注册并把对应 `profiles.id` 填到脚本里（脚本本身的更新留待后续按需补）。

## 文档

- `docs/specs/` — 设计规格，包括完整的 Phase 2 用户体系 spec（codex 6 轮审核）与 Category Management spec（3 轮审核）
- `docs/plans/` — 实施计划（含每步代码与验证命令）
- `supabase/migrations/` — 数据库 schema 演进
- `.env.example` — 完整环境变量清单
