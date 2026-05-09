import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

const bag = {
  getUser: vi.fn(),
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
  }),
}));

const chatHandler = (await import("../../api/chat")).default;
const supaLib = await import("../../api/lib/supabase");

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

let originalFetch: typeof fetch;

function mockAuthOk() {
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
  bag.profileLookup = { data: null, error: null };
  supaLib.__resetServiceRoleClientForTests();
  originalFetch = globalThis.fetch;
  mockAuthOk();
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

  it("returns 401 when password_set=false", async () => {
    bag.getUser.mockResolvedValue({
      data: { user: { id: "x", email: "x@y.com", user_metadata: {} } },
      error: null,
    });
    const req = makeReq({ method: "POST", body: validBody, authorization: "Bearer T" });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("returns 405 for non-POST", async () => {
    const req = makeReq({ method: "GET", authorization: "Bearer T" });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(405);
  });

  it("returns 400 for missing apiKey", async () => {
    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] },
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for invalid model", async () => {
    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: { ...validBody, model: "gpt-4" },
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for empty messages array", async () => {
    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: { ...validBody, messages: [] },
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for unknown body fields (strict)", async () => {
    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
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
      authorization: "Bearer T",
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
      authorization: "Bearer T",
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
      authorization: "Bearer T",
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
      authorization: "Bearer T",
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
      authorization: "Bearer T",
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
      authorization: "Bearer T",
      body: validBody,
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(502);
  });
});

// ---------------- Streaming path ----------------

function mockStreamingRes() {
  const chunks: string[] = [];
  let ended = false;
  const headers: Record<string, string> = {};
  return {
    obj: {
      statusCode: 0,
      setHeader: vi.fn((k: string, v: string) => {
        headers[k] = v;
      }),
      flushHeaders: vi.fn(),
      write: vi.fn((s: string) => {
        chunks.push(s);
        return true;
      }),
      end: vi.fn(() => {
        ended = true;
      }),
      status: vi.fn(function (this: any, code: number) {
        this.statusCode = code;
        return this;
      }),
      json: vi.fn(),
    } as any,
    chunks,
    headers,
    isEnded: () => ended,
  };
}

function streamFromChunks(rawChunks: string[]) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= rawChunks.length) return { done: true, value: undefined };
          const value = enc.encode(rawChunks[i++]);
          return { done: false, value };
        },
      };
    },
  };
}

describe("POST /api/chat — streaming", () => {
  it("forwards SSE chunks verbatim and ends the response", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: streamFromChunks(sse),
    })) as any;

    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: { ...validBody, stream: true },
    });
    const r = mockStreamingRes();
    await chatHandler(req, r.obj as unknown as VercelResponse);

    expect(r.headers["Content-Type"]).toMatch(/text\/event-stream/);
    expect(r.isEnded()).toBe(true);
    const out = r.chunks.join("");
    expect(out).toContain('"hi"');
    expect(out).toContain('" there"');
    expect(out).toContain("[DONE]");
  });

  it("returns JSON 401 (not SSE) when upstream key is invalid in stream mode", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as any;

    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: { ...validBody, stream: true },
    });
    const res = makeRes();
    await chatHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(401);
    expect((res.body as any).error.code).toBe("INVALID_KEY");
  });
});
