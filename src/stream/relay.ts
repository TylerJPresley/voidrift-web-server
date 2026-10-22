/**
 * The scoped event relay (web-blueprint.md §3, §4.3, §7).
 *
 * One WebSocket per authenticated connection. The principal is established at
 * the HTTP upgrade and never re-sent per message (§3.1). For each session the
 * connection subscribes to, the relay FIRST verifies the principal owns it
 * (§4.2) and only then opens a core SESSION-SCOPED subscription
 * (`events.subscribe("*", h, { scope: { session } })`, core §14.5). Because the
 * subscription is scoped, user B's events are structurally unable to reach user
 * A's connection — the backend never subscribes A to B's session, and a scoped
 * subscription never observes a sibling session (invariant §12.1#4, #8). The
 * subscription is torn down on unsubscribe/close so no relay outlives its
 * consumer (§3.1 step 3).
 */
import type { CoreAPI, EventEnvelope } from "@voidrift/core";
import type { Authorizer } from "../authz/ownership.js";
import type { Principal } from "../auth/principal.js";
import { wsClientMessageSchema, MAX_WS_FRAME_BYTES } from "../http/schemas.js";

/** The minimal socket surface the relay drives (satisfied by `ws`). */
export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
}

/** A server → browser frame carries exactly one session's event (§2.1, §3.1). */
export interface RelayFrame {
  readonly sessionId: string;
  readonly event: EventEnvelope;
}

/**
 * Manages one connection's scoped subscriptions. Each `subscribe` opens exactly
 * one core subscription for an OWNED session; an unauthorized subscribe is
 * refused and logged and no event ever reaches the connection (§3.1 step 1).
 */
export class ConnectionRelay {
  private readonly subs = new Map<string, () => void>();
  private closed = false;

  constructor(
    private readonly api: CoreAPI,
    private readonly authz: Authorizer,
    private readonly principal: Principal,
    private readonly socket: RelaySocket,
    private readonly audit: (entry: AuditEntry) => void,
  ) {
    socket.on("message", (data) => void this.onMessage(data));
    socket.on("close", () => this.dispose());
  }

  /** Validate and dispatch a client frame. Malformed frames are rejected by Zod
   * (§7) and oversize frames are dropped before parsing. */
  private async onMessage(data: unknown): Promise<void> {
    if (this.closed) return;
    const text = frameToString(data);
    if (text === null || text.length > MAX_WS_FRAME_BYTES) {
      this.socket.send(JSON.stringify({ kind: "error", reason: "invalid frame" }));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.socket.send(JSON.stringify({ kind: "error", reason: "invalid json" }));
      return;
    }
    const result = wsClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.socket.send(JSON.stringify({ kind: "error", reason: "invalid message" }));
      return;
    }
    const msg = result.data;
    if (msg.kind === "ping") {
      this.socket.send(JSON.stringify({ kind: "pong" }));
      return;
    }
    if (msg.kind === "unsubscribe") {
      this.unsubscribe(msg.sessionId);
      return;
    }
    await this.subscribe(msg.sessionId);
  }

  /** Open a scoped subscription for an OWNED session (§3.1, §4.3). */
  async subscribe(sessionId: string): Promise<void> {
    if (this.subs.has(sessionId)) return;
    const outcome = await this.authz.authorize(this.principal.userId, sessionId);
    if (!outcome.allowed) {
      // An unauthorized subscribe is refused and logged; no events ever flow
      // for that session on this connection (§3.1 step 1, §4.4).
      this.audit({ userId: this.principal.userId, sessionId, op: "subscribe", outcome: "refused" });
      this.socket.send(JSON.stringify({ kind: "error", reason: "forbidden", sessionId }));
      return;
    }
    const unsubscribe = this.api.events.subscribe(
      "*",
      (event: EventEnvelope) => {
        if (this.closed) return;
        const frame: RelayFrame = { sessionId, event };
        this.socket.send(JSON.stringify(frame));
      },
      { scope: { session: sessionId } },
    );
    this.subs.set(sessionId, unsubscribe);
    this.audit({ userId: this.principal.userId, sessionId, op: "subscribe", outcome: "granted" });
    this.socket.send(JSON.stringify({ kind: "subscribed", sessionId }));
  }

  unsubscribe(sessionId: string): void {
    const off = this.subs.get(sessionId);
    if (off) {
      off();
      this.subs.delete(sessionId);
    }
  }

  /** True when the connection currently relays `sessionId` (test visibility). */
  has(sessionId: string): boolean {
    return this.subs.has(sessionId);
  }

  /** Tear down every subscription (close/heartbeat timeout, §3.1, §3.3). */
  dispose(): void {
    this.closed = true;
    for (const off of this.subs.values()) off();
    this.subs.clear();
  }
}

export interface AuditEntry {
  readonly userId: string;
  readonly sessionId: string;
  readonly op: string;
  readonly outcome: "granted" | "refused";
}

/** Normalize a `ws` frame payload to a string, or null if it is binary/invalid. */
export function frameToString(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  return null;
}

/**
 * Strict Origin check for the WebSocket upgrade (§7 — strict Origin check on the
 * upgrade; wss-only). An upgrade whose `Origin` is not in the configured allow
 * list is rejected before the socket is accepted. An absent Origin (non-browser
 * client) is rejected too — a browser always sends one.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false;
  return allowed.includes(origin);
}
