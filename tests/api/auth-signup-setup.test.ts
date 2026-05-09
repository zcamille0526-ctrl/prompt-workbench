import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SHARED_PASSWORD", "team-pass-123");
vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
vi.stubEnv("ADMIN_EMAILS", "admin@example.com");
vi.stubEnv("SITE_URL", "https://test.example.com");

// One mutable bag the tests rewrite per case. The factory below reads from it
// each time the module is re-imported, so we get a fresh client per test.
type MockBag = {
  listUsers: ReturnType<typeof vi.fn>;
  inviteUserByEmail: ReturnType<typeof vi.fn>;
  updateUserById: ReturnType<typeof vi.fn>;
  deleteUser: ReturnType<typeof vi.fn>;
  getUser: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
  fromCalls: { table: string; method: string; args: unknown[] }[];
  profileLookupResult: { data: unknown; error: unknown };
  profileUpsertResult: { error: unknown };
};

const bag: MockBag = {
  listUsers: vi.fn(),
  inviteUserByEmail: vi.fn(),
  updateUserById: vi.fn(),
  deleteUser: vi.fn(),
  getUser: vi.fn(),
  signOut: vi.fn(),
  fromCalls: [],
  profileLookupResult: { data: null, error: null },
  profileUpsertResult: { error: null },
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: (...args: unknown[]) => (bag.getUser as any)(...args),
      admin: {
        listUsers: (...args: unknown[]) => (bag.listUsers as any)(...args),
        inviteUserByEmail: (...args: unknown[]) => (bag.inviteUserByEmail as any)(...args),
        updateUserById: (...args: unknown[]) => (bag.updateUserById as any)(...args),
        deleteUser: (...args: unknown[]) => (bag.deleteUser as any)(...args),
        signOut: (...args: unknown[]) => (bag.signOut as any)(...args),
      },
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const wrap = (method: string) =>
        (...args: unknown[]) => {
          bag.fromCalls.push({ table, method, args });
          return chain;
        };
      chain.select = wrap("select");
      chain.eq = wrap("eq");
      chain.upsert = (...args: unknown[]) => {
        bag.fromCalls.push({ table, method: "upsert", args });
        return Promise.resolve(bag.profileUpsertResult);
      };
      chain.maybeSingle = () => Promise.resolve(bag.profileLookupResult);
      chain.single = () => Promise.resolve(bag.profileLookupResult);
      return chain;
    },
  }),
}));

const signup = (await import("../../api/auth/signup")).default;
const setupAccount = (await import("../../api/auth/setup-account")).default;
const supaLib = await import("../../api/lib/supabase");

