import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SHARED_PASSWORD", "test-password-123");
vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

const mockInsert = vi.fn();
const mockUpdate = vi.fn();
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
  method: string;
  body?: unknown;
  query?: Record<string, string>;
  authorization: string;
}): VercelRequest {
  return {
    method: opts.method,
    body: opts.body,
    query: opts.query ?? {},
    headers: { authorization: opts.authorization },
  } as unknown as VercelRequest;
}

let token: string;

const validCreateBody = {
  title: "测试提示词",
  content: "内容",
  category: "生文",
  tags: ["标签1"],
  variables: [],
  created_by: "alice",
};

const validUpdateBody = {
  title: "更新后的标题",
  content: "更新后的内容",
  category: "生文",
  tags: [],
  variables: [],
};

beforeEach(async () => {
  mockFrom.mockReset();
  mockInsert.mockReset();
  mockUpdate.mockReset();

  const verifyReq = makeReq({
    method: "POST",
    body: { password: "test-password-123" },
    authorization: "", // verify doesn't need auth
  });
  const verifyRes = makeRes();
  await verifyHandler(verifyReq, verifyRes as unknown as VercelResponse);
  token = (verifyRes.body as { token: string }).token;
});

describe("POST /api/prompts — strict schema rejects unknown fields", () => {
  it("accepts valid create body", async () => {
    const singleMock = vi
      .fn()
      .mockResolvedValue({ data: { id: "new-id", ...validCreateBody }, error: null });
    const selectMock = vi.fn().mockReturnValue({ single: singleMock });
    const insertMock = vi.fn().mockReturnValue({ select: selectMock });
    mockFrom.mockReturnValue({ insert: insertMock });

    const req = makeReq({
      method: "POST",
      body: validCreateBody,
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(201);
  });

  it("rejects POST body containing 'id' field with 400", async () => {
    const req = makeReq({
      method: "POST",
      body: { ...validCreateBody, id: "should-not-be-here" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
    const body = res.body as { error: string; details: string[] };
    expect(body.error).toBe("Invalid payload");
  });

  it("rejects POST body containing 'created_at' field with 400", async () => {
    const req = makeReq({
      method: "POST",
      body: { ...validCreateBody, created_at: "2026-01-01" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects POST body containing 'use_count' field with 400", async () => {
    const req = makeReq({
      method: "POST",
      body: { ...validCreateBody, use_count: 100 },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects POST body containing arbitrary unknown field with 400", async () => {
    const req = makeReq({
      method: "POST",
      body: { ...validCreateBody, foo_bar_baz: "hack" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe("PUT /api/prompts — strict schema rejects unknown fields", () => {
  it("accepts valid update body", async () => {
    // Handler now pre-fetches the row for the draft-owner check, then updates.
    // First mockFrom() call → SELECT existing; second → UPDATE.
    const fetchSingle = vi
      .fn()
      .mockResolvedValue({ data: { is_draft: false, created_by: "alice" }, error: null });
    const fetchEq = vi.fn().mockReturnValue({ single: fetchSingle });
    const fetchSelect = vi.fn().mockReturnValue({ eq: fetchEq });

    const updSingle = vi
      .fn()
      .mockResolvedValue({ data: { id: "abc", ...validUpdateBody }, error: null });
    const updSelect = vi.fn().mockReturnValue({ single: updSingle });
    const updEq = vi.fn().mockReturnValue({ select: updSelect });
    const updateFn = vi.fn().mockReturnValue({ eq: updEq });

    let n = 0;
    mockFrom.mockImplementation(() =>
      ++n === 1 ? { select: fetchSelect } : { update: updateFn }
    );

    const req = makeReq({
      method: "PUT",
      body: validUpdateBody,
      query: { id: "abc", viewer: "alice" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
  });

  it("rejects PUT body containing 'id' with 400", async () => {
    const req = makeReq({
      method: "PUT",
      body: { ...validUpdateBody, id: "injected" },
      query: { id: "abc" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects PUT body containing 'created_at' with 400", async () => {
    const req = makeReq({
      method: "PUT",
      body: { ...validUpdateBody, created_at: "2026-01-01" },
      query: { id: "abc" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("rejects PUT body with unknown custom field with 400", async () => {
    const req = makeReq({
      method: "PUT",
      body: { ...validUpdateBody, evil_field: "x" },
      query: { id: "abc" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
