import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

type ChainCall = { table: string; method: string; args: unknown[] };
type Bag = {
  getUser: ReturnType<typeof vi.fn>;
  // First single() call for "examples" with head:true returns count, others return data.
  results: Map<string, Array<{ data?: unknown; error?: unknown; count?: number }>>;
  calls: ChainCall[];
  // Track whether a select was called with { count: "exact", head: true }
  // to route the next then() to a count result.
  countMode: Map<string, boolean>;
};

const bag: Bag = {
  getUser: vi.fn(),
  results: new Map(),
  calls: [],
  countMode: new Map(),
};

function pushResult(
  table: string,
  result: { data?: unknown; error?: unknown; count?: number }
) {
  if (!bag.results.has(table)) bag.results.set(table, []);
  bag.results.get(table)!.push(result);
}

function nextResult(table: string) {
  const q = bag.results.get(table);
  if (!q || q.length === 0)
    return { data: null, error: { message: `no mocked result for ${table}` } };
  return q.shift()!;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: (...a: unknown[]) => (bag.getUser as any)(...a) },
    from: (table: string) => {
      const chain: any = {};
      chain.select = (cols: unknown, opts?: { count?: string; head?: boolean }) => {
        bag.calls.push({ table, method: "select", args: [cols, opts] });
        if (opts?.count === "exact" && opts?.head === true) {
          bag.countMode.set(table, true);
        }
        return chain;
      };
      chain.eq = (...args: unknown[]) => {
        bag.calls.push({ table, method: "eq", args });
        return chain;
      };
      chain.insert = (...args: unknown[]) => {
        bag.calls.push({ table, method: "insert", args });
        return chain;
      };
      chain.delete = (...args: unknown[]) => {
        bag.calls.push({ table, method: "delete", args });
        return chain;
      };
      chain.order = (...args: unknown[]) => {
        bag.calls.push({ table, method: "order", args });
        return chain;
      };
      chain.single = () => Promise.resolve(nextResult(table));
      chain.then = (fn: any) => Promise.resolve(nextResult(table)).then(fn);
      return chain;
    },
  }),
}));

const handler = (await import("../../api/examples")).default;
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

const REGULAR_USER = {
  id: "user-aaa",
  email: "alice@example.com",
  display_name: "Alice",
  is_admin: false,
};
const OTHER_USER = {
  id: "user-bbb",
  email: "bob@example.com",
  display_name: "Bob",
  is_admin: false,
};
const ADMIN_USER = {
  id: "user-zzz",
  email: "admin@example.com",
  display_name: "Admin",
  is_admin: true,
};

function mockAuthenticated(user: typeof REGULAR_USER) {
  bag.getUser.mockResolvedValue({
    data: {
      user: {
        id: user.id,
        email: user.email,
        user_metadata: { password_set: true },
      },
    },
    error: null,
  });
  pushResult("profiles", {
    data: { display_name: user.display_name, is_admin: user.is_admin },
    error: null,
  });
}

const VALID_PROMPT_ID = "11111111-1111-4111-8111-111111111111";
const VALID_EXAMPLE_ID = "22222222-2222-4222-8222-222222222222";

const VALID_BODY = {
  prompt_id: VALID_PROMPT_ID,
  variable_values: {},
  model: "deepseek-v4-flash",
  messages: [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: "hello" },
  ],
};

beforeEach(() => {
  bag.getUser.mockReset();
  bag.results.clear();
  bag.calls = [];
  bag.countMode.clear();
  supaLib.__resetServiceRoleClientForTests();
});

describe("/api/examples — auth", () => {
  it("401 without bearer token", async () => {
    const req = makeReq({ method: "GET", query: { prompt_id: VALID_PROMPT_ID } });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });
});

