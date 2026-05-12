# Category Management Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `CATEGORIES` constant with admin-managed categories persisted in Supabase, surfaced through a new `/api/categories` CRUD + a SettingsDialog admin panel.

**Architecture:** A new `categories` table holds name + display_order. A soft FK trigger on `prompts` enforces category existence using `FOR KEY SHARE` locks that mutually-exclude with `FOR UPDATE` in the rename/delete RPCs — closing the concurrency window between "trigger sees category exists" and "admin deletes category." Four SQL functions (`create_category`, `rename_category`, `move_category`, `delete_category`) keep mutations atomic. Frontend swaps the `CATEGORIES` constant for a `useCategories()` context provider, fed by a single GET on mount.

**Tech Stack:** Supabase (Postgres + plpgsql + service_role), Vercel serverless (TypeScript), React Context, Zod, Vitest (in-memory Supabase mock).

**Spec:** [docs/specs/2026-05-12-category-management-design.md](../specs/2026-05-12-category-management-design.md)

---

## Chunk 1: Database layer — migrations 007 + 008

Two SQL migrations. 007 creates the table, backfills old data, installs the soft-FK trigger. 008 installs the four mutation RPCs.

### Task 1: Write migration 007 (schema + backfill + trigger)

**Files:**
- Create: `supabase/migrations/007_category_management.sql`

- [ ] **Step 1: Create the migration file**

Write this SQL:

```sql
-- Migration 007: category management
--
-- Introduces a categories table to replace the hardcoded CATEGORIES array.
-- See docs/specs/2026-05-12-category-management-design.md for rationale.

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

-- Pre-seed the five canonical categories at display_order 10-50.
insert into categories (name, display_order) values
  ('元提示词', 10),
  ('生图', 20),
  ('生文', 30),
  ('分析', 40),
  ('开发', 50);

-- Backfill any non-canonical categories already present in prompts.
-- Canonical names hit on conflict (name) do nothing. Legacy names land at
-- display_order 60+ in alphabetical order.
insert into categories (name, display_order)
  select distinct category,
         60 + (row_number() over (order by category) - 1) * 10
  from prompts
on conflict (name) do nothing;

-- Soft FK: trigger enforces prompts.category must exist in categories.name.
-- FOR KEY SHARE holds a row-lock on the referenced category row; this is
-- mutually exclusive with the FOR UPDATE locks in rename_category and
-- delete_category (see migration 008), so concurrent prompt writes can't
-- slip through while an admin mutation is in flight.
create or replace function enforce_category_exists()
returns trigger as $$
declare
  found_id uuid;
begin
  select id into found_id from categories
    where name = new.category
    for key share;
  if found_id is null then
    raise exception 'category "%" does not exist', new.category
      using errcode = '23503';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger prompts_enforce_category
  before insert or update of category on prompts
  for each row execute function enforce_category_exists();

-- RLS: public read (sidebar needs it pre-auth); no authenticated writes
-- (everything goes through service_role + admin check in /api/categories).
-- No explicit service_role_all policy — service_role bypasses RLS by default.
alter table public.categories enable row level security;

create policy "categories_public_read" on categories
  for select
  using (true);
```

- [ ] **Step 2: Syntax sanity check**

Run: `cat supabase/migrations/007_category_management.sql | grep -c "create"`
Expected: at least 5 (table, index, trigger x2, function, policy — actually 6)

- [ ] **Step 3: Commit migration 007**

```bash
git add supabase/migrations/007_category_management.sql
git commit -m "feat(db): add categories table + soft-FK trigger (007)

Creates the categories table, pre-seeds the 5 canonical categories at
display_order 10-50, backfills any non-canonical prompt categories from
60+, and installs enforce_category_exists trigger on prompts. The trigger
uses FOR KEY SHARE so it interlocks with the FOR UPDATE locks in the
mutation RPCs (migration 008) to close the count+delete TOCTOU window."
```

### Task 2: Write migration 008 (four mutation RPCs)

**Files:**
- Create: `supabase/migrations/008_category_rpc.sql`

- [ ] **Step 1: Create the migration file**

Write this SQL:

```sql
-- Migration 008: category mutation RPCs
--
-- All four use security invoker (service_role bypasses RLS by default; no
-- need for definer). Row-level FOR UPDATE locks in rename/delete interlock
-- with the FOR KEY SHARE in the prompts trigger to prevent orphan refs.

create or replace function create_category(p_name text)
returns categories
language plpgsql
security invoker
as $$
declare
  next_order integer;
  new_row categories;
begin
  -- Serialize concurrent admins so they can't read the same max(display_order)
  -- and both insert the same next_order. Auto-released at transaction end.
  perform pg_advisory_xact_lock(hashtext('categories.display_order'));

  select coalesce(max(display_order), 0) + 10 into next_order from categories;
  insert into categories (name, display_order)
    values (p_name, next_order)
    returning * into new_row;
  return new_row;
end;
$$;

create or replace function rename_category(category_id uuid, new_name text)
returns categories
language plpgsql
security invoker
as $$
declare
  old_name text;
  updated_row categories;
begin
  -- FOR UPDATE on categories row. Mutually exclusive with the trigger's
  -- FOR KEY SHARE: concurrent prompt writes wait until rename commits, or
  -- this rename waits until any in-flight prompt write commits.
  select name into old_name from categories where id = category_id for update;
  if old_name is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if old_name = new_name then
    select * into updated_row from categories where id = category_id;
    return updated_row;
  end if;

  -- Order matters: UPDATE categories first. The trigger only fires on
  -- prompts INSERT/UPDATE of category, not on categories itself. The second
  -- UPDATE of prompts then sees the new name already present, trigger OK.
  -- Both statements run in the function's single transaction, so no other
  -- session observes the intermediate state.
  update categories set name = new_name where id = category_id
    returning * into updated_row;
  update prompts set category = new_name where category = old_name;
  return updated_row;
end;
$$;

create or replace function move_category(category_id uuid, direction text)
returns void
language plpgsql
security invoker
as $$
declare
  cur record;
  neighbor record;
begin
  select * into cur from categories where id = category_id for update;
  if cur is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if direction = 'up' then
    select * into neighbor from categories
      where display_order < cur.display_order
      order by display_order desc limit 1
      for update;
  elsif direction = 'down' then
    select * into neighbor from categories
      where display_order > cur.display_order
      order by display_order asc limit 1
      for update;
  else
    raise exception 'invalid_direction' using errcode = '22023';
  end if;

  if neighbor is null then
    raise exception 'cannot_move' using errcode = 'P0001';
  end if;

  -- Two-phase swap with a sentinel so that, if a unique index on
  -- display_order is ever added, the swap stays safe.
  update categories set display_order = -1 where id = cur.id;
  update categories set display_order = cur.display_order where id = neighbor.id;
  update categories set display_order = neighbor.display_order where id = cur.id;
end;
$$;

create or replace function delete_category(category_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  cat_name text;
  used_count integer;
begin
  select name into cat_name from categories where id = category_id for update;
  if cat_name is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select count(*) into used_count from prompts where category = cat_name;
  if used_count > 0 then
    raise exception 'in_use:%', used_count using errcode = 'P0001';
  end if;
  delete from categories where id = category_id;
end;
$$;
```

