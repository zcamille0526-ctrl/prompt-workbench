# 管理员分类管理 — 设计规格文档

## 0. 决策汇总

| # | 项 | 选择 |
|---|---|---|
| 1 | 删除策略 | **阻止删除**：已有提示词使用该分类时 API 返回 409 + 使用计数 |
| 2 | 重命名 | **支持**：事务内同步更新 `prompts.category` 字符串 |
| 3 | 排序 | **↑↓ 按钮**：相邻两项交换 `display_order`，不引入拖拽依赖 |
| 4 | 前端同步 | **单次加载**：mount 时 GET 一次，缓存到 context；当前 tab 的管理员操作立即刷新 |
| 5 | 初始数据 | **Migration 预填 5 条** + 脏数据回填，保证软 FK 不炸 |
| 6 | 管理 UI 入口 | **SettingsDialog 内**仅对 `is_admin` 可见的折叠区 |

## 1. 动机

当前 `src/lib/constants.ts` 硬编码 `CATEGORIES = ["元提示词", "生图", "生文", "分析", "开发"]`。加分类需要改代码 → 提交 PR → 等部署，对运营类改动过重。让 admin 在运行时管理分类。

## 2. 数据模型

### 2.1 新增 `public.categories`

```sql
create table public.categories (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  display_order integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index categories_display_order_idx on categories (display_order);

create trigger categories_updated_at
  before update on categories
  for each row execute function update_updated_at();
```

**设计要点**：
- `name` UNIQUE：禁止重名分类。冲突由 DB 层兜底，API 翻成 409。
- `display_order` 以 **10 间隔步进**（10/20/30…）。上下移位改相邻两项即可，不必重排整表。
- 不给 `name` 加真外键到 `prompts.category`：`prompts.category` 是 `text` 列且已有数据，改成 FK 要引入新列 + 数据回填，侵入性大于本 spec 范围。改用软 FK（trigger）。

### 2.2 `prompts.category` 软外键 trigger

```sql
create or replace function enforce_category_exists()
returns trigger as $$
begin
  if not exists (select 1 from categories where name = new.category) then
    raise exception 'category "%" does not exist', new.category
      using errcode = '23503';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger prompts_enforce_category
  before insert or update of category on prompts
  for each row execute function enforce_category_exists();
```

Trigger 保证 `prompts.category` 写入值必须在 `categories.name` 集合中。写操作违反时 `errcode = '23503'`（foreign_key_violation），API 层捕获后返回 400。

### 2.3 RLS

```sql
alter table public.categories enable row level security;

-- Public read: 侧边栏加载分类 UI 不强求登录（登录前虽然看不到
-- AuthenticatedApp，但 hook 提前绑定更简单）
create policy "categories_public_read" on categories
  for select
  using (true);

-- 不写 INSERT/UPDATE/DELETE 给 authenticated。所有写操作走 API + service_role。
-- 不显式建 "service_role_all" 策略 —— service_role 在 Supabase 里本来就绕过 RLS，
-- 加这条只是视觉噪音。
```

### 2.4 Migration 007 内联预填 + 脏数据回填

Migration 顺序：

1. 创建 `categories` 表
2. **先回填**：把 prompts 里现存的 distinct category 值塞进 categories，避免 trigger 安装时老数据违约
   ```sql
   insert into categories (name, display_order)
     select distinct category, row_number() over (order by category) * 10
     from prompts
     on conflict (name) do nothing;
   ```
3. **再合并预填**（5 条规范分类，覆盖旧数据未覆盖的情况）：
   ```sql
   insert into categories (name, display_order) values
     ('元提示词', 10), ('生图', 20), ('生文', 30), ('分析', 40), ('开发', 50)
   on conflict (name) do update
     set display_order = excluded.display_order;
   ```
   冲突时用预填顺序覆盖（让 5 条规范分类拿到预期顺序；回填出来的其他分类已有 `display_order`，不在这 5 条里就不 touch）。
4. 安装 trigger：保证之后的写操作遵守约束。

理由：**先回填再安 trigger**，这样不需要 `ALTER TABLE prompts VALIDATE CONSTRAINT` 之类的二次扫表。

## 3. API

### 3.1 端点列表

