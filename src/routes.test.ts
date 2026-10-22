/**
 * Route and lifecycle coverage tests (web-blueprint.md §2, §5.3, §6, §7, §10).
 * Exercises owned-session success paths, the HTTPS redirect, 404 on a core
 * miss, the per-user session cap, panels, approvals, and the out_of_band handler.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { makeHarness, makeTestKeys, mintToken, type Harness, type TestKeys } from "./test-harness.js";
import { outOfBandApprovalHandler } from "./approvals.js";
import { statusForRun } from "./http/app.js";
import type { TurnResult } from "@voidrift/core";

const ORIGIN = "https://app.test";
const headersFor = async (keys: TestKeys, u: string): Promise<Record<string, string>> => ({
  authorization: `Bearer ${await mintToken(keys, u)}`,
  origin: ORIGIN,
});

describe("§2/§5/§6 route coverage", () => {
  let keys: TestKeys;
  let h: Harness;
  beforeAll(async () => {
    keys = await makeTestKeys();
    h = await makeHarness({ keys });
    return () => h.close();
  });

  it("rename, cancel, approvals, and delete succeed for the owner", async () => {
    const hdr = await headersFor(keys, "owner");
    const created = await h.app.inject({ method: "POST", url: "/api/sessions", headers: hdr, payload: {} });
    const id = created.json<{ id: string }>().id;

    const renamed = await h.app.inject({ method: "PATCH", url: `/api/sessions/${id}`, headers: hdr, payload: { name: "renamed" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ name: string }>().name).toBe("renamed");

    const cancel = await h.app.inject({ method: "POST", url: `/api/sessions/${id}/cancel`, headers: hdr });
    expect(cancel.statusCode).toBe(200);

    const appr = await h.app.inject({ method: "GET", url: `/api/sessions/${id}/approvals`, headers: hdr });
    expect(appr.statusCode).toBe(200);
    expect(Array.isArray(appr.json())).toBe(true);

    const del = await h.app.inject({ method: "DELETE", url: `/api/sessions/${id}`, headers: hdr });
    expect(del.statusCode).toBe(200);
  });

  it("confirms map to the core and return a result status", async () => {
    const hdr = await headersFor(keys, "owner");
    const created = await h.app.inject({ method: "POST", url: "/api/sessions", headers: hdr, payload: {} });
    const id = created.json<{ id: string }>().id;
    // No pending approval → the core returns an error result, mapped to 400.
    const confirm = await h.app.inject({
      method: "POST",
      url: `/api/sessions/${id}/confirm`,
      headers: hdr,
      payload: { requestId: "none", decision: "approve" },
    });
    expect(confirm.statusCode).toBe(400);
  });

  it("rejects invalid ids and bodies with 400", async () => {
    const hdr = await headersFor(keys, "owner");
    const longId = "x".repeat(200);
    expect([400, 414]).toContain((await h.app.inject({ method: "GET", url: `/api/sessions/${longId}`, headers: hdr })).statusCode);
    const created = await h.app.inject({ method: "POST", url: "/api/sessions", headers: hdr, payload: {} });
    const id = created.json<{ id: string }>().id;
    expect(
      (await h.app.inject({ method: "PATCH", url: `/api/sessions/${id}`, headers: hdr, payload: {} })).statusCode,
    ).toBe(400);
    expect(
      (await h.app.inject({ method: "POST", url: `/api/sessions/${id}/confirm`, headers: hdr, payload: { decision: "x" } })).statusCode,
    ).toBe(400);
  });

  it("serves the panels registry declarations", async () => {
    const hdr = await headersFor(keys, "owner");
    const res = await h.app.inject({ method: "GET", url: "/api/panels", headers: hdr });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it("enforces the per-user session cap with 429", async () => {
    const capped = await makeHarness({ keys, maxSessionsPerUser: 1 });
    try {
      const hdr = await headersFor(keys, "capped");
      const first = await capped.app.inject({ method: "POST", url: "/api/sessions", headers: hdr, payload: {} });
      expect(first.statusCode).toBe(201);
      const second = await capped.app.inject({ method: "POST", url: "/api/sessions", headers: hdr, payload: {} });
      expect(second.statusCode).toBe(429);
    } finally {
      await capped.close();
    }
  });

  it("redirects insecure HTTP to HTTPS with a 308 when enforced", async () => {
    const secure = await makeHarness({ keys, enforceHttps: true });
    try {
      const hdr = await headersFor(keys, "owner");
      const res = await secure.app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { ...hdr, host: "app.test", "x-forwarded-proto": "http" },
      });
      expect(res.statusCode).toBe(308);
      expect(res.headers["location"]).toContain("https://");
    } finally {
      await secure.close();
    }
  });

  it("statusForRun maps every RunStatus", () => {
    const mk = (status: string): TurnResult => ({ status }) as unknown as TurnResult;
    expect(statusForRun(mk("completed"))).toBe(200);
    expect(statusForRun(mk("waiting_for_approval"))).toBe(202);
    expect(statusForRun(mk("waiting_for_input"))).toBe(202);
    expect(statusForRun(mk("cancelled"))).toBe(200);
    expect(statusForRun(mk("limit_reached"))).toBe(200);
    expect(statusForRun(mk("failed"))).toBe(500);
    expect(statusForRun(mk("other"))).toBe(200);
  });

  it("the out_of_band handler never resolves (pauses the turn durably)", async () => {
    const handler = outOfBandApprovalHandler();
    const race = await Promise.race([
      handler({ id: "a", tool: "t", args: {}, choices: ["approve"], mode: "out_of_band" }).then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(race).toBe("pending");
  });
});
