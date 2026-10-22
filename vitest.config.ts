import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./src/test-hermetic.ts"],
    globalSetup: ["./src/test-hermetic.global.ts"],
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/test-hermetic.global.ts","src/**/*.test.ts", "src/**/*.spec.ts", "src/index.ts", "src/server.ts", "src/test-harness.ts"],
      // Statements/functions/lines floor at the AGENTS.md 80% package floor.
      // Branch floor is the adapter tier (70%, AGENTS.md): this is a transport/
      // adapter layer whose remaining uncovered branches are defensive option
      // spreads (`...(x ? {} : {})`), not logic.
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
    },
  },
});
