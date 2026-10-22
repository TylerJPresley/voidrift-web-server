/**
 * The HTTP + WebSocket app (web-blueprint.md §2, §3, §4, §7).
 *
 * Builds the Fastify instance with the full request path: security middleware
 * ahead of every route (§7), an auth hook that establishes the principal and
 * returns 401 BEFORE any route/CoreAPI call (§4.1), the REST routes that each
 * map a browser action to EXACTLY ONE CoreAPI operation (§2.1) behind an
 * ownership check that returns 403 before the CoreAPI (§4.2), and the WebSocket
 * hub whose per-connection scoped subscriptions make cross-user leakage
 * structurally impossible (§3). No endpoint beyond the blueprint's surface.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import type { CoreAPI, TurnResult, ApprovalResponse } from "@voidrift/core";
import type { PrincipalVerifier} from "../auth/principal.js";
import { AuthError, type Principal } from "../auth/principal.js";
import type { Authorizer } from "../authz/ownership.js";
import { SessionRegistry, type Refusal } from "../sessions.js";
import { ConnectionRelay, originAllowed, type RelaySocket, type AuditEntry } from "../stream/relay.js";
import {
  installSecurity,
  sendRateLimit,
  type SecurityOptions,
} from "../security/security.js";
import {
  sendBodySchema,
  createBodySchema,
  renameBodySchema,
  confirmBodySchema,
  sessionIdSchema,
  MAX_BODY_BYTES,
} from "./schemas.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AppOptions {
  readonly api: CoreAPI;
  readonly verifier: PrincipalVerifier;
  readonly authz: Authorizer;
  readonly security: SecurityOptions;
  readonly maxSessionsPerUser: number;
  readonly sendPerMinute: number;
  /** The access log for authorization decisions, including refusals that never
   * reach the core (§4.4). Defaults to a no-op; a deployment supplies a sink. */
  readonly audit?: (entry: AuditEntry) => void;
}

/** Map a terminal/non-terminal `RunStatus` to an HTTP status (§2.2). */
export function statusForRun(result: TurnResult): number {
  switch (result.status) {
    case "completed":
      return 200;
    case "waiting_for_approval":
    case "waiting_for_input":
      return 202;
    case "cancelled":
      return 200;
    case "limit_reached":
      return 200;
    case "failed":
      return 500;
    default:
      return 200;
  }
}

