/**
 * Postgres-backed session-ownership store (web-blueprint.md §4.2, §11).
 *
 * Persists ownership to the SAME Postgres the core's checkpointer and hosted
 * store use (one database per deployment, §11), so authorization is consistent
 * across backend instances behind the load balancer and survives a restart.
 * This is web-layer state — the core never learns who owns a session (§11).
 *
 * The driver (`pg`, MIT) is injected as a minimal `PgPool` so a test can run the
 * store against an in-memory fake without a live database; production passes a
 * real `pg.Pool`. Only the two methods the store needs are required.
 */
import type { OwnershipRecord, OwnershipStore } from "./ownership.js";

/** The minimal `pg.Pool` surface this adapter uses (query + end). */
export interface PgPool {
  query<R = unknown>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

const DDL = `
CREATE TABLE IF NOT EXISTS web_session_ownership (
  session_id TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  grants     TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS web_session_ownership_owner_idx ON web_session_ownership (owner_id);
`;

interface Row {
  session_id: string;
  owner_id: string;
  grants: string[];
}

export class PostgresOwnershipStore implements OwnershipStore {
  constructor(private readonly pool: PgPool) {}

  /** Create the table if absent. Called once at startup (§1.5 step 3). */
  async init(): Promise<void> {
    await this.pool.query(DDL);
  }

  async record(sessionId: string, ownerId: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO web_session_ownership (session_id, owner_id) VALUES ($1, $2) ON CONFLICT (session_id) DO NOTHING",
      [sessionId, ownerId],
    );
  }

  async get(sessionId: string): Promise<OwnershipRecord | null> {
    const { rows } = await this.pool.query<Row>(
      "SELECT session_id, owner_id, grants FROM web_session_ownership WHERE session_id = $1",
      [sessionId],
    );
    const r = rows[0];
    return r ? { sessionId: r.session_id, ownerId: r.owner_id, grants: r.grants ?? [] } : null;
  }

  async listFor(userId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ session_id: string }>(
      "SELECT session_id FROM web_session_ownership WHERE owner_id = $1 OR $1 = ANY(grants)",
      [userId],
    );
    return rows.map((r) => r.session_id);
  }

  async grant(sessionId: string, userId: string): Promise<void> {
    await this.pool.query(
      "UPDATE web_session_ownership SET grants = array_append(grants, $2) WHERE session_id = $1 AND NOT ($2 = ANY(grants))",
      [sessionId, userId],
    );
  }

  async remove(sessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM web_session_ownership WHERE session_id = $1", [sessionId]);
  }

  async countOwned(userId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM web_session_ownership WHERE owner_id = $1",
      [userId],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