| 方法 | 路径 | 权限 | 用途 |
|---|---|---|---|
| GET | `/api/categories` | 无认证 | 列出所有分类，按 display_order 升序 |
| POST | `/api/categories` | admin | 新建分类 |
| PATCH | `/api/categories/:id` | admin | 重命名分类 |
| POST | `/api/categories/:id/move` | admin | 上/下移动一位 |
| DELETE | `/api/categories/:id` | admin | 删除空分类 |

**权限实现**：所有写端点入口：
```ts
const { user } = await authenticate(req);
if (!user.is_admin) return res.status(403).json({ error: "forbidden" });
```

### 3.2 GET /api/categories

响应：
```json
{ "categories": [{ "id": "...", "name": "元提示词", "display_order": 10 }, ...] }
```

无需认证。ETag / cache-control 暂不加（数据小、变更低频、先保证正确性）。

### 3.3 POST /api/categories

Body Zod schema：
```ts
const CategoryCreateSchema = z.object({
  name: z.string().trim().min(1, "名称不能为空").max(32, "名称过长"),
}).strict();
```

`.trim()` 在 `.min` 之前，否则 `"   "` 能过 `.min(1)` 再 trim 成空串（Phase 2 codex 曾发现同类问题）。

流程：
1. `authenticate()` + admin check
2. Parse body，失败 400
3. 调 `rpc("create_category", { p_name: name })`，function 内 `SELECT COALESCE(max(display_order), 0) + 10` 与 INSERT 同事务，消除 TOCTOU
4. `23505`（unique_violation）→ 409 `{ error: "duplicate_name" }`
5. 返回 201 + 新记录

Function 定义（008_category_rpc.sql）：
```sql
create or replace function create_category(p_name text)
returns categories
language plpgsql
security invoker
as $$
declare
  next_order integer;
  row categories;
begin
  select coalesce(max(display_order), 0) + 10 into next_order from categories;
  insert into categories (name, display_order)
    values (p_name, next_order)
    returning * into row;
  return row;
end;
$$;
```

### 3.4 PATCH /api/categories/:id

Body：`{ name: string }`（同样 `.trim().min(1).max(32).strict()`）

**核心约束**：重命名必须原子 —— 要么 `categories.name` 和所有 `prompts.category` 都改，要么都不动。

实现：SQL function（放在 `008_category_rpc.sql` 里）：
```sql
create or replace function rename_category(category_id uuid, new_name text)
returns void
language plpgsql
security invoker
as $$
declare
  old_name text;
begin
  select name into old_name from categories where id = category_id;
  if old_name is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if old_name = new_name then return; end if;  -- no-op

  -- 顺序：先 categories 后 prompts。
  -- trigger `prompts_enforce_category` 只在 prompts INSERT/UPDATE of category
  -- 时触发；categories 的改名不触发它。第二条 UPDATE prompts 执行时，新名字
  -- 已经在 categories 里，trigger 通过。两条在同一 function 事务中，外部
  -- 会话看不到中间态。
  update categories set name = new_name where id = category_id;
  update prompts set category = new_name where category = old_name;
end;
$$;
```

API 层：
1. admin check → parse body
2. 调 `rpc("rename_category", { category_id, new_name })`
3. `P0002` → 404 not_found
4. `23505` → 409 duplicate_name
5. 成功 → 200 + 刷新后的记录

### 3.5 POST /api/categories/:id/move

Body：`{ direction: "up" | "down" }`

实现：SQL function
```sql
create or replace function move_category(category_id uuid, direction text)
returns void
language plpgsql
security invoker
as $$
declare
  cur record; neighbor record;
begin
  select * into cur from categories where id = category_id;
  if cur is null then raise exception 'not_found' using errcode = 'P0002'; end if;

  if direction = 'up' then
    select * into neighbor from categories
      where display_order < cur.display_order
      order by display_order desc limit 1;
  elsif direction = 'down' then
    select * into neighbor from categories
      where display_order > cur.display_order
      order by display_order asc limit 1;
  else
    raise exception 'invalid_direction' using errcode = '22023';
  end if;

  if neighbor is null then
    raise exception 'cannot_move' using errcode = 'P0001';
  end if;

  -- 两阶段交换避免 unique 冲突（display_order 无 unique，但为严谨起见）
  update categories set display_order = -1 where id = cur.id;
  update categories set display_order = cur.display_order where id = neighbor.id;
  update categories set display_order = neighbor.display_order where id = cur.id;
end;
$$;
```

API 层把 `P0001` 翻成 400 `{ error: "cannot_move" }`，`P0002` 翻 404，`22023` 翻 400。

