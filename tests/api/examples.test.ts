import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SHARED_PASSWORD", "test-password-123");
vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

const mockFrom = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: mockFrom }),
}));

const verifyMod = await import("../../api/verify");
const verifyHandler = verifyMod.default;
const examplesMod = await import("../../api/examples");
const examplesHandler = examplesMod.default;

type MockRes = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  statusCode: number;
  body: unknown;
};

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: undefined,
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json.mockImplementation((data: unknown) => {
    res.body = data;
    return res;
  });
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

/**
 * A chainable that records each call and resolves the leaf to `result`.
 * `single()` resolves the same way; `then` makes the chain itself awaitable
 * for the .select().eq().order() pattern that returns directly.
 */
function chain(result: { data?: unknown; error?: unknown; count?: number }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const obj: any = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "order"]) {
    obj[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return obj;
    };
  }
  obj.single = () => Promise.resolve(result);
  obj.then = (fn: any) => Promise.resolve(result).then(fn);
  return { obj, calls };
}

let token: string;
const VALID_PROMPT_ID = "550e8400-e29b-41d4-a716-446655440001";
const VALID_EXAMPLE_ID = "550e8400-e29b-41d4-a716-446655440002";

beforeEach(async () => {
  const verifyReq = makeReq({
    method: "POST",
    body: { password: "test-password-123" },
  });
  const verifyRes = makeRes();
  await verifyHandler(verifyReq, verifyRes as unknown as VercelResponse);
  token = (verifyRes.body as { token: string }).token;
  mockFrom.mockReset();
});

const validBody = {
  prompt_id: VALID_PROMPT_ID,
  title: "测试示例",
  variable_values: { 学科: "语文" },
  model: "deepseek-v4-flash",
  messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ],
  created_by: "alice",
};

describe("examples handler — auth", () => {
  it("returns 401 without token", async () => {
    const req = makeReq({ method: "GET", query: { prompt_id: VALID_PROMPT_ID } });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/examples", () => {
  it("returns 400 when prompt_id is missing", async () => {
    const req = makeReq({ method: "GET", authorization: `Bearer ${token}` });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("returns examples when prompt is published", async () => {
    const parent = chain({ data: { is_draft: false, created_by: "alice" }, error: null });
    const list = chain({ data: [{ id: "e1", prompt_id: VALID_PROMPT_ID }], error: null });
    let n = 0;
    mockFrom.mockImplementation(() => (++n === 1 ? parent.obj : list.obj));

    const req = makeReq({
      method: "GET",
      query: { prompt_id: VALID_PROMPT_ID },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns 403 for draft prompt when viewer is not owner", async () => {
    const parent = chain({ data: { is_draft: true, created_by: "alice" }, error: null });
    mockFrom.mockReturnValueOnce(parent.obj);

    const req = makeReq({
      method: "GET",
      query: { prompt_id: VALID_PROMPT_ID, viewer: "bob" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(403);
  });

  it("returns examples for draft prompt when viewer is owner", async () => {
    const parent = chain({ data: { is_draft: true, created_by: "alice" }, error: null });
    const list = chain({ data: [], error: null });
    let n = 0;
    mockFrom.mockImplementation(() => (++n === 1 ? parent.obj : list.obj));

    const req = makeReq({
      method: "GET",
      query: { prompt_id: VALID_PROMPT_ID, viewer: "alice" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/examples", () => {
  it("creates example when under cap", async () => {
    const parent = chain({ data: { is_draft: false, created_by: "alice" }, error: null });
    const count = chain({ data: null, error: null, count: 2 });
    const insert = chain({ data: { id: "e-new", ...validBody }, error: null });
    let n = 0;
    mockFrom.mockImplementation(() => {
      n++;
      if (n === 1) return parent.obj;
      if (n === 2) return count.obj;
      return insert.obj;
    });

    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: validBody,
    });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(201);
  });

  it("returns 400 when prompt already has 5 examples", async () => {
    const parent = chain({ data: { is_draft: false, created_by: "alice" }, error: null });
    const count = chain({ data: null, error: null, count: 5 });
    let n = 0;
    mockFrom.mockImplementation(() => (++n === 1 ? parent.obj : count.obj));

    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: validBody,
    });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toContain("上限");
  });

  it("returns 403 when adding example to someone else's draft", async () => {
    const parent = chain({ data: { is_draft: true, created_by: "bob" }, error: null });
    mockFrom.mockReturnValueOnce(parent.obj);

    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: validBody, // created_by: "alice"
    });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(403);
  });

  it("returns 400 for invalid body shape", async () => {
    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: { ...validBody, messages: [{ role: "user", content: "x" }] }, // only 1 msg
    });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("returns 400 for unknown body fields (strict)", async () => {
    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: { ...validBody, leaked: true },
    });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/examples", () => {
  it("returns 403 when viewer is neither creator nor prompt owner", async () => {
    const exists = chain({ data: { created_by: "alice", prompt_id: VALID_PROMPT_ID }, error: null });
    const parent = chain({ data: { created_by: "bob" }, error: null });
    let n = 0;
    mockFrom.mockImplementation(() => (++n === 1 ? exists.obj : parent.obj));

    const req = makeReq({
      method: "DELETE",
      query: { id: VALID_EXAMPLE_ID, viewer: "carol" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(403);
  });

  it("allows the example creator to delete", async () => {
    const exists = chain({ data: { created_by: "alice", prompt_id: VALID_PROMPT_ID }, error: null });
    const parent = chain({ data: { created_by: "bob" }, error: null });
    const del = chain({ data: null, error: null });
    let n = 0;
    mockFrom.mockImplementation(() => {
      n++;
      if (n === 1) return exists.obj;
      if (n === 2) return parent.obj;
      return del.obj;
    });

    const req = makeReq({
      method: "DELETE",
      query: { id: VALID_EXAMPLE_ID, viewer: "alice" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
  });

  it("allows the prompt owner to delete someone else's example", async () => {
    const exists = chain({ data: { created_by: "alice", prompt_id: VALID_PROMPT_ID }, error: null });
    const parent = chain({ data: { created_by: "bob" }, error: null });
    const del = chain({ data: null, error: null });
    let n = 0;
    mockFrom.mockImplementation(() => {
      n++;
      if (n === 1) return exists.obj;
      if (n === 2) return parent.obj;
      return del.obj;
    });

    const req = makeReq({
      method: "DELETE",
      query: { id: VALID_EXAMPLE_ID, viewer: "bob" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
  });

  it("returns 403 when viewer is missing", async () => {
    const exists = chain({ data: { created_by: "alice", prompt_id: VALID_PROMPT_ID }, error: null });
    const parent = chain({ data: { created_by: "bob" }, error: null });
    let n = 0;
    mockFrom.mockImplementation(() => (++n === 1 ? exists.obj : parent.obj));

    const req = makeReq({
      method: "DELETE",
      query: { id: VALID_EXAMPLE_ID },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await examplesHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(403);
  });
});
