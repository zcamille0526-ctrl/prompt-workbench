# 智能提示词工作台 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared prompt management web app where a small team can store, categorize, search, and reuse prompt templates with variable substitution.

**Architecture:** React SPA with Vercel Serverless Functions as a secure proxy to Supabase PostgreSQL. Password authentication via serverless function, no user accounts. Three-column layout: category nav, prompt list, detail/edit panel.

**Tech Stack:** React, TypeScript, Radix UI, Tailwind CSS, Zod, Supabase (PostgreSQL + Realtime), Vercel Serverless Functions

**Spec:** `docs/superpowers/specs/2026-04-30-prompt-workbench-design.md`

---

## File Structure

```
prompt-workbench/
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
├── vite.config.ts
├── vercel.json
├── .env.local                          # Local dev env vars (not committed)
├── .env.example                        # Template for env vars
├── .gitignore
│
├── api/                                # Vercel Serverless Functions
│   ├── verify.ts                       # Password verification, returns session token
│   └── prompts.ts                      # CRUD proxy to Supabase (GET/POST/PUT/DELETE)
│
├── src/
│   ├── main.tsx                        # React entry point
│   ├── App.tsx                         # Root component, auth gate + layout
│   │
│   ├── lib/
│   │   ├── constants.ts                # Categories array, API base URL
│   │   ├── schemas.ts                  # Zod schemas for Prompt, Variable
│   │   ├── api.ts                      # Fetch wrapper for serverless functions
│   │   ├── variables.ts                # Parse {{var}} from content, substitute values
│   │   └── supabase.ts                 # Supabase client for Realtime subscriptions
│   │
│   ├── hooks/
│   │   ├── useAuth.ts                  # Auth state (sessionStorage token)
│   │   ├── usePrompts.ts               # Fetch, create, update, delete prompts
│   │   └── useRealtimePrompts.ts       # Supabase Realtime subscription
│   │
│   ├── components/
│   │   ├── PasswordGate.tsx            # Password input page
│   │   ├── Layout.tsx                  # Three-column responsive shell
│   │   ├── Sidebar.tsx                 # Left: category nav + search + export
│   │   ├── PromptList.tsx              # Middle: filtered prompt cards
│   │   ├── PromptDetail.tsx            # Right: view prompt, variable form, copy
│   │   ├── PromptForm.tsx              # Dialog: create/edit prompt form
│   │   └── ConfirmDialog.tsx           # Reusable delete confirmation dialog
│   │
│   └── index.css                       # Tailwind directives + global styles
│
├── supabase/
│   └── migrations/
│       └── 001_create_prompts.sql      # DDL for prompts table + RLS policies
│
└── tests/
    ├── lib/
    │   ├── schemas.test.ts             # Zod schema validation tests
    │   └── variables.test.ts           # Variable parsing + substitution tests
    └── api/
        ├── verify.test.ts              # Password verification tests
        └── prompts.test.ts             # CRUD proxy tests
```

---

## Chunk 1: Project Scaffolding + Database + Auth

### Task 1: Initialize project

**Files:**
- Create: `prompt-workbench/package.json`
- Create: `prompt-workbench/tsconfig.json`
- Create: `prompt-workbench/vite.config.ts`
- Create: `prompt-workbench/tailwind.config.ts`
- Create: `prompt-workbench/postcss.config.js`
- Create: `prompt-workbench/.gitignore`
- Create: `prompt-workbench/.env.example`
- Create: `prompt-workbench/vercel.json`
- Create: `prompt-workbench/src/main.tsx`
- Create: `prompt-workbench/src/index.css`

- [ ] **Step 1: Create project directory and initialize**

```bash
mkdir -p prompt-workbench && cd prompt-workbench
npm create vite@latest . -- --template react-ts
```

Select React + TypeScript when prompted.

- [ ] **Step 2: Install dependencies**

```bash
cd prompt-workbench
npm install @radix-ui/react-dialog @radix-ui/react-select @radix-ui/react-tabs @radix-ui/react-alert-dialog @supabase/supabase-js zod react-markdown
npm install -D tailwindcss postcss autoprefixer vitest @testing-library/react @testing-library/jest-dom jsdom
```

- [ ] **Step 3: Configure Tailwind CSS**

Create `prompt-workbench/postcss.config.js`:
```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

Create `prompt-workbench/tailwind.config.ts`:
```ts
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
```

Replace `prompt-workbench/src/index.css` with:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 4: Configure Vitest**

Add to `prompt-workbench/vite.config.ts`:
```ts
/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
  },
});
```

- [ ] **Step 5: Create .env.example and .gitignore**

Create `prompt-workbench/.env.example`:
```
SHARED_PASSWORD=your-shared-password-here
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_ANON_KEY=your-anon-key
VITE_API_BASE_URL=http://localhost:3000
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Ensure `.gitignore` includes:
```
node_modules/
dist/
.env
.env.local
```

- [ ] **Step 6: Create vercel.json**

Create `prompt-workbench/vercel.json`:
```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

- [ ] **Step 7: Verify project builds**

```bash
cd prompt-workbench && npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 8: Commit**

```bash
git add prompt-workbench/
git commit -m "feat: scaffold prompt-workbench project with React, Tailwind, Vitest"
```

---

### Task 2: Database migration

**Files:**
- Create: `prompt-workbench/supabase/migrations/001_create_prompts.sql`

- [ ] **Step 1: Write migration SQL**

