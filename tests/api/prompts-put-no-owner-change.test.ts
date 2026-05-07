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

beforeEach(async () => {
  mockFrom.mockReset();

  const verifyReq = makeReq({
    method: "POST",
    body: { password: "test-password-123" },
    authorization: "",
  });
  const verifyRes = makeRes();
  await verifyHandler(verifyReq, verifyRes as unknown as VercelResponse);
  token = (verifyRes.body as { token: string }).token;
});

describe("PUT /api/prompts — owner protection", () => {
  it("rejects PUT body containing 'created_by' with 400 (strict schema gate)", async () => {
    const req = makeReq({
      method: "PUT",
      body: {
        title: "新标题",
        content: "新内容",
        category: "生文",
        tags: [],
        variables: [],
        created_by: "attacker", // 试图夺取 owner
      },
      query: { id: "abc" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
    const body = res.body as { error: string; details: string[] };
    expect(body.error).toBe("Invalid payload");
    // The strict-mode error message references the unrecognized key
    expect(JSON.stringify(body.details)).toContain("created_by");
  });

  it("when valid PUT (no created_by) is made, the update payload sent to supabase does NOT include created_by (defense-in-depth)", async () => {
    let capturedUpdatePayload: Record<string, unknown> | undefined;

    // Pre-fetch (1st mockFrom call) — handler reads is_draft + created_by
    const fetchSingle = vi
      .fn()
      .mockResolvedValue({ data: { is_draft: false, created_by: "alice" }, error: null });
    const fetchEq = vi.fn().mockReturnValue({ single: fetchSingle });
    const fetchSelect = vi.fn().mockReturnValue({ eq: fetchEq });

    // Update (2nd mockFrom call)
    const updSingle = vi.fn().mockResolvedValue({
      data: {
        id: "abc",
        title: "新标题",
        content: "新内容",
        category: "生文",
        tags: [],
        variables: [],
        created_by: "alice",
      },
      error: null,
    });
    const updSelect = vi.fn().mockReturnValue({ single: updSingle });
    const updEq = vi.fn().mockReturnValue({ select: updSelect });
    const updateFn = vi.fn().mockImplementation((payload) => {
      capturedUpdatePayload = payload;
      return { eq: updEq };
    });

    let n = 0;
    mockFrom.mockImplementation(() =>
      ++n === 1 ? { select: fetchSelect } : { update: updateFn }
    );

    const req = makeReq({
      method: "PUT",
      body: {
        title: "新标题",
        content: "新内容",
        category: "生文",
        tags: [],
        variables: [],
      },
      query: { id: "abc", viewer: "alice" },
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(capturedUpdatePayload).toBeDefined();
    expect(capturedUpdatePayload).not.toHaveProperty("created_by");
  });
});
