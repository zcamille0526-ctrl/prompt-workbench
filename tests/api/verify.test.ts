import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SHARED_PASSWORD", "test-password-123");

const handlerModule = await import("../../api/verify");
const handler = handlerModule.default;
const verifyToken = handlerModule.verifyToken;

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

function makeReq(body: unknown, method = "POST"): VercelRequest {
  return {
    method,
    body,
    headers: { "content-type": "application/json" },
    query: {},
  } as unknown as VercelRequest;
}

describe("verify handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns token for correct password", async () => {
    const req = makeReq({ password: "test-password-123" });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    const body = res.body as { token: string };
    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe("string");
  });

  it("returns 401 for wrong password", async () => {
    const req = makeReq({ password: "wrong" });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 for missing password", async () => {
    const req = makeReq({});
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("returns 405 for non-POST", async () => {
    const req = makeReq({ password: "test-password-123" }, "GET");
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(405);
  });
});

describe("verifyToken", () => {
  it("verifies a token it issued", async () => {
    const req = makeReq({ password: "test-password-123" });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    const body = res.body as { token: string };
    expect(verifyToken(body.token)).toBe(true);
  });

  it("rejects a tampered token", () => {
    expect(verifyToken("invalid.token")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(verifyToken("")).toBe(false);
  });
});
