/**
 * Schema validation tests (web-blueprint.md §2.1, §7, §10).
 */
import { describe, it, expect } from "vitest";
import {
  sendBodySchema,
  createBodySchema,
  confirmBodySchema,
  wsClientMessageSchema,
  appsWebSchema,
  MAX_BODY_BYTES,
  MAX_WS_FRAME_BYTES,
} from "./schemas.js";

describe("§2.1/§7 request + WS schemas", () => {
  it("accepts a valid send and rejects empty/oversize/extra", () => {
    expect(sendBodySchema.safeParse({ input: "hi" }).success).toBe(true);
    expect(sendBodySchema.safeParse({ input: "" }).success).toBe(false);
    expect(sendBodySchema.safeParse({ input: "x", extra: 1 }).success).toBe(false);
    expect(sendBodySchema.safeParse({ input: "a".repeat(100_001) }).success).toBe(false);
  });

  it("validates create and confirm bodies", () => {
    expect(createBodySchema.safeParse({}).success).toBe(true);
    expect(createBodySchema.safeParse({ name: "x" }).success).toBe(true);
    expect(confirmBodySchema.safeParse({ requestId: "r1", decision: "approve" }).success).toBe(true);
    expect(confirmBodySchema.safeParse({ requestId: "r1", decision: "nope" }).success).toBe(false);
    expect(confirmBodySchema.safeParse({ decision: "approve" }).success).toBe(false);
  });

  it("validates WS client frames (no principal in the body)", () => {
    expect(wsClientMessageSchema.safeParse({ kind: "subscribe", sessionId: "s1" }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ kind: "ping" }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ kind: "subscribe", userId: "x" }).success).toBe(false);
    expect(wsClientMessageSchema.safeParse({ kind: "unknown" }).success).toBe(false);
  });

  it("validates apps.web config and applies defaults", () => {
    const parsed = appsWebSchema.safeParse({
      auth: { issuer: "https://i.test", audience: "aud" },
      tls: { certEnv: "C", keyEnv: "K" },
      postgresUrlEnv: "P",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.rateLimit.perMinute).toBe(120);
      expect(parsed.data.rateLimit.sendPerMinute).toBe(20);
      expect(parsed.data.maxSessionsPerUser).toBe(100);
      expect(parsed.data.sessionShareEnabled).toBe(false);
    }
    expect(appsWebSchema.safeParse({ auth: { issuer: "not-a-url", audience: "a" } }).success).toBe(false);
  });

  it("exposes positive size limits", () => {
    expect(MAX_BODY_BYTES).toBeGreaterThan(0);
    expect(MAX_WS_FRAME_BYTES).toBeGreaterThan(0);
  });
});
