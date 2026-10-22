/**
 * Persistence-across-instances and durable-approval tests (web-blueprint.md §11, §6, §3).
 *
 * Two app "instances" share one SessionRepository, checkpointer, and ownership
 * store (one Postgres in production). A session created on instance 1 resumes by
 * id on instance 2 for the OWNER only; a non-owner is still 403; the WS upgrade
 * rejects a hostile Origin.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import {
  makeHarness,
  makeTestKeys,
  mintToken,
  SharedSessionRepository,
  type TestKeys,
} from "./test-harness.js";
import { InMemoryOwnershipStore } from "./authz/ownership.js";

const ORIGIN = "https://app.test";

describe("§11 resume-across-process + §3 WS origin", () => {
  let keys: TestKeys;
  beforeAll(async () => {
    keys = await makeTestKeys();
  });

  it("resumes a session by id on a second instance for the owner only", async () => {
    const ownership = new InMemoryOwnershipStore();
    const checkpointer = new MemorySaver();
    const repo = new SharedSessionRepository();

    const inst1 = await makeHarness({ keys, ownership, checkpointer, sessionRepository: repo });
    const aAuth = { authorization: `Bearer ${await mintToken(keys, "owner")}`, origin: ORIGIN };
    const created = await inst1.app.inject({ method: "POST", url: "/api/sessions", headers: aAuth, payload: { name: "n" } });
    const id = created.json<{ id: string }>().id;
    await inst1.close();

    // A fresh instance over the SAME stores resumes by id for the owner.
    const inst2 = await makeHarness({ keys, ownership, checkpointer, sessionRepository: repo });
    try {
      const resume = await inst2.app.inject({ method: "GET", url: `/api/sessions/${id}`, headers: aAuth });
      expect(resume.statusCode).toBe(200);
      expect(resume.json<{ info: { id: string } }>().info.id).toBe(id);

      // A non-owner is still refused on the second instance.
      const bAuth = { authorization: `Bearer ${await mintToken(keys, "intruder")}`, origin: ORIGIN };
      const refused = await inst2.app.inject({ method: "GET", url: `/api/sessions/${id}`, headers: bAuth });
      expect(refused.statusCode).toBe(403);

      // Ownership is consistent across instances.
      expect((await inst2.authz.authorize("owner", id)).allowed).toBe(true);
    } finally {
      await inst2.close();
    }
  });

  it("rejects a hostile Origin on the WebSocket upgrade", async () => {
    const h = await makeHarness({ keys, corsOrigins: [ORIGIN] });
    try {
      // The CORS onRequest hook rejects an unlisted origin before the upgrade;
      // the relay's originAllowed is unit-tested in relay.test.ts.
      const res = await h.app.inject({
        method: "GET",
        url: "/api/stream",
        headers: { origin: "https://evil.test", connection: "upgrade", upgrade: "websocket" },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await h.close();
    }
  });
});