### 3.6 DELETE /api/categories/:id

调 `rpc("delete_category", { category_id })`，function 内把"检查引用"和"删除"放同事务，消除 TOCTOU：

```sql
create or replace function delete_category(category_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  cat_name text;
  used_count integer;
begin
  select name into cat_name from categories where id = category_id;
  if cat_name is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select count(*) into used_count from prompts where category = cat_name;
  if used_count > 0 then
    -- 用 P0001 + MESSAGE 带上计数，API 层解析
    raise exception 'in_use:%', used_count using errcode = 'P0001';
  end if;
  delete from categories where id = category_id;
end;
$$;
```

API 层：
1. admin check
2. 调 rpc
3. `P0002` → 404 not_found
4. `P0001` + message 以 `in_use:` 开头 → 409 `{ error: "in_use", used_by_count: N }`（解析 N）
5. 成功 → 204

## 4. 前端

### 4.1 数据层

**新增** `src/lib/categoriesContext.tsx`：
```ts
type Category = { id: string; name: string; display_order: number };
type Ctx = {
  categories: Category[];
  loading: boolean;
  refresh: () => Promise<void>;
};
export const CategoriesContext = createContext<Ctx | null>(null);
export function CategoriesProvider({ children }) {
  const [state, setState] = useState({ categories: [], loading: true });
  const refresh = useCallback(async () => {
    const data = await api.listCategories();
    setState({ categories: data, loading: false });
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <CategoriesContext.Provider value={{ ...state, refresh }}>...
}
export function useCategories() {
  const ctx = useContext(CategoriesContext);
  if (!ctx) throw new Error("useCategories must be used within CategoriesProvider");
  return ctx;
}
```

挂载位置：`App.tsx` 的 `<CurrentUserProvider>` 内层包一层 `<CategoriesProvider>`。

### 4.2 CATEGORIES 常量清理

- `src/lib/constants.ts`：删除 `CATEGORIES` 与 `Category` 类型别名
- `src/components/Sidebar.tsx`：`import { useCategories }`，遍历 `categories.map(c => c.name)`
- `src/components/PromptForm.tsx`：同上

**保留 `schemas.ts` 的 `category: z.string().min(1)` 不变** —— 前端校验只保证非空，具体有效性由后端 trigger 兜底。避免前端分类缓存过期 → 误判有效输入。

前端不给 `category` 加 `.trim()`。下拉选择产出的永远是准确值，用户无从输入空白。若未来改成 free-text 再考虑 trim。后端 trigger 对 `"  "` 自然判不存在、返回 400，UI 按 §4.4 提示即可。

### 4.3 SettingsDialog 管理员区

SettingsDialog 内加一段：
```tsx
{currentUser.is_admin && <CategoryManagerPanel />}
```

`<CategoryManagerPanel>` 结构：
```
┌─ 分类管理 ─────────────────────┐
│  ↑ ↓  元提示词      ✏️  🗑️   │
│  ↑ ↓  生图          ✏️  🗑️   │
│  ...                          │
│  ┌────────────────────────┐   │
│  │ + 新建分类           │   │
│  └────────────────────────┘   │
└────────────────────────────────┘
```

- **重命名**：点 ✏️ 就地变 input，回车提交 / Esc 取消。成功后本地状态 + `refresh()`。
- **删除**：点 🗑️ → ConfirmDialog。409 时在 dialog 里显示"有 N 条提示词在用，请先迁移"，按钮变灰。
- **新建**：底部 input，回车或点"创建"。空白 / 重名 inline 提示。
- **↑↓**：首位禁用 ↑，末位禁用 ↓。乐观 UI（先改本地顺序再调 API，失败回滚）。

所有操作成功后调 `useCategories().refresh()` 保持全局一致。

### 4.4 错误 UX

| 场景 | UI 处理 |
|---|---|
| 403（非 admin） | 不应发生（UI 先判 `is_admin` 再渲染面板）；真出则 toast "权限不足" |
| 409 duplicate_name | 输入框下方红字 "该分类名已存在" |
| 409 in_use | ConfirmDialog 改文案 "有 N 条提示词在用，请先迁移到其他分类" |
| 400 cannot_move | 理论上按钮已灰，硬出则 toast "已经在边界位置" |
| 400 invalid_category（PromptForm 提交时） | 提示 "分类已被管理员删除，请重新选择" + 调 `refresh()` |

