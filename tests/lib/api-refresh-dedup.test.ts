/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.stubEnv("VITE_API_BASE_URL", "");
vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
vi.stubEnv("VITE_SUPABASE_ANON_KEY", "sb_publishable_test");

// Provide a stub for supabaseClient so api.ts → authClient → supabaseClient
// doesn't try to talk to a real Supabase instance during the test.
vi.mock("../../src/lib/supabaseClient", () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      signOut: async () => ({ error: null }),
      setSession: async () => ({ data: { session: null }, error: null }),
    },
  }),
}));

const { api, __resetRefreshDedupForTests } = await import("../../src/lib/api");

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.sessionStorage.setItem("pw.access_token", "AT-old");
  window.sessionStorage.setItem("pw.refresh_token", "RT-old");
  __resetRefreshDedupForTests();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe("api refresh deduplication", () => {
  it("two concurrent 401s share ONE /api/auth/refresh call, both retries succeed", async () => {
    // Sequence of fetches we expect:
    //   1. GET /api/prompts → 401  (callA)
    //   2. GET /api/prompts → 401  (callB, fired before callA's refresh resolves)
    //   3. POST /api/auth/refresh → 200 {access_token: AT-new, refresh_token: RT-new}
    //   4. GET /api/prompts → 200 [...]  (callA retry)
    //   5. GET /api/prompts → 200 [...]  (callB retry)
    //
    // Critical assertion: exactly ONE call to /api/auth/refresh, not two.
    //
    // We gate the refresh response on a manual deferred so callB has time to
    // arrive at refreshAccessTokenDeduped while callA is still waiting.

    let resolveRefresh!: () => void;
    const refreshGate = new Promise<void>((r) => {
      resolveRefresh = r;
    });

    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/auth/refresh") {
        // Block until both callers have queued up.
        await refreshGate;
        return jsonResponse(200, {
          access_token: "AT-new",
          refresh_token: "RT-new",
          expires_in: 3600,
        });
      }
      if (url === "/api/prompts") {
        // Look at the Authorization header to decide between original 401
        // and the post-refresh retry.
        const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1];
        const auth = (init?.headers as Record<string, string>)?.authorization;
        if (auth === "Bearer AT-new") {
          return jsonResponse(200, []);
        }
        return jsonResponse(401, { error: "Unauthorized" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const callA = api.request<unknown[]>("/api/prompts");
    // Microtask gap so callA's first fetch (the 401) settles before callB starts.
    await Promise.resolve();
    const callB = api.request<unknown[]>("/api/prompts");
    // Let both calls run far enough to both queue on refreshAccessTokenDeduped.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    resolveRefresh();

    const [a, b] = await Promise.all([callA, callB]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);

    const refreshCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/auth/refresh"
    );
    expect(refreshCalls.length).toBe(1);

    // And we should see both retries succeed (two 200 prompts calls AFTER
    // the refresh).
    const promptsCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/prompts"
    );
    // 2 initial 401s + 2 retries = 4.
    expect(promptsCalls.length).toBe(4);
  });

  it("after a refresh completes, a LATER 401 wave triggers a fresh refresh", async () => {
    // First wave: 401 → refresh → 200. Then a delayed second call also 401s,
    // which must NOT reuse the stale resolved promise — a fresh refresh fires.

    let refreshCallCount = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/auth/refresh") {
        refreshCallCount++;
        return jsonResponse(200, {
          access_token: `AT-new-${refreshCallCount}`,
          refresh_token: `RT-new-${refreshCallCount}`,
          expires_in: 3600,
        });
      }
      if (url === "/api/prompts") {
        const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1];
        const auth = (init?.headers as Record<string, string>)?.authorization;
        if (auth?.startsWith("Bearer AT-new-")) {
          return jsonResponse(200, []);
        }
        return jsonResponse(401, { error: "Unauthorized" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await api.request("/api/prompts");
    // After the first refresh resolves and pendingRefresh clears, simulate a
    // new wave by reverting the stored token so the second call also 401s.
    window.sessionStorage.setItem("pw.access_token", "AT-stale-again");
    window.sessionStorage.setItem("pw.refresh_token", "RT-stale-again");
    await api.request("/api/prompts");

    expect(refreshCallCount).toBe(2);
  });

  it("refresh returning 401 (refresh_token invalid) surfaces as 401 to the caller", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/auth/refresh") {
        return jsonResponse(401, { error: "REFRESH_FAILED" });
      }
      if (url === "/api/prompts") {
        return jsonResponse(401, { error: "Unauthorized" });
      }
      throw new Error(`unexpected: ${url}`);
    });

    await expect(api.request("/api/prompts")).rejects.toThrow("Session expired");
  });
});
