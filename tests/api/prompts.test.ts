import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

// Bag-style mock used across the Phase 2 endpoint tests. Each test wires up
// what auth.getUser / profile lookup / table operations should return; the
// chain object collects the call sequence so we can assert what the handler
// asked for.

type ChainCall = { table: string; method: string; args: unknown[] };
type Bag = {
  getUser: ReturnType<typeof vi.fn>;
  // For each "from(table)" call we plant a queue of results keyed by table.
  // Each select/insert/update/delete chain ends in single() / order() —
  // we resolve those with the next item from the queue for that table.
  results: Map<string, Array<{ data: unknown; error: unknown }>>;
  calls: ChainCall[];
};

const bag: Bag = {
  getUser: vi.fn(),
  results: new Map(),
  calls: [],
};

function pushResult(table: string, result: { data: unknown; error: unknown }) {
  if (!bag.results.has(table)) bag.results.set(table, []);
  bag.results.get(table)!.push(result);
}

function nextResult(table: string): { data: unknown; error: unknown } {
  const q = bag.results.get(table);
  if (!q || q.length === 0) {
    return { data: null, error: { message: `no mocked result for ${table}` } };
  }
  return q.shift()!;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: (...a: unknown[]) => (bag.getUser as any)(...a),
    },
    from: (table: string) => {
      const chain: any = {};
      const record = (method: string) =>
        (...args: unknown[]) => {
          bag.calls.push({ table, method, args });
          return chain;
        };
      chain.select = record("select");
      chain.eq = record("eq");
      chain.insert = (...args: unknown[]) => {
        bag.calls.push({ table, method: "insert", args });
        return chain;
      };
      chain.update = (...args: unknown[]) => {
        bag.calls.push({ table, method: "update", args });
        return chain;
      };
      chain.delete = (...args: unknown[]) => {
        bag.calls.push({ table, method: "delete", args });
        return chain;
      };
      chain.order = record("order");
      // Both single() and the bare-then path resolve from the same queue.
      chain.single = () => Promise.resolve(nextResult(table));
      chain.then = (fn: any) => Promise.resolve(nextResult(table)).then(fn);
      return chain;
    },
  }),
}));

const promptsHandler = (await import("../../api/prompts")).default;
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

// Reusable user fixtures.
const REGULAR_USER = {
  id: "user-aaa",
  email: "alice@example.com",
  display_name: "Alice",
  is_admin: false,
};
const ADMIN_USER = {
  id: "user-zzz",
  email: "admin@example.com",
  display_name: "Admin",
  is_admin: true,
};

/**
 * Wire authenticate() to return the given user. authenticate() does:
 *   1. supabase.auth.getUser(token) → { user: { id, email, user_metadata }}
 *   2. select profiles by id → { display_name, is_admin }
 * Both must succeed for authenticate() to return a non-null user.
 */
