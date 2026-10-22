/**
 * Backend config loading (web-blueprint.md §1.5 step 1, §10).
 *
 * The backend validates its own `apps.web` pocket with Zod at boot; an invalid
 * value is rejected and the key falls back to its default (core §13.3). Secrets
 * are never config values — the pocket holds env var NAMES, and the backend
 * resolves the actual secret from `process.env` by that name (core §11.2). A
 * missing required secret (TLS material, auth issuer, Postgres URL) is a fatal
 * startup error that exits non-zero before any listener opens (§1.5 step 1).
 */
import { appsWebSchema, type AppsWebConfig } from "./http/schemas.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ResolvedSecrets {
  readonly tlsCert: string;
  readonly tlsKey: string;
  readonly postgresUrl: string;
}

export interface LoadedConfig {
  readonly web: AppsWebConfig;
  /** Secrets resolved from the environment by the names the config holds. */
  readonly secrets: ResolvedSecrets;
}

/**
 * Validate the raw `apps.web` pocket. On a schema failure the whole pocket is
 * rejected and the caller treats it as a fatal config error for required fields;
 * optional numeric/boolean keys carry their defaults via the schema (§13.3).
 */
export function validateWebConfig(raw: unknown): AppsWebConfig {
  const parsed = appsWebSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ConfigError(`invalid apps.web config: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}

/** Resolve the three required secrets from the environment by name (§10). A
 * missing env var is fatal (§1.5 step 1). */
export function resolveSecrets(web: AppsWebConfig, env: NodeJS.ProcessEnv): ResolvedSecrets {
  const tlsCert = requireEnv(env, web.tls.certEnv, "TLS certificate");
  const tlsKey = requireEnv(env, web.tls.keyEnv, "TLS private key");
  const postgresUrl = requireEnv(env, web.postgresUrlEnv, "Postgres URL");
  return { tlsCert, tlsKey, postgresUrl };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string, label: string): string {
  const value = env[name];
  if (!value) throw new ConfigError(`missing required ${label} (env var ${name})`);
  return value;
}

/**
 * Refuse `auto_approve` on a shared backend (web-blueprint.md §1.5 step 2,
 * core §2.5, §9.5). The host-only auto-approve mode disables the human approval step
 * for a single local operator; a remote, multi-user server must never run with
 * approvals disabled. The backend NEVER sets `CoreOptions.autoApprove`, and any
 * attempt to request it through config or the environment is fatal BEFORE any
 * listener opens — a hostile or misconfigured value can never silently enable
 * it. Scans the raw `apps.web` pocket (and any nested object) for a
 * `autoApprove` / `auto_approve` key and the environment for a matching var.
 */
export function refuseAutoApprove(rawPocket: unknown, env: NodeJS.ProcessEnv): void {
  const KEY = /^auto[_]?approve$/i;
  const requestsIt = (v: unknown): boolean => {
    if (!v || typeof v !== "object") return false;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (KEY.test(k)) return true;
      if (val && typeof val === "object" && requestsIt(val)) return true;
    }
    return false;
  };
  if (requestsIt(rawPocket)) {
    throw new ConfigError(
      "auto_approve is refused on the web backend: the host-only auto-approve mode cannot run on a shared, multi-user server (web §1.5, core §9.5)",
    );
  }
  for (const name of Object.keys(env)) {
    if (/^VOIDRIFT_AUTO[_]?APPROVE$/i.test(name) && env[name]) {
      throw new ConfigError(
        `auto_approve is refused on the web backend: environment variable ${name} cannot enable it on a shared, multi-user server (web §1.5, core §9.5)`,
      );
    }
  }
}

/** Load and validate the full backend config, resolving secrets (§1.5 step 1). */
export function loadConfig(rawPocket: unknown, env: NodeJS.ProcessEnv): LoadedConfig {
  // A shared backend never runs with approvals disabled (§1.5 step 2): refuse
  // any config/env request for auto_approve before anything else.
  refuseAutoApprove(rawPocket, env);
  const web = validateWebConfig(rawPocket);
  const secrets = resolveSecrets(web, env);
  return { web, secrets };
}