Create `prompt-workbench/supabase/migrations/001_create_prompts.sql`:
```sql
create extension if not exists "uuid-ossp";

create table prompts (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  content text not null,
  category text not null,
  tags text[] not null default '{}',
  variables jsonb not null default '[]',
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-update updated_at on row change
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger prompts_updated_at
  before update on prompts
  for each row
  execute function update_updated_at();

-- RLS: deny anon access, only service_role can read/write
alter table prompts enable row level security;

create policy "service_role_all" on prompts
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
```

- [ ] **Step 2: Apply migration to Supabase**

Run this SQL in the Supabase dashboard SQL Editor, or via CLI:
```bash
supabase db push
```

Expected: Table `prompts` created with RLS enabled.

- [ ] **Step 3: Commit**

```bash
git add prompt-workbench/supabase/
git commit -m "feat: add prompts table migration with RLS"
```

---

### Task 3: Zod schemas and constants

**Files:**
- Create: `prompt-workbench/src/lib/constants.ts`
- Create: `prompt-workbench/src/lib/schemas.ts`
- Create: `prompt-workbench/tests/lib/schemas.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `prompt-workbench/tests/lib/schemas.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PromptSchema, VariableSchema } from "../../src/lib/schemas";

describe("VariableSchema", () => {
  it("accepts valid variable", () => {
    const result = VariableSchema.safeParse({ name: "学科", default: "语文" });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = VariableSchema.safeParse({ name: "", default: "" });
    expect(result.success).toBe(false);
  });

  it("accepts variable without default", () => {
    const result = VariableSchema.safeParse({ name: "年级" });
    expect(result.success).toBe(true);
  });
});

