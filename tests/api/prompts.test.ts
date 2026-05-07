import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SHARED_PASSWORD", "test-password-123");
vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

// A lazy chainable that returns itself for every method until awaited.
// Each test installs mockFrom to return whatever shape it wants per call,
// so we don't need a single one-size-fits-all mock here.
const mockFrom = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: mockFrom }),
}));

const verifyMod = await import("../../api/verify");
const verifyHandler = verifyMod.default;
const promptsMod = await import("../../api/prompts");
const promptsHandler = promptsMod.default;

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
 * Builds a chainable Supabase query mock that resolves to `result` and
 * exposes the recorded calls. Methods (eq, order, single, select, update,
 * delete, insert) return `this` so any call sequence works.
 */
function chain(result: { data?: unknown; error?: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const make = () => {
    const obj: any = {};
    for (const m of ["select", "insert", "update", "delete", "eq", "order"]) {
      obj[m] = (...args: unknown[]) => {
        calls.push({ method: m, args });
        return obj;
      };
    }
    obj.single = () => Promise.resolve(result);
    obj.then = (fn: any) => Promise.resolve(result).then(fn);
    return obj;
  };
  return { obj: make(), calls };
}

let token: string;

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

describe("prompts handler — auth", () => {
  it("returns 401 without token", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const req = makeReq({
      method: "GET",
      authorization: "Bearer invalid-token",
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/prompts — draft filtering", () => {
  it("without viewer, returns only published prompts", async () => {
    const c1 = chain({
      data: [{ id: "1", is_draft: false, created_at: "2026-05-06T00:00:00Z" }],
      error: null,
    });
    mockFrom.mockReturnValue(c1.obj);

    const req = makeReq({ method: "GET", authorization: `Bearer ${token}` });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    // Only one query — published — was issued
    expect(c1.calls.filter((c) => c.method === "eq")).toEqual([
      { method: "eq", args: ["is_draft", false] },
    ]);
  });

  it("with viewer, runs both published query and viewer-draft query", async () => {
    const calls: any[] = [];
    let n = 0;
    mockFrom.mockImplementation(() => {
      n++;
      if (n === 1) {
        const c = chain({
          data: [{ id: "p1", is_draft: false, created_at: "2026-05-06T01:00:00Z" }],
          error: null,
        });
        calls.push(c);
        return c.obj;
      }
      const c = chain({
        data: [{ id: "d1", is_draft: true, created_by: "alice", created_at: "2026-05-06T02:00:00Z" }],
        error: null,
      });
      calls.push(c);
      return c.obj;
    });

    const req = makeReq({
      method: "GET",
      query: { viewer: "alice" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(mockFrom).toHaveBeenCalledTimes(2);
    // Second query filters drafts AND created_by
    const draftEqCalls = calls[1].calls.filter((c: any) => c.method === "eq");
    expect(draftEqCalls).toEqual([
      { method: "eq", args: ["is_draft", true] },
      { method: "eq", args: ["created_by", "alice"] },
    ]);
    // Result is merged & sorted desc: draft (02:00) before published (01:00)
    const body = res.body as any[];
    expect(body.map((p) => p.id)).toEqual(["d1", "p1"]);
  });

  it("rejects viewer with disallowed characters", async () => {
    const req = makeReq({
      method: "GET",
      query: { viewer: "alice'; drop table--" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("accepts Chinese viewer names", async () => {
    const c1 = chain({ data: [], error: null });
    const c2 = chain({ data: [], error: null });
    let n = 0;
    mockFrom.mockImplementation(() => (++n === 1 ? c1.obj : c2.obj));

    const req = makeReq({
      method: "GET",
      query: { viewer: "卡米尔" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/prompts — is_draft", () => {
  it("accepts is_draft=true", async () => {
    const c = chain({
      data: { id: "new", is_draft: true, created_by: "alice" },
      error: null,
    });
    mockFrom.mockReturnValue(c.obj);

    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: {
        title: "Draft thing",
        content: "wip",
        category: "通用",
        tags: [],
        variables: [],
        created_by: "alice",
        is_draft: true,
      },
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(201);
    const insertCall = c.calls.find((x) => x.method === "insert");
    expect(insertCall?.args[0]).toEqual(
      expect.objectContaining({ is_draft: true, created_by: "alice" })
    );
  });

  it("rejects unknown fields (strict schema)", async () => {
    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: {
        title: "x",
        content: "y",
        category: "通用",
        tags: [],
        variables: [],
        created_by: "alice",
        private: true, // legacy field name — must be rejected
      },
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe("PUT /api/prompts — draft owner check", () => {
  function makeFetchExisting(existing: { is_draft: boolean; created_by: string } | null) {
    return chain({
      data: existing,
      error: existing ? null : { message: "not found" },
    });
  }

  it("returns 403 when editing a draft and viewer is missing", async () => {
    const fetchC = makeFetchExisting({ is_draft: true, created_by: "alice" });
    mockFrom.mockReturnValueOnce(fetchC.obj);

    const req = makeReq({
      method: "PUT",
      query: { id: "d1" },
      authorization: `Bearer ${token}`,
      body: { title: "x", content: "y", category: "通用", tags: [], variables: [] },
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(403);
    expect(mockFrom).toHaveBeenCalledTimes(1); // never reached the update call
  });

  it("returns 403 when viewer differs from draft owner", async () => {
    const fetchC = makeFetchExisting({ is_draft: true, created_by: "alice" });
    mockFrom.mockReturnValueOnce(fetchC.obj);

    const req = makeReq({
      method: "PUT",
      query: { id: "d1", viewer: "bob" },
      authorization: `Bearer ${token}`,
      body: { title: "x", content: "y", category: "通用", tags: [], variables: [] },
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(403);
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it("allows update when viewer matches draft owner", async () => {
    const fetchC = makeFetchExisting({ is_draft: true, created_by: "alice" });
    const updateC = chain({ data: { id: "d1", title: "new" }, error: null });
    let call = 0;
    mockFrom.mockImplementation(() => (++call === 1 ? fetchC.obj : updateC.obj));

    const req = makeReq({
      method: "PUT",
      query: { id: "d1", viewer: "alice" },
      authorization: `Bearer ${token}`,
      body: { title: "new", content: "y", category: "通用", tags: [], variables: [] },
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
  });

  it("allows any user to edit published prompts", async () => {
    const fetchC = makeFetchExisting({ is_draft: false, created_by: "alice" });
    const updateC = chain({ data: { id: "p1", title: "new" }, error: null });
    let call = 0;
    mockFrom.mockImplementation(() => (++call === 1 ? fetchC.obj : updateC.obj));

    const req = makeReq({
      method: "PUT",
      query: { id: "p1", viewer: "bob" }, // different from owner
      authorization: `Bearer ${token}`,
      body: { title: "new", content: "y", category: "通用", tags: [], variables: [] },
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
  });
});

describe("DELETE /api/prompts — draft owner check", () => {
  it("returns 403 when deleting a draft as non-owner", async () => {
    const fetchC = chain({
      data: { is_draft: true, created_by: "alice" },
      error: null,
    });
    mockFrom.mockReturnValueOnce(fetchC.obj);

    const req = makeReq({
      method: "DELETE",
      query: { id: "d1", viewer: "bob" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(403);
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it("allows deletion of published prompts by any user", async () => {
    const fetchC = chain({
      data: { is_draft: false, created_by: "alice" },
      error: null,
    });
    const delC = chain({ data: null, error: null });
    let call = 0;
    mockFrom.mockImplementation(() => (++call === 1 ? fetchC.obj : delC.obj));

    const req = makeReq({
      method: "DELETE",
      query: { id: "p1", viewer: "bob" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
  });
});
