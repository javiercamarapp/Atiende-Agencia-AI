// Contrato de vercel.json para el portal publico del cliente final (despachos).
// Las rutas /portal-cliente/{resumen,documentos,mensajes} las sirve la API; en produccion el front y la API
// comparten origen (VITE_API_BASE_URL = ""), asi que sin un rewrite a /api caerian en el catch-all
// `/(.*)` -> /index.html y el cliente recibiria HTML 200 en lugar de JSON.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const vercel = JSON.parse(readFileSync(path.resolve(here, "..", "..", "..", "vercel.json"), "utf8")) as {
  rewrites?: Array<{ source: string; destination: string; has?: unknown }>;
};
const rewrites = vercel.rewrites ?? [];

describe("vercel.json -- portal publico del cliente final", () => {
  it("reescribe /portal-cliente/:path* hacia la API (sin condicion de header)", () => {
    const entry = rewrites.find((r) => r.source === "/portal-cliente/:path*");
    expect(entry).toEqual({ source: "/portal-cliente/:path*", destination: "/api" });
  });

  it("el rewrite a la API va ANTES del catch-all que sirve el SPA", () => {
    const idxApi = rewrites.findIndex((r) => r.source === "/portal-cliente/:path*");
    const idxCatchAll = rewrites.findIndex((r) => r.source === "/(.*)");
    expect(idxApi).toBeGreaterThanOrEqual(0);
    expect(idxCatchAll).toBeGreaterThan(idxApi);
  });

  it("la pagina del SPA (/portal/cliente) no queda capturada por el rewrite a la API", () => {
    expect(rewrites.some((r) => r.source === "/portal/:path*" || r.source === "/portal/cliente")).toBe(false);
  });
});
