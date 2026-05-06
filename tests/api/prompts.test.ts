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

  it("calls supabase select on GET with valid token", async () => {
    const orderMock = vi.fn().mockResolvedValue({ data: [], error: null });
    const selectMock = vi.fn().mockReturnValue({ order: orderMock });
    mockFrom.mockReturnValue({ select: selectMock });

    const req = makeReq({
      method: "GET",
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(mockFrom).toHaveBeenCalledWith("prompts");
  });
});
