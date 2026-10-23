/**
 * Config loader tests (web-blueprint.md §1.5, §10).
 */
import { describe, it, expect } from "vitest";
import { loadConfig, validateWebConfig, resolveSecrets, refuseAutoApprove, ConfigError } from "./config.js";

const validPocket = {
  auth: { issuer: "https://i.test", audience: "aud" },
  corsOrigins: ["https://app.test"],
  tls: { certEnv: "WEB_TLS_CERT", keyEnv: "WEB_TLS_KEY" },
  postgresUrlEnv: "WEB_PG_URL",
};

const env = {
  WEB_TLS_CERT: "cert-material",
  WEB_TLS_KEY: "key-material",
  WEB_PG_URL: "postgres://localhost/db",
} as NodeJS.ProcessEnv;

describe("§1.5/§10 config", () => {
  it("loads a valid pocket and resolves secrets by env name", () => {
    const { web, secrets } = loadConfig(validPocket, env);
    expect(web.auth.issuer).toBe("https://i.test");
    expect(secrets.tlsCert).toBe("cert-material");
    expect(secrets.postgresUrl).toBe("postgres://localhost/db");
  });

  it("rejects an invalid pocket (fatal)", () => {
    expect(() => validateWebConfig({ auth: { issuer: "bad", audience: "a" } })).toThrow(ConfigError);
  });

  it("fails when a required secret env var is missing", () => {
    expect(() => resolveSecrets(validateWebConfig(validPocket), { WEB_TLS_CERT: "c" })).toThrow(
      ConfigError,
    );
  });

  it("holds no secret as a config value — only env var names", () => {
    const serialized = JSON.stringify(validateWebConfig(validPocket));
    expect(serialized).not.toContain("cert-material");
    expect(serialized).not.toContain("key-material");
    expect(serialized).toContain("WEB_TLS_CERT");
  });

  describe("§1.5 step 2 — auto_approve is refused on a shared backend", () => {
    it("loadConfig throws when the pocket requests auto_approve (any casing / nesting)", () => {
      expect(() => loadConfig({ ...validPocket, autoApprove: true }, env)).toThrow(ConfigError);
      expect(() => loadConfig({ ...validPocket, auto_approve: true }, env)).toThrow(ConfigError);
      expect(() => loadConfig({ ...validPocket, nested: { autoApprove: true } }, env)).toThrow(ConfigError);
    });

    it("loadConfig throws when an environment variable asks for it", () => {
      expect(() => loadConfig(validPocket, { ...env, VOIDRIFT_AUTO_APPROVE: "1" })).toThrow(ConfigError);
      expect(() => loadConfig(validPocket, { ...env, VOIDRIFT_AUTOAPPROVE: "true" })).toThrow(ConfigError);
    });

    it("refuseAutoApprove is a no-op for a clean pocket and environment", () => {
      expect(() => refuseAutoApprove(validPocket, env)).not.toThrow();
    });

    it("a clean valid config still loads (the guard does not false-positive)", () => {
      expect(() => loadConfig(validPocket, env)).not.toThrow();
    });
  });

  describe("§1.5 — the web backend never exposes or calls session.setMode (vibe is CLI-only)", () => {
    it("no web-server source calls .setMode / enters vibe (modes stay a CLI concern, core §2.7)", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const url = await import("node:url");
      const srcDir = path.dirname(url.fileURLToPath(import.meta.url));
      const walk = (dir: string): string[] =>
        fs.readdirSync(dir).flatMap((e) => {
          const p = path.join(dir, e);
          return fs.statSync(p).isDirectory() ? walk(p) : [p];
        });
      const files = walk(srcDir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
      for (const f of files) {
        const text = fs.readFileSync(f, "utf8");
        // The backend never relays `setMode` and never selects `vibe`; a remote,
        // multi-user server never runs with approvals disabled (§1.5 step 2).
        expect(text, f).not.toMatch(/\.setMode\s*\(/);
        expect(text, f).not.toMatch(/["']setMode["']/);
      }
    });
  });
});
