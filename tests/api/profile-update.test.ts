import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

type ChainCall = { table: string; method: string; args: unknown[] };
type Bag = {
  getUser: ReturnType<typeof vi.fn>;
  results: Map<string, Array<{ data?: unknown; error?: unknown }>>;
  calls: ChainCall[];
};

const bag: Bag = {
  getUser: vi.fn(),
  results: new Map(),
  calls: [],
};

function pushResult(table: string, result: { data?: unknown; error?: unknown }) {
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
      const record = (method: string) =>
        (...args: unknown[]) => {
          bag.calls.push({ table, method, args });
          return chain;
        };
      chain.select = record("select");
      chain.eq = record("eq");
      chain.update = (...args: unknown[]) => {
        bag.calls.push({ table, method: "update", args });
        return chain;
      };
      chain.single = () => Promise.resolve(nextResult(table));
      chain.then = (fn: any) => Promise.resolve(nextResult(table)).then(fn);
      return chain;
    },
  }),
}));

const handler = (await import("../../api/profile/update")).default;
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
    method: opts.method ?? "PATCH",
    body: opts.body,
    query: {},
    headers: opts.authorization ? { authorization: opts.authorization } : {},
  } as unknown as VercelRequest;
}

const USER = {
  id: "user-aaa",
  email: "alice@example.com",
  display_name: "Old Name",
  is_admin: false,
};

function mockAuthenticated() {
  bag.getUser.mockResolvedValue({
    data: {
      user: {
        id: USER.id,
        email: USER.email,
        user_metadata: { password_set: true },
      },
    },
    error: null,
  });
  // authenticate() does a profile SELECT before returning the user.
  pushResult("profiles", {
    data: { display_name: USER.display_name, is_admin: USER.is_admin },
    error: null,
  });
}

beforeEach(() => {
  bag.getUser.mockReset();
  bag.results.clear();
  bag.calls = [];
  supaLib.__resetServiceRoleClientForTests();
});

describe("/api/profile/update — auth + method", () => {
  it("401 without bearer token", async () => {
    const req = makeReq({ body: { display_name: "X" } });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("401 when password_set=false (closes half-success window)", async () => {
    bag.getUser.mockResolvedValue({
      data: { user: { id: "x", email: "x@y.com", user_metadata: {} } },
      error: null,
    });
    const req = makeReq({
      authorization: "Bearer T",
      body: { display_name: "X" },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("405 for non-PATCH", async () => {
    mockAuthenticated();
    const req = makeReq({
      method: "POST",
      authorization: "Bearer T",
      body: { display_name: "X" },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(405);
  });
});

describe("/api/profile/update — strict schema", () => {
  it("rejects is_admin in body (most important attack surface)", async () => {
    mockAuthenticated();
    const req = makeReq({
      authorization: "Bearer T",
      body: { display_name: "X", is_admin: true },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid payload");
    // Critical: no UPDATE was ever issued, so is_admin can't have changed
    // in the DB even by accident.
    expect(
      bag.calls.find((c) => c.method === "update")
    ).toBeUndefined();
  });

  it("rejects email in body", async () => {
    mockAuthenticated();
    const req = makeReq({
      authorization: "Bearer T",
      body: { display_name: "X", email: "evil@example.com" },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("rejects id in body", async () => {
    mockAuthenticated();
    const req = makeReq({
      authorization: "Bearer T",
      body: { display_name: "X", id: "user-zzz" },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("rejects arbitrary unknown fields", async () => {
    mockAuthenticated();
    const req = makeReq({
      authorization: "Bearer T",
      body: { display_name: "X", surprise: 1 },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("rejects empty display_name", async () => {
    mockAuthenticated();
    const req = makeReq({
      authorization: "Bearer T",
      body: { display_name: "" },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });

  it("rejects display_name > 64 chars", async () => {
    mockAuthenticated();
    const req = makeReq({
      authorization: "Bearer T",
      body: { display_name: "a".repeat(65) },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });
});

describe("/api/profile/update — happy path", () => {
  it("updates display_name and returns the new user summary", async () => {
    mockAuthenticated();
    // The endpoint's own UPDATE → RETURNING select → single()
    pushResult("profiles", {
      data: { display_name: "New Name", is_admin: false },
      error: null,
    });

    const req = makeReq({
      authorization: "Bearer T",
      body: { display_name: "New Name" },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      id: USER.id,
      email: USER.email,
      display_name: "New Name",
      is_admin: false,
    });
  });

  it("update payload contains ONLY display_name — is_admin never written", async () => {
    mockAuthenticated();
    pushResult("profiles", {
      data: { display_name: "Trimmed", is_admin: false },
      error: null,
    });

    const req = makeReq({
      authorization: "Bearer T",
      body: { display_name: "  Trimmed  " },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    const updateCall = bag.calls.find(
      (c) => c.table === "profiles" && c.method === "update"
    );
    expect(updateCall).toBeDefined();
    const payload = updateCall!.args[0] as Record<string, unknown>;
    // Locked: only display_name is in the UPDATE SET clause.
    expect(Object.keys(payload)).toEqual(["display_name"]);
    // Trim happens via Zod transform.
    expect(payload.display_name).toBe("Trimmed");
    // is_admin must not appear anywhere.
    expect(payload).not.toHaveProperty("is_admin");
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("id");
  });

  it("admin user updating their own display_name preserves is_admin in response", async () => {
    bag.getUser.mockResolvedValue({
      data: {
        user: {
          id: "user-zzz",
          email: "admin@example.com",
          user_metadata: { password_set: true },
        },
      },
      error: null,
    });
    pushResult("profiles", {
      data: { display_name: "Old Admin", is_admin: true },
      error: null,
    });
    pushResult("profiles", {
      data: { display_name: "Renamed Admin", is_admin: true },
      error: null,
    });

    const req = makeReq({
      authorization: "Bearer T",
      body: { display_name: "Renamed Admin" },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(res.body.is_admin).toBe(true);
  });
});