describe("/api/examples GET", () => {
  it("403 when prompt is draft and caller is not the owner", async () => {
    mockAuthenticated(REGULAR_USER);
    pushResult("prompts", {
      data: { is_draft: true, created_by_id: "someone-else" },
      error: null,
    });
    const req = makeReq({
      method: "GET",
      authorization: "Bearer T",
      query: { prompt_id: VALID_PROMPT_ID },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(403);
  });

  it("admin still cannot view someone else's draft examples (drafts stay private per spec §5.3)", async () => {
    mockAuthenticated(ADMIN_USER);
    pushResult("prompts", {
      data: { is_draft: true, created_by_id: "someone-else" },
      error: null,
    });
    const req = makeReq({
      method: "GET",
      authorization: "Bearer T",
      query: { prompt_id: VALID_PROMPT_ID },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(403);
  });

  it("returns flattened examples list when caller may view", async () => {
    mockAuthenticated(REGULAR_USER);
    pushResult("prompts", {
      data: { is_draft: false, created_by_id: "anyone" },
      error: null,
    });
    pushResult("examples", {
      data: [
        {
          id: "e1",
          prompt_id: VALID_PROMPT_ID,
          created_by_id: REGULAR_USER.id,
          creator: { display_name: "Alice" },
          messages: [],
        },
      ],
      error: null,
    });
    const req = makeReq({
      method: "GET",
      authorization: "Bearer T",
      query: { prompt_id: VALID_PROMPT_ID },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body[0].created_by_name).toBe("Alice");
    expect(res.body[0].creator).toBeUndefined();
  });
});

describe("/api/examples POST", () => {
  it("strict-rejects body containing created_by", async () => {
    mockAuthenticated(REGULAR_USER);
    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: { ...VALID_BODY, created_by: "forged" },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("strict-rejects body containing created_by_id", async () => {
    mockAuthenticated(REGULAR_USER);
    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: { ...VALID_BODY, created_by_id: "forged" },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("403 when posting to someone else's draft", async () => {
    mockAuthenticated(REGULAR_USER);
    pushResult("prompts", {
      data: { is_draft: true, created_by_id: OTHER_USER.id },
      error: null,
    });
    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: VALID_BODY,
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(403);
  });

  it("happy path: count check then insert with server-injected created_by_id", async () => {
    mockAuthenticated(REGULAR_USER);
    pushResult("prompts", {
      data: { is_draft: false, created_by_id: "anyone" },
      error: null,
    });
    pushResult("examples", { count: 0, error: null });
    pushResult("examples", {
      data: {
        id: "e-new",
        created_by_id: REGULAR_USER.id,
        creator: { display_name: REGULAR_USER.display_name },
      },
      error: null,
    });

    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: VALID_BODY,
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(201);
    const insertCall = bag.calls.find(
      (c) => c.table === "examples" && c.method === "insert"
    );
    expect((insertCall!.args[0] as any).created_by_id).toBe(REGULAR_USER.id);
    expect(res.body.created_by_name).toBe(REGULAR_USER.display_name);
    expect(res.body.creator).toBeUndefined();
  });

  it("400 when 5-per-prompt cap is hit", async () => {
    mockAuthenticated(REGULAR_USER);
    pushResult("prompts", {
      data: { is_draft: false, created_by_id: "anyone" },
      error: null,
    });
    pushResult("examples", { count: 5, error: null });

    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: VALID_BODY,
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });
});

describe("/api/examples DELETE — option B + admin", () => {
  function pushExample(opts: { creator: string; promptId: string }) {
    pushResult("examples", {
      data: { created_by_id: opts.creator, prompt_id: opts.promptId },
      error: null,
    });
  }
  function pushPrompt(opts: { creator: string }) {
    pushResult("prompts", {
      data: { created_by_id: opts.creator },
      error: null,
    });
  }

  it("403 when caller is neither example creator, prompt owner, nor admin", async () => {
    mockAuthenticated(REGULAR_USER);
    pushExample({ creator: OTHER_USER.id, promptId: VALID_PROMPT_ID });
    pushPrompt({ creator: OTHER_USER.id });
    const req = makeReq({
      method: "DELETE",
      authorization: "Bearer T",
      query: { id: VALID_EXAMPLE_ID },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(403);
  });

  it("example creator can delete → 200", async () => {
    mockAuthenticated(REGULAR_USER);
    pushExample({ creator: REGULAR_USER.id, promptId: VALID_PROMPT_ID });
    pushPrompt({ creator: OTHER_USER.id });
    pushResult("examples", { data: null, error: null });
    const req = makeReq({
      method: "DELETE",
      authorization: "Bearer T",
      query: { id: VALID_EXAMPLE_ID },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
  });

  it("prompt owner can delete other users' examples → 200", async () => {
    mockAuthenticated(REGULAR_USER);
    pushExample({ creator: OTHER_USER.id, promptId: VALID_PROMPT_ID });
    pushPrompt({ creator: REGULAR_USER.id });
    pushResult("examples", { data: null, error: null });
    const req = makeReq({
      method: "DELETE",
      authorization: "Bearer T",
      query: { id: VALID_EXAMPLE_ID },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
  });

  it("admin can delete other users' examples even if not prompt owner → 200", async () => {
    mockAuthenticated(ADMIN_USER);
    pushExample({ creator: OTHER_USER.id, promptId: VALID_PROMPT_ID });
    pushPrompt({ creator: REGULAR_USER.id });
    pushResult("examples", { data: null, error: null });
    const req = makeReq({
      method: "DELETE",
      authorization: "Bearer T",
      query: { id: VALID_EXAMPLE_ID },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
  });
});
