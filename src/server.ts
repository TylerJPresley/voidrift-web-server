/**
 * The backend entry point (web-blueprint.md §1.5).
 *
 * Boots the backend once per process: load+validate config and resolve secrets
 * (fatal on a missing required secret), construct the single core with the
 * Postgres checkpointer injected, open the ownership store and auth verifier,
 * install security middleware ahead of every route, register its own built-in
 * panel declarations, and start the HTTPS listener and the WebSocket hub. This module is the
 * composition root; all logic lives in the modules it wires (invariant §12.1#1).
 */
import { createServer } from "node:https";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Pool } from "pg";
import { createCoreHost } from "./core-host.js";
import { loadConfig } from "./config.js";
import { PrincipalVerifier } from "./auth/principal.js";
import { Authorizer } from "./authz/ownership.js";
import { PostgresOwnershipStore } from "./authz/postgres-ownership.js";
import { buildApp } from "./http/app.js";

/** Boot the backend. Rejects (exit non-zero) on any fatal startup error (§1.5). */
export async function main(): Promise<void> {
  const workspaceRoot = process.cwd();

  // Step 1: config + secrets. The raw pocket would come from the core config
  // cascade in a full wiring; here it is read from the environment pocket file.
  const rawPocket = JSON.parse(process.env["VOIDRIFT_WEB_CONFIG"] ?? "{}") as unknown;
  const { web, secrets } = loadConfig(rawPocket, process.env);

  // Step 2: the single core with the Postgres checkpointer injected (§11).
  const checkpointer = PostgresSaver.fromConnString(secrets.postgresUrl);
  await checkpointer.setup();
  const { api } = await createCoreHost({ workspaceRoot, checkpointer });

  // Step 3: ownership store (same Postgres) and the auth verifier (§4).
  const pool = new Pool({ connectionString: secrets.postgresUrl });
  const ownership = new PostgresOwnershipStore(pool);
  await ownership.init();
  const authz = new Authorizer(ownership);
  const verifier = new PrincipalVerifier({
    issuer: web.auth.issuer,
    audience: web.auth.audience,
    ...(web.auth.jwksUri ? { jwksUri: web.auth.jwksUri } : {}),
  });

  // Step 4/5/6: security ahead of routes, panels relayed from the registry, listen.
  const app = await buildApp({
    api,
    verifier,
    authz,
    security: {
      corsOrigins: web.corsOrigins,
      perMinute: web.rateLimit.perMinute,
      sendPerMinute: web.rateLimit.sendPerMinute,
      enforceHttps: true,
    },
    maxSessionsPerUser: web.maxSessionsPerUser,
    sendPerMinute: web.rateLimit.sendPerMinute,
  });

  const server = createServer({ cert: secrets.tlsCert, key: secrets.tlsKey }, (req, res) =>
    app.routing(req, res),
  );
  await app.ready();
  server.listen(Number(process.env["PORT"] ?? 8443));

  const shutdown = async (): Promise<void> => {
    server.close();
    await app.close();
    await api.session.shutdown();
    await pool.end();
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((e) => {
  // A fatal startup error exits non-zero before any listener opens (§1.5).
  process.stderr.write(`[web-server] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
