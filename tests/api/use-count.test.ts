import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SHARED_PASSWORD", "test-password-123");
vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

const mockRpc = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: mockRpc }),
}));

const verifyMod = await import("../../api/verify");
const verifyHandler = verifyMod.default;
const useCountMod = await import("../../api/use-count");
const useCountHandler = useCountMod.default;

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
  authorization?: string;
}): VercelRequest {
  return {
    method: opts.method,
    body: opts.body,
    query: {},
    headers: opts.authorization ? { authorization: opts.authorization } : {},
  } as unknown as VercelRequest;
}

let token: string;

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

beforeEach(async () => {
  mockRpc.mockReset();
  const verifyReq = makeReq({
    method: "POST",
    body: { password: "test-password-123" },
  });
  const verifyRes = makeRes();
  await verifyHandler(verifyReq, verifyRes as unknown as VercelResponse);
  token = (verifyRes.body as { token: string }).token;
});

describe("POST /api/use-count", () => {
  it("returns 401 without token", async () => {
    const req = makeReq({ method: "POST", body: { id: VALID_UUID } });
    const res = makeRes();
    await useCountHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 405 for non-POST", async () => {
    const req = makeReq({
      method: "GET",
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await useCountHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(405);
  });

  it("returns 400 when id is missing", async () => {
    const req = makeReq({
      method: "POST",
      body: {},
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await useCountHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 400 when id is not a UUID", async () => {
    const req = makeReq({
      method: "POST",
      body: { id: "not-a-uuid" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await useCountHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 400 when body has unknown fields (strict schema)", async () => {
    const req = makeReq({
      method: "POST",
      body: { id: VALID_UUID, extra: "should-not-be-here" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await useCountHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls increment_use_count RPC with valid id", async () => {
    mockRpc.mockResolvedValue({ error: null });
    const req = makeReq({
      method: "POST",
      body: { id: VALID_UUID },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await useCountHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith("increment_use_count", {
      p_id: VALID_UUID,
    });
  });
});
