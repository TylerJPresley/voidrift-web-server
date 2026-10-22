/**
 * Request, WebSocket-message, and config schemas (web-blueprint.md §2.1, §7, §10).
 *
 * Every HTTP request body and every WebSocket frame is validated with Zod at the
 * edge (core §2.6 mirrored at the boundary; security-trust: validate all input).
 * Oversize and malformed payloads are rejected before any CoreAPI call.
 */
import { z } from "zod";

/** A send maps to `session.send(sessionId, { input })` (§2.2). */
export const sendBodySchema = z
  .object({
    input: z.string().min(1).max(100_000),
  })
  .strict();

/** A create records the new session's owner (§4.2); an optional display name. */
export const createBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

/** A rename body. */
export const renameBodySchema = z.object({ name: z.string().min(1).max(200) }).strict();

/** An approval decision posted to `session.confirm` (core §9.5). The full
 * ApprovalResponse the core defines; validated structurally at the edge. */
export const confirmBodySchema = z
  .object({
    requestId: z.string().min(1).max(200),
    decision: z.enum(["approve", "edit", "reject"]),
    editedArgs: z.record(z.string(), z.unknown()).optional(),
    remember: z.enum(["session", "project"]).optional(),
    chosenPattern: z.string().max(500).optional(),
  })
  .strict();

/** The session id path param — opaque, never enumerable (§4.3). */
export const sessionIdSchema = z.string().min(1).max(128);

/** WebSocket client → server frames. The principal is NEVER re-sent per message
 * (§3.1): it is established at the upgrade. Only subscribe/unsubscribe/ping. */
export const wsClientMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("subscribe"), sessionId: sessionIdSchema }).strict(),
  z.object({ kind: z.literal("unsubscribe"), sessionId: sessionIdSchema }).strict(),
  z.object({ kind: z.literal("ping") }).strict(),
]);

export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
export type SendBody = z.infer<typeof sendBodySchema>;
export type ConfirmBody = z.infer<typeof confirmBodySchema>;

/** The `apps.web` config pocket (§10). Secrets are env var NAMES, never values. */
export const appsWebSchema = z
  .object({
    auth: z.object({
      issuer: z.string().url(),
      audience: z.string().min(1),
      jwksUri: z.string().url().optional(),
    }),
    corsOrigins: z.array(z.string()).default([]),
    tls: z.object({ certEnv: z.string().min(1), keyEnv: z.string().min(1) }),
    postgresUrlEnv: z.string().min(1),
    rateLimit: z
      .object({
        perMinute: z.number().int().positive().default(120),
        sendPerMinute: z.number().int().positive().default(20),
      })
      .default({ perMinute: 120, sendPerMinute: 20 }),
    maxSessionsPerUser: z.number().int().positive().default(100),
    reduceMotion: z.boolean().default(false),
    sessionShareEnabled: z.boolean().default(false),
  })
  .strict();

export type AppsWebConfig = z.infer<typeof appsWebSchema>;

/** The maximum accepted request body size in bytes (§7 request-size limits). */
export const MAX_BODY_BYTES = 256 * 1024;
/** The maximum accepted WebSocket frame size in bytes (§7). */
export const MAX_WS_FRAME_BYTES = 64 * 1024;
