/**
 * Postgres ownership adapter tests (web-blueprint.md §4.2, §11).
 * A fake `PgPool` records SQL and returns rows so the adapter's shape is proven
 * without a live database.
 */
import { describe, it, expect } from "vitest";
import { PostgresOwnershipStore, type PgPool } from "./postgres-ownership.js";

interface Row {
  session_id: string;
  owner_id: string;
  grants: string[];
}

/** An in-memory fake of the two-method `PgPool` surface. */
function fakePool(): PgPool & { table: Map<string, Row>; calls: string[] } {
  const table = new Map<string, Row>();
  const calls: string[] = [];
  return {
    table,
    calls,
    async query<R = unknown>(text: string, params: readonly unknown[] = []): Promise<{ rows: R[] }> {
      calls.push(text.trim().split("\n")[0]!.trim());
      if (text.includes("CREATE TABLE")) return { rows: [] };
      if (text.startsWith("INSERT")) {
        const [id, owner] = params as [string, string];
        if (!table.has(id)) table.set(id, { session_id: id, owner_id: owner, grants: [] });
        return { rows: [] };
      }
      if (text.startsWith("SELECT session_id, owner_id")) {
        const r = table.get(params[0] as string);
        return { rows: (r ? [r] : []) as R[] };
      }
      if (text.startsWith("SELECT session_id FROM")) {
        const uid = params[0] as string;
        const rows = [...table.values()]
          .filter((r) => r.owner_id === uid || r.grants.includes(uid))
          .map((r) => ({ session_id: r.session_id }));
        return { rows: rows as R[] };
      }
      if (text.startsWith("UPDATE")) {
        const [id, uid] = params as [string, string];
        const r = table.get(id);
        if (r && !r.grants.includes(uid)) r.grants.push(uid);
        return { rows: [] };
      }
      if (text.startsWith("DELETE")) {
        table.delete(params[0] as string);
        return { rows: [] };
      }
      if (text.startsWith("SELECT COUNT")) {
        const uid = params[0] as string;
        const n = [...table.values()].filter((r) => r.owner_id === uid).length;
        return { rows: [{ n: String(n) }] as R[] };
      }
      return { rows: [] };
    },
  };
}

describe("§11 PostgresOwnershipStore", () => {
  it("init creates the table, record+get+list+grant+count+remove round-trip", async () => {
    const pool = fakePool();
    const store = new PostgresOwnershipStore(pool);
    await store.init();
    expect(pool.calls.some((c) => c.includes("CREATE TABLE"))).toBe(true);

    await store.record("s1", "A");
    await store.record("s1", "B"); // ON CONFLICT DO NOTHING — owner stays A
    expect((await store.get("s1"))?.ownerId).toBe("A");
    expect(await store.get("ghost")).toBeNull();

    await store.record("s2", "B");
    expect(await store.listFor("A")).toEqual(["s1"]);
    expect(await store.countOwned("A")).toBe(1);

    await store.grant("s1", "B");
    expect((await store.listFor("B")).sort()).toEqual(["s1", "s2"]);

    await store.remove("s1");
    expect(await store.get("s1")).toBeNull();
  });
});
