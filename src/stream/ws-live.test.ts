/**
 * Live WebSocket relay test (web-blueprint.md §3.2 — multi-session on the wire).
 *
 * Two users each open a real WebSocket, authenticate at the upgrade (token in
 * the query — a browser WebSocket cannot set headers), and subscribe to their
 * own session. Each receives only its own session's event frames and never the
 * other's; an unauthorized subscribe is refused. This proves the scoped relay
 * end to end over a real socket, not only the in-process ConnectionRelay.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { makeHarness, makeTestKeys, mintToken, type Harness, type TestKeys } from "../test-harness.js";

const ORIGIN = "https://app.test";

/** Collect frames from a socket until a predicate or a timeout. */
function collect(ws: WebSocket, until: (f: Record<string, unknown>) => boolean, ms = 300): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const frames: Record<string, unknown>[] = [];
    const timer = setTimeout(() => resolve(frames), ms);
    ws.on("message", (d) => {
      const f = JSON.parse(String(d)) as Record<string, unknown>;
      frames.push(f);
      if (until(f)) {
        clearTimeout(timer);
        resolve(frames);
      }
    });
  });
}

describe("§3.2 live WebSocket scoped relay", () => {
  let keys: TestKeys;
  let h: Harness;
  let base: string;

  beforeAll(async () => {
    keys = await makeTestKeys();
    h = await makeHarness({ keys });
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = h.app.server.address() as AddressInfo;
    base = `ws://127.0.0.1:${addr.port}/api/stream`;
  });

  afterAll(async () => {
    // close() removes the temp workspace after the drain; but it is raced
    // against a 2s cap to defend against a hang, which can skip that cleanup —
    // so remove the workspace unconditionally here too (idempotent).
    const ws = h.workspaceRoot;
    await Promise.race([h.close(), new Promise((r) => setTimeout(r, 2000))]);
    fs.rmSync(ws, { recursive: true, force: true });
  }, 15000);

  async function connect(user: string): Promise<WebSocket> {
    const token = await mintToken(keys, user);
    const ws = new WebSocket(`${base}?token=${token}`, { origin: ORIGIN });
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
    });
    return ws;
  }

  it("delivers only the owner's session events to the owner's connection", async () => {
    // user-A owns sA; user-B owns sB — created through the HTTP surface.
    const aHdr = { authorization: `Bearer ${await mintToken(keys, "wsA")}`, origin: ORIGIN };
    const bHdr = { authorization: `Bearer ${await mintToken(keys, "wsB")}`, origin: ORIGIN };
    const sA = (await h.app.inject({ method: "POST", url: "/api/sessions", headers: aHdr, payload: {} })).json<{ id: string }>().id;
    const sB = (await h.app.inject({ method: "POST", url: "/api/sessions", headers: bHdr, payload: {} })).json<{ id: string }>().id;

    const wsA = await connect("wsA");
    const wsB = await connect("wsB");
    try {
      wsA.send(JSON.stringify({ kind: "subscribe", sessionId: sA }));
      wsB.send(JSON.stringify({ kind: "subscribe", sessionId: sB }));
      // Wait for both subscribe acks.
      await collect(wsA, (f) => f["kind"] === "subscribed");
      await collect(wsB, (f) => f["kind"] === "subscribed");

      // B tries to subscribe to A's session — refused.
      wsB.send(JSON.stringify({ kind: "subscribe", sessionId: sA }));

      // Drive turns on both sessions concurrently.
      const aFrames = collect(wsA, (f) => "event" in f && (f["event"] as { type: string }).type === "TURN_COMPLETE");
      const bFrames = collect(wsB, (f) => "event" in f && (f["event"] as { type: string }).type === "TURN_COMPLETE");
      await Promise.all([
        h.app.inject({ method: "POST", url: `/api/sessions/${sA}/send`, headers: aHdr, payload: { input: "hi-a" } }),
        h.app.inject({ method: "POST", url: `/api/sessions/${sB}/send`, headers: bHdr, payload: { input: "hi-b" } }),
      ]);
      const [aCollected, bCollected] = await Promise.all([aFrames, bFrames]);

      // A's connection only ever carries sA frames; never sB.
      const aRelay = aCollected.filter((f) => "event" in f);
      expect(aRelay.length).toBeGreaterThan(0);
      expect(aRelay.every((f) => f["sessionId"] === sA)).toBe(true);
      expect(aRelay.some((f) => f["sessionId"] === sB)).toBe(false);
      // B's connection saw a forbidden error for sA and only sB relay frames.
      expect(bCollected.some((f) => f["kind"] === "error" && f["reason"] === "forbidden")).toBe(true);
      const bRelay = bCollected.filter((f) => "event" in f);
      expect(bRelay.every((f) => f["sessionId"] === sB)).toBe(true);
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  it("rejects a connection with no token and a hostile origin", async () => {
    const noToken = new WebSocket(base, { origin: ORIGIN });
    const closed = await new Promise<number>((res) => {
      noToken.on("close", (code) => res(code));
      noToken.on("error", () => undefined);
    });
    expect(closed).toBe(1008);

    const token = await mintToken(keys, "wsA");
    const hostile = new WebSocket(`${base}?token=${token}`, { origin: "https://evil.test" });
    const hostileClosed = await new Promise<number>((res) => {
      hostile.on("unexpected-response", (_req, resp) => res(resp.statusCode ?? 0));
      hostile.on("close", (code) => res(code));
      hostile.on("error", () => undefined);
    });
    expect([403, 1008]).toContain(hostileClosed);
  });
});
