// Pruebas E2E de navegador de apps/web (Playwright). Ver docs/QA-E2E.md.
//
// Contra que corre: el build estatico de apps/web (`vite build` + `vite preview`) apuntando al servidor de
// API simulada de e2e/mock-api. NUNCA contra la base real, Supabase ni produccion; sin secretos.
//
// Variables (todas opcionales):
//   E2E_WEB_PORT (4173) · E2E_API_PORT (8788) · E2E_WORKERS (2 local, 2 en CI)
//   E2E_SKIP_BUILD=1  reutiliza apps/web/dist-e2e ya construido
//   E2E_API_LATENCY_MS  latencia base de la API simulada
import { defineConfig, devices } from "@playwright/test";

const puertoWeb = Number(process.env.E2E_WEB_PORT ?? "4173");
const puertoApi = Number(process.env.E2E_API_PORT ?? "8788");
const enCI = Boolean(process.env.CI);
const urlWeb = `http://127.0.0.1:${puertoWeb}`;
const urlApi = `http://127.0.0.1:${puertoApi}`;

const comandoBuild = process.env.E2E_SKIP_BUILD === "1" ? "" : `npx vite build --outDir dist-e2e --emptyOutDir && `;

// Los proyectos oscuros solo corren las pruebas marcadas @oscuro (ver e2e/tests/ds-shell.spec.ts).
const soloOscuro = /@oscuro/;

export default defineConfig({
  testDir: "./e2e/tests",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: enCI,
  retries: enCI ? 1 : 0,
  // La Mac de desarrollo es compartida y de 24 GB: workers acotados.
  workers: Number(process.env.E2E_WORKERS ?? "2"),
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: enCI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: urlWeb,
    locale: "es-MX",
    timezoneId: "America/Merida",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    extraHTTPHeaders: {},
  },
  projects: [
    { name: "escritorio-claro", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, colorScheme: "light" } },
    { name: "movil-claro", use: { ...devices["Pixel 7"], viewport: { width: 375, height: 812 }, colorScheme: "light" } },
    { name: "escritorio-oscuro", grep: soloOscuro, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, colorScheme: "dark" } },
    { name: "movil-oscuro", grep: soloOscuro, use: { ...devices["Pixel 7"], viewport: { width: 375, height: 812 }, colorScheme: "dark" } },
  ],
  webServer: [
    {
      command: "node --experimental-strip-types e2e/mock-api/main.ts",
      url: `${urlApi}/__mock/salud`,
      reuseExistingServer: !enCI,
      timeout: 30_000,
      env: { E2E_API_PORT: String(puertoApi), E2E_API_LATENCY_MS: process.env.E2E_API_LATENCY_MS ?? "0" },
    },
    {
      command: `${comandoBuild}npx vite preview --outDir dist-e2e --host 127.0.0.1 --port ${puertoWeb} --strictPort`,
      url: urlWeb,
      reuseExistingServer: !enCI,
      timeout: 300_000,
      env: { VITE_API_BASE_URL: urlApi },
    },
  ],
});