function mockAuthenticated(user: {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
}) {
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

beforeEach(() => {
  bag.getUser.mockReset();
  bag.results.clear();
  bag.calls = [];
  supaLib.__resetServiceRoleClientForTests();
});

describe("/api/prompts — auth", () => {
  it("401 without bearer token", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("401 when password_set=false (reverse half-success window)", async () => {
    bag.getUser.mockResolvedValue({
      data: {
        user: {
          id: "x",
          email: "x@y.com",
          user_metadata: {},
        },
      },
      error: null,
    });
    const req = makeReq({ method: "GET", authorization: "Bearer T" });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("401 when profile is missing", async () => {
    bag.getUser.mockResolvedValue({
      data: {
        user: {
          id: "x",
          email: "x@y.com",
          user_metadata: { password_set: true },
        },
      },
      error: null,
    });
    pushResult("profiles", { data: null, error: null });
    const req = makeReq({ method: "GET", authorization: "Bearer T" });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });
});

describe("/api/prompts GET", () => {
  it("returns published + caller's drafts, flattens creator profile", async () => {
    mockAuthenticated(REGULAR_USER);
    pushResult("prompts", {
      data: [
        {
          id: "p1",
          title: "pub-1",
          is_draft: false,
          created_by_id: "other",
          created_at: "2026-05-01",
          creator: { display_name: "Bob" },
        },
      ],
      error: null,
    });
    pushResult("prompts", {
      data: [
        {
          id: "p2",
          title: "my-draft",
          is_draft: true,
          created_by_id: REGULAR_USER.id,
          created_at: "2026-05-02",
          creator: { display_name: "Alice" },
        },
      ],
      error: null,
    });

    const req = makeReq({ method: "GET", authorization: "Bearer T" });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    const list = res.body as any[];
    expect(list).toHaveLength(2);
    // Newest first (2026-05-02 before 2026-05-01).
    expect(list[0].id).toBe("p2");
    // Creator alias is flattened to created_by_name and creator nested
    // object is removed.
    expect(list[0].created_by_name).toBe("Alice");
    expect(list[1].created_by_name).toBe("Bob");
    expect(list[0].creator).toBeUndefined();

    // Spec §5.3: drafts list is filtered by created_by_id = caller.
    const draftQuery = bag.calls.filter(
      (c) => c.table === "prompts" && c.method === "eq"
    );
    const draftCreatedByEq = draftQuery.find(
      (c) => (c.args[0] as string) === "created_by_id"
    );
    expect(draftCreatedByEq?.args[1]).toBe(REGULAR_USER.id);
  });
});

describe("/api/prompts POST", () => {
  it("strict-rejects body containing created_by", async () => {
    mockAuthenticated(REGULAR_USER);
    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: {
        title: "t",
        content: "c",
        category: "生文",
        tags: [],
        variables: [],
        is_draft: false,
        created_by: "forged",
      },
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid payload");
  });

  it("strict-rejects body containing created_by_id", async () => {
    mockAuthenticated(REGULAR_USER);
    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: {
        title: "t",
        content: "c",
        category: "生文",
        tags: [],
        variables: [],
        is_draft: false,
        created_by_id: "00000000-0000-0000-0000-000000000000",
      },
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("injects created_by_id from authenticated user — sanity insert payload", async () => {
    mockAuthenticated(REGULAR_USER);
    pushResult("prompts", {
      data: {
        id: "new-id",
        title: "t",
        created_by_id: REGULAR_USER.id,
        creator: { display_name: REGULAR_USER.display_name },
      },
      error: null,
    });

    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: {
        title: "t",
        content: "c",
        category: "生文",
        tags: [],
        variables: [],
        is_draft: false,
      },
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(201);
    const insertCall = bag.calls.find(
      (c) => c.table === "prompts" && c.method === "insert"
    );
    expect((insertCall!.args[0] as any).created_by_id).toBe(REGULAR_USER.id);
    // Response is flattened.
    expect(res.body.created_by_name).toBe(REGULAR_USER.display_name);
    expect(res.body.creator).toBeUndefined();
  });
});

describe("/api/prompts PUT — ownership", () => {
  function pushExisting(opts: { is_draft: boolean; owner: string }) {
    pushResult("prompts", {
      data: { is_draft: opts.is_draft, created_by_id: opts.owner },
      error: null,
    });
  }
  function pushUpdated() {
    pushResult("prompts", {
      data: {
        id: "p1",
        title: "updated",
        creator: { display_name: "X" },
      },
      error: null,
    });
  }
  const validBody = {
    title: "new",
    content: "c",
    category: "生文",
    tags: [],
    variables: [],
    is_draft: false,
  };

  it("404 when prompt does not exist", async () => {
    mockAuthenticated(REGULAR_USER);
    pushResult("prompts", { data: null, error: { message: "no rows" } });
    const req = makeReq({
      method: "PUT",
      authorization: "Bearer T",
      query: { id: "p1" },
      body: validBody,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(404);
  });

  it("owner can edit own published prompt → 200", async () => {
    mockAuthenticated(REGULAR_USER);
    pushExisting({ is_draft: false, owner: REGULAR_USER.id });
    pushUpdated();
    const req = makeReq({
      method: "PUT",
      authorization: "Bearer T",
      query: { id: "p1" },
      body: validBody,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
  });

  it("non-owner non-admin → 403 on published prompt", async () => {
    mockAuthenticated(REGULAR_USER);
    pushExisting({ is_draft: false, owner: "someone-else" });
    const req = makeReq({
      method: "PUT",
      authorization: "Bearer T",
      query: { id: "p1" },
      body: validBody,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(403);
  });

  it("non-owner non-admin → 403 on someone else's draft", async () => {
    mockAuthenticated(REGULAR_USER);
    pushExisting({ is_draft: true, owner: "someone-else" });
    const req = makeReq({
      method: "PUT",
      authorization: "Bearer T",
      query: { id: "p1" },
      body: validBody,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(403);
  });

  it("admin can edit other users' published prompts → 200", async () => {
    mockAuthenticated(ADMIN_USER);
    pushExisting({ is_draft: false, owner: "someone-else" });
    pushUpdated();
    const req = makeReq({
      method: "PUT",
      authorization: "Bearer T",
      query: { id: "p1" },
      body: validBody,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
  });

  it("admin can edit other users' drafts → 200 (clean-up authority per spec §5.3)", async () => {
    mockAuthenticated(ADMIN_USER);
    pushExisting({ is_draft: true, owner: "someone-else" });
    pushUpdated();
    const req = makeReq({
      method: "PUT",
      authorization: "Bearer T",
      query: { id: "p1" },
      body: validBody,
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
  });

  it("PUT body cannot smuggle a created_by_id field (strict schema)", async () => {
    mockAuthenticated(REGULAR_USER);
    const req = makeReq({
      method: "PUT",
      authorization: "Bearer T",
      query: { id: "p1" },
      body: { ...validBody, created_by_id: "forged" },
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });
});

describe("/api/prompts DELETE — ownership", () => {
  function pushExisting(opts: { is_draft: boolean; owner: string }) {
    pushResult("prompts", {
      data: { is_draft: opts.is_draft, created_by_id: opts.owner },
      error: null,
    });
  }

  it("non-owner non-admin → 403", async () => {
    mockAuthenticated(REGULAR_USER);
    pushExisting({ is_draft: false, owner: "someone-else" });
    const req = makeReq({
      method: "DELETE",
      authorization: "Bearer T",
      query: { id: "p1" },
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(403);
  });

  it("owner → 200", async () => {
    mockAuthenticated(REGULAR_USER);
    pushExisting({ is_draft: false, owner: REGULAR_USER.id });
    pushResult("prompts", { data: null, error: null });
    const req = makeReq({
      method: "DELETE",
      authorization: "Bearer T",
      query: { id: "p1" },
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
  });

  it("admin can delete other users' drafts → 200", async () => {
    mockAuthenticated(ADMIN_USER);
    pushExisting({ is_draft: true, owner: "someone-else" });
    pushResult("prompts", { data: null, error: null });
    const req = makeReq({
      method: "DELETE",
      authorization: "Bearer T",
      query: { id: "p1" },
    });
    const res = makeRes();
    await promptsHandler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
  });
});
