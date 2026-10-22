/**
 * Security helper tests (web-blueprint.md §7).
 */
import { describe, it, expect } from "vitest";
import { rateLimitKey, CONTENT_SECURITY_POLICY, sendRateLimit } from "./security.js";
import { originAllowed } from "../stream/relay.js";
import type { FastifyRequest } from "fastify";

describe("§7 security helpers", () => {
  it("keys the rate limiter by principal when present, else by IP", () => {
    const withP = { principal: { userId: "A", roles: [] }, ip: "1.2.3.4" } as unknown as FastifyRequest;
    const withoutP = { ip: "1.2.3.4" } as unknown as FastifyRequest;
    expect(rateLimitKey(withP)).toBe("u:A");
    expect(rateLimitKey(withoutP)).toBe("ip:1.2.3.4");
  });

  it("allows only configured origins and rejects absent/hostile ones", () => {
    const allow = ["https://app.test"];
    expect(originAllowed("https://app.test", allow)).toBe(true);
    expect(originAllowed("https://evil.test", allow)).toBe(false);
    expect(originAllowed(undefined, allow)).toBe(false);
  });

  it("CSP disallows inline script and framing", () => {
    expect(CONTENT_SECURITY_POLICY["script-src"]).toEqual(["'self'"]);
    expect(CONTENT_SECURITY_POLICY["frame-ancestors"]).toEqual(["'none'"]);
  });

  it("sendRateLimit carries the tighter bound", () => {
    const cfg = sendRateLimit(5);
    expect(cfg.config.rateLimit.max).toBe(5);
  });
});