- [ ] **Step 2: Syntax sanity check**

Run: `grep -c "create or replace function" supabase/migrations/008_category_rpc.sql`
Expected: `4`

- [ ] **Step 3: Commit migration 008**

```bash
git add supabase/migrations/008_category_rpc.sql
git commit -m "feat(db): add four category mutation RPCs (008)

create_category / rename_category / move_category / delete_category.
All run security invoker (service_role bypasses RLS) and use FOR UPDATE
row locks that interlock with the soft-FK trigger's FOR KEY SHARE.
create_category also takes a pg_advisory_xact_lock so concurrent admins
can't produce duplicate display_order values."
```

---

## Chunk 2: API layer — /api/categories + tests

One serverless handler, one test file, dev-server registration, and Zod schemas. Tests are TDD — write them first so we have a failing target, then implement.

### Task 3: Add Zod schemas for category create/rename

**Files:**
- Modify: `src/lib/schemas.ts` (append after existing prompt schemas)

- [ ] **Step 1: Add schemas**

Append to `src/lib/schemas.ts`:

```ts
// ---------------------------------------------------------------------------
// Category admin API schemas
//
// .trim() runs BEFORE .min(1) so "   " is normalized to "" and fails length.
// (Codex P2-1 incident: the reverse order let whitespace-only names through.)

export const CategoryCreateSchema = z
  .object({
    name: z.string().trim().min(1, "名称不能为空").max(32, "名称过长"),
  })
  .strict();

export const CategoryRenameSchema = z
  .object({
    name: z.string().trim().min(1, "名称不能为空").max(32, "名称过长"),
  })
  .strict();

export const CategoryMoveSchema = z
  .object({
    direction: z.enum(["up", "down"]),
  })
  .strict();

export type CategoryCreateInput = z.infer<typeof CategoryCreateSchema>;
export type CategoryRenameInput = z.infer<typeof CategoryRenameSchema>;
export type CategoryMoveInput = z.infer<typeof CategoryMoveSchema>;

export interface Category {
  id: string;
  name: string;
  display_order: number;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: Add schema tests**

Modify `tests/lib/schemas.test.ts`, append:

```ts
import {
  CategoryCreateSchema,
  CategoryRenameSchema,
  CategoryMoveSchema,
} from "../../src/lib/schemas";

describe("CategoryCreateSchema", () => {
  it("accepts a normal name", () => {
    const r = CategoryCreateSchema.safeParse({ name: "新分类" });
    expect(r.success).toBe(true);
  });
  it("trims surrounding whitespace before min()", () => {
    const r = CategoryCreateSchema.safeParse({ name: "   " });
    expect(r.success).toBe(false);
  });
  it("rejects names longer than 32 chars", () => {
    const r = CategoryCreateSchema.safeParse({ name: "x".repeat(33) });
    expect(r.success).toBe(false);
  });
  it("rejects unknown fields (strict)", () => {
    const r = CategoryCreateSchema.safeParse({ name: "ok", sneaky: 1 });
    expect(r.success).toBe(false);
  });
});

