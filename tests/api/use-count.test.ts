import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

const bag = {
  getUser: vi.fn(),
  rpc: vi.fn(),
  profileLookup: { data: null as unknown, error: null as unknown },
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: (...a: unknown[]) => (bag.getUser as any)(...a) },
    from: () => {
      const c: any = {};
      c.select = () => c;
      c.eq = () => c;
      c.single = () => Promise.resolve(bag.profileLookup);
      return c;
    },
    rpc: (...a: unknown[]) => (bag.rpc as any)(...a),
  }),
}));

const handler = (await import("../../api/use-count")).default;
const supaLib = await import("../../api/lib/supabase");

function makeRes() {
  const res: any = { statusCode: 0, body: undefined };
  res.status = vi.fn((c: number) => {
    res.statusCode = c;
    return res;
  });
  res.json = vi.fn((d: unknown) => {
    res.body = d;
    return res;
  });
  return res;
}

function makeReq(opts: {
  method?: string;
  body?: unknown;
  authorization?: string;
}): VercelRequest {
  return {
    method: opts.method ?? "POST",
    body: opts.body,
    query: {},
    headers: opts.authorization ? { authorization: opts.authorization } : {},
  } as unknown as VercelRequest;
}

function mockAuthenticated() {
  bag.getUser.mockResolvedValue({
    data: {
      user: {
        id: "u1",
        email: "x@y.com",
        user_metadata: { password_set: true },
      },
    },
    error: null,
  });
  bag.profileLookup = {
    data: { display_name: "X", is_admin: false },
    error: null,
  };
}

beforeEach(() => {
  bag.getUser.mockReset();
  bag.rpc.mockReset();
  bag.profileLookup = { data: null, error: null };
  supaLib.__resetServiceRoleClientForTests();
});

describe("/api/use-count", () => {
  it("401 without bearer token", async () => {
    const req = makeReq({});
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("401 when password_set=false", async () => {
    bag.getUser.mockResolvedValue({
      data: { user: { id: "u1", email: "x@y.com", user_metadata: {} } },
      error: null,
    });
    const req = makeReq({ authorization: "Bearer T", body: { id: "00000000-0000-0000-0000-000000000000" } });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("400 on invalid uuid", async () => {
    mockAuthenticated();
    const req = makeReq({ authorization: "Bearer T", body: { id: "not-a-uuid" } });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("400 on unknown field (strict schema)", async () => {
    mockAuthenticated();
    const req = makeReq({
      authorization: "Bearer T",
      body: { id: "11111111-1111-4111-8111-111111111111", evil: true },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("happy path increments via RPC and returns 200", async () => {
    mockAuthenticated();
    bag.rpc.mockResolvedValue({ error: null });
    const req = makeReq({
      authorization: "Bearer T",
      body: { id: "11111111-1111-4111-8111-111111111111" },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(bag.rpc).toHaveBeenCalledWith("increment_use_count", {
      p_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("405 for non-POST", async () => {
    mockAuthenticated();
    const req = makeReq({ method: "GET", authorization: "Bearer T" });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(405);
  });
});
