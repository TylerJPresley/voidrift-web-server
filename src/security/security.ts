/**
 * Transport security middleware (web-blueprint.md §7).
 *
 * Installed AHEAD of every route (§1.5 step 4). Carries the edge protections the
 * core leaves to its host: secure headers (HSTS, CSP disallowing inline script,
 * nosniff, frame-deny, strict referrer), HTTPS redirect, strict CORS to the
 * configured origins only, request-size limits, and per-principal + per-IP rate
 * limiting with a tighter bound on the model-touching `send` route.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Principal } from "../auth/principal.js";
import { MAX_BODY_BYTES } from "../http/schemas.js";

export interface SecurityOptions {
  readonly corsOrigins: readonly string[];
  readonly perMinute: number;
  readonly sendPerMinute: number;
  /** When true (default), HTTP requests are redirected to HTTPS and HSTS set.
   * A test over plain HTTP sets this false so the local server is reachable. */
  readonly enforceHttps: boolean;
}

/** The CSP the UI runs under: no inline script, origins restricted to self (§7). */
export const CONTENT_SECURITY_POLICY = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "style-src": ["'self'"],
  "connect-src": ["'self'"],
  "img-src": ["'self'", "data:"],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
} as const;

/** Install helmet, CORS, HTTPS redirect, and the base rate limit (§7). */
export async function installSecurity(app: FastifyInstance, opts: SecurityOptions): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { ...CONTENT_SECURITY_POLICY } },
    hsts: opts.enforceHttps ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    xFrameOptions: { action: "deny" },
    xContentTypeOptions: true,
    referrerPolicy: { policy: "no-referrer" },
  });

  await app.register(rateLimit, {
    global: true,
    max: opts.perMinute,
    timeWindow: "1 minute",
    keyGenerator: rateLimitKey,
  });

  // HTTPS redirect + strict CORS run before every handler (§7).
  app.addHook("onRequest", async (request, reply) => {
    if (opts.enforceHttps && isInsecure(request)) {
      const host = request.headers.host ?? "";
      await reply.code(308).redirect(`https://${host}${request.url}`);
      return reply;
    }
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!opts.corsOrigins.includes(origin)) {
        await reply.code(403).send({ error: "origin not allowed" });
        return reply;
      }
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Access-Control-Allow-Headers", "authorization,content-type");
      reply.header("Access-Control-Allow-Methods", "GET,POST,DELETE,PATCH,OPTIONS");
    }
    return undefined;
  });
  return undefined;
}

/** The tighter per-route rate-limit config for the `send` path (§7). */
export function sendRateLimit(sendPerMinute: number): {
  config: { rateLimit: { max: number; timeWindow: string; keyGenerator: (r: FastifyRequest) => string } };
} {
  return {
    config: {
      rateLimit: { max: sendPerMinute, timeWindow: "1 minute", keyGenerator: rateLimitKey },
    },
  };
}

/** Key by principal when authenticated, else by IP (§7 — per-principal + per-IP). */
export function rateLimitKey(request: FastifyRequest): string {
  const principal = (request as FastifyRequest & { principal?: Principal }).principal;
  return principal ? `u:${principal.userId}` : `ip:${request.ip}`;
}

function isInsecure(request: FastifyRequest): boolean {
  if (request.protocol === "https") return false;
  const xfp = request.headers["x-forwarded-proto"];
  const proto = Array.isArray(xfp) ? xfp[0] : xfp;
  return proto !== "https";
}

export { MAX_BODY_BYTES };
