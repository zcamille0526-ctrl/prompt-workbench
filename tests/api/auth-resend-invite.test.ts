import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

vi.stubEnv("SHARED_PASSWORD", "team-pass-123");
vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
vi.stubEnv("SITE_URL", "https://test.example.com");

type Bag = {
  rpc: ReturnType<typeof vi.fn>;
  listUsers: ReturnType<typeof vi.fn>;
  inviteUserByEmail: ReturnType<typeof vi.fn>;
  updateUserById: ReturnType<typeof vi.fn>;
};

const bag: Bag = {
  rpc: vi.fn(),
  listUsers: vi.fn(),
  inviteUserByEmail: vi.fn(),
  updateUserById: vi.fn(),
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      admin: {
        listUsers: (...a: unknown[]) => (bag.listUsers as any)(...a),
        inviteUserByEmail: (...a: unknown[]) => (bag.inviteUserByEmail as any)(...a),
        updateUserById: (...a: unknown[]) => (bag.updateUserById as any)(...a),
      },
    },
    rpc: (...a: unknown[]) => (bag.rpc as any)(...a),
  }),
}));

const handler = (await import("../../api/auth/resend-invite")).default;
const resendMod = await import("../../api/auth/resend-invite");
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

function makeReq(opts: { body?: unknown; method?: string; ip?: string }): VercelRequest {
  return {
    method: opts.method ?? "POST",
    body: opts.body,
    query: {},
    headers: opts.ip ? { "x-forwarded-for": opts.ip } : {},
  } as unknown as VercelRequest;
}

beforeEach(() => {
  bag.rpc.mockReset();
  bag.listUsers.mockReset();
  bag.inviteUserByEmail.mockReset();
  bag.updateUserById.mockReset();
  resendMod.__resetIpThrottleForTests();
  supaLib.__resetServiceRoleClientForTests();
});

const OPAQUE_MSG = "如果该邮箱可重发，我们已发送邀请";

describe("/api/auth/resend-invite", () => {
  it("400 WRONG_TEAM_PASSWORD when team password mismatches (no DB calls)", async () => {
    const req = makeReq({
      body: { email: "x@y.com", team_password: "wrong" },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("WRONG_TEAM_PASSWORD");
    expect(bag.rpc).not.toHaveBeenCalled();
    expect(bag.listUsers).not.toHaveBeenCalled();
  });

  it("opaque 200 when user does not exist (no email-probe leak)", async () => {
    bag.rpc.mockResolvedValue({ data: true, error: null });
    bag.listUsers.mockResolvedValue({ data: { users: [] }, error: null });

    const req = makeReq({
      body: { email: "ghost@y.com", team_password: "team-pass-123" },
      ip: "1.1.1.1",
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe(OPAQUE_MSG);
    expect(res.body.error).toBeUndefined();
    expect(bag.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("opaque 200 when user already setup (does NOT re-invite)", async () => {
    bag.rpc.mockResolvedValue({ data: true, error: null });
    bag.listUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: "u1",
            email: "done@y.com",
            user_metadata: { password_set: true, display_name: "Done" },
          },
        ],
      },
      error: null,
    });

    const req = makeReq({
      body: { email: "done@y.com", team_password: "team-pass-123" },
      ip: "2.2.2.2",
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe(OPAQUE_MSG);
    expect(bag.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("happy path: re-invite uses existing display_name, NOT a client-supplied one, and re-writes team_pass_verified", async () => {
    bag.rpc.mockResolvedValue({ data: true, error: null });
    bag.listUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: "u1",
            email: "pending@y.com",
            user_metadata: { display_name: "Original Name" },
            app_metadata: { team_pass_verified: false },
          },
        ],
      },
      error: null,
    });
    bag.inviteUserByEmail.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
    bag.updateUserById.mockResolvedValue({ error: null });

    const req = makeReq({
      body: {
        email: "pending@y.com",
        team_password: "team-pass-123",
        // Client tries to inject display_name — strict schema must reject.
        // We DON'T pass it here; covered by separate strict-schema test.
      },
      ip: "3.3.3.3",
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe(OPAQUE_MSG);
    expect(bag.inviteUserByEmail).toHaveBeenCalledTimes(1);
    const args = bag.inviteUserByEmail.mock.calls[0];
    expect(args[0]).toBe("pending@y.com");
    expect(args[1].data.display_name).toBe("Original Name");
    expect(args[1].redirectTo).toBe("https://test.example.com/auth/callback");

    // Orphan-repair: team_pass_verified must be re-written to true.
    expect(bag.updateUserById).toHaveBeenCalledTimes(1);
    expect(bag.updateUserById.mock.calls[0][0]).toBe("u1");
    expect(bag.updateUserById.mock.calls[0][1]).toEqual({
      app_metadata: { team_pass_verified: true },
    });
  });

  it("strict schema rejects client-supplied display_name", async () => {
    const req = makeReq({
      body: {
        email: "x@y.com",
        team_password: "team-pass-123",
        display_name: "Imposter",
      },
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid payload");
  });

  it("429 THROTTLED when email-level RPC returns false (atomic cooldown)", async () => {
    bag.rpc.mockResolvedValue({ data: false, error: null });

    const req = makeReq({
      body: { email: "x@y.com", team_password: "team-pass-123" },
      ip: "4.4.4.4",
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(429);
    expect(res.body.error).toBe("THROTTLED");
    // Critical: throttle short-circuits before listUsers — does NOT consume
    // a Supabase API call when the cooldown rejects.
    expect(bag.listUsers).not.toHaveBeenCalled();
    expect(bag.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("429 IP_THROTTLED after 10 requests within an hour from the same IP (best-effort UX guard)", async () => {
    bag.rpc.mockResolvedValue({ data: true, error: null });
    bag.listUsers.mockResolvedValue({ data: { users: [] }, error: null });

    const ip = "5.5.5.5";
    for (let i = 0; i < 10; i++) {
      const req = makeReq({
        body: { email: `n${i}@y.com`, team_password: "team-pass-123" },
        ip,
      });
      const res = makeRes();
      await handler(req, res as unknown as VercelResponse);
      expect(res.statusCode).toBe(200);
    }
    // 11th from same IP → throttled
    const req = makeReq({
      body: { email: "n11@y.com", team_password: "team-pass-123" },
      ip,
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toBe("THROTTLED");
  });

  it("opaque 200 even on internal display_name corruption (does not leak account state)", async () => {
    bag.rpc.mockResolvedValue({ data: true, error: null });
    bag.listUsers.mockResolvedValue({
      data: {
        users: [
          {
            id: "u1",
            email: "broken@y.com",
            user_metadata: {}, // missing display_name → corrupted state
          },
        ],
      },
      error: null,
    });

    const req = makeReq({
      body: { email: "broken@y.com", team_password: "team-pass-123" },
      ip: "6.6.6.6",
    });
    const res = makeRes();
    await handler(req, res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe(OPAQUE_MSG);
    expect(bag.inviteUserByEmail).not.toHaveBeenCalled();
  });
});

// NOTE: Spec §9 also requires a real-Postgres atomicity test (Promise.all of
// two concurrent same-email calls → exactly one true). That cannot run in
// unit tests with mocked RPC; it's tracked for the Step 3 integration suite.
