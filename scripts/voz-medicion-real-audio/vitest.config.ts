// Config propia (el vitest.config.ts raiz no incluye scripts/). Uso: npx vitest run -c scripts/voz-medicion-real-audio/vitest.config.ts <archivo>
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["scripts/voz-medicion-real-audio/tests/**/*.spec.ts"], testTimeout: 30_000 } });
