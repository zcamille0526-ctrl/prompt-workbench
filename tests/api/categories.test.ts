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
