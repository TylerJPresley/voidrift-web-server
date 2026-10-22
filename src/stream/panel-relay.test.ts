/**
 * Panel relay round-trip (web-blueprint.md §5.3, panels-blueprint §5).
 *
 * The backend depends on the core, registers its OWN built-in panel declarations
 * (handoff §0.1 — panels ship with the product; no dependency on any plugin),
 * and relays them to the browser as JSON unchanged. This test registers the
 * product's own declarations through a real core, reads them back from
 * `registry.panels()` the way the relay does, and asserts each serializes to
 * JSON EQUAL to the product's source declaration — so any drift between the
 * core's `PanelDeclaration` shape and the wire form the browser's local type
 * mirrors is caught inside this product's own repository.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { createCore } from "@voidrift/core";
import { BUILTIN_PANELS, registerBuiltinPanels } from "./builtin-panels.js";

describe("§5.3 panel relay — the backend's own declarations serialize to the wire form unchanged", () => {
  it("every built-in registered through the core round-trips to JSON equal to its source", async () => {
    // Given a real core at a temp workspace (removed after shutdown).
    const workspaceRoot = hermeticTmp("web-panels");
    const { api } = await createCore({ workspaceRoot });

    // When the backend registers its own built-in declarations through the core.
    registerBuiltinPanels(api);

    // Then each relayed entry serializes to JSON equal to its source declaration
    // — the exact bytes the server sends and the browser's local type renders.
    const entries = api.registry.panels();
    expect(entries.length).toBe(Object.keys(BUILTIN_PANELS).length);
    for (const entry of entries) {
      const name = entry.key.slice("panels.".length);
      const relayed = JSON.parse(JSON.stringify(entry.value));
      const source = JSON.parse(JSON.stringify(BUILTIN_PANELS[name as keyof typeof BUILTIN_PANELS]));
      expect(relayed, name).toEqual(source);
    }

    await api.session.shutdown();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
});
