/**
 * The web backend's own built-in panel declarations (web-blueprint.md §5.3,
 * panels-blueprint §4).
 *
 * Panels ship WITH the product (handoff §0.1): the backend owns this pure-data
 * set and registers it through the SAME `core.register.panel` seam a third-party
 * plugin uses, right after `createCore` (core-host.ts). Each entry is DATA typed
 * as the core's `PanelDeclaration`. The backend relays `registry.panels()` to
 * the browser unchanged (`/api/panels`), so the browser's local wire type and
 * fixture mirror exactly these declarations and a plugin-registered panel
 * relays with no backend code change.
 */
import type { CoreAPI, PanelDeclaration } from "@voidrift/core";

/** The canonical built-in panel set the backend registers at startup (§5.3). */
export const BUILTIN_PANELS: Readonly<Record<string, PanelDeclaration>> = Object.freeze({
  sessions: {
    title: "Sessions",
    source: "sessions",
    columns: [
      { key: "name", label: "Name", width: 18 },
      { key: "id", label: "Id", width: 10 },
      { key: "lastActiveAt", label: "Last active", width: 16 },
      { key: "summary", label: "Summary" },
    ],
  },
  model: {
    title: "Models",
    source: "models",
    columns: [
      { key: "name", label: "Name", width: 18 },
      { key: "model", label: "Model", width: 24 },
      { key: "protocol", label: "Protocol", width: 10 },
      { key: "active", label: "Active", width: 8 },
    ],
  },
  agent: {
    title: "Agents",
    source: "agents",
    columns: [
      { key: "name", label: "Name", width: 18 },
      { key: "description", label: "Description" },
    ],
  },
  tools: {
    title: "Tools",
    source: "tools",
    columns: [
      { key: "name", label: "Name", width: 24 },
      { key: "description", label: "Description" },
    ],
  },
  mcp: {
    title: "MCP",
    source: "mcp",
    columns: [
      { key: "name", label: "Server", width: 20 },
      { key: "status", label: "Status", width: 14 },
      { key: "toolCount", label: "Tools", width: 8 },
    ],
  },
  plugins: {
    title: "Plugins",
    source: "plugins",
    columns: [
      { key: "id", label: "Plugin", width: 24 },
      { key: "enabled", label: "Enabled", width: 10 },
      { key: "scope", label: "Scope", width: 12 },
    ],
  },
  permissions: {
    title: "Permissions",
    source: "permissions",
    columns: [
      { key: "pattern", label: "Pattern", width: 28 },
      { key: "decision", label: "Decision", width: 12 },
      { key: "scope", label: "Scope", width: 12 },
    ],
  },
  compliance: {
    title: "Compliance",
    source: "compliance",
    columns: [
      { key: "label", label: "Item", width: 28 },
      { key: "detail", label: "Detail" },
    ],
  },
  memory: {
    title: "Memory",
    source: ["memory", "memory-suggestions"],
    columns: [
      { key: "kind", label: "Kind", width: 12 },
      { key: "title", label: "Title", width: 28 },
      { key: "detail", label: "Detail" },
    ],
    actions: {
      a: { label: "approve", op: "memory.suggestions.approve" },
      r: { label: "reject", op: "memory.suggestions.reject" },
    },
  },
  skills: {
    title: "Skills",
    source: "skills",
    columns: [
      { key: "name", label: "Name", width: 24 },
      { key: "scope", label: "Scope", width: 10 },
      { key: "description", label: "Description" },
    ],
  },
  prompts: {
    title: "Prompts",
    source: "prompts",
    columns: [
      { key: "key", label: "Key", width: 24 },
      { key: "label", label: "Label" },
    ],
  },
  stats: {
    title: "Stats",
    source: "stats",
    columns: [
      { key: "label", label: "Metric", width: 24 },
      { key: "value", label: "Value" },
    ],
  },
  context: {
    title: "Context",
    source: "context",
    columns: [
      { key: "label", label: "Segment", width: 24 },
      { key: "value", label: "Value" },
    ],
  },
  diff: {
    title: "Diff",
    source: "diff",
    columns: [{ key: "line", label: "Working-tree diff" }],
  },
  help: {
    title: "Help",
    source: "commands",
    columns: [
      { key: "name", label: "Command", width: 18 },
      { key: "description", label: "Description" },
    ],
  },
});

/** Register the backend's built-in declarations through the core seam (§5.3). */
export function registerBuiltinPanels(api: CoreAPI): void {
  for (const [name, declaration] of Object.entries(BUILTIN_PANELS)) {
    api.register.panel(name, declaration);
  }
}
