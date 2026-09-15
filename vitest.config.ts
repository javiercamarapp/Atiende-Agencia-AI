import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ["default"],
    // Hallazgo de auditoría (rubro 2, "sin rate-limit en /auth/login, /auth/refresh,
    // accept-invite") — ver el comentario de cabecera del archivo para el porqué.
    setupFiles: ["./test-setup/reset-rate-limiter.ts"],
    include: ["packages/*/tests/**/*.spec.ts", "packages/mcp-servers/*/tests/**/*.spec.ts", "apps/*/tests/**/*.spec.ts"],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
  },
});
