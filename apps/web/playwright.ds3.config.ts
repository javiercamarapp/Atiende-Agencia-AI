// Verificacion visual del rediseno ds3 (barrido de rutas + medidor + carga/fps). Config APARTE: no toca playwright.config.ts
// (su testDir es ./e2e/tests) ni el job e2e actual. Reutiliza `use`, `webServer` (API simulada + vite preview) y reporter del
// config base. Script: `npm run e2e:ds3` (ver docs de cada spec en e2e-ds3/).
//
// Variables (todas opcionales):
//   DS3_MATRIZ=completa     anade m390-oscuro, m360-claro, t768-claro y t1024-claro (nocturno / etiquetado)
//   DS3_BARRIDO=completo    todas las rutas del menu por consola (por omision: modo HUMO, <= 6 por consola)
//   DS3_INFORMATIVO=1       el barrido NO falla por defectos: los reporta (JSON + adjuntos). Sin esto, cualquier defecto duro falla
//   DS3_CAPTURAS=1          guarda PNG por pantalla; DS3_ETAPA=antes|despues (nombre del PNG); DS3_SALIDA=<carpeta> (por omision test-results-ds3/evidencia)
//   E2E_DISENO=ds3          enciende la bandera de diseno (localStorage) antes de cargar; vacio = diseno actual
//   E2E_WEB_PORT / E2E_API_PORT / E2E_SKIP_BUILD / E2E_WORKERS: igual que el config base
import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config.ts";

const completa = process.env.DS3_MATRIZ === "completa";

const escritorio = (ancho: number, alto: number, colorScheme: "light" | "dark") => ({
  ...devices["Desktop Chrome"],
  viewport: { width: ancho, height: alto },
  colorScheme,
});
// Pixel 7 ya trae isMobile + hasTouch (pointer:coarse); se fijan viewport y DPR de la matriz.
const movil = (ancho: number, alto: number, deviceScaleFactor: number, colorScheme: "light" | "dark") => ({
  ...devices["Pixel 7"],
  viewport: { width: ancho, height: alto },
  deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  colorScheme,
});

export default defineConfig({
  ...base,
  testDir: "./e2e-ds3",
  outputDir: "./test-results-ds3",
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? "2"),
  timeout: 180_000, // un barrido de consola es largo
  // Los 4 proyectos cruzan viewport y tema: cada ancho y cada tema quedan cubiertos al menos una vez.
  projects: [
    { name: "d1440-claro", use: escritorio(1440, 900, "light") },
    { name: "d1440-oscuro", use: escritorio(1440, 900, "dark") },
    { name: "m390-claro", use: movil(390, 844, 3, "light") },
    { name: "m360-oscuro", use: movil(360, 740, 2, "dark") },
    ...(completa
      ? [
          { name: "m390-oscuro", use: movil(390, 844, 3, "dark") },
          { name: "m360-claro", use: movil(360, 740, 2, "light") },
          { name: "t768-claro", use: escritorio(768, 1024, "light") },
          { name: "t1024-claro", use: escritorio(1024, 768, "light") },
        ]
      : []),
  ],
});
