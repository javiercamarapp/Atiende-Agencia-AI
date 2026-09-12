import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ["default"],
    include: ["packages/*/tests/**/*.spec.ts", "packages/mcp-servers/*/tests/**/*.spec.ts", "apps/*/tests/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
  },
});
