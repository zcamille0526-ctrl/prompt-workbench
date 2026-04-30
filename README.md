# 提示词工作台 Prompt Workbench

多人共享的提示词管理工具。集中存储、分类、搜索和复用提示词模板。

线上地址：https://prompt-workbench-three.vercel.app

## 功能

- 提示词增删改查，支持 Markdown 格式
- 按大类筛选（生图 / 生文 / 分析 / 开发 / 元提示词）
- 标签过滤和关键词搜索
- 变量模板：用 `{{变量名}}` 定义占位符，使用时填入具体值，一键复制
- 多人实时同步（Supabase Realtime）
- 导出全部提示词为 JSON 文件
- 共享密码访问，无需注册

## 技术栈

- React + TypeScript
- Radix UI + Tailwind CSS
- Zod（数据校验）
- Supabase（PostgreSQL + Realtime）
- Vercel（部署 + Serverless Functions）

## 本地开发

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env.local`，填入你的配置：

```bash
cp .env.example .env.local
```

需要填写：
- `SHARED_PASSWORD` — 访问密码
- `SUPABASE_URL` — Supabase 项目地址
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role 密钥
- `SUPABASE_ANON_KEY` — Supabase anon 公钥
- `VITE_SUPABASE_URL` — 同 SUPABASE_URL
- `VITE_SUPABASE_ANON_KEY` — 同 SUPABASE_ANON_KEY

### 3. 初始化数据库

在 Supabase SQL Editor 中执行 `supabase/migrations/001_create_prompts.sql`。

### 4. 启动开发服务器

```bash
# 启动 API 服务
npx tsx --env-file=.env.local dev-server.ts &

# 启动前端
npm run dev
```

打开 http://localhost:5173

### 5. 运行测试

```bash
npm test
```

## 批量导入提示词

将提示词整理为 Markdown 文件，用 `# ==标题==` 分隔每条提示词，然后修改 `scripts/import-prompts.py` 中的分类和标签映射，执行：

```bash
SUPABASE_SERVICE_ROLE_KEY="your-key" python3 scripts/import-prompts.py
```

## 部署到 Vercel

1. Fork 本仓库
2. 在 Vercel 中导入项目
3. 配置环境变量（同 `.env.example` 中的字段）
4. 部署
