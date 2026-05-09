import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");

type Bag = {
  signInWithPassword: ReturnType<typeof vi.fn>;
  refreshSession: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
  getUser: ReturnType<typeof vi.fn>;
  profileLookupResult: { data: unknown; error: unknown };
};

const bag: Bag = {
  signInWithPassword: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(),
  getUser: vi.fn(),
  profileLookupResult: { data: null, error: null },
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: (...a: unknown[]) => (bag.signInWithPassword as any)(...a),
      refreshSession: (...a: unknown[]) => (bag.refreshSession as any)(...a),
      getUser: (...a: unknown[]) => (bag.getUser as any)(...a),
      admin: {
        signOut: (...a: unknown[]) => (bag.signOut as any)(...a),
      },
    },
    from: () => {
      const c: any = {};
      c.select = () => c;
      c.eq = () => c;
      c.single = () => Promise.resolve(bag.profileLookupResult);
      return c;
    },
  }),
}));

const login = (await import("../../api/auth/login")).default;
const refresh = (await import("../../api/auth/refresh")).default;
const logout = (await import("../../api/auth/logout")).default;
const me = (await import("../../api/auth/me")).default;
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

beforeEach(() => {
  bag.signInWithPassword.mockReset();
  bag.refreshSession.mockReset();
  bag.signOut.mockReset();
  bag.getUser.mockReset();
  bag.profileLookupResult = { data: null, error: null };
  supaLib.__resetServiceRoleClientForTests();
});

describe("/api/auth/login", () => {
  it("invalid credentials → 401 INVALID_CREDENTIALS", async () => {
    bag.signInWithPassword.mockResolvedValue({
      data: null,
      error: { message: "Invalid login credentials" },
    });
    const req = makeReq({ body: { email: "x@y.com", password: "wrong" } });
    const res = makeRes();
    await login(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("INVALID_CREDENTIALS");
  });

  it("email_not_confirmed → 401 EMAIL_NOT_VERIFIED", async () => {
    bag.signInWithPassword.mockResolvedValue({
      data: null,
      error: { code: "email_not_confirmed", message: "Email not confirmed" },
    });
    const req = makeReq({ body: { email: "x@y.com", password: "p" } });
    const res = makeRes();
    await login(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("EMAIL_NOT_VERIFIED");
  });

  it("happy path returns access/refresh token + user_summary", async () => {
    bag.signInWithPassword.mockResolvedValue({
      data: {
        session: {
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 3600,
        },
        user: { id: "u1", email: "x@y.com" },
      },
      error: null,
    });
    bag.profileLookupResult = {
      data: { display_name: "X", is_admin: false },
      error: null,
    };
    const req = makeReq({ body: { email: "x@y.com", password: "p" } });
    const res = makeRes();
    await login(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body.access_token).toBe("AT");
    expect(res.body.refresh_token).toBe("RT");
    expect(res.body.user_summary).toMatchObject({
      id: "u1",
      email: "x@y.com",
      display_name: "X",
      is_admin: false,
    });
  });

  it("missing profile is treated as EMAIL_NOT_VERIFIED", async () => {
    bag.signInWithPassword.mockResolvedValue({
      data: {
        session: { access_token: "A", refresh_token: "R", expires_in: 60 },
        user: { id: "u1", email: "x@y.com" },
      },
      error: null,
    });
    bag.profileLookupResult = { data: null, error: { message: "no rows" } };
    const req = makeReq({ body: { email: "x@y.com", password: "p" } });
    const res = makeRes();
    await login(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("EMAIL_NOT_VERIFIED");
  });
});

describe("/api/auth/refresh", () => {
  it("invalid refresh_token → 401", async () => {
    bag.refreshSession.mockResolvedValue({
      data: null,
      error: { message: "invalid" },
    });
    const req = makeReq({ body: { refresh_token: "bad" } });
    const res = makeRes();
    await refresh(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe("REFRESH_FAILED");
  });

  it("happy path returns new access/refresh", async () => {
    bag.refreshSession.mockResolvedValue({
      data: {
        session: {
          access_token: "AT2",
          refresh_token: "RT2",
          expires_in: 3600,
        },
      },
      error: null,
    });
    const req = makeReq({ body: { refresh_token: "RT" } });
    const res = makeRes();
    await refresh(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body.access_token).toBe("AT2");
    expect(res.body.refresh_token).toBe("RT2");
  });

  it("rejects unknown fields", async () => {
    const req = makeReq({ body: { refresh_token: "RT", evil: 1 } });
    const res = makeRes();
    await refresh(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
  });
});

describe("/api/auth/logout", () => {
  it("calls admin.signOut with bearer token + 'local' scope, returns 200", async () => {
    bag.signOut.mockResolvedValue({ error: null });
    const req = makeReq({ body: {}, authorization: "Bearer AT" });
    const res = makeRes();
    await logout(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(bag.signOut).toHaveBeenCalledTimes(1);
    expect(bag.signOut.mock.calls[0][0]).toBe("AT");
    // Critical anti-regression: logout must use 'local', NOT 'global'.
    // 'global' would kill the user's other devices (spec §13 multi-device).
    expect(bag.signOut.mock.calls[0][1]).toBe("local");
    expect(bag.signOut.mock.calls[0][1]).not.toBe("global");
  });

  it("tolerates signOut failure and still returns 200", async () => {
    bag.signOut.mockRejectedValue(new Error("boom"));
    const req = makeReq({ body: {}, authorization: "Bearer AT" });
    const res = makeRes();
    await logout(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
  });

  it("no authorization header still returns 200 (frontend clears local state)", async () => {
    const req = makeReq({ body: {} });
    const res = makeRes();
    await logout(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(bag.signOut).not.toHaveBeenCalled();
  });
});

describe("/api/auth/me", () => {
  it("no token → 401", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await me(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("valid token + profile + password_set → returns user", async () => {
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
    bag.profileLookupResult = {
      data: { display_name: "X", is_admin: true },
      error: null,
    };
    const req = makeReq({ method: "GET", authorization: "Bearer AT" });
    const res = makeRes();
    await me(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      id: "u1",
      email: "x@y.com",
      display_name: "X",
      is_admin: true,
    });
  });

  it("valid token but password_set=false → 401 (closes reverse half-success window)", async () => {
    bag.getUser.mockResolvedValue({
      data: {
        user: {
          id: "u1",
          email: "x@y.com",
          user_metadata: {},
        },
      },
      error: null,
    });
    const req = makeReq({ method: "GET", authorization: "Bearer AT" });
    const res = makeRes();
    await me(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("non-GET → 405", async () => {
    const req = makeReq({ method: "POST", authorization: "Bearer AT" });
    const res = makeRes();
    await me(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(405);
  });
});