#### 4.4.1 PromptForm 的"孤儿分类"

编辑一条老提示词时，它的 `prompt.category` 可能已经被 admin 改名/删除（`useCategories()` 里不存在）。处理：
- 下拉选项正常展示 `useCategories()` 的所有分类
- 若 `prompt.category` 不在列表里，**额外在最前面插入一个标记项**：`<option value="旧名" disabled>旧名（已失效，请重新选择）</option>`，并且让 `<select>` 的默认值不选中它（显式渲染"请选择"占位）
- 用户必须主动挑一个新分类才能提交，避免带着无效值 POST 到后端再触发 trigger

## 5. 测试

### 5.1 `tests/api/categories.test.ts`（新）

沿用 Phase 2 的 authenticate mock + in-memory store 模式。

| 用例 | 断言 |
|---|---|
| GET 返回按 display_order 排序 | 顺序正确 |
| POST admin 成功 | 201 + 新 display_order = max + 10 |
| POST 非 admin | 403 |
| POST 重名 | 409 duplicate_name |
| POST name 为 `"   "` | 400（trim 后空串） |
| POST name 33 字符 | 400 |
| POST 未知字段 | 400（strict() 拒绝） |
| PATCH 重命名成功 | 200；相应 prompts.category 全部同步 |
| PATCH 重名 | 409 |
| PATCH 未 trim 的 `"  生图  "` | 200 + 入库为 `生图`（trim 生效） |
| PATCH 不存在 | 404 |
| DELETE 空分类 | 204 |
| DELETE 被引用 | 409 + used_by_count |
| DELETE 不存在 | 404 |
| MOVE up 首位 | 400 cannot_move |
| MOVE down 末位 | 400 cannot_move |
| MOVE up 中间位 | 200 + display_order 与相邻项交换 |
| MOVE direction 为 `"sideways"` | 400 invalid_direction |
| MOVE 不存在 id | 404 |

### 5.2 `tests/lib/schemas.test.ts`（若新增 CategoryCreateSchema 导出）

与 Phase 2 prompts schema 同款模式：strict 字段、trim 边界、长度边界。

### 5.3 不测

- **Realtime / 并发**：管理员操作低频。两个 admin 同时删，DB unique + trigger 兜底。
- **前端 E2E**：项目无 Playwright，延续 Vitest-only 政策。

## 6. 迁移与部署

### 6.1 Migration 文件

- `supabase/migrations/007_category_management.sql`：建表 + 回填 + 预填 + trigger
- `supabase/migrations/008_category_rpc.sql`：`create_category` + `rename_category` + `move_category` + `delete_category` 四个 function

分两份是为了让 function 改动能独立演进不扰动建表。

### 6.2 部署顺序

1. `007`、`008` 在 Supabase SQL Editor 执行（现场校对结果）
2. merge 到 main → Vercel 自动部署后端 + 前端
3. 打开生产站验证：
   - 普通用户：侧边栏分类不变
   - 管理员：SettingsDialog 出现分类管理区
4. 回滚计划：
   - **若需要回滚，必须先前端后数据库**：先 revert 包含 `CATEGORIES` 常量删除 + useCategories 接入的 commit（让前端退回硬编码 5 条），再 `drop trigger prompts_enforce_category on prompts; drop function rename_category, move_category, create_category, delete_category; drop table categories cascade;`
   - 单独 drop 表不 revert 前端 → Sidebar/PromptForm 渲染空列表，用户无法选分类
   - 反过来 revert 前端但保留表和 trigger → 无害（前端不调 /api/categories 也不会写），只是多了个未用表

## 7. 非目标

- **多语言分类名**：单一字段 `name`，不做 i18n
- **分类描述 / 图标**：仅名称 + 顺序，不引入额外元数据
- **按用户定制分类顺序**：所有人看到的顺序一致（由 admin 决定）
- **分类级权限**（某分类仅某角色可建提示词）：不做
- **历史审计**（"谁改了分类名"）：不做。Supabase log 里能追溯到 service_role 操作，够用

## 8. 开放问题（留待实施时决定）

- 若 `CATEGORIES` 常量删除导致 TypeScript 类型推断出问题，在 `constants.ts` 留 `export type Category = string` 作 type-only 出口即可。
- Migration 007 的回填脚本遇到 `prompts` 表为空时照常执行（空 SELECT 不产生 INSERT 行），无需特殊处理。