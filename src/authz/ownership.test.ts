/**
 * Ownership + authorization tests (web-blueprint.md §4.2, §4.3).
 */
import { describe, it, expect } from "vitest";
import { Authorizer, InMemoryOwnershipStore } from "./ownership.js";

describe("§4.2/§4.3 Authorizer", () => {
  it("records an owner and authorizes only the owner", async () => {
    const authz = new Authorizer(new InMemoryOwnershipStore());
    await authz.recordOwner("s1", "A");
    expect((await authz.authorize("A", "s1")).allowed).toBe(true);
    const refused = await authz.authorize("B", "s1");
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toBe("forbidden");
  });

  it("reports a missing record as not_found without leaking existence", async () => {
    const authz = new Authorizer(new InMemoryOwnershipStore());
    const out = await authz.authorize("A", "ghost");
    expect(out.allowed).toBe(false);
    if (!out.allowed) expect(out.reason).toBe("not_found");
  });

  it("filters ownedIds to the principal (no enumeration)", async () => {
    const authz = new Authorizer(new InMemoryOwnershipStore());
    await authz.recordOwner("s1", "A");
    await authz.recordOwner("s2", "B");
    const a = await authz.ownedIds("A");
    expect([...a]).toEqual(["s1"]);
    expect(a.has("s2")).toBe(false);
  });

  it("honors a sharing grant", async () => {
    const authz = new Authorizer(new InMemoryOwnershipStore());
    await authz.recordOwner("s1", "A");
    await authz.grant("s1", "B");
    expect((await authz.authorize("B", "s1")).allowed).toBe(true);
    expect([...(await authz.ownedIds("B"))]).toContain("s1");
  });

  it("counts owned sessions and forgets on delete", async () => {
    const authz = new Authorizer(new InMemoryOwnershipStore());
    await authz.recordOwner("s1", "A");
    await authz.recordOwner("s2", "A");
    expect(await authz.countOwned("A")).toBe(2);
    await authz.forget("s1");
    expect(await authz.countOwned("A")).toBe(1);
  });
});
