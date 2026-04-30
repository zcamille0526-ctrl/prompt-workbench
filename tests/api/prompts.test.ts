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
