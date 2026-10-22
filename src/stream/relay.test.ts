/**
 * Scoped relay tests (web-blueprint.md §3, §4.3).
 * Proves a session-scoped subscription receives only its session's events and
 * an unauthorized subscribe is refused with no leaked events.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { MemorySaver } from "@langchain/langgraph";
import fs from "node:fs";
import { createCoreHost } from "../core-host.js";
import { Authorizer, InMemoryOwnershipStore } from "../authz/ownership.js";
import { ConnectionRelay, frameToString, type RelaySocket, type AuditEntry } from "./relay.js";
import type { CoreAPI } from "@voidrift/core";

/** A fake WebSocket capturing sent frames and exposing message injection. */
class FakeSocket implements RelaySocket {
  sent: string[] = [];
  private handlers: { message: ((d: unknown) => void)[]; close: (() => void)[] } = { message: [], close: [] };
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    for (const h of this.handlers.close) h();
  }
  on(event: "message" | "close", listener: never): void {
    if (event === "message") this.handlers.message.push(listener);
    else this.handlers.close.push(listener);
  }
  inject(msg: unknown): void {
    const text = typeof msg === "string" ? msg : JSON.stringify(msg);
    for (const h of this.handlers.message) h(text);
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

async function makeCore(workspaceRoot: string): Promise<CoreAPI> {
  const { api } = await createCoreHost({
    workspaceRoot,
    checkpointer: new MemorySaver(),
    chatModelFactory: () => fakeModel().respond(new AIMessage("ok")),
  });
  return api;
}

describe("§3/§4.3 ConnectionRelay", () => {
  let api: CoreAPI;
  // A per-suite temp workspace so the core never writes its `.voidrift` session
  // directory into the package folder. Drained and removed in afterAll.
  let workspaceRoot: string;
  beforeAll(async () => {
    workspaceRoot = hermeticTmp("web");
    api = await makeCore(workspaceRoot);
  });
  afterAll(async () => {
    await api.session.shutdown();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("opens a scoped subscription only for an owned session and relays only its events", async () => {
    const authz = new Authorizer(new InMemoryOwnershipStore());
    const sA = await api.session.create();
    const sB = await api.session.create();
    if (!sA.ok || !sB.ok) throw new Error("setup");
    await authz.recordOwner(sA.value.id, "A");
    await authz.recordOwner(sB.value.id, "B");

    const socket = new FakeSocket();
    const audit: AuditEntry[] = [];
    const relay = new ConnectionRelay(api, authz, { userId: "A", roles: [] }, socket, (e) => audit.push(e));

    await relay.subscribe(sA.value.id);
    expect(relay.has(sA.value.id)).toBe(true);

    // Emit an event into B's session scope — A's connection must not see it.
    api.events.register("TEST_EVENT");
    api.events.emit("TEST_EVENT", { x: 1 }, { session: sB.value.id });
    api.events.emit("TEST_EVENT", { x: 2 }, { session: sA.value.id });

    const relayFrames = socket.frames().filter((f) => "sessionId" in f && "event" in f);
    expect(relayFrames.length).toBe(1);
    expect(relayFrames[0]!["sessionId"]).toBe(sA.value.id);
  });

  it("refuses an unauthorized subscribe and leaks no events", async () => {
    const authz = new Authorizer(new InMemoryOwnershipStore());
    const sA = await api.session.create();
    if (!sA.ok) throw new Error("setup");
    await authz.recordOwner(sA.value.id, "A");

    const socket = new FakeSocket();
    const audit: AuditEntry[] = [];
    const relay = new ConnectionRelay(api, authz, { userId: "B", roles: [] }, socket, (e) => audit.push(e));
    await relay.subscribe(sA.value.id);

    expect(relay.has(sA.value.id)).toBe(false);
    expect(audit.some((e) => e.outcome === "refused" && e.op === "subscribe")).toBe(true);
    expect(socket.frames().some((f) => f["kind"] === "error" && f["reason"] === "forbidden")).toBe(true);
  });

  it("rejects malformed and oversize frames via Zod", async () => {
    const authz = new Authorizer(new InMemoryOwnershipStore());
    const socket = new FakeSocket();
    new ConnectionRelay(api, authz, { userId: "A", roles: [] }, socket, () => undefined);
    socket.inject("{not json");
    socket.inject({ kind: "bogus" });
    socket.inject("x".repeat(70_000));
    const reasons = socket.frames().map((f) => f["reason"]);
    expect(reasons).toContain("invalid json");
    expect(reasons).toContain("invalid message");
    expect(reasons).toContain("invalid frame");
  });

  it("responds to ping with pong and tears down on dispose", async () => {
    const authz = new Authorizer(new InMemoryOwnershipStore());
    const sA = await api.session.create();
    if (!sA.ok) throw new Error("setup");
    await authz.recordOwner(sA.value.id, "A");
    const socket = new FakeSocket();
    const relay = new ConnectionRelay(api, authz, { userId: "A", roles: [] }, socket, () => undefined);
    socket.inject({ kind: "ping" });
    expect(socket.frames().some((f) => f["kind"] === "pong")).toBe(true);
    await relay.subscribe(sA.value.id);
    socket.inject({ kind: "unsubscribe", sessionId: sA.value.id });
    expect(relay.has(sA.value.id)).toBe(false);
    relay.dispose();
  });

  it("frameToString normalizes buffers and rejects binary garbage", () => {
    expect(frameToString("hi")).toBe("hi");
    expect(frameToString(Buffer.from("hi"))).toBe("hi");
    expect(frameToString(new Uint8Array([104, 105]))).toBe("hi");
    expect(frameToString(42)).toBeNull();
  });
});