type MockRes = {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  statusCode: number;
  body: any;
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

function resetBag() {
  bag.listUsers.mockReset();
  bag.inviteUserByEmail.mockReset();
  bag.updateUserById.mockReset();
  bag.deleteUser.mockReset();
  bag.getUser.mockReset();
  bag.signOut.mockReset();
  bag.fromCalls = [];
  bag.profileLookupResult = { data: null, error: null };
  bag.profileUpsertResult = { error: null };
  supaLib.__resetServiceRoleClientForTests();
}

describe("/api/auth/signup", () => {
  beforeEach(resetBag);

  it("returns 400 WRONG_TEAM_PASSWORD when team password mismatches", async () => {
    const req = makeReq({
      body: { email: "x@example.com", display_name: "X", team_password: "nope" },
    });
    const res = makeRes();
    await signup(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("WRONG_TEAM_PASSWORD");
    expect(bag.listUsers).not.toHaveBeenCalled();
    expect(bag.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("returns 400 EMAIL_TAKEN when listUsers shows password_set=true", async () => {
    bag.listUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: "u1",
            email: "x@example.com",
            user_metadata: { password_set: true },
          },
        ],
      },
      error: null,
    });
    const req = makeReq({
      body: { email: "x@example.com", display_name: "X", team_password: "team-pass-123" },
    });
    const res = makeRes();
    await signup(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("EMAIL_TAKEN");
    expect(bag.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("returns 400 EMAIL_PENDING when user exists with password_set=false", async () => {
    bag.listUsers.mockResolvedValue({
      data: {
        users: [
          { id: "u1", email: "x@example.com", user_metadata: {} },
        ],
      },
      error: null,
    });
    const req = makeReq({
      body: { email: "x@example.com", display_name: "X", team_password: "team-pass-123" },
    });
    const res = makeRes();
    await signup(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("EMAIL_PENDING");
  });

  it("happy path: invites user, writes team_pass_verified flag, returns 200", async () => {
    bag.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
    bag.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "u-new", email: "new@example.com" } },
      error: null,
    });
    bag.updateUserById.mockResolvedValue({ error: null });

    const req = makeReq({
      body: {
        email: "new@example.com",
        display_name: "Newbie",
        team_password: "team-pass-123",
      },
    });
    const res = makeRes();
    await signup(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(bag.inviteUserByEmail).toHaveBeenCalledTimes(1);
    const inviteArgs = bag.inviteUserByEmail.mock.calls[0];
    expect(inviteArgs[0]).toBe("new@example.com");
    expect(inviteArgs[1]).toMatchObject({ data: { display_name: "Newbie" } });
    expect(inviteArgs[1].redirectTo).toBe("https://test.example.com/auth/callback");

    expect(bag.updateUserById).toHaveBeenCalledWith("u-new", {
      app_metadata: { team_pass_verified: true },
    });
    expect(bag.deleteUser).not.toHaveBeenCalled();
  });

  it("rolls back via deleteUser when team_pass_verified write fails", async () => {
    bag.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
    bag.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "u-orphan", email: "rb@example.com" } },
      error: null,
    });
    bag.updateUserById.mockResolvedValue({
      error: { message: "boom" },
    });
    bag.deleteUser.mockResolvedValue({ error: null });

    const req = makeReq({
      body: {
        email: "rb@example.com",
        display_name: "RB",
        team_password: "team-pass-123",
      },
    });
    const res = makeRes();
    await signup(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("INVITE_FAILED");
    expect(bag.deleteUser).toHaveBeenCalledWith("u-orphan");
  });

  it("TOCTOU: duplicate-user error after listUsers said absent → maps to EMAIL_PENDING", async () => {
    // First listUsers in pre-check → empty
    // Invite throws duplicate-user
    // Second listUsers in fallback → user exists with password_set=false
    bag.listUsers
      .mockResolvedValueOnce({ data: { users: [] }, error: null })
      .mockResolvedValueOnce({
        data: {
          users: [
            { id: "u1", email: "race@example.com", user_metadata: {} },
          ],
        },
        error: null,
      });
    bag.inviteUserByEmail.mockResolvedValue({
      data: null,
      error: { code: "email_exists", status: 422, message: "User already registered" },
    });

    const req = makeReq({
      body: {
        email: "race@example.com",
        display_name: "R",
        team_password: "team-pass-123",
      },
    });
    const res = makeRes();
    await signup(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("EMAIL_PENDING");
    expect(bag.listUsers).toHaveBeenCalledTimes(2);
  });

  it("TOCTOU: duplicate-user where re-lookup shows password_set=true → EMAIL_TAKEN", async () => {
    bag.listUsers
      .mockResolvedValueOnce({ data: { users: [] }, error: null })
      .mockResolvedValueOnce({
        data: {
          users: [
            {
              id: "u1",
              email: "race2@example.com",
              user_metadata: { password_set: true },
            },
          ],
        },
        error: null,
      });
    bag.inviteUserByEmail.mockResolvedValue({
      data: null,
      error: { code: "email_exists", status: 422, message: "User already registered" },
    });

    const req = makeReq({
      body: {
        email: "race2@example.com",
        display_name: "R",
        team_password: "team-pass-123",
      },
    });
    const res = makeRes();
    await signup(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("EMAIL_TAKEN");
  });
});

describe("/api/auth/setup-account", () => {
  beforeEach(resetBag);

  it("returns 401 without bearer token", async () => {
    const req = makeReq({ body: { password: "newpass-12345" } });
    const res = makeRes();
    await setupAccount(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 BYPASS_ATTEMPT when team_pass_verified is missing", async () => {
    bag.getUser.mockResolvedValue({
      data: {
        user: {
          id: "u1",
          email: "x@example.com",
          app_metadata: {},
          user_metadata: { display_name: "X" },
        },
      },
      error: null,
    });
    const req = makeReq({
      body: { password: "abcdefgh" },
      authorization: "Bearer invite-jwt",
    });
    const res = makeRes();
    await setupAccount(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe("BYPASS_ATTEMPT");
    expect(bag.signOut).not.toHaveBeenCalled();
  });

  it("first-setup happy path: UPSERT profile, set password, signOut(jwt,'global'), requires_relogin=true", async () => {
    bag.getUser.mockResolvedValue({
      data: {
        user: {
          id: "u-first",
          email: "new@example.com",
          app_metadata: { team_pass_verified: true },
          user_metadata: { display_name: "Newbie" },
        },
      },
      error: null,
    });
    // First profile lookup (early-return check) → not found
    // Second profile lookup (response build) → returns final state
    bag.profileLookupResult = { data: null, error: null };
    bag.updateUserById.mockResolvedValue({ error: null });
    bag.signOut.mockResolvedValue({ error: null });

    // Override profile lookups: first call maybeSingle returns null, second call single returns profile
    let lookupCount = 0;
    const supabaseMod: any = await import("@supabase/supabase-js");
    void supabaseMod; // not used directly; bag-based mock above handles it
    const origLookup = bag.profileLookupResult;
    Object.defineProperty(bag, "profileLookupResult", {
      get() {
        lookupCount++;
        if (lookupCount === 1) return { data: null, error: null };
        return {
          data: { display_name: "Newbie", is_admin: false },
          error: null,
        };
      },
      configurable: true,
    });

    const req = makeReq({
      body: { password: "abcdefgh" },
      authorization: "Bearer invite-jwt-aaa",
    });
    const res = makeRes();
    await setupAccount(req, res as unknown as VercelResponse);

    // Restore static lookup
    Object.defineProperty(bag, "profileLookupResult", {
      value: origLookup,
      writable: true,
      configurable: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.requires_relogin).toBe(true);
    expect(res.body.user_summary).toMatchObject({
      id: "u-first",
      email: "new@example.com",
      display_name: "Newbie",
      is_admin: false,
    });

    // password was set
    expect(bag.updateUserById).toHaveBeenCalledTimes(1);
    expect(bag.updateUserById.mock.calls[0][0]).toBe("u-first");
    expect(bag.updateUserById.mock.calls[0][1].password).toBe("abcdefgh");
    expect(bag.updateUserById.mock.calls[0][1].user_metadata.password_set).toBe(true);

    // CRITICAL (round-6): signOut first arg MUST be the JWT, not user.id.
    expect(bag.signOut).toHaveBeenCalledTimes(1);
    expect(bag.signOut.mock.calls[0][0]).toBe("invite-jwt-aaa");
    expect(bag.signOut.mock.calls[0][0]).not.toBe("u-first");
    expect(bag.signOut.mock.calls[0][1]).toBe("global");

    // profile UPSERT happened
    const upsertCall = bag.fromCalls.find(
      (c) => c.table === "profiles" && c.method === "upsert"
    );
    expect(upsertCall).toBeDefined();
    expect((upsertCall!.args[0] as any).is_admin).toBe(false);
  });

  it("first-setup with admin email writes is_admin=true", async () => {
    bag.getUser.mockResolvedValue({
      data: {
        user: {
          id: "u-admin",
          email: "admin@example.com",
          app_metadata: { team_pass_verified: true },
          user_metadata: { display_name: "Admin" },
        },
      },
      error: null,
    });
    bag.updateUserById.mockResolvedValue({ error: null });
    bag.signOut.mockResolvedValue({ error: null });

    let lookupCount = 0;
    Object.defineProperty(bag, "profileLookupResult", {
      get() {
        lookupCount++;
        if (lookupCount === 1) return { data: null, error: null };
        return {
          data: { display_name: "Admin", is_admin: true },
          error: null,
        };
      },
      configurable: true,
    });

    const req = makeReq({
      body: { password: "abcdefgh" },
      authorization: "Bearer admin-jwt",
    });
    const res = makeRes();
    await setupAccount(req, res as unknown as VercelResponse);

    Object.defineProperty(bag, "profileLookupResult", {
      value: { data: null, error: null },
      writable: true,
      configurable: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.user_summary.is_admin).toBe(true);
    const upsertCall = bag.fromCalls.find(
      (c) => c.table === "profiles" && c.method === "upsert"
    );
    expect((upsertCall!.args[0] as any).is_admin).toBe(true);
  });

  it("ALREADY_SETUP: password_set=true AND profile exists → 409, NO writes, NO signOut (DoS guard)", async () => {
    bag.getUser.mockResolvedValue({
      data: {
        user: {
          id: "u-done",
          email: "done@example.com",
          app_metadata: { team_pass_verified: true },
          user_metadata: { display_name: "Done", password_set: true },
        },
      },
      error: null,
    });
    bag.profileLookupResult = {
      data: { id: "u-done", display_name: "Done", is_admin: false },
      error: null,
    };

    const req = makeReq({
      body: { password: "anything-12345" },
      authorization: "Bearer some-token",
    });
    const res = makeRes();
    await setupAccount(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("ALREADY_SETUP");
    expect(res.body.requires_relogin).toBeUndefined();
    // Critical anti-DoS: no writes, no signOut.
    expect(bag.updateUserById).not.toHaveBeenCalled();
    expect(bag.signOut).not.toHaveBeenCalled();
    expect(
      bag.fromCalls.find((c) => c.method === "upsert")
    ).toBeUndefined();
  });

  it("self-heal: password_set=true + profile missing → 200, profile UPSERTed, NO password set, NO signOut", async () => {
    bag.getUser.mockResolvedValue({
      data: {
        user: {
          id: "u-heal",
          email: "heal@example.com",
          app_metadata: { team_pass_verified: true },
          user_metadata: { display_name: "Heal", password_set: true },
        },
      },
      error: null,
    });

    // First lookup (early-return check) returns null → not the ALREADY_SETUP path
    // Second lookup (response build) returns the just-created profile
    let lookupCount = 0;
    Object.defineProperty(bag, "profileLookupResult", {
      get() {
        lookupCount++;
        if (lookupCount === 1) return { data: null, error: null };
        return {
          data: { display_name: "Heal", is_admin: false },
          error: null,
        };
      },
      configurable: true,
    });

    const req = makeReq({
      body: { password: "ignored-12345" },
      authorization: "Bearer heal-jwt",
    });
    const res = makeRes();
    await setupAccount(req, res as unknown as VercelResponse);

    Object.defineProperty(bag, "profileLookupResult", {
      value: { data: null, error: null },
      writable: true,
      configurable: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.requires_relogin).toBe(false);
    // Self-heal must NOT touch password and must NOT signOut other devices.
    expect(bag.updateUserById).not.toHaveBeenCalled();
    expect(bag.signOut).not.toHaveBeenCalled();
    // But it DOES UPSERT the profile.
    expect(
      bag.fromCalls.find(
        (c) => c.table === "profiles" && c.method === "upsert"
      )
    ).toBeDefined();
  });

  it("signOut failure during first-setup is logged-only and still returns 200", async () => {
    bag.getUser.mockResolvedValue({
      data: {
        user: {
          id: "u-fs",
          email: "fs@example.com",
          app_metadata: { team_pass_verified: true },
          user_metadata: { display_name: "FS" },
        },
      },
      error: null,
    });
    bag.updateUserById.mockResolvedValue({ error: null });
    bag.signOut.mockRejectedValue(new Error("transient"));

    let lookupCount = 0;
    Object.defineProperty(bag, "profileLookupResult", {
      get() {
        lookupCount++;
        if (lookupCount === 1) return { data: null, error: null };
        return {
          data: { display_name: "FS", is_admin: false },
          error: null,
        };
      },
      configurable: true,
    });

    const req = makeReq({
      body: { password: "abcdefgh" },
      authorization: "Bearer fs-jwt",
    });
    const res = makeRes();
    await setupAccount(req, res as unknown as VercelResponse);

    Object.defineProperty(bag, "profileLookupResult", {
      value: { data: null, error: null },
      writable: true,
      configurable: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.requires_relogin).toBe(true);
    expect(bag.signOut).toHaveBeenCalledTimes(1);
  });
});
