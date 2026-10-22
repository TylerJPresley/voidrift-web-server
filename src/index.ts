/**
 * voidrift-web-server — the Web UI backend (SDK host).
 *
 * Exports the composable units the entry point and tests wire: the app builder,
 * the core-host wiring, auth, authorization/ownership, the scoped relay, config
 * loading, and the security middleware (web-blueprint.md §1.3).
 */
export { buildApp, statusForRun, type AppOptions } from "./http/app.js";
export { createCoreHost, type CoreHostOptions } from "./core-host.js";
export { outOfBandApprovalHandler } from "./approvals.js";
export {
  PrincipalVerifier,
  AuthError,
  bearerToken,
  defaultJwksUri,
  type Principal,
  type AuthConfig,
  type KeyResolver,
} from "./auth/principal.js";
export {
  Authorizer,
  InMemoryOwnershipStore,
  type OwnershipStore,
  type OwnershipRecord,
  type AuthzOutcome,
} from "./authz/ownership.js";
export { PostgresOwnershipStore, type PgPool } from "./authz/postgres-ownership.js";
export { SessionRegistry, type Refusal, type Authorized } from "./sessions.js";
export {
  ConnectionRelay,
  originAllowed,
  frameToString,
  type RelaySocket,
  type RelayFrame,
  type AuditEntry,
} from "./stream/relay.js";
export {
  installSecurity,
  sendRateLimit,
  rateLimitKey,
  CONTENT_SECURITY_POLICY,
  type SecurityOptions,
} from "./security/security.js";
export {
  loadConfig,
  validateWebConfig,
  resolveSecrets,
  refuseAutoApprove,
  ConfigError,
  type LoadedConfig,
  type ResolvedSecrets,
} from "./config.js";
export {
  sendBodySchema,
  createBodySchema,
  renameBodySchema,
  confirmBodySchema,
  wsClientMessageSchema,
  appsWebSchema,
  MAX_BODY_BYTES,
  MAX_WS_FRAME_BYTES,
  type AppsWebConfig,
  type WsClientMessage,
} from "./http/schemas.js";
