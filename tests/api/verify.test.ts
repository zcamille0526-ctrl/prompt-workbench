import { describe, it, expect, vi } from "vitest";

vi.stubEnv("SHARED_PASSWORD", "test-password-123");

const { handler, verifyToken } = await import("../../api/verify");

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/verify", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("verify handler", () => {
  it("returns token for correct password", async () => {
    const req = makeRequest({ password: "test-password-123" });
    const res = await handler(req);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.token).toBeDefined();
    expect(typeof data.token).toBe("string");
  });

  it("returns 401 for wrong password", async () => {
    const req = makeRequest({ password: "wrong" });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing password", async () => {
    const req = makeRequest({});
    const res = await handler(req);
    expect(res.status).toBe(400);
  });
});

describe("verifyToken", () => {
  it("verifies a token it issued", async () => {
    const req = makeRequest({ password: "test-password-123" });
    const res = await handler(req);
    const data = await res.json();
    expect(verifyToken(data.token)).toBe(true);
  });

  it("rejects a tampered token", () => {
    expect(verifyToken("invalid.token")).toBe(false);
  });
});
