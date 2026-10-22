/**
 * Session-ownership store and per-user authorization (web-blueprint.md §4.2, §4.3).
 *
 * The core resolves a session by id for anyone who asks (core §2.4); the backend
 * is what decides WHO may ask. This store maps each core session id to the
 * `userId` that created it, with optional sharing grants. Every session-targeting
 * operation passes an ownership check that returns a 403 refusal BEFORE the
 * CoreAPI is touched; `list` is filtered to the principal so a user never sees
 * another user's ids (no id enumeration). The store is a port so a durable
 * Postgres adapter backs production and an in-memory adapter backs tests; both
 * survive their process and (for Postgres) are consistent across instances.
 */

export interface OwnershipRecord {
  readonly sessionId: string;
  readonly ownerId: string;
  /** Additional userIds granted access when session sharing is enabled (§4.2). */
  readonly grants: readonly string[];
}

/** The durable store port (§4.2, §11 — same Postgres as the checkpointer). */
export interface OwnershipStore {
  record(sessionId: string, ownerId: string): Promise<void>;
  get(sessionId: string): Promise<OwnershipRecord | null>;
  /** Session ids the principal owns or is granted — the filter for `list` (§4.2). */
  listFor(userId: string): Promise<string[]>;
  grant(sessionId: string, userId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
  /** Count of sessions a user owns, for the per-user cap (§10 maxSessionsPerUser). */
  countOwned(userId: string): Promise<number>;
}

/** In-memory ownership store for tests and single-process dev (§11, §15.3). */
export class InMemoryOwnershipStore implements OwnershipStore {
  private readonly byId = new Map<string, { ownerId: string; grants: Set<string> }>();

  async record(sessionId: string, ownerId: string): Promise<void> {
    if (!this.byId.has(sessionId)) this.byId.set(sessionId, { ownerId, grants: new Set() });
  }
  async get(sessionId: string): Promise<OwnershipRecord | null> {
    const r = this.byId.get(sessionId);
    return r ? { sessionId, ownerId: r.ownerId, grants: [...r.grants] } : null;
  }
  async listFor(userId: string): Promise<string[]> {
    const out: string[] = [];
    for (const [id, r] of this.byId) if (r.ownerId === userId || r.grants.has(userId)) out.push(id);
    return out;
  }
  async grant(sessionId: string, userId: string): Promise<void> {
    const r = this.byId.get(sessionId);
    if (r) r.grants.add(userId);
  }
  async remove(sessionId: string): Promise<void> {
    this.byId.delete(sessionId);
  }
  async countOwned(userId: string): Promise<number> {
    let n = 0;
    for (const r of this.byId.values()) if (r.ownerId === userId) n += 1;
    return n;
  }
}

/** The outcome of an authorization check (§4.3). A refusal never reaches the core. */
export type AuthzOutcome =
  | { readonly allowed: true; readonly record: OwnershipRecord }
  | { readonly allowed: false; readonly reason: "not_found" | "forbidden" };

/**
 * Per-user authorization over the ownership store (§4.2, §4.3). Every
 * session-targeting operation calls `authorize` first; a non-owner (and
 * non-grantee) is refused `forbidden` so the HTTP layer returns 403 and the WS
 * relay refuses the subscribe — in both cases before any CoreAPI call.
 */
export class Authorizer {
  constructor(private readonly store: OwnershipStore) {}

  /** Check that `principal` may act on `sessionId`. Refusal precedes any core call. */
  async authorize(userId: string, sessionId: string): Promise<AuthzOutcome> {
    const record = await this.store.get(sessionId);
    // A missing record is reported as `not_found`, never leaking whether the id
    // exists under another owner (ids are not authorization — ownership is, §4.3).
    if (!record) return { allowed: false, reason: "not_found" };
    if (record.ownerId === userId || record.grants.includes(userId)) return { allowed: true, record };
    return { allowed: false, reason: "forbidden" };
  }

  /** Record a freshly created session's owner (§4.2 — create records the owner). */
  async recordOwner(sessionId: string, ownerId: string): Promise<void> {
    await this.store.record(sessionId, ownerId);
  }

  /** Owned/granted session ids for the principal — the `list` filter (§4.2). */
  async ownedIds(userId: string): Promise<Set<string>> {
    return new Set(await this.store.listFor(userId));
  }

  async countOwned(userId: string): Promise<number> {
    return this.store.countOwned(userId);
  }

  async grant(sessionId: string, userId: string): Promise<void> {
    await this.store.grant(sessionId, userId);
  }

  async forget(sessionId: string): Promise<void> {
    await this.store.remove(sessionId);
  }
}
