import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SHARED_PASSWORD", "test-password-123");

const verifyMod = await import("../../api/verify");
const verifyHandler = verifyMod.default;
const chatMod = await import("../../api/chat");
const chatHandler = chatMod.default;

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
let originalFetch: typeof fetch;

beforeEach(async () => {
  const verifyReq = makeReq({
    method: "POST",
    body: { password: "test-password-123" },
  });
  const verifyRes = makeRes();
  await verifyHandler(verifyReq, verifyRes as unknown as VercelResponse);
  token = (verifyRes.body as { token: string }).token;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const validBody = {
  apiKey: "sk-test-key-1234567890",
  model: "deepseek-v4-flash" as const,
  messages: [{ role: "user" as const, content: "hello" }],
};

describe("POST /api/chat", () => {
  it("returns 401 without token", async () => {
    const req = makeReq({ method: "POST", body: validBody });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("returns 405 for non-POST", async () => {
    const req = makeReq({ method: "GET", authorization: `Bearer ${token}` });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(405);
  });

  it("returns 400 for missing apiKey", async () => {
    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] },
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for invalid model", async () => {
    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: { ...validBody, model: "gpt-4" },
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for empty messages array", async () => {
    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: { ...validBody, messages: [] },
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for unknown body fields (strict)", async () => {
    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: { ...validBody, temperature: 0.5 },
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("forwards to DeepSeek and returns content on success", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "hi there" } }],
        }),
      } as any;
    });

    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: validBody,
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect((res.body as { content: string }).content).toBe("hi there");
    expect(capturedUrl).toBe("https://api.deepseek.com/chat/completions");
    expect(capturedInit?.headers).toMatchObject({
      authorization: `Bearer ${validBody.apiKey}`,
    });
  });

  it("maps DeepSeek 401 to INVALID_KEY", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as any;

    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: validBody,
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(401);
    expect((res.body as any).error.code).toBe("INVALID_KEY");
  });

  it("maps DeepSeek 402 to INSUFFICIENT_BALANCE", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 402,
      json: async () => ({}),
    })) as any;

    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: validBody,
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(402);
    expect((res.body as any).error.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("maps DeepSeek 429 to RATE_LIMITED", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    })) as any;

    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: validBody,
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(429);
    expect((res.body as any).error.code).toBe("RATE_LIMITED");
  });

  it("returns 502 OTHER when upstream returns malformed JSON", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    })) as any;

    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: validBody,
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(502);
    expect((res.body as any).error.code).toBe("OTHER");
  });

  it("returns 502 OTHER when response shape is missing content", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
    })) as any;

    const req = makeReq({
      method: "POST",
      authorization: `Bearer ${token}`,
      body: validBody,
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(502);
  });
});