describe("CategoryRenameSchema", () => {
  it("accepts a normal name and trims", () => {
    const r = CategoryRenameSchema.safeParse({ name: "  新名  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("新名");
  });
  it("rejects empty after trim", () => {
    expect(CategoryRenameSchema.safeParse({ name: "" }).success).toBe(false);
  });
  it("rejects unknown fields", () => {
    expect(
      CategoryRenameSchema.safeParse({ name: "ok", extra: 1 }).success,
    ).toBe(false);
  });
});

describe("CategoryMoveSchema", () => {
  it("accepts up/down", () => {
    expect(CategoryMoveSchema.safeParse({ direction: "up" }).success).toBe(true);
    expect(CategoryMoveSchema.safeParse({ direction: "down" }).success).toBe(true);
  });
  it("rejects sideways", () => {
    expect(CategoryMoveSchema.safeParse({ direction: "sideways" }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run schema tests**

Run: `cd /home/ddzhang16/prompt-workbench && npx vitest run tests/lib/schemas.test.ts`
Expected: PASS (existing tests + 6 new)

- [ ] **Step 4: Commit**

```bash
git add src/lib/schemas.ts tests/lib/schemas.test.ts
git commit -m "feat(schemas): add CategoryCreate/Rename/Move Zod schemas

Strict schemas reject unknown fields. .trim() runs before .min(1) so
whitespace-only names fail length check (mirrors the Phase 2 fix for
display_name on /api/profile/update)."
```

### Task 4: Write categories API test scaffolding + auth tests (TDD)

**Files:**
- Create: `tests/api/categories.test.ts`

- [ ] **Step 1: Create the test file with mock scaffolding**

Copy the Bag-style mock from `tests/api/prompts.test.ts:1-153`, then add auth tests:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

type ChainCall = { table: string; method: string; args: unknown[] };
type Bag = {
  getUser: ReturnType<typeof vi.fn>;
  rpc: ReturnType<typeof vi.fn>;
  results: Map<string, Array<{ data: unknown; error: unknown }>>;
  calls: ChainCall[];
};

const bag: Bag = {
  getUser: vi.fn(),
  rpc: vi.fn(),
  results: new Map(),
  calls: [],
};

function pushResult(table: string, result: { data: unknown; error: unknown }) {
  if (!bag.results.has(table)) bag.results.set(table, []);
  bag.results.get(table)!.push(result);
}

function nextResult(table: string): { data: unknown; error: unknown } {
  const q = bag.results.get(table);
  if (!q || q.length === 0) {
    return { data: null, error: { message: `no mocked result for ${table}` } };
  }
  return q.shift()!;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: (...a: unknown[]) => (bag.getUser as any)(...a),
    },
    rpc: (...a: unknown[]) => (bag.rpc as any)(...a),
    from: (table: string) => {
      const chain: any = {};
      const record = (method: string) =>
        (...args: unknown[]) => {
          bag.calls.push({ table, method, args });
          return chain;
        };
      chain.select = record("select");
      chain.eq = record("eq");
      chain.order = record("order");
      chain.single = () => Promise.resolve(nextResult(table));
      chain.then = (fn: any) => Promise.resolve(nextResult(table)).then(fn);
      return chain;
    },
  }),
}));

const categoriesHandler = (await import("../../api/categories")).default;
const supaLib = await import("../../api/lib/supabase");

function makeRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn((d: unknown) => { res.body = d; return res; });
  return res;
}

function makeReq(opts: {
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  authorization?: string;
}): VercelRequest {
  return {
    method: opts.method ?? "GET",
    body: opts.body,
    query: opts.query ?? {},
    headers: opts.authorization ? { authorization: opts.authorization } : {},
  } as unknown as VercelRequest;
}

const REGULAR_USER = {
  id: "user-aaa", email: "alice@example.com",
  display_name: "Alice", is_admin: false,
};
const ADMIN_USER = {
  id: "user-zzz", email: "admin@example.com",
  display_name: "Admin", is_admin: true,
};

function mockAuthenticated(user: typeof REGULAR_USER) {
  bag.getUser.mockResolvedValue({
    data: { user: { id: user.id, email: user.email,
      user_metadata: { password_set: true } } },
    error: null,
  });
  pushResult("profiles", {
    data: { display_name: user.display_name, is_admin: user.is_admin },
    error: null,
  });
}

beforeEach(() => {
  bag.getUser.mockReset();
  bag.rpc.mockReset();
  bag.results.clear();
  bag.calls = [];
  supaLib.__resetServiceRoleClientForTests();
});

describe("/api/categories — auth", () => {
  it("GET is public (no bearer required)", async () => {
    pushResult("categories", { data: [], error: null });
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    // Handler must order by display_order ascending (spec §3.2).
    expect(bag.calls).toContainEqual(expect.objectContaining({
      table: "categories",
      method: "order",
      args: ["display_order", { ascending: true }],
    }));
  });

  it("POST without bearer → 401", async () => {
    const req = makeReq({ method: "POST", body: { name: "foo" } });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("POST as non-admin → 403", async () => {
    mockAuthenticated(REGULAR_USER);
    const req = makeReq({
      method: "POST", body: { name: "foo" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd /home/ddzhang16/prompt-workbench && npx vitest run tests/api/categories.test.ts 2>&1 | tail -20`
Expected: FAIL with "Cannot find module '../../api/categories'"

- [ ] **Step 3: Commit test scaffolding (failing)**

```bash
git add tests/api/categories.test.ts
git commit -m "test(api): add /api/categories test scaffolding

Three auth tests (public GET, 401 missing bearer, 403 non-admin).
All fail until the handler is implemented in the next commit."
```

### Task 5: Implement /api/categories handler (auth path)

**Files:**
- Create: `api/categories.ts`

- [ ] **Step 1: Write minimal handler covering auth**

Create `api/categories.ts`:

```ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  CategoryCreateSchema,
  CategoryRenameSchema,
  CategoryMoveSchema,
} from "../src/lib/schemas.js";
import { authenticate } from "./lib/auth.js";
import { getServiceRoleClient } from "./lib/supabase.js";
import { safeLog } from "./lib/log.js";

const ENDPOINT = "/api/categories";

function badRequest(res: VercelResponse, issues: string[]) {
  return res.status(400).json({ error: "Invalid payload", details: issues });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();
  const supabase = getServiceRoleClient();

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("categories")
      .select("*")
      .order("display_order", { ascending: true });
    if (error) {
      safeLog({ endpoint: ENDPOINT, method: "GET", status: 500, errorCode: "SUPABASE_SELECT" });
      return res.status(500).json({ error: error.message });
    }
    safeLog({ endpoint: ENDPOINT, method: "GET", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json({ categories: data ?? [] });
  }

  // All other methods are admin-only.
  const user = await authenticate(req);
  if (!user) {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 401 });
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!user.is_admin) {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 403, errorCode: "NOT_ADMIN" });
    return res.status(403).json({ error: "forbidden" });
  }

  safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
  return res.status(405).json({ error: "Method not allowed" });
}
```

- [ ] **Step 2: Run auth tests**

Run: `cd /home/ddzhang16/prompt-workbench && npx vitest run tests/api/categories.test.ts 2>&1 | tail -20`
Expected: 3 PASS

- [ ] **Step 3: Commit**

```bash
git add api/categories.ts
git commit -m "feat(api): /api/categories — GET (public) + admin gate

Only GET is implemented; other methods fall through to 405 after the
authenticate + is_admin check so the gate is exercised. POST/PATCH/
DELETE bodies come in the next task."
```

### Task 6: Add POST /api/categories (create) — tests + impl

**Files:**
- Modify: `tests/api/categories.test.ts` (append POST tests)
- Modify: `api/categories.ts` (add POST branch)

- [ ] **Step 1: Append POST tests**

Add to `tests/api/categories.test.ts`:

```ts
describe("POST /api/categories", () => {
  it("admin can create, returns 201 + row", async () => {
    mockAuthenticated(ADMIN_USER);
    bag.rpc.mockResolvedValue({
      data: { id: "cat-1", name: "AI", display_order: 60,
        created_at: "2026-05-12T00:00:00Z", updated_at: "2026-05-12T00:00:00Z" },
      error: null,
    });
    const req = makeReq({
      method: "POST", body: { name: "AI" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(201);
    expect((res.body as any).name).toBe("AI");
    expect(bag.rpc).toHaveBeenCalledWith("create_category", { p_name: "AI" });
  });

  it("whitespace-only name → 400", async () => {
    mockAuthenticated(ADMIN_USER);
    const req = makeReq({
      method: "POST", body: { name: "   " },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("33-char name → 400", async () => {
    mockAuthenticated(ADMIN_USER);
    const req = makeReq({
      method: "POST", body: { name: "x".repeat(33) },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("unknown field → 400 (strict schema)", async () => {
    mockAuthenticated(ADMIN_USER);
    const req = makeReq({
      method: "POST", body: { name: "ok", sneaky: true },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("duplicate name (23505) → 409 duplicate_name", async () => {
    mockAuthenticated(ADMIN_USER);
    bag.rpc.mockResolvedValue({
      data: null,
      error: { code: "23505", message: "duplicate key value" },
    });
    const req = makeReq({
      method: "POST", body: { name: "生图" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toBe("duplicate_name");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd /home/ddzhang16/prompt-workbench && npx vitest run tests/api/categories.test.ts 2>&1 | tail -20`
Expected: FAIL (POST reaches 405 or wrong code)

- [ ] **Step 3: Add POST branch to handler**

Insert before the final 405 fall-through in `api/categories.ts`:

```ts
  if (req.method === "POST") {
    const parsed = CategoryCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      );
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "ZOD" });
      return badRequest(res, issues);
    }
    const { data, error } = await supabase.rpc("create_category", {
      p_name: parsed.data.name,
    });
    if (error) {
      if ((error as any).code === "23505") {
        safeLog({ endpoint: ENDPOINT, method: "POST", status: 409, errorCode: "DUPLICATE" });
        return res.status(409).json({ error: "duplicate_name" });
      }
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "SUPABASE_RPC" });
      return res.status(500).json({ error: (error as any).message ?? "RPC failed" });
    }
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 201, durationMs: Date.now() - startedAt });
    return res.status(201).json(data);
  }
```

- [ ] **Step 4: Run POST tests**

Run: `cd /home/ddzhang16/prompt-workbench && npx vitest run tests/api/categories.test.ts 2>&1 | tail -20`
Expected: 8 PASS

- [ ] **Step 5: Commit**

```bash
git add api/categories.ts tests/api/categories.test.ts
git commit -m "feat(api): POST /api/categories — create via create_category RPC

Zod validation (strict, trim-before-min, max 32). 23505 → 409
duplicate_name. Other errors surface as 500."
```

### Task 7: Add PATCH /api/categories — tests + impl

**Files:**
- Modify: `tests/api/categories.test.ts`
- Modify: `api/categories.ts`

- [ ] **Step 1: Append PATCH tests**

Add to `tests/api/categories.test.ts`:

```ts
describe("PATCH /api/categories", () => {
  it("admin can rename, returns 200", async () => {
    mockAuthenticated(ADMIN_USER);
    bag.rpc.mockResolvedValue({
      data: { id: "cat-1", name: "图像生成", display_order: 20,
        created_at: "x", updated_at: "x" },
      error: null,
    });
    const req = makeReq({
      method: "PATCH", body: { name: "图像生成" },
      query: { id: "cat-1" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(bag.rpc).toHaveBeenCalledWith("rename_category", {
      category_id: "cat-1", new_name: "图像生成",
    });
  });

  it("trims leading/trailing whitespace", async () => {
    mockAuthenticated(ADMIN_USER);
    bag.rpc.mockResolvedValue({
      data: { id: "cat-1", name: "生图", display_order: 20,
        created_at: "x", updated_at: "x" },
      error: null,
    });
    const req = makeReq({
      method: "PATCH", body: { name: "  生图  " },
      query: { id: "cat-1" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(bag.rpc).toHaveBeenCalledWith("rename_category", {
      category_id: "cat-1", new_name: "生图",
    });
  });

  it("not found (P0002) → 404", async () => {
    mockAuthenticated(ADMIN_USER);
    bag.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "not_found" },
    });
    const req = makeReq({
      method: "PATCH", body: { name: "x" },
      query: { id: "no-such" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(404);
  });

  it("duplicate name (23505) → 409", async () => {
    mockAuthenticated(ADMIN_USER);
    bag.rpc.mockResolvedValue({
      data: null,
      error: { code: "23505", message: "duplicate" },
    });
    const req = makeReq({
      method: "PATCH", body: { name: "生图" },
      query: { id: "cat-1" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toBe("duplicate_name");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd /home/ddzhang16/prompt-workbench && npx vitest run tests/api/categories.test.ts 2>&1 | tail -20`
Expected: PATCH tests FAIL

- [ ] **Step 3: Add PATCH branch**

Insert in `api/categories.ts` before the final 405 fall-through (after the POST branch):

```ts
  if (req.method === "PATCH") {
    const id = req.query.id as string | undefined;
    if (!id) return res.status(400).json({ error: "missing id" });
    const parsed = CategoryRenameSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      );
      safeLog({ endpoint: ENDPOINT, method: "PATCH", status: 400, errorCode: "ZOD" });
      return badRequest(res, issues);
    }
    const { data, error } = await supabase.rpc("rename_category", {
      category_id: id, new_name: parsed.data.name,
    });
    if (error) {
      const code = (error as any).code;
      if (code === "P0002") return res.status(404).json({ error: "not_found" });
      if (code === "23505") return res.status(409).json({ error: "duplicate_name" });
      safeLog({ endpoint: ENDPOINT, method: "PATCH", status: 500, errorCode: "SUPABASE_RPC" });
      return res.status(500).json({ error: (error as any).message ?? "RPC failed" });
    }
    safeLog({ endpoint: ENDPOINT, method: "PATCH", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json(data);
  }
```

- [ ] **Step 4: Run PATCH tests**

Run: `cd /home/ddzhang16/prompt-workbench && npx vitest run tests/api/categories.test.ts 2>&1 | tail -20`
Expected: 12 PASS

- [ ] **Step 5: Commit**

```bash
git add api/categories.ts tests/api/categories.test.ts
git commit -m "feat(api): PATCH /api/categories?id= — rename via rename_category RPC

Zod trim+min+max, strict. P0002 → 404, 23505 → 409 duplicate_name."
```

### Task 8: Add move + delete branches — tests + impl

**Files:**
- Modify: `tests/api/categories.test.ts`
- Modify: `api/categories.ts`

- [ ] **Step 1: Append move + delete tests**

Add to `tests/api/categories.test.ts`:

```ts
describe("POST /api/categories/:id/move", () => {
  it("admin can move up, returns 200", async () => {
    mockAuthenticated(ADMIN_USER);
    bag.rpc.mockResolvedValue({ data: null, error: null });
    const req = makeReq({
      method: "POST", body: { direction: "up" },
      query: { id: "cat-1", action: "move" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(bag.rpc).toHaveBeenCalledWith("move_category", {
      category_id: "cat-1", direction: "up",
    });
  });

  it("cannot_move (P0001) at top → 400", async () => {
    mockAuthenticated(ADMIN_USER);
    bag.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "cannot_move" },
    });
    const req = makeReq({
      method: "POST", body: { direction: "up" },
      query: { id: "cat-1", action: "move" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toBe("cannot_move");
  });

  it("invalid direction (22023) → 400", async () => {
    mockAuthenticated(ADMIN_USER);
    bag.rpc.mockResolvedValue({
      data: null,
      error: { code: "22023", message: "invalid_direction" },
    });
    const req = makeReq({
      method: "POST", body: { direction: "up" },
      query: { id: "cat-1", action: "move" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("non-existent id (P0002) → 404", async () => {
    mockAuthenticated(ADMIN_USER);
    bag.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "not_found" },
    });
    const req = makeReq({
      method: "POST", body: { direction: "up" },
      query: { id: "nope", action: "move" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(404);
  });

  it("schema-invalid direction → 400 before RPC", async () => {
    mockAuthenticated(ADMIN_USER);
    const req = makeReq({
      method: "POST", body: { direction: "sideways" },
      query: { id: "cat-1", action: "move" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect(bag.rpc).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/categories", () => {
  it("empty category → 204", async () => {
    mockAuthenticated(ADMIN_USER);
    bag.rpc.mockResolvedValue({ data: null, error: null });
    const req = makeReq({
      method: "DELETE",
      query: { id: "cat-1" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(204);
    expect(bag.rpc).toHaveBeenCalledWith("delete_category", {
      category_id: "cat-1",
    });
  });

  it("in-use → 409 with used_by_count", async () => {
    mockAuthenticated(ADMIN_USER);
    bag.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "in_use:7" },
    });
    const req = makeReq({
      method: "DELETE",
      query: { id: "cat-1" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(409);
    expect((res.body as any).error).toBe("in_use");
    expect((res.body as any).used_by_count).toBe(7);
  });

  it("not found (P0002) → 404", async () => {
    mockAuthenticated(ADMIN_USER);
    bag.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "not_found" },
    });
    const req = makeReq({
      method: "DELETE",
      query: { id: "nope" },
      authorization: "Bearer T",
    });
    const res = makeRes();
    await categoriesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd /home/ddzhang16/prompt-workbench && npx vitest run tests/api/categories.test.ts 2>&1 | tail -20`
Expected: move + delete tests FAIL

- [ ] **Step 3: Add move + delete branches**

Move handler (inserted in `api/categories.ts` — disambiguate move from create by `req.query.action === "move"`):

```ts
  if (req.method === "POST" && req.query.action === "move") {
    const id = req.query.id as string | undefined;
    if (!id) return res.status(400).json({ error: "missing id" });
    const parsed = CategoryMoveSchema.safeParse(req.body);
    if (!parsed.success) {
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "ZOD" });
      return badRequest(
        res,
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      );
    }
    const { error } = await supabase.rpc("move_category", {
      category_id: id, direction: parsed.data.direction,
    });
    if (error) {
      const code = (error as any).code;
      if (code === "P0002") return res.status(404).json({ error: "not_found" });
      if (code === "P0001") return res.status(400).json({ error: "cannot_move" });
      if (code === "22023") return res.status(400).json({ error: "invalid_direction" });
      safeLog({ endpoint: ENDPOINT, method: "POST(move)", status: 500, errorCode: "SUPABASE_RPC" });
      return res.status(500).json({ error: (error as any).message ?? "RPC failed" });
    }
    safeLog({ endpoint: ENDPOINT, method: "POST(move)", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json({ ok: true });
  }
```

**Important — ORDERING IS LOAD-BEARING:** this branch MUST come BEFORE the plain `POST` branch from Task 6. Both match `req.method === "POST"`; the first matching branch wins. If a future editor places the create branch first, every move request will be routed to `create_category` and move tests will fail with 201 instead of 200. Add a comment in the handler noting this.

Delete handler (appended):

```ts
  if (req.method === "DELETE") {
    const id = req.query.id as string | undefined;
    if (!id) return res.status(400).json({ error: "missing id" });
    const { error } = await supabase.rpc("delete_category", { category_id: id });
    if (error) {
      const code = (error as any).code;
      if (code === "P0002") return res.status(404).json({ error: "not_found" });
      if (code === "P0001") {
        // Message format is "in_use:N" — parse N out.
        const msg = String((error as any).message ?? "");
        const m = msg.match(/^in_use:(\d+)/);
        const used_by_count = m ? parseInt(m[1], 10) : 0;
        return res.status(409).json({ error: "in_use", used_by_count });
      }
      safeLog({ endpoint: ENDPOINT, method: "DELETE", status: 500, errorCode: "SUPABASE_RPC" });
      return res.status(500).json({ error: (error as any).message ?? "RPC failed" });
    }
    safeLog({ endpoint: ENDPOINT, method: "DELETE", status: 204, durationMs: Date.now() - startedAt });
    return res.status(204).end();
  }
```

- [ ] **Step 4: Run all /api/categories tests**

Run: `cd /home/ddzhang16/prompt-workbench && npx vitest run tests/api/categories.test.ts 2>&1 | tail -20`
Expected: ~20 PASS (3 auth + 5 POST + 4 PATCH + 5 move + 3 delete)

- [ ] **Step 5: Commit**

```bash
git add api/categories.ts tests/api/categories.test.ts
git commit -m "feat(api): move + delete branches for /api/categories

POST ?action=move → move_category RPC. DELETE → delete_category RPC.
P0001 with in_use: prefix parses the count back out for the 409 body."
```

### Task 9: Register /api/categories in dev-server

**Files:**
- Modify: `dev-server.ts`

- [ ] **Step 1: Add import + route**

In `dev-server.ts`, add to the imports block:

```ts
import categoriesHandler from "./api/categories.js";
```

And register the route alongside the other `app.all` calls:

```ts
app.all("/api/categories", adapt(categoriesHandler));
```

- [ ] **Step 2: Smoke test**

Run: `cd /home/ddzhang16/prompt-workbench && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add dev-server.ts
git commit -m "chore(dev-server): register /api/categories route"
```

---

## Chunk 3: Frontend data layer

Replace the `CATEGORIES` constant with a `useCategories()` context hook. Extend the `api` client. Update Sidebar + PromptForm consumers.

### Task 10: Add categories methods to ApiClient

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add types + methods**

Import the Category type at top:

```ts
import type { Category } from "./schemas";
```

Add methods inside `ApiClient` class (after the examples methods):

```ts
  // -------- Categories --------

  async listCategories(): Promise<Category[]> {
    const res = await fetch(`${API_BASE_URL}/api/categories`);
    if (!res.ok) throw new Error("Failed to load categories");
    const body = await res.json();
    return body.categories ?? [];
  }

  async createCategory(name: string): Promise<Category> {
    return this.request<Category>("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  async renameCategory(id: string, name: string): Promise<Category> {
    const qs = new URLSearchParams({ id });
    return this.request<Category>(`/api/categories?${qs.toString()}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  async moveCategory(id: string, direction: "up" | "down"): Promise<void> {
    const qs = new URLSearchParams({ id, action: "move" });
    await this.request(`/api/categories?${qs.toString()}`, {
      method: "POST",
      body: JSON.stringify({ direction }),
    });
  }

  async deleteCategory(id: string): Promise<void> {
    const qs = new URLSearchParams({ id });
    const res = await authedFetch(`/api/categories?${qs.toString()}`, {
      method: "DELETE",
    });
    // 204 No Content is success; anything else with a body is an error.
    if (res.status === 204) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error === "in_use"
        ? `in_use:${err.used_by_count ?? 0}`
        : err.error ?? "Delete failed";
      throw new Error(msg);
    }
  }
```

- [ ] **Step 2: Typecheck**

Run: `cd /home/ddzhang16/prompt-workbench && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api-client): categories CRUD methods

listCategories (public, no auth), createCategory, renameCategory,
moveCategory, deleteCategory. Delete preserves the in_use:N message
format so the UI can distinguish 'in use' from generic failures."
```

### Task 11: Create CategoriesContext

**Files:**
- Create: `src/lib/categoriesContext.tsx`

- [ ] **Step 1: Write the provider + hook**

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import type { Category } from "./schemas";

type CategoriesCtx = {
  categories: Category[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const Ctx = createContext<CategoriesCtx | null>(null);

export function CategoriesProvider({ children }: { children: ReactNode }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listCategories();
      setCategories(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载分类失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Ctx.Provider value={{ categories, loading, error, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCategories(): CategoriesCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCategories must be used within CategoriesProvider");
  return v;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /home/ddzhang16/prompt-workbench && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/categoriesContext.tsx
git commit -m "feat: CategoriesProvider + useCategories hook

Single GET on mount, caches in context. refresh() re-fetches for use
after admin mutations. throws if consumed outside provider."
```

### Task 12: Wire provider into App; switch Sidebar to useCategories

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Wrap CurrentUserProvider**

In `src/App.tsx`, modify the default export:

```tsx
import { CategoriesProvider } from "./lib/categoriesContext";

export default function App() {
  return (
    <CurrentUserProvider>
      <CategoriesProvider>
        <AppRoutes />
      </CategoriesProvider>
    </CurrentUserProvider>
  );
}
```

- [ ] **Step 2: Sidebar reads from useCategories**

In `src/components/Sidebar.tsx`:

Remove `import { CATEGORIES } from "../lib/constants";`.

Add `import { useCategories } from "../lib/categoriesContext";`.

Inside the component, grab categories:

```ts
const { categories } = useCategories();
```

Replace `{CATEGORIES.map((cat) => (` (both in the expanded and the navigation block — there's only one) with `{categories.map((c) => {`:

```tsx
{categories.map((c) => (
  <button
    key={c.id}
    onClick={() => onSelectCategory(c.name)}
    className={`w-full text-left px-3 py-1.5 text-sm rounded-sm mb-1 ${
      selectedCategory === c.name
        ? "bg-white/15 text-white"
        : "text-white/70 hover:bg-white/10"
    }`}
  >
    {c.name}
  </button>
))}
```

- [ ] **Step 3: Typecheck + build**

Run: `cd /home/ddzhang16/prompt-workbench && npx tsc --noEmit && npm run build`
Expected: no errors; build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/components/Sidebar.tsx
git commit -m "feat: Sidebar reads categories from useCategories

App wraps AppRoutes in CategoriesProvider (nested inside
CurrentUserProvider per spec §4.1). Sidebar swaps CATEGORIES constant
for the hook."
```

### Task 13: PromptForm reads useCategories + handles orphan category

**Files:**
- Modify: `src/components/PromptForm.tsx`

- [ ] **Step 1: Swap CATEGORIES → useCategories**

Remove `import { CATEGORIES } from "../lib/constants";`.
Add `import { useCategories } from "../lib/categoriesContext";`.

Inside the component:

```ts
const { categories } = useCategories();
```

- [ ] **Step 2: Render orphan category handling**

Replace the `<select>` block with:

```tsx
{/* If the prompt's saved category no longer exists in the list, force the
    select's current value to "" so the "请选择" placeholder becomes the
    selected one — the orphan appears as a disabled hint, NOT selected. */}
{(() => {
  const isOrphan = !!category && !categories.some((c) => c.name === category);
  const selectValue = isOrphan ? "" : category;
  return (
    <select
      value={selectValue}
      onChange={(e) => setCategory(e.target.value)}
      className="input-field mt-1"
    >
      <option value="">请选择</option>
      {isOrphan && (
        <option value={category} disabled>
          {category}（已失效，请重新选择）
        </option>
      )}
      {categories.map((c) => (
        <option key={c.id} value={c.name}>{c.name}</option>
      ))}
    </select>
  );
})()}
```

Spec §4.4.1 mandates the select's default VALUE is the placeholder when the saved category is orphaned — otherwise the disabled orphan option renders as the displayed label and the form would submit with the stale value if the user hit Save without touching the dropdown. The `selectValue` indirection makes sure the user must actively pick a valid option.

- [ ] **Step 3: Typecheck + build**

Run: `cd /home/ddzhang16/prompt-workbench && npx tsc --noEmit && npm run build`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/components/PromptForm.tsx
git commit -m "feat: PromptForm reads categories from useCategories

Adds orphan-category handling per spec §4.4.1: if the prompt's saved
category was deleted by an admin, render it as a disabled option
labeled '(已失效，请重新选择)' so the user is forced to pick a valid
category before the form can submit."
```

### Task 14: Remove CATEGORIES constant

**Files:**
- Modify: `src/lib/constants.ts`

- [ ] **Step 1: Delete the constant**

Replace the file contents with:

```ts
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "";
```

(Drop CATEGORIES and the `Category` type alias — the real `Category` interface lives in `schemas.ts` now.)

- [ ] **Step 2: Hunt for lingering imports**

Run: `cd /home/ddzhang16/prompt-workbench && grep -rn "CATEGORIES\|from.*constants.*Category" src/ 2>&1 | grep -v "//"`
Expected: empty output (no lingering imports)

- [ ] **Step 3: Typecheck + build**

Run: `cd /home/ddzhang16/prompt-workbench && npx tsc --noEmit && npm run build`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/constants.ts
git commit -m "chore: remove hardcoded CATEGORIES constant

Sidebar and PromptForm now read from useCategories(). The canonical
Category TypeScript interface lives in schemas.ts, aligned with the
server wire format."
```

---

## Chunk 4: Admin UI — CategoryManagerPanel

A new component rendered inside SettingsDialog, visible only to admins. Handles list/create/rename/move/delete with inline UI.

### Task 15: Scaffold CategoryManagerPanel (list-only)

**Files:**
- Create: `src/components/CategoryManagerPanel.tsx`

- [ ] **Step 1: Write the list view**

```tsx
import { useState } from "react";
import { useCategories } from "../lib/categoriesContext";
import { api } from "../lib/api";
import type { Category } from "../lib/schemas";

/**
 * Admin-only panel rendered inside SettingsDialog. Provides CRUD + reorder
 * for the categories table. Parent already gates on currentUser.is_admin
 * before rendering this; we don't re-check here.
 */
export function CategoryManagerPanel() {
  const { categories, refresh, error: listError } = useCategories();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  return (
    <div className="border-t border-primary/10 pt-4 mt-4">
      <h3 className="text-sm font-semibold text-primary mb-2">分类管理</h3>
      {listError && <p className="text-error text-xs mb-2">{listError}</p>}
      {opError && <p className="text-error text-xs mb-2">{opError}</p>}
      <div className="space-y-1">
        {categories.map((c, idx) => (
          <CategoryRow
            key={c.id}
            category={c}
            isFirst={idx === 0}
            isLast={idx === categories.length - 1}
            busy={busyId === c.id}
            onBusy={setBusyId}
            onError={setOpError}
            onChanged={refresh}
          />
        ))}
      </div>
    </div>
  );
}

function CategoryRow({
  category,
  isFirst,
  isLast,
  busy,
  onBusy,
  onError,
  onChanged,
}: {
  category: Category;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onBusy: (id: string | null) => void;
  onError: (msg: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <div className="flex items-center gap-1 text-sm">
      <button
        type="button"
        disabled={isFirst || busy}
        className="px-1.5 py-0.5 text-xs text-primary/70 hover:text-primary disabled:opacity-30"
        title="上移"
      >
        ↑
      </button>
      <button
        type="button"
        disabled={isLast || busy}
        className="px-1.5 py-0.5 text-xs text-primary/70 hover:text-primary disabled:opacity-30"
        title="下移"
      >
        ↓
      </button>
      <span className="flex-1 truncate">{category.name}</span>
      {/* rename + delete buttons come in Task 16/17 */}
    </div>
  );
}
```

- [ ] **Step 2: Render it in SettingsDialog**

In `src/components/SettingsDialog.tsx`, add the import at the top:

```ts
import { CategoryManagerPanel } from "./CategoryManagerPanel";
```

Insert the admin panel as a new sibling BETWEEN the API-key block's closing `</div>` (currently line 154) and the buttons `<div>` (currently line 156). DO NOT nest inside the API-key div:

```tsx
          </div>

          {currentUser.status === "authenticated" && currentUser.user.is_admin && (
            <CategoryManagerPanel />
          )}

          <div className="flex justify-end gap-2 mt-6">
```

(The three-line block above shows closing `</div>` + admin panel + opening buttons `<div>` as an anchor so the insertion lands in the right spot.)

- [ ] **Step 3: Typecheck + build**

Run: `cd /home/ddzhang16/prompt-workbench && npx tsc --noEmit && npm run build`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/components/CategoryManagerPanel.tsx src/components/SettingsDialog.tsx
git commit -m "feat(ui): CategoryManagerPanel scaffold with list rendering

Admin-only panel rendered inside SettingsDialog. This commit only
surfaces the list + up/down buttons (disabled). Actions wired in
subsequent commits."
```

### Task 16: Wire up/down buttons

**Files:**
- Modify: `src/components/CategoryManagerPanel.tsx`

- [ ] **Step 1: Add onClick to ↑ and ↓ buttons**

In `CategoryRow`, add:

```tsx
const handleMove = async (direction: "up" | "down") => {
  onError(null);
  onBusy(category.id);
  try {
    await api.moveCategory(category.id, direction);
    await onChanged();
  } catch (e) {
    onError(e instanceof Error ? e.message : "移动失败");
  } finally {
    onBusy(null);
  }
};
```

Wire them:

```tsx
<button
  type="button"
  disabled={isFirst || busy}
  onClick={() => void handleMove("up")}
  className="px-1.5 py-0.5 text-xs text-primary/70 hover:text-primary disabled:opacity-30"
  title="上移"
>
  ↑
</button>
<button
  type="button"
  disabled={isLast || busy}
  onClick={() => void handleMove("down")}
  className="px-1.5 py-0.5 text-xs text-primary/70 hover:text-primary disabled:opacity-30"
  title="下移"
>
  ↓
</button>
```

Also add `import { api } from "../lib/api";` at top of the file (already there from Task 15 if scaffolded correctly).

- [ ] **Step 2: Manual smoke test**

Run `npm run dev` and `npx tsx dev-server.ts` in two terminals; log in as admin (set `ADMIN_EMAILS` env to your email); open SettingsDialog; click ↑ / ↓ and verify sidebar category order updates.

(Skip if no local admin account configured — pass if typecheck + build pass.)

Run: `cd /home/ddzhang16/prompt-workbench && npx tsc --noEmit && npm run build`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/components/CategoryManagerPanel.tsx
git commit -m "feat(ui): wire up/down buttons to moveCategory"
```

### Task 17: Wire rename (inline edit)

**Files:**
- Modify: `src/components/CategoryManagerPanel.tsx`

- [ ] **Step 1: Add rename UI to CategoryRow**

Inside `CategoryRow`, add state + handlers:

```tsx
const [editing, setEditing] = useState(false);
const [draft, setDraft] = useState(category.name);
// Guard against onBlur firing a second rename after Enter already submitted.
// Enter → handleRename → setEditing(false) → input unmounts → onBlur fires.
// Without this flag we'd double-POST the same name.
const renamingRef = useRef(false);

const translateError = (msg: string): string => {
  if (msg === "duplicate_name") return "该分类名已存在";
  if (msg.startsWith("in_use:")) {
    const n = msg.slice("in_use:".length);
    return `有 ${n} 条提示词在用，请先迁移`;
  }
  return msg;
};

const handleRename = async () => {
  if (renamingRef.current) return;
  const name = draft.trim();
  if (!name || name === category.name) {
    setEditing(false);
    setDraft(category.name);
    return;
  }
  renamingRef.current = true;
  onError(null);
  onBusy(category.id);
  try {
    await api.renameCategory(category.id, name);
    await onChanged();
    setEditing(false);
  } catch (e) {
    onError(translateError(e instanceof Error ? e.message : "重命名失败"));
  } finally {
    renamingRef.current = false;
    onBusy(null);
  }
};
```

Add `useRef` to the imports from "react" at top of the file.

Replace the plain `<span>{category.name}</span>` with a conditional:

```tsx
{editing ? (
  <input
    type="text"
    value={draft}
    onChange={(e) => setDraft(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === "Enter") void handleRename();
      if (e.key === "Escape") { setEditing(false); setDraft(category.name); }
    }}
    onBlur={() => void handleRename()}
    autoFocus
    className="flex-1 text-sm px-1.5 py-0.5 border border-primary/30 rounded"
    maxLength={32}
  />
) : (
  <span className="flex-1 truncate">{category.name}</span>
)}
<button
  type="button"
  onClick={() => setEditing(true)}
  disabled={busy || editing}
  className="px-1.5 py-0.5 text-xs text-primary/70 hover:text-primary disabled:opacity-30"
  title="重命名"
>
  ✏️
</button>
```

Also import `useState` if not already imported.

- [ ] **Step 2: Typecheck + build**

Run: `cd /home/ddzhang16/prompt-workbench && npx tsc --noEmit && npm run build`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/components/CategoryManagerPanel.tsx
git commit -m "feat(ui): wire rename via inline edit

Enter commits, Esc cancels, blur commits. Unchanged names are a no-op."
```

### Task 18: Wire delete

**Files:**
- Modify: `src/components/CategoryManagerPanel.tsx`

- [ ] **Step 1: Add delete button**

Stay with `window.confirm` to match the existing precedent in `src/components/ExamplesList.tsx` — spec §4.3 suggested ConfirmDialog, but the codebase uses native confirm for low-stakes admin dialogs. The `in_use` 409 is surfaced via the shared panel-level error line (where `translateError` from Task 17 formats it).

In `CategoryRow`, add handler (re-use `translateError` defined in Task 17):

```tsx
const handleDelete = async () => {
  onError(null);
  if (!window.confirm(`确认删除分类「${category.name}」？`)) return;
  onBusy(category.id);
  try {
    await api.deleteCategory(category.id);
    await onChanged();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "删除失败";
    onError(translateError(msg));
  } finally {
    onBusy(null);
  }
};
```

Add delete button after the ✏️ button:

```tsx
<button
  type="button"
  onClick={() => void handleDelete()}
  disabled={busy || editing}
  className="px-1.5 py-0.5 text-xs text-error/70 hover:text-error disabled:opacity-30"
  title="删除"
>
  🗑️
</button>
```

- [ ] **Step 2: Typecheck + build**

Run: `cd /home/ddzhang16/prompt-workbench && npx tsc --noEmit && npm run build`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/components/CategoryManagerPanel.tsx
git commit -m "feat(ui): wire delete with in_use error translation

in_use:N errors render as '有 N 条提示词在用…请先迁移'. All other
errors surface verbatim."
```

### Task 19: Wire create (bottom input row)

**Files:**
- Modify: `src/components/CategoryManagerPanel.tsx`

- [ ] **Step 1: Add create form to the panel**

In `CategoryManagerPanel`, add state + handler before the return:

```tsx
const [newName, setNewName] = useState("");
const [creating, setCreating] = useState(false);

// Shared with CategoryRow — hoist to module scope or duplicate here.
// Create + rename both surface 'duplicate_name' from the server.
const translateCreateError = (msg: string): string => {
  if (msg === "duplicate_name") return "该分类名已存在";
  return msg;
};

const handleCreate = async (e: React.FormEvent) => {
  e.preventDefault();
  const name = newName.trim();
  if (!name) return;
  setOpError(null);
  setCreating(true);
  try {
    await api.createCategory(name);
    setNewName("");
    await refresh();
  } catch (e) {
    setOpError(translateCreateError(e instanceof Error ? e.message : "创建失败"));
  } finally {
    setCreating(false);
  }
};
```

Below the category list (before the closing `</div>`), add:

```tsx
<form onSubmit={handleCreate} className="flex gap-2 mt-3">
  <input
    type="text"
    value={newName}
    onChange={(e) => setNewName(e.target.value)}
    placeholder="新分类名"
    maxLength={32}
    className="flex-1 text-sm px-2 py-1 border border-primary/20 rounded"
  />
  <button
    type="submit"
    disabled={!newName.trim() || creating}
    className="btn-pill bg-accent text-primary text-xs px-3 py-1 disabled:opacity-50"
  >
    {creating ? "创建中..." : "+ 新建"}
  </button>
</form>
```

- [ ] **Step 2: Typecheck + build**

Run: `cd /home/ddzhang16/prompt-workbench && npx tsc --noEmit && npm run build`
Expected: no errors

- [ ] **Step 3: Full test run**

Run: `cd /home/ddzhang16/prompt-workbench && npx vitest run 2>&1 | tail -10`
Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/components/CategoryManagerPanel.tsx
git commit -m "feat(ui): wire create form at bottom of admin panel

New category input with maxLength 32, inline error display. Append to
list on success and clears the input."
```

---

## Chunk 5: Production deployment

### Task 20: Run migrations in Supabase

**Files:** (DB changes only — no code changes in this task)

- [ ] **Step 1: Confirm migrations read cleanly**

Run: `cd /home/ddzhang16/prompt-workbench && cat supabase/migrations/007_category_management.sql | head -5 && echo "---" && cat supabase/migrations/008_category_rpc.sql | head -5`
Expected: two files' headers print without error.

- [ ] **Step 2: Apply 007 in Supabase SQL Editor**

Open Supabase dashboard → SQL Editor → New Query.

Paste full contents of `supabase/migrations/007_category_management.sql`, click Run.

Expected output: success; `select count(*) from categories;` returns **at least 5** (the canonicals 元提示词 / 生图 / 生文 / 分析 / 开发 plus any legacy categories present in `prompts.category`).

If errors: roll back with the FULL teardown (trigger + function + table — `drop table ... cascade` alone leaves the trigger dangling since it references `categories` by name, not by oid):

```sql
drop trigger if exists prompts_enforce_category on prompts;
drop function if exists enforce_category_exists();
drop table if exists categories cascade;
```

Then investigate the error before retrying.

- [ ] **Step 3: Apply 008 in Supabase SQL Editor**

Paste full contents of `supabase/migrations/008_category_rpc.sql`, click Run.

Expected: success; `\df create_category` (or select from `pg_proc`) shows four functions.

Verification query:

```sql
select proname from pg_proc
where proname in ('create_category', 'rename_category', 'move_category', 'delete_category')
order by proname;
```

Expected: 4 rows.

- [ ] **Step 4: Sanity-check concurrency locking**

Run in SQL Editor:

```sql
-- Does the trigger acquire FOR KEY SHARE? (Inspect function body)
select pg_get_functiondef(oid) from pg_proc where proname = 'enforce_category_exists';
```

Expected: output contains `for key share`.

- [ ] **Step 5: Record deployment**

No commit — this is a runtime change. Proceed to Task 21.

### Task 21: Deploy frontend + API

**Files:** (Git operations only)

- [ ] **Step 1: Push main to origin**

Run: `cd /home/ddzhang16/prompt-workbench && git log --oneline origin/main..HEAD`
Expected: ~15-20 commits from Chunks 1-4

Run: `git push origin main`
Expected: push succeeds; Vercel automatically starts deployment.

- [ ] **Step 2: Wait for Vercel deployment**

Watch the deployment in Vercel dashboard or via `vercel --prod` if CLI is configured. Wait for "Ready".

- [ ] **Step 3: Smoke test production**

Open production URL. As a regular user:
- Sidebar shows 5 categories in order 元提示词 / 生图 / 生文 / 分析 / 开发
- Create a prompt — dropdown shows the same 5

As an admin (test only if your ADMIN_EMAILS env var is set):
- Open SettingsDialog; see "分类管理" section
- **Create**: add a new category (e.g., "临时测试") → appears at the bottom of the sidebar
- **Move**: up/down buttons change sidebar order
- **Rename**: ✏️ → type new name → Enter. Rename a canonical (e.g., 生图 → 图像生成) and verify any existing prompt with that category still reads correctly (`prompts.category` was atomically updated).
- **Delete — in_use path**: try deleting a category that has a prompt using it → panel shows red text "有 N 条提示词在用，请先迁移"
- **Delete — success path**: create a new category, assign no prompts, delete it → row disappears.
- **Orphan path**: create a category "临时测试2", create a prompt with that category, delete the category via the panel (prompt still references it via old name since delete was blocked — actually this case can't happen because of in_use block; instead use the force path: edit the prompt to another category first, then delete). Then manually UPDATE one prompt in SQL Editor to a category name that doesn't exist:
  ```sql
  update prompts set category = '已删除的测试' where id = '<some-id>';
  ```
  Reopen that prompt in the web UI → click Edit → PromptForm dropdown shows "已删除的测试（已失效，请重新选择）" as a disabled option; the select's displayed value is "请选择"; save is effectively blocked until user picks a valid category.

Revert the hand-edited prompt afterward:
```sql
update prompts set category = '元提示词' where id = '<some-id>';
```

- [ ] **Step 4: Document the deployment**

No commit. If any issue arises, see rollback in spec §6.2 step 4.

---

## Execution notes

- **Commit frequency:** Every task ends with a commit. Do not batch.
- **Test granularity:** Each task adds or verifies tests; all pass before commit.
- **No skipping manual QA:** Tasks 16/21 include manual browser checks — do them even if typecheck is green. The Sidebar/SettingsDialog UX is not covered by Vitest.
- **Rollback:** Spec §6.2 step 4 has the full rollback procedure — revert frontend FIRST, then drop DB objects. Do not skip the order.