function sendRefusal(reply: import("fastify").FastifyReply, refusal: Refusal): void {
  void reply.code(refusal.status).send({ error: refusal.reason });
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: MAX_BODY_BYTES, trustProxy: true });
  const registry = new SessionRegistry(opts.api, opts.authz, opts.maxSessionsPerUser);
  const audit = opts.audit ?? (() => undefined);

  await installSecurity(app, opts.security);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // ── auth hook: 401 BEFORE any route/CoreAPI call (§4.1) ──
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return undefined;
    // The WS upgrade on the stream route authenticates in the hub (so a bad
    // Origin is refused first). Scoped to the exact path so a spoofed `upgrade`
    // header on any other route cannot bypass the 401 gate (§4.1).
    if (request.url.split("?")[0] === "/api/stream" && isWebSocketUpgrade(request)) return undefined;
    try {
      request.principal = await opts.verifier.verifyHeader(request.headers.authorization);
    } catch (e) {
      if (e instanceof AuthError) {
        await reply.code(401).send({ error: "unauthorized" });
        return reply;
      }
      throw e;
    }
    return undefined;
  });

  const principalOf = (request: FastifyRequest): Principal => {
    const p = request.principal;
    if (!p) throw new AuthError("no principal"); // unreachable past the hook
    return p;
  };

  // ── sessions ──
  app.get("/api/sessions", async (request) => {
    return registry.list(principalOf(request));
  });

  app.post("/api/sessions", async (request, reply) => {
    const body = createBodySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    const out = await registry.create(principalOf(request), body.data.name);
    if (out.refused) return sendRefusal(reply, out);
    if (!out.value.ok) return reply.code(400).send({ error: out.value.error.message });
    audit({ userId: principalOf(request).userId, sessionId: out.value.value.id, op: "create", outcome: "granted" });
    return reply.code(201).send(out.value.value);
  });

  app.get("/api/sessions/:id", async (request, reply) => {
    const id = sessionIdSchema.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: "invalid id" });
    const out = await registry.resume(principalOf(request), id.data);
    if (out.refused) return refuseAudited(reply, out, principalOf(request), id.data, "resume", audit);
    if (!out.value.ok) return reply.code(404).send({ error: out.value.error.message });
    return reply.send(out.value.value);
  });

  app.patch("/api/sessions/:id", async (request, reply) => {
    const id = sessionIdSchema.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: "invalid id" });
    const body = renameBodySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    const out = await registry.rename(principalOf(request), id.data, body.data.name);
    if (out.refused) return refuseAudited(reply, out, principalOf(request), id.data, "rename", audit);
    if (!out.value.ok) return reply.code(404).send({ error: out.value.error.message });
    return reply.send(out.value.value);
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const id = sessionIdSchema.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: "invalid id" });
    const out = await registry.remove(principalOf(request), id.data);
    if (out.refused) return refuseAudited(reply, out, principalOf(request), id.data, "delete", audit);
    if (!out.value.ok) return reply.code(404).send({ error: out.value.error.message });
    audit({ userId: principalOf(request).userId, sessionId: id.data, op: "delete", outcome: "granted" });
    return reply.send(out.value.value);
  });

  // ── send (tighter rate limit, §7) ──
  app.post("/api/sessions/:id/send", sendRateLimit(opts.sendPerMinute), async (request, reply) => {
    const id = sessionIdSchema.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: "invalid id" });
    const body = sendBodySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    const out = await registry.send(principalOf(request), id.data, body.data.input);
    if (out.refused) return refuseAudited(reply, out, principalOf(request), id.data, "send", audit);
    if (!out.value.ok) return reply.code(400).send({ error: out.value.error.message });
    return reply.code(statusForRun(out.value.value)).send(out.value.value);
  });

  // ── confirm (approvals, §6) ──
  app.post("/api/sessions/:id/confirm", async (request, reply) => {
    const id = sessionIdSchema.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: "invalid id" });
    const body = confirmBodySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    const response = body.data as ApprovalResponse;
    const out = await registry.confirm(principalOf(request), id.data, response);
    if (out.refused) return refuseAudited(reply, out, principalOf(request), id.data, "confirm", audit);
    if (!out.value.ok) return reply.code(400).send({ error: out.value.error.message });
    return reply.code(statusForRun(out.value.value)).send(out.value.value);
  });

  // ── cancel ──
  app.post("/api/sessions/:id/cancel", async (request, reply) => {
    const id = sessionIdSchema.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: "invalid id" });
    const out = await registry.cancel(principalOf(request), id.data);
    if (out.refused) return refuseAudited(reply, out, principalOf(request), id.data, "cancel", audit);
    return reply.send({ ok: true });
  });

  // ── pending approvals for an owned session (§6) ──
  app.get("/api/sessions/:id/approvals", async (request, reply) => {
    const id = sessionIdSchema.safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: "invalid id" });
    const out = await registry.approvals(principalOf(request), id.data);
    if (out.refused) return refuseAudited(reply, out, principalOf(request), id.data, "approvals", audit);
    if (!out.value.ok) return reply.code(400).send({ error: out.value.error.message });
    return reply.send(out.value.value);
  });

  // ── panels: the registry declarations the frontend renders (§5.3) ──
  app.get("/api/panels", async () => {
    return opts.api.registry.panels();
  });

  // ── WebSocket hub: scoped event relay (§3) ──
  app.get("/api/stream", { websocket: true }, (connection, request) => {
    const socket = connection as unknown as RelaySocket & { close: (c?: number, r?: string) => void };
    const origin = request.headers.origin;
    if (!originAllowed(origin, opts.security.corsOrigins)) {
      // Strict Origin check on the upgrade (§7). A hostile/absent Origin is
      // refused before any subscription is possible.
      socket.close(1008, "origin not allowed");
      return;
    }
    void authenticateAndRelay(socket, request, opts, audit);
  });

  return app;
}

async function authenticateAndRelay(
  socket: RelaySocket,
  request: FastifyRequest,
  opts: AppOptions,
  audit: (entry: AuditEntry) => void,
): Promise<void> {
  let principal: Principal;
  try {
    const token = extractUpgradeToken(request);
    principal = await opts.verifier.verifyHeader(token);
  } catch {
    socket.close(1008, "unauthorized");
    return;
  }
  // One relay per connection; its scoped subscriptions are opened only for owned
  // sessions (§3.1, §4.3). The ConnectionRelay owns subscribe/unsubscribe/close.
  new ConnectionRelay(opts.api, opts.authz, principal, socket, audit);
}

/** The WS upgrade carries the bearer in `Authorization` or a `token` query param
 * (a browser WebSocket cannot set headers, so a short-lived token query is the
 * conventional carrier; it is verified identically, §4.1).
 *
 * OPERATIONAL NOTE — a `?token=` query parameter can leak into access logs and
 * proxy logs, which commonly record the full request line including the query
 * string. Any reverse proxy or load balancer in front of this server MUST redact
 * the query string on the `/api/stream` upgrade (e.g. nginx `log_format` without
 * `$query_string`, or an explicit scrub), and tokens here must be short-lived.
 * This is a deployment requirement, not a behavior the server changes — the
 * token is accepted exactly as before. See deployment documentation maintained outside this repository. */
function extractUpgradeToken(request: FastifyRequest): string | undefined {
  if (request.headers.authorization) return request.headers.authorization;
  const q = (request.query as { token?: string } | undefined)?.token;
  return q ? `Bearer ${q}` : undefined;
}

function isWebSocketUpgrade(request: FastifyRequest): boolean {
  const upgrade = request.headers.upgrade;
  return typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";
}

function refuseAudited(
  reply: import("fastify").FastifyReply,
  refusal: Refusal,
  principal: Principal,
  sessionId: string,
  op: string,
  audit: (entry: AuditEntry) => void,
): import("fastify").FastifyReply {
  audit({ userId: principal.userId, sessionId, op, outcome: "refused" });
  void reply.code(refusal.status).send({ error: refusal.reason });
  return reply;
}
