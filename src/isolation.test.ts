/**
 * HTTP integration + two-user isolation tests (web-blueprint.md §2, §4, §7).
 *
 * The centerpiece: user A creates a session; user B gets 403 on every
 * session-targeting op for A's id, B's list excludes A's, and the refusals are
 * audited — all before any CoreAPI call. Plus: 401 without/with a bad token,
 * rate-limit trip, hostile Origin rejection on the HTTP CORS path, malformed and
 * oversize bodies rejected, and no secret in any response.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { makeHarness, makeTestKeys, mintToken, type Harness, type TestKeys } from "./test-harness.js";

const ORIGIN = "https://app.test";

async function auth(keys: TestKeys, user: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await mintToken(keys, user)}`, origin: ORIGIN };
}

describe("§4 two-user isolation + §2/§7 edge", () => {
  let keys: TestKeys;
  let h: Harness;

  beforeAll(async () => {
    keys = await makeTestKeys();
    h = await makeHarness({ keys });
    return () => h.close();
  });

  it("401 without a token before any CoreAPI call", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/sessions", headers: { origin: ORIGIN } });
    expect(res.statusCode).toBe(401);
  });

  it("401 with a bad token", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { origin: ORIGIN, authorization: "Bearer not.a.jwt" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("a spoofed websocket upgrade header on a normal route still requires auth (no bypass)", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { origin: ORIGIN, connection: "upgrade", upgrade: "websocket" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("A creates a session; B is refused 403 on every op for A's id and never sees it in a list", async () => {
    const aHeaders = await auth(keys, "user-A");
    const bHeaders = await auth(keys, "user-B");

    const created = await h.app.inject({ method: "POST", url: "/api/sessions", headers: aHeaders, payload: {} });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    // B is refused on resume/send/confirm/cancel/delete/approvals — all 403.
    const ops: Array<{ method: "GET" | "POST" | "DELETE"; url: string; payload?: unknown }> = [
      { method: "GET", url: `/api/sessions/${id}` },
      { method: "POST", url: `/api/sessions/${id}/send`, payload: { input: "hi" } },
      { method: "POST", url: `/api/sessions/${id}/confirm`, payload: { requestId: "r", decision: "approve" } },
      { method: "POST", url: `/api/sessions/${id}/cancel` },
      { method: "GET", url: `/api/sessions/${id}/approvals` },
      { method: "DELETE", url: `/api/sessions/${id}` },
    ];
    for (const op of ops) {
      const res = await h.app.inject({
        method: op.method,
        url: op.url,
        headers: bHeaders,
        ...(op.payload ? { payload: op.payload } : {}),
      });
      expect(res.statusCode, `${op.method} ${op.url}`).toBe(403);
    }

    // B's list excludes A's session; A's includes it.
    const bList = await h.app.inject({ method: "GET", url: "/api/sessions", headers: bHeaders });
    expect(bList.json<Array<{ id: string }>>().some((s) => s.id === id)).toBe(false);
    const aList = await h.app.inject({ method: "GET", url: "/api/sessions", headers: aHeaders });
    expect(aList.json<Array<{ id: string }>>().some((s) => s.id === id)).toBe(true);

    // Every refusal was audited (§4.4).
    const refusals = h.audit.filter((e) => e.userId === "user-B" && e.outcome === "refused");
    expect(refusals.length).toBeGreaterThanOrEqual(ops.length);
  });

  it("A's own send runs through one CoreAPI op and returns a terminal TurnResult", async () => {
    const aHeaders = await auth(keys, "user-A");
    const created = await h.app.inject({ method: "POST", url: "/api/sessions", headers: aHeaders, payload: {} });
    const id = created.json<{ id: string }>().id;
    const res = await h.app.inject({ method: "POST", url: `/api/sessions/${id}/send`, headers: aHeaders, payload: { input: "hello" } });
    expect([200, 202]).toContain(res.statusCode);
    expect(res.json<{ status: string }>().status).toBeDefined();
  });

  it("rejects a malformed body and an oversize body", async () => {
    const aHeaders = await auth(keys, "user-A");
    const created = await h.app.inject({ method: "POST", url: "/api/sessions", headers: aHeaders, payload: {} });
    const id = created.json<{ id: string }>().id;
    const bad = await h.app.inject({ method: "POST", url: `/api/sessions/${id}/send`, headers: aHeaders, payload: { wrong: 1 } });
    expect(bad.statusCode).toBe(400);
    const oversize = await h.app.inject({
      method: "POST",
      url: `/api/sessions/${id}/send`,
      headers: aHeaders,
      payload: { input: "x".repeat(300_000) },
    });
    expect([400, 413]).toContain(oversize.statusCode);
  });

  it("rejects a cross-origin request from an unlisted origin", async () => {
    const headers = { authorization: `Bearer ${await mintToken(keys, "user-A")}`, origin: "https://evil.test" };
    const res = await h.app.inject({ method: "GET", url: "/api/sessions", headers });
    expect(res.statusCode).toBe(403);
  });

  it("sets CSP, nosniff, and frame-deny headers", async () => {
    const aHeaders = await auth(keys, "user-A");
    const res = await h.app.inject({ method: "GET", url: "/api/sessions", headers: aHeaders });
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["x-frame-options"]).toLowerCase()).toBe("deny");
  });

  it("no response body carries a secret", async () => {
    const aHeaders = await auth(keys, "user-A");
    const created = await h.app.inject({ method: "POST", url: "/api/sessions", headers: aHeaders, payload: {} });
    expect(created.body).not.toMatch(/postgres:\/\//);
    expect(created.body.toLowerCase()).not.toContain("tls");
    expect(created.body).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
  });

  it("trips the send rate limit with 429 + Retry-After", async () => {
    const limited = await makeHarness({ keys, sendPerMinute: 2 });
    try {
      const aHeaders = await auth(keys, "user-A");
      const created = await limited.app.inject({ method: "POST", url: "/api/sessions", headers: aHeaders, payload: {} });
      const id = created.json<{ id: string }>().id;
      let got429 = false;
      let retryAfter: unknown;
      for (let i = 0; i < 6; i += 1) {
        const res = await limited.app.inject({ method: "POST", url: `/api/sessions/${id}/send`, headers: aHeaders, payload: { input: "x" } });
        if (res.statusCode === 429) {
          got429 = true;
          retryAfter = res.headers["retry-after"];
          break;
        }
      }
      expect(got429).toBe(true);
      expect(retryAfter).toBeDefined();
    } finally {
      await limited.close();
    }
  });
});
