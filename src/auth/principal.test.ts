/**
 * Principal verification tests (web-blueprint.md §4.1).
 * Given a local JWKS, When a token is missing/malformed/expired/wrong-aud,
 * Then verification throws AuthError (→ 401 before any CoreAPI call).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { PrincipalVerifier, AuthError, bearerToken, defaultJwksUri } from "./principal.js";
import { makeTestKeys, mintToken, TEST_ISSUER, TEST_AUDIENCE, type TestKeys } from "../test-harness.js";

describe("§4.1 PrincipalVerifier", () => {
  let keys: TestKeys;
  let verifier: PrincipalVerifier;

  beforeAll(async () => {
    keys = await makeTestKeys();
    verifier = new PrincipalVerifier({ issuer: TEST_ISSUER, audience: TEST_AUDIENCE }, keys.keyResolver);
  });

  it("verifies a valid token into a principal with roles", async () => {
    const token = await mintToken(keys, "user-a", { roles: ["product"] });
    const p = await verifier.verifyHeader(`Bearer ${token}`);
    expect(p.userId).toBe("user-a");
    expect(p.roles).toEqual(["product"]);
  });

  it("rejects a missing header", async () => {
    await expect(verifier.verifyHeader(undefined)).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a malformed header", async () => {
    await expect(verifier.verifyHeader("Token abc")).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects an expired token", async () => {
    const token = await mintToken(keys, "user-a", { expired: true });
    await expect(verifier.verifyHeader(`Bearer ${token}`)).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a wrong-audience token", async () => {
    const token = await mintToken(keys, "user-a", { audience: "other" });
    await expect(verifier.verifyHeader(`Bearer ${token}`)).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a wrong-issuer token", async () => {
    const token = await mintToken(keys, "user-a", { issuer: "https://evil.test" });
    await expect(verifier.verifyHeader(`Bearer ${token}`)).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects an HS256-signed token even with the correct issuer/audience (algorithm allow-list)", async () => {
    // Defense in depth (§4.1): a symmetric HS256 token must be rejected by the
    // RS256/ES256 allow-list — the JWKS-confusion attack where a public key is
    // used as an HMAC secret. The payload is otherwise valid.
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode("public-key-material-abused-as-hmac-secret");
    const hs256 = await new SignJWT({ roles: ["product"] })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-a")
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setExpirationTime("1h")
      .sign(secret);
    await expect(verifier.verifyHeader(`Bearer ${hs256}`)).rejects.toBeInstanceOf(AuthError);
  });

  it("bearerToken extracts and defaults jwks uri", () => {
    expect(bearerToken("Bearer xyz")).toBe("xyz");
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken("Basic xyz")).toBeUndefined();
    expect(defaultJwksUri("https://i.test/")).toBe("https://i.test/.well-known/jwks.json");
    expect(defaultJwksUri("https://i.test")).toBe("https://i.test/.well-known/jwks.json");
  });
});
