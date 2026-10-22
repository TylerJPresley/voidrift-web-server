/**
 * Deterministic, offline test harness (web-blueprint.md §12.2).
 *
 * Scripts a real `createCore` with `fakeModel()` and in-memory storage, an
 * injected test JWT issuer/JWKS (local keys — NO network), and a Fastify
 * `inject` client. Shared stores (checkpointer, session repository, ownership)
 * can be reused across two app instances to prove resume-across-process (§11).
 */
import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { afterAll } from "vitest";
import fs from "node:fs";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JWK,
  type CryptoKey,
} from "jose";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { createCoreHost } from "./core-host.js";
import { hermeticTmp } from "./test-hermetic.js";
import { InMemoryConfigStore } from "@voidrift/core";
import { PrincipalVerifier, type KeyResolver } from "./auth/principal.js";
import { Authorizer, InMemoryOwnershipStore, type OwnershipStore } from "./authz/ownership.js";
import { buildApp } from "./http/app.js";
import type { AuditEntry } from "./stream/relay.js";
import type { SessionRepository, PersistedSession, SessionMetadata } from "@voidrift/core";

export const TEST_ISSUER = "https://issuer.test";
export const TEST_AUDIENCE = "voidrift-web";

export interface TestKeys {
  privateKey: CryptoKey;
  publicJwk: JWK;
  keyResolver: KeyResolver;
}

/** Generate a local RS256 key pair and a JWKS resolver (no network, §4.1). */
export async function makeTestKeys(): Promise<TestKeys> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  const keyResolver = createLocalJWKSet({ keys: [publicJwk] });
  return { privateKey, publicJwk, keyResolver };
}

/** Mint a signed bearer token for a user (§4.1). */
export async function mintToken(
  keys: TestKeys,
  userId: string,
  opts?: { roles?: string[]; audience?: string; issuer?: string; expired?: boolean },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ roles: opts?.roles ?? [] })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject(userId)
    .setIssuer(opts?.issuer ?? TEST_ISSUER)
    .setAudience(opts?.audience ?? TEST_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(opts?.expired ? now - 60 : now + 3600)
    .sign(keys.privateKey);
}

export interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  authz: Authorizer;
  ownership: OwnershipStore;
  checkpointer: BaseCheckpointSaver;
  audit: AuditEntry[];
  /** The per-harness temp workspace (inside the run's hermetic root), removed by `close()`. */
  workspaceRoot: string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  keys: TestKeys;
  /** Shared stores to prove resume-across-process (§11). */
  ownership?: OwnershipStore;
  checkpointer?: BaseCheckpointSaver;
  sessionRepository?: import("@voidrift/core").SessionRepository;
  corsOrigins?: string[];
  /** A tight per-minute bound to exercise the rate limiter (§7). */
  perMinute?: number;
  sendPerMinute?: number;
  enforceHttps?: boolean;
  maxSessionsPerUser?: number;
}

/** A fakeModel factory that always answers deterministically (offline). */
function fakeFactory() {
  return () => fakeModel().respond(new AIMessage("ok"));
}

/** A shareable in-memory SessionRepository so two app "instances" resume the
 * same sessions by id — proving resume-across-process (§11). */
export class SharedSessionRepository implements SessionRepository {
  private readonly byId = new Map<string, PersistedSession>();
  async save(state: PersistedSession): Promise<void> {
    this.byId.set(state.metadata.id, structuredClone(state));
  }
  async load(id: string): Promise<PersistedSession | null> {
    const s = this.byId.get(id);
    return s ? structuredClone(s) : null;
  }
  async list(): Promise<SessionMetadata[]> {
    return [...this.byId.values()]
      .map((s) => s.metadata)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }
  async remove(id: string): Promise<void> {
    this.byId.delete(id);
  }
}

/** Temp workspaces created by `makeHarness`, removed in afterAll as a safety net
 * so a slow or raced `close()` (e.g. a 2s race timeout in ws-live) never leaks
 * a workspace directory. `close()` still removes its own eagerly. */
const harnessWorkspaceRoots = new Set<string>();
afterAll(() => {
  for (const root of harnessWorkspaceRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  harnessWorkspaceRoots.clear();
});

/** Build a ready app over a scripted core (§12.2). */
export async function makeHarness(opts: HarnessOptions): Promise<Harness> {
  const checkpointer = opts.checkpointer ?? new MemorySaver();
  const ownership = opts.ownership ?? new InMemoryOwnershipStore();
  const authz = new Authorizer(ownership);
  const audit: AuditEntry[] = [];

  // A per-harness temp workspace so the core never writes its `.voidrift`
  // session directory into the package folder (the production server uses its
  // cwd — see server.ts — but tests must stay hermetic). It lives inside the
  // run's `vr-hermetic-*` temp root (removed by the global teardown); `close()`
  // also removes it eagerly.
  const workspaceRoot = hermeticTmp("web");
  harnessWorkspaceRoots.add(workspaceRoot);

  const { api } = await createCoreHost({
    workspaceRoot,
    checkpointer,
    chatModelFactory: fakeFactory(),
    // In-memory config store seeded with a valid local model so the harness is
    // deterministic and offline and never reads/writes the developer's on-disk
    // config (§13.1, §15.3).
    configStore: new InMemoryConfigStore({
      models: { local: { model: "local-model", protocol: "openai", contextLimit: 32000 } },
      modelSelected: "local",
    }),
    ...(opts.sessionRepository ? { sessionRepository: opts.sessionRepository } : {}),
  });

  const verifier = new PrincipalVerifier(
    { issuer: TEST_ISSUER, audience: TEST_AUDIENCE },
    opts.keys.keyResolver,
  );

  const app = await buildApp({
    api,
    verifier,
    authz,
    security: {
      corsOrigins: opts.corsOrigins ?? ["https://app.test"],
      perMinute: opts.perMinute ?? 1000,
      sendPerMinute: opts.sendPerMinute ?? 1000,
      enforceHttps: opts.enforceHttps ?? false,
    },
    maxSessionsPerUser: opts.maxSessionsPerUser ?? 100,
    sendPerMinute: opts.sendPerMinute ?? 1000,
    audit: (e) => audit.push(e),
  });
  await app.ready();

  return {
    app,
    authz,
    ownership,
    checkpointer,
    audit,
    workspaceRoot,
    close: async () => {
      await app.close();
      await api.session.shutdown();
      // Shutdown has drained the ObsWriter; the temp workspace is now safe to remove.
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      harnessWorkspaceRoots.delete(workspaceRoot);
    },
  };
}
