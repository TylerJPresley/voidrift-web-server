/**
 * Request-principal authentication (web-blueprint.md §4.1).
 *
 * Every HTTP request and every WebSocket upgrade is authenticated BEFORE any
 * route or CoreAPI call runs. The backend verifies an OIDC/JWT bearer credential
 * with `jose` against the configured issuer and audience, establishing a
 * `Principal { userId, roles }`. Verification checks signature, issuer, audience,
 * and expiry; a missing, malformed, or expired credential is rejected and no
 * CoreAPI call is made. Identity provisioning, passwords, and MFA belong to the
 * external IdP — the backend consumes verified identity and NEVER stores a
 * credential. The principal is request-scoped and never trusted from the client
 * body; it comes only from the verified token.
 */
import { jwtVerify, createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** The authenticated identity for a request (§4.1). Never sourced from the body. */
export interface Principal {
  readonly userId: string;
  readonly roles: readonly string[];
}

export interface AuthConfig {
  readonly issuer: string;
  readonly audience: string;
  /** The JWKS endpoint; discovered from the issuer when absent (§4.1, §10). */
  readonly jwksUri?: string;
}

/** The seam the verifier resolves keys through. Tests inject a local key set so
 * no network call is made; production uses the issuer's remote JWKS. */
export type KeyResolver = JWTVerifyGetKey;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Verifies bearer tokens into a `Principal`. The key resolver is injected so a
 * test supplies a local JWKS (no network) and production supplies the issuer's
 * remote JWKS (§4.1 integration test: an injected test JWT issuer/JWKS).
 */
export class PrincipalVerifier {
  private readonly keys: KeyResolver;

  constructor(
    private readonly config: AuthConfig,
    keys?: KeyResolver,
  ) {
    this.keys = keys ?? createRemoteJWKSet(new URL(config.jwksUri ?? defaultJwksUri(config.issuer)));
  }

  /**
   * Verify a raw `Authorization` header value. Returns the principal or throws
   * `AuthError`. Signature, issuer, audience, and expiry are all checked; a
   * missing/malformed/expired token throws so the caller returns 401 before any
   * CoreAPI call (§4.1).
   */
  async verifyHeader(authorization: string | undefined): Promise<Principal> {
    const token = bearerToken(authorization);
    if (!token) throw new AuthError("missing or malformed bearer token");
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        // Defense in depth (§4.1): pin an asymmetric-algorithm allow-list so a
        // token is accepted ONLY when signed with RS256/ES256. This structurally
        // rejects an HS256 (symmetric) token — the classic JWKS confusion attack
        // where an attacker signs with the public key as an HMAC secret — and any
        // `alg: none` token, regardless of what the token header claims.
        algorithms: ["RS256", "ES256"],
      }));
    } catch (e) {
      throw new AuthError(`token verification failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const userId = typeof payload.sub === "string" ? payload.sub : undefined;
    if (!userId) throw new AuthError("token has no subject");
    return { userId, roles: extractRoles(payload) };
  }
}

/** Extract a bearer token from an `Authorization` header, or undefined. */
export function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const m = /^Bearer (.+)$/.exec(authorization.trim());
  return m?.[1]?.trim() || undefined;
}

/** Roles from a `roles` claim (array or space/comma-delimited string). */
function extractRoles(payload: JWTPayload): string[] {
  const raw = (payload as Record<string, unknown>)["roles"];
  if (Array.isArray(raw)) return raw.filter((r): r is string => typeof r === "string");
  if (typeof raw === "string") return raw.split(/[\s,]+/).filter(Boolean);
  return [];
}

/** The conventional OIDC JWKS endpoint derived from an issuer URL (§4.1). */
export function defaultJwksUri(issuer: string): string {
  const base = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
  return `${base}/.well-known/jwks.json`;
}