describe("PromptSchema", () => {
  it("accepts valid prompt", () => {
    const result = PromptSchema.safeParse({
      title: "测试提示词",
      content: "请梳理{{学科}}的知识点",
      category: "生文",
      tags: ["教育"],
      variables: [{ name: "学科", default: "语文" }],
      created_by: "张三",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing title", () => {
    const result = PromptSchema.safeParse({
      title: "",
      content: "内容",
      category: "生文",
      tags: [],
      variables: [],
      created_by: "张三",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing created_by", () => {
    const result = PromptSchema.safeParse({
      title: "标题",
      content: "内容",
      category: "生文",
      tags: [],
      variables: [],
      created_by: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate variable names", () => {
    const result = PromptSchema.safeParse({
      title: "标题",
      content: "{{x}} {{x}}",
      category: "生文",
      tags: [],
      variables: [{ name: "x" }, { name: "x" }],
      created_by: "张三",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd prompt-workbench && npx vitest run tests/lib/schemas.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement constants**

Create `prompt-workbench/src/lib/constants.ts`:
```ts
export const CATEGORIES = ["生图", "生文", "分析", "开发", "元提示词"] as const;

export type Category = (typeof CATEGORIES)[number];

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "";
```

- [ ] **Step 4: Implement schemas**

Create `prompt-workbench/src/lib/schemas.ts`:
```ts
import { z } from "zod";

export const VariableSchema = z.object({
  name: z.string().min(1, "变量名不能为空"),
  default: z.string().optional(),
});

export type Variable = z.infer<typeof VariableSchema>;

export const PromptSchema = z
  .object({
    title: z.string().min(1, "标题不能为空"),
    content: z.string().min(1, "内容不能为空"),
    category: z.string().min(1, "请选择分类"),
    tags: z.array(z.string()),
    variables: z.array(VariableSchema),
    created_by: z.string().min(1, "创建人不能为空"),
  })
  .refine(
    (data) => {
      const names = data.variables.map((v) => v.name);
      return new Set(names).size === names.length;
    },
    { message: "变量名不能重复" }
  );

export type PromptInput = z.infer<typeof PromptSchema>;

export interface Prompt {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  variables: Variable[];
  created_by: string;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd prompt-workbench && npx vitest run tests/lib/schemas.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add prompt-workbench/src/lib/constants.ts prompt-workbench/src/lib/schemas.ts prompt-workbench/tests/lib/schemas.test.ts
git commit -m "feat: add Zod schemas and constants for prompts"
```

---

### Task 4: Variable parsing and substitution

**Files:**
- Create: `prompt-workbench/src/lib/variables.ts`
- Create: `prompt-workbench/tests/lib/variables.test.ts`

- [ ] **Step 1: Write failing tests**

Create `prompt-workbench/tests/lib/variables.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { extractVariables, substituteVariables } from "../../src/lib/variables";

describe("extractVariables", () => {
  it("extracts variable names from content", () => {
    const result = extractVariables("请梳理{{学科}}{{年级}}的知识点");
    expect(result).toEqual(["学科", "年级"]);
  });

  it("returns empty array for no variables", () => {
    const result = extractVariables("没有变量的文本");
    expect(result).toEqual([]);
  });

  it("deduplicates variable names", () => {
    const result = extractVariables("{{x}} and {{x}} again");
    expect(result).toEqual(["x"]);
  });
});

describe("substituteVariables", () => {
  it("replaces variables with values", () => {
    const result = substituteVariables("请梳理{{学科}}{{年级}}的知识点", {
      学科: "语文",
      年级: "八年级",
    });
    expect(result).toBe("请梳理语文八年级的知识点");
  });

  it("leaves unmatched variables as-is", () => {
    const result = substituteVariables("{{a}} and {{b}}", { a: "hello" });
    expect(result).toBe("hello and {{b}}");
  });

  it("handles empty values map", () => {
    const result = substituteVariables("{{x}}", {});
    expect(result).toBe("{{x}}");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd prompt-workbench && npx vitest run tests/lib/variables.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement variables.ts**

Create `prompt-workbench/src/lib/variables.ts`:
```ts
export function extractVariables(content: string): string[] {
  const matches = content.match(/\{\{([^}]+)\}\}/g);
  if (!matches) return [];
  const names = matches.map((m) => m.slice(2, -2));
  return [...new Set(names)];
}

export function substituteVariables(
  content: string,
  values: Record<string, string>
): string {
  return content.replace(/\{\{([^}]+)\}\}/g, (match, name) => {
    return name in values ? values[name] : match;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd prompt-workbench && npx vitest run tests/lib/variables.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add prompt-workbench/src/lib/variables.ts prompt-workbench/tests/lib/variables.test.ts
git commit -m "feat: add variable extraction and substitution utilities"
```

---

### Task 5: Serverless function — password verification

**Files:**
- Create: `prompt-workbench/api/verify.ts`
- Create: `prompt-workbench/tests/api/verify.test.ts`

- [ ] **Step 1: Write failing tests**

Create `prompt-workbench/tests/api/verify.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";

vi.stubEnv("SHARED_PASSWORD", "test-password-123");

const { handler, verifyToken } = await import("../../api/verify");

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/verify", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("verify handler", () => {
  it("returns token for correct password", async () => {
    const req = makeRequest({ password: "test-password-123" });
    const res = await handler(req);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.token).toBeDefined();
    expect(typeof data.token).toBe("string");
  });

  it("returns 401 for wrong password", async () => {
    const req = makeRequest({ password: "wrong" });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing password", async () => {
    const req = makeRequest({});
    const res = await handler(req);
    expect(res.status).toBe(400);
  });
});

describe("verifyToken", () => {
  it("verifies a token it issued", async () => {
    const req = makeRequest({ password: "test-password-123" });
    const res = await handler(req);
    const data = await res.json();
    expect(verifyToken(data.token)).toBe(true);
  });

  it("rejects a tampered token", () => {
    expect(verifyToken("invalid.token")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd prompt-workbench && npx vitest run tests/api/verify.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement verify.ts**

Create `prompt-workbench/api/verify.ts`:
```ts
import crypto from "node:crypto";

export const config = { runtime: "edge" };

const SECRET = process.env.SHARED_PASSWORD!;

function signToken(): string {
  const payload = JSON.stringify({ exp: Date.now() + 24 * 60 * 60 * 1000 });
  const encoded = Buffer.from(payload).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifyToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [encoded, sig] = parts;
  const expectedSig = crypto
    .createHmac("sha256", SECRET)
    .update(encoded)
    .digest("base64url");
  if (sig !== expectedSig) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
    return payload.exp > Date.now();
  } catch {
    return false;
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
    });
  }

  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
    });
  }

  if (!body.password) {
    return new Response(JSON.stringify({ error: "Password required" }), {
      status: 400,
    });
  }

  const expected = process.env.SHARED_PASSWORD;
  if (!expected) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500,
    });
  }

  const pwBuf = Buffer.from(body.password);
  const expBuf = Buffer.from(expected);
  if (pwBuf.length !== expBuf.length || !crypto.timingSafeEqual(pwBuf, expBuf)) {
    return new Response(JSON.stringify({ error: "Invalid password" }), {
      status: 401,
    });
  }

  const token = signToken();
  return new Response(JSON.stringify({ token }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export default handler;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd prompt-workbench && npx vitest run tests/api/verify.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add prompt-workbench/api/verify.ts prompt-workbench/tests/api/verify.test.ts
git commit -m "feat: add password verification serverless function with HMAC tokens"
```

---

### Task 6: Serverless function — CRUD proxy

**Files:**
- Create: `prompt-workbench/api/prompts.ts`
- Create: `prompt-workbench/tests/api/prompts.test.ts`

- [ ] **Step 1: Write failing tests**

Create `prompt-workbench/tests/api/prompts.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.stubEnv("SHARED_PASSWORD", "test-password-123");
vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

const mockFrom = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: mockFrom }),
}));

const { handler: verifyHandler } = await import("../../api/verify");
const { handler } = await import("../../api/prompts");

let token: string;

beforeEach(async () => {
  const req = new Request("http://localhost/api/verify", {
    method: "POST",
    body: JSON.stringify({ password: "test-password-123" }),
    headers: { "content-type": "application/json" },
  });
  const res = await verifyHandler(req);
  const data = await res.json();
  token = data.token;
  mockFrom.mockReset();
});

describe("prompts handler", () => {
  it("returns 401 without token", async () => {
    const req = new Request("http://localhost/api/prompts", {
      method: "GET",
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const req = new Request("http://localhost/api/prompts", {
      method: "GET",
      headers: { authorization: "Bearer invalid-token" },
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it("calls supabase select on GET with valid token", async () => {
    const mockSelect = vi.fn().mockReturnValue({
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    });
    mockFrom.mockReturnValue({ select: mockSelect });

    const req = new Request("http://localhost/api/prompts", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(mockFrom).toHaveBeenCalledWith("prompts");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd prompt-workbench && npx vitest run tests/api/prompts.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement prompts.ts**

Create `prompt-workbench/api/prompts.ts`:
```ts
import { createClient } from "@supabase/supabase-js";
import { verifyToken } from "./verify";
import { PromptSchema } from "../src/lib/schemas";

export const config = { runtime: "edge" };

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function authenticate(req: Request): boolean {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return verifyToken(auth.slice(7));
}

export async function handler(req: Request): Promise<Response> {
  if (!authenticate(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("prompts")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
      });
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "POST") {
    const body = await req.json();
    const parsed = PromptSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400 }
      );
    }
    const { data, error } = await supabase
      .from("prompts")
      .insert(parsed.data)
      .select()
      .single();
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
      });
    }
    return new Response(JSON.stringify(data), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "PUT" && id) {
    const body = await req.json();
    const parsed = PromptSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: parsed.error.issues[0].message }),
        { status: 400 }
      );
    }
    const { data, error } = await supabase
      .from("prompts")
      .update(parsed.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
      });
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "DELETE" && id) {
    const { error } = await supabase.from("prompts").delete().eq("id", id);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
  });
}

export default handler;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd prompt-workbench && npx vitest run tests/api/prompts.test.ts
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add prompt-workbench/api/prompts.ts prompt-workbench/tests/api/prompts.test.ts
git commit -m "feat: add CRUD proxy serverless function for prompts"
```

---

### Task 7: Frontend API client and auth hook

**Files:**
- Create: `prompt-workbench/src/lib/api.ts`
- Create: `prompt-workbench/src/hooks/useAuth.ts`

- [ ] **Step 1: Implement API client**

Create `prompt-workbench/src/lib/api.ts`:
```ts
import { API_BASE_URL } from "./constants";

class ApiClient {
  private token: string | null = null;

  setToken(token: string) {
    this.token = token;
    sessionStorage.setItem("auth_token", token);
  }

  getToken(): string | null {
    if (!this.token) {
      this.token = sessionStorage.getItem("auth_token");
    }
    return this.token;
  }

  clearToken() {
    this.token = null;
    sessionStorage.removeItem("auth_token");
  }

  async verify(password: string): Promise<boolean> {
    const res = await fetch(`${API_BASE_URL}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    this.setToken(data.token);
    return true;
  }

  async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = this.getToken();
    if (!token) throw new Error("Not authenticated");

    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        ...options.headers,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });

    if (res.status === 401) {
      this.clearToken();
      throw new Error("Session expired");
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Request failed");
    }

    return res.json();
  }
}

export const api = new ApiClient();
```

- [ ] **Step 2: Implement useAuth hook**

Create `prompt-workbench/src/hooks/useAuth.ts`:
```ts
import { useState, useCallback } from "react";
import { api } from "../lib/api";

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(
    () => !!api.getToken()
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (password: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const success = await api.verify(password);
      if (success) {
        setIsAuthenticated(true);
      } else {
        setError("密码错误");
      }
    } catch {
      setError("验证失败，请重试");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    api.clearToken();
    setIsAuthenticated(false);
  }, []);

  return { isAuthenticated, isLoading, error, login, logout };
}
```

- [ ] **Step 3: Verify build**

```bash
cd prompt-workbench && npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add prompt-workbench/src/lib/api.ts prompt-workbench/src/hooks/useAuth.ts
git commit -m "feat: add API client and auth hook"
```

---

## Chunk 2: Frontend UI Components

### Task 8: usePrompts hook

**Files:**
- Create: `prompt-workbench/src/hooks/usePrompts.ts`

- [ ] **Step 1: Implement usePrompts hook**

Create `prompt-workbench/src/hooks/usePrompts.ts`:
```ts
import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { Prompt, PromptInput } from "../lib/schemas";

export function usePrompts() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPrompts = useCallback(async () => {
    try {
      const data = await api.request<Prompt[]>("/api/prompts");
      setPrompts(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrompts();
  }, [fetchPrompts]);

  const createPrompt = useCallback(async (input: PromptInput) => {
    const data = await api.request<Prompt>("/api/prompts", {
      method: "POST",
      body: JSON.stringify(input),
    });
    setPrompts((prev) => [data, ...prev]);
    return data;
  }, []);

  const updatePrompt = useCallback(async (id: string, input: PromptInput) => {
    const data = await api.request<Prompt>(`/api/prompts?id=${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    setPrompts((prev) => prev.map((p) => (p.id === id ? data : p)));
    return data;
  }, []);

  const deletePrompt = useCallback(async (id: string) => {
    await api.request(`/api/prompts?id=${id}`, { method: "DELETE" });
    setPrompts((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return {
    prompts,
    isLoading,
    error,
    fetchPrompts,
    createPrompt,
    updatePrompt,
    deletePrompt,
  };
}
```

- [ ] **Step 2: Verify build**

```bash
cd prompt-workbench && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add prompt-workbench/src/hooks/usePrompts.ts
git commit -m "feat: add usePrompts hook for CRUD operations"
```

---

### Task 9: PasswordGate component

**Files:**
- Create: `prompt-workbench/src/components/PasswordGate.tsx`

- [ ] **Step 1: Implement PasswordGate**

Create `prompt-workbench/src/components/PasswordGate.tsx`:
```tsx
import { useState } from "react";

interface Props {
  onLogin: (password: string) => Promise<void>;
  isLoading: boolean;
  error: string | null;
}

export function PasswordGate({ onLogin, isLoading, error }: Props) {
  const [password, setPassword] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.trim()) {
      onLogin(password);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <form
        onSubmit={handleSubmit}
        className="bg-white p-8 rounded-lg shadow-md w-full max-w-sm"
      >
        <h1 className="text-xl font-semibold text-gray-900 mb-6 text-center">
          提示词工作台
        </h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="请输入访问密码"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
          autoFocus
        />
        {error && (
          <p className="text-red-500 text-sm mb-4">{error}</p>
        )}
        <button
          type="submit"
          disabled={isLoading || !password.trim()}
          className="w-full py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? "验证中..." : "进入"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd prompt-workbench && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add prompt-workbench/src/components/PasswordGate.tsx
git commit -m "feat: add PasswordGate component"
```

---

### Task 10: Sidebar component

**Files:**
- Create: `prompt-workbench/src/components/Sidebar.tsx`

- [ ] **Step 1: Implement Sidebar**

Create `prompt-workbench/src/components/Sidebar.tsx`:
```tsx
import { CATEGORIES } from "../lib/constants";

interface Props {
  selectedCategory: string | null;
  onSelectCategory: (category: string | null) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onExport: () => void;
  onNewPrompt: () => void;
  selectedTag: string | null;
  onClearTag: () => void;
}

export function Sidebar({
  selectedCategory,
  onSelectCategory,
  searchQuery,
  onSearchChange,
  onExport,
  onNewPrompt,
  selectedTag,
  onClearTag,
}: Props) {
  return (
    <aside className="w-56 border-r border-gray-200 bg-gray-50 flex flex-col h-full">
      <div className="p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          提示词工作台
        </h2>
        <label className="sr-only" htmlFor="search-input">搜索</label>
        <input
          id="search-input"
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索..."
          className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
        />
        <button
          onClick={onNewPrompt}
          className="w-full py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 mb-4"
        >
          + 新建提示词
        </button>
      </div>

      {selectedTag && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-1 text-xs">
            <span className="bg-blue-100 text-blue-700 rounded px-2 py-0.5">
              标签：{selectedTag}
            </span>
            <button
              onClick={onClearTag}
              className="text-gray-400 hover:text-gray-600"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <nav className="flex-1 px-2">
        <button
          onClick={() => onSelectCategory(null)}
          className={`w-full text-left px-3 py-1.5 text-sm rounded-md mb-1 ${
            selectedCategory === null
              ? "bg-blue-100 text-blue-700"
              : "text-gray-700 hover:bg-gray-100"
          }`}
        >
          全部
        </button>
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => onSelectCategory(cat)}
            className={`w-full text-left px-3 py-1.5 text-sm rounded-md mb-1 ${
              selectedCategory === cat
                ? "bg-blue-100 text-blue-700"
                : "text-gray-700 hover:bg-gray-100"
            }`}
          >
            {cat}
          </button>
        ))}
      </nav>
      <div className="p-4 border-t border-gray-200">
        <button
          onClick={onExport}
          className="w-full py-1.5 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-100"
        >
          导出数据
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd prompt-workbench && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add prompt-workbench/src/components/Sidebar.tsx
git commit -m "feat: add Sidebar component with category nav and search"
```

---

### Task 11: PromptList component

**Files:**
- Create: `prompt-workbench/src/components/PromptList.tsx`

- [ ] **Step 1: Implement PromptList**

Create `prompt-workbench/src/components/PromptList.tsx`:
```tsx
import type { Prompt } from "../lib/schemas";

interface Props {
  prompts: Prompt[];
  selectedId: string | null;
  onSelect: (prompt: Prompt) => void;
  onTagClick: (tag: string) => void;
}

export function PromptList({ prompts, selectedId, onSelect, onTagClick }: Props) {
  if (prompts.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        暂无提示词
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {prompts.map((prompt) => (
        <button
          key={prompt.id}
          onClick={() => onSelect(prompt)}
          className={`w-full text-left p-3 border-b border-gray-100 hover:bg-gray-50 ${
            selectedId === prompt.id ? "bg-blue-50" : ""
          }`}
        >
          <div className="font-medium text-sm text-gray-900 truncate">
            {prompt.title}
          </div>
          <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-1">
            <span className="inline-block bg-gray-100 rounded px-1.5 py-0.5">
              {prompt.category}
            </span>
            {prompt.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                onClick={(e) => {
                  e.stopPropagation();
                  onTagClick(tag);
                }}
                className="inline-block bg-gray-100 rounded px-1.5 py-0.5 hover:bg-blue-100 hover:text-blue-700 cursor-pointer"
              >
                {tag}
              </span>
            ))}
          </div>
          <div className="text-xs text-gray-400 mt-1 truncate">
            {prompt.content.length > 60
              ? `${prompt.content.slice(0, 60)}...`
              : prompt.content}
          </div>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd prompt-workbench && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add prompt-workbench/src/components/PromptList.tsx
git commit -m "feat: add PromptList component"
```

---

### Task 12: PromptDetail component (view + variable substitution + copy)

**Files:**
- Create: `prompt-workbench/src/components/PromptDetail.tsx`

- [ ] **Step 1: Implement PromptDetail**

Create `prompt-workbench/src/components/PromptDetail.tsx`:
```tsx
import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Prompt } from "../lib/schemas";
import { extractVariables, substituteVariables } from "../lib/variables";

interface Props {
  prompt: Prompt;
  onEdit: () => void;
  onDelete: () => void;
}

export function PromptDetail({ prompt, onEdit, onDelete }: Props) {
  const variables = useMemo(
    () => extractVariables(prompt.content),
    [prompt.content]
  );
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const v of prompt.variables) {
      init[v.name] = v.default || "";
    }
    return init;
  });
  const [copied, setCopied] = useState(false);

  const finalContent = useMemo(
    () => substituteVariables(prompt.content, values),
    [prompt.content, values]
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(finalContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = finalContent;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            {prompt.title}
          </h2>
          <div className="flex gap-1 mt-1">
            <span className="text-xs bg-blue-100 text-blue-700 rounded px-2 py-0.5">
              {prompt.category}
            </span>
            {prompt.tags.map((tag) => (
              <span
                key={tag}
                className="text-xs bg-gray-100 text-gray-600 rounded px-2 py-0.5"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onEdit}
            className="text-sm px-3 py-1 border border-gray-300 rounded-md hover:bg-gray-50"
          >
            编辑
          </button>
          <button
            onClick={onDelete}
            className="text-sm px-3 py-1 border border-red-300 text-red-600 rounded-md hover:bg-red-50"
          >
            删除
          </button>
        </div>
      </div>

      {variables.length > 0 && (
        <div className="bg-gray-50 rounded-lg p-4 mb-4">
          <h3 className="text-sm font-medium text-gray-700 mb-2">变量填写</h3>
          <div className="grid grid-cols-2 gap-2">
            {variables.map((name) => (
              <div key={name}>
                <label className="text-xs text-gray-500">{name}</label>
                <input
                  type="text"
                  value={values[name] || ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [name]: e.target.value }))
                  }
                  className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                  placeholder={
                    prompt.variables.find((v) => v.name === name)?.default || ""
                  }
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="prose prose-sm max-w-none mb-4">
        <ReactMarkdown>{finalContent}</ReactMarkdown>
      </div>

      <button
        onClick={handleCopy}
        className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700"
      >
        {copied ? "已复制" : "复制提示词"}
      </button>

      <div className="mt-4 text-xs text-gray-400">
        创建人：{prompt.created_by} · 更新于{" "}
        {new Date(prompt.updated_at).toLocaleDateString("zh-CN")}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd prompt-workbench && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add prompt-workbench/src/components/PromptDetail.tsx
git commit -m "feat: add PromptDetail with variable substitution and copy"
```

---

### Task 13: ConfirmDialog component

**Files:**
- Create: `prompt-workbench/src/components/ConfirmDialog.tsx`

- [ ] **Step 1: Implement ConfirmDialog**

Create `prompt-workbench/src/components/ConfirmDialog.tsx`:
```tsx
import * as AlertDialog from "@radix-ui/react-alert-dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
}: Props) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg p-6 w-full max-w-sm shadow-lg">
          <AlertDialog.Title className="text-lg font-semibold">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-gray-500 mt-2">
            {description}
          </AlertDialog.Description>
          <div className="flex justify-end gap-2 mt-4">
            <AlertDialog.Cancel className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50">
              取消
            </AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={onConfirm}
              className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700"
            >
              确认删除
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd prompt-workbench && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add prompt-workbench/src/components/ConfirmDialog.tsx
git commit -m "feat: add ConfirmDialog component"
```

---

### Task 14: PromptForm dialog (create/edit)

**Files:**
- Create: `prompt-workbench/src/components/PromptForm.tsx`

- [ ] **Step 1: Implement PromptForm**

Create `prompt-workbench/src/components/PromptForm.tsx`:
```tsx
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CATEGORIES } from "../lib/constants";
import { PromptSchema } from "../lib/schemas";
import type { Prompt, PromptInput, Variable } from "../lib/schemas";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: PromptInput) => Promise<void>;
  initial?: Prompt;
}

export function PromptForm({ open, onOpenChange, onSubmit, initial }: Props) {
  const [title, setTitle] = useState(initial?.title || "");
  const [content, setContent] = useState(initial?.content || "");
  const [category, setCategory] = useState(initial?.category || "");
  const [tagsInput, setTagsInput] = useState(
    initial?.tags.join(", ") || ""
  );
  const [variables, setVariables] = useState<Variable[]>(
    initial?.variables || []
  );
  const [createdBy, setCreatedBy] = useState(initial?.created_by || "");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const addVariable = () => {
    setVariables((prev) => [...prev, { name: "", default: "" }]);
  };

  const removeVariable = (index: number) => {
    setVariables((prev) => prev.filter((_, i) => i !== index));
  };

  const updateVariable = (
    index: number,
    field: "name" | "default",
    value: string
  ) => {
    setVariables((prev) =>
      prev.map((v, i) => (i === index ? { ...v, [field]: value } : v))
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const tags = tagsInput
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);

    const data = {
      title,
      content,
      category,
      tags,
      variables: variables.filter((v) => v.name.trim()),
      created_by: createdBy,
    };

    const parsed = PromptSchema.safeParse(data);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit(parsed.data);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-lg">
          <Dialog.Title className="text-lg font-semibold mb-4">
            {initial ? "编辑提示词" : "新建提示词"}
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm text-gray-700">标题</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md mt-1"
              />
            </div>

            <div>
              <label className="text-sm text-gray-700">分类</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md mt-1"
              >
                <option value="">请选择</option>
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm text-gray-700">
                标签（逗号分隔）
              </label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="如：儿童, 科普, 绘本"
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md mt-1"
              />
            </div>

            <div>
              <label className="text-sm text-gray-700">
                内容（支持 Markdown，用 {"{{变量名}}"} 定义变量）
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={12}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md mt-1 font-mono"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-gray-700">变量定义</label>
                <button
                  type="button"
                  onClick={addVariable}
                  className="text-xs text-blue-600 hover:text-blue-700"
                >
                  + 添加变量
                </button>
              </div>
              {variables.map((v, i) => (
                <div key={i} className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={v.name}
                    onChange={(e) => updateVariable(i, "name", e.target.value)}
                    placeholder="变量名"
                    className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded"
                  />
                  <input
                    type="text"
                    value={v.default || ""}
                    onChange={(e) =>
                      updateVariable(i, "default", e.target.value)
                    }
                    placeholder="默认值（可选）"
                    className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded"
                  />
                  <button
                    type="button"
                    onClick={() => removeVariable(i)}
                    className="text-red-500 text-sm px-2 hover:text-red-700"
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>

            <div>
              <label className="text-sm text-gray-700">创建人</label>
              <input
                type="text"
                value={createdBy}
                onChange={(e) => setCreatedBy(e.target.value)}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md mt-1"
              />
            </div>

            {error && <p className="text-red-500 text-sm">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <Dialog.Close className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50">
                取消
              </Dialog.Close>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {isSubmitting ? "保存中..." : "保存"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd prompt-workbench && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add prompt-workbench/src/components/PromptForm.tsx
git commit -m "feat: add PromptForm dialog for create/edit"
```

---

## Chunk 3: Layout, App Integration, and Export

### Task 15: Layout component

**Files:**
- Create: `prompt-workbench/src/components/Layout.tsx`

- [ ] **Step 1: Implement Layout**

Create `prompt-workbench/src/components/Layout.tsx`:
```tsx
import { ReactNode, useState } from "react";

interface Props {
  sidebar: ReactNode;
  list: ReactNode;
  detail: ReactNode;
}

export function Layout({ sidebar, list, detail }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="h-screen flex overflow-hidden">
      {/* Mobile hamburger */}
      <button
        onClick={() => setSidebarOpen(true)}
        className="md:hidden fixed top-3 left-3 z-30 p-2 bg-white border border-gray-200 rounded-md shadow-sm"
        aria-label="打开导航"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Sidebar overlay for mobile */}
      {sidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/40 z-40"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed md:static z-50 h-full transition-transform md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div onClick={() => setSidebarOpen(false)}>{sidebar}</div>
      </div>

      {/* List */}
      <div className="w-full md:w-72 border-r border-gray-200 flex flex-col">
        <div className="md:hidden h-12" /> {/* spacer for hamburger */}
        {list}
      </div>

      {/* Detail */}
      <div className="hidden md:flex flex-1 flex-col">{detail}</div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
cd prompt-workbench && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add prompt-workbench/src/components/Layout.tsx
git commit -m "feat: add Layout component with three-column structure"
```

---

### Task 16: App component — wire everything together

**Files:**
- Create: `prompt-workbench/src/App.tsx`
- Modify: `prompt-workbench/src/main.tsx`

- [ ] **Step 1: Implement App.tsx**

Create `prompt-workbench/src/App.tsx`:
```tsx
import { useState, useMemo, useCallback } from "react";
import { useAuth } from "./hooks/useAuth";
import { usePrompts } from "./hooks/usePrompts";
import { useRealtimePrompts } from "./hooks/useRealtimePrompts";
import { PasswordGate } from "./components/PasswordGate";
import { Layout } from "./components/Layout";
import { Sidebar } from "./components/Sidebar";
import { PromptList } from "./components/PromptList";
import { PromptDetail } from "./components/PromptDetail";
import { PromptForm } from "./components/PromptForm";
import { ConfirmDialog } from "./components/ConfirmDialog";
import type { Prompt, PromptInput } from "./lib/schemas";

function AuthenticatedApp() {
  const {
    prompts,
    isLoading,
    fetchPrompts,
    createPrompt,
    updatePrompt,
    deletePrompt,
  } = usePrompts();

  useRealtimePrompts(fetchPrompts);

  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<Prompt | undefined>();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const filteredPrompts = useMemo(() => {
    let result = prompts;
    if (selectedCategory) {
      result = result.filter((p) => p.category === selectedCategory);
    }
    if (selectedTag) {
      result = result.filter((p) => p.tags.includes(selectedTag));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.content.toLowerCase().includes(q)
      );
    }
    return result;
  }, [prompts, selectedCategory, selectedTag, searchQuery]);

  const handleTagClick = useCallback((tag: string) => {
    setSelectedTag((prev) => (prev === tag ? null : tag));
  }, []);

  const handleExport = useCallback(() => {
    const blob = new Blob([JSON.stringify(prompts, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `prompts-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [prompts]);

  const handleNewPrompt = () => {
    setEditingPrompt(undefined);
    setFormOpen(true);
  };

  const handleEdit = () => {
    setEditingPrompt(selectedPrompt || undefined);
    setFormOpen(true);
  };

  const handleFormSubmit = async (data: PromptInput) => {
    if (editingPrompt) {
      const updated = await updatePrompt(editingPrompt.id, data);
      setSelectedPrompt(updated);
    } else {
      const created = await createPrompt(data);
      setSelectedPrompt(created);
    }
  };

  const handleDeleteConfirm = async () => {
    if (selectedPrompt) {
      await deletePrompt(selectedPrompt.id);
      setSelectedPrompt(null);
      setDeleteOpen(false);
    }
  };

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center text-gray-400">
        加载中...
      </div>
    );
  }

  return (
    <>
      <Layout
        sidebar={
          <Sidebar
            selectedCategory={selectedCategory}
            onSelectCategory={(cat) => {
              setSelectedCategory(cat);
              setSelectedTag(null);
            }}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onExport={handleExport}
            onNewPrompt={handleNewPrompt}
            selectedTag={selectedTag}
            onClearTag={() => setSelectedTag(null)}
          />
        }
        list={
          <PromptList
            prompts={filteredPrompts}
            selectedId={selectedPrompt?.id || null}
            onSelect={setSelectedPrompt}
            onTagClick={handleTagClick}
          />
        }
        detail={
          selectedPrompt ? (
            <PromptDetail
              key={selectedPrompt.id}
              prompt={selectedPrompt}
              onEdit={handleEdit}
              onDelete={() => setDeleteOpen(true)}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
              选择一个提示词查看详情
            </div>
          )
        }
      />

      <PromptForm
        key={editingPrompt?.id ?? "new"}
        open={formOpen}
        onOpenChange={setFormOpen}
        onSubmit={handleFormSubmit}
        initial={editingPrompt}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="删除提示词"
        description={`确定要删除「${selectedPrompt?.title}」吗？此操作不可撤销。`}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}

export default function App() {
  const { isAuthenticated, isLoading, error, login } = useAuth();

  if (!isAuthenticated) {
    return (
      <PasswordGate onLogin={login} isLoading={isLoading} error={error} />
    );
  }

  return <AuthenticatedApp />;
}
}
```

- [ ] **Step 2: Update main.tsx**

Replace `prompt-workbench/src/main.tsx` with:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 3: Verify build**

```bash
cd prompt-workbench && npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add prompt-workbench/src/App.tsx prompt-workbench/src/main.tsx
git commit -m "feat: wire up App with all components and state management"
```

---

### Task 17: Supabase Realtime subscription

**Files:**
- Create: `prompt-workbench/src/lib/supabase.ts`
- Create: `prompt-workbench/src/hooks/useRealtimePrompts.ts`

Note: App.tsx (Task 16) already imports and uses these modules. Create the files here.

Note: Supabase Realtime requires the anon role to have SELECT permission on the prompts table. Add this RLS policy alongside the existing service_role policy in the migration, or add it manually in the Supabase dashboard:
```sql
create policy "anon_select" on prompts for select using (true);
```

- [ ] **Step 1: Implement Supabase client**

Create `prompt-workbench/src/lib/supabase.ts`:
```ts
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && key ? createClient(url, key) : null;
```

- [ ] **Step 2: Implement useRealtimePrompts hook**

Create `prompt-workbench/src/hooks/useRealtimePrompts.ts`:
```ts
import { useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";

export function useRealtimePrompts(onUpdate: () => void) {
  const callbackRef = useRef(onUpdate);
  callbackRef.current = onUpdate;

  useEffect(() => {
    if (!supabase) return;

    const channel = supabase
      .channel("prompts-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "prompts" },
        () => {
          callbackRef.current();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);
}
```

- [ ] **Step 3: Verify build**

```bash
cd prompt-workbench && npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add prompt-workbench/src/lib/supabase.ts prompt-workbench/src/hooks/useRealtimePrompts.ts
git commit -m "feat: add Supabase Realtime subscription for live updates"
```

---

### Task 18: End-to-end manual test

- [ ] **Step 1: Set up environment**

Copy `.env.example` to `.env.local` and fill in real values:
```bash
cd prompt-workbench && cp .env.example .env.local
```

Edit `.env.local` with your Supabase project URL, keys, and shared password.

- [ ] **Step 2: Install Vercel CLI for local dev**

```bash
cd prompt-workbench && npm install -D vercel
```

- [ ] **Step 3: Run the Supabase migration**

Execute the SQL in `supabase/migrations/001_create_prompts.sql` in the Supabase dashboard SQL Editor. Also add the anon SELECT policy for Realtime:
```sql
create policy "anon_select" on prompts for select using (true);
```

- [ ] **Step 4: Start dev server**

```bash
cd prompt-workbench && npx vercel dev
```

This serves both the Vite frontend and the serverless functions under `/api/*`.

- [ ] **Step 5: Test password gate**

Open `http://localhost:3000` in browser.
Expected: Password input page shows. Wrong password shows error. Correct password enters main interface.

- [ ] **Step 5: Test CRUD flow**

1. Click "新建提示词" → fill form → save → appears in list
2. Click the new prompt → detail shows on right
3. Click "编辑" → modify title → save → title updates
4. Click "删除" → confirm → prompt removed from list

- [ ] **Step 6: Test variable substitution**

1. Create a prompt with content: `请梳理{{学科}}{{年级}}的知识点`
2. Add variables: `学科` (default: 语文), `年级` (default: 八年级)
3. View the prompt → variable form shows → fill values → click "复制提示词"
4. Paste in a text editor → verify variables are substituted

- [ ] **Step 7: Test category filter and search**

1. Create prompts in different categories
2. Click category in sidebar → list filters correctly
3. Type in search box → list filters by keyword

- [ ] **Step 8: Test export**

Click "导出数据" → JSON file downloads with all prompts.

- [ ] **Step 9: Test Realtime sync**

Open two browser tabs at `http://localhost:3000`. In tab A, create a new prompt. Tab B should automatically show the new prompt without refreshing.

- [ ] **Step 10: Commit any fixes**

```bash
cd prompt-workbench && git add src/ api/ && git commit -m "fix: address issues found during manual testing"
```

---

### Task 19: Run all tests

- [ ] **Step 1: Run full test suite**

```bash
cd prompt-workbench && npx vitest run
```

Expected: All tests pass.

- [ ] **Step 2: Final commit if needed**

```bash
cd prompt-workbench && git add src/ api/ tests/ && git commit -m "chore: final cleanup after testing"
```
