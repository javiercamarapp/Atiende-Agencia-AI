// Contrato de `vercel.json::headers` (cabeceras de la SPA estática). Solo lee el
// archivo: no despliega nada. Ver docs/SEGURIDAD-CABECERAS.md.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Regla {
  readonly source: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
}
const config = JSON.parse(readFileSync(resolve(__dirname, "../../../vercel.json"), "utf8")) as { headers?: Regla[]; redirects?: unknown; rewrites?: unknown };
const reglas = config.headers ?? [];
// Reglas globales (todas las rutas); sin excepciones por ruta.
const reglasGlobales = reglas.filter((r) => r.source === "/(.*)");
const todas = new Map(reglasGlobales.flatMap((r) => r.headers.map((h) => [h.key.toLowerCase(), h.value] as const)));

describe("vercel.json headers", () => {
  it("aplica a todas las rutas: ya no hay excepciones por ruta (la tienda /pedir/* se eliminó)", () => {
    expect(reglasGlobales.length).toBeGreaterThan(0);
    expect(reglas.filter((r) => r.source !== "/(.*)").map((r) => r.source)).toEqual([]);
  });

  it("geolocation esta deshabilitada en todo el sitio, sin excepcion", () => {
    expect(todas.get("permissions-policy")).toContain("geolocation=()");
  });

  it("/pedir/* (tienda eliminada) redirige (permanente) a la raiz y ya no se reescribe a la API", () => {
    const cfg = config as { redirects?: { source: string; destination: string; permanent?: boolean }[]; rewrites?: { source: string; destination: string }[] };
    expect(cfg.redirects).toEqual([{ source: "/pedir/:path*", destination: "/", permanent: true }]);
    expect((cfg.rewrites ?? []).filter((r) => r.source.startsWith("/pedir"))).toEqual([]);
  });

  it("HSTS, nosniff, anti-framing, Referrer-Policy, Permissions-Policy y COOP van enforcing", () => {
    expect(todas.get("strict-transport-security")).toMatch(/max-age=\d{8,}/);
    expect(todas.get("x-content-type-options")).toBe("nosniff");
    expect(todas.get("x-frame-options")).toBe("DENY");
    expect(todas.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(todas.get("permissions-policy")).toContain("camera=()");
    expect(todas.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("la CSP de la SPA es Report-Only: NO existe Content-Security-Policy enforcing (no rompe login ni panel)", () => {
    expect(todas.has("content-security-policy")).toBe(false);
    expect(todas.has("content-security-policy-report-only")).toBe(true);
  });

  it("la CSP Report-Only cubre las fuentes reales de la SPA y no abre eval ni scripts inline", () => {
    const csp = todas.get("content-security-policy-report-only") ?? "";
    const directiva = (n: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${n} `)) ?? "";
    expect(directiva("script-src")).toBe("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline.*script-src/);
    expect(directiva("style-src")).toContain("https://fonts.googleapis.com");
    expect(directiva("font-src")).toContain("https://fonts.gstatic.com");
    expect(directiva("connect-src")).toContain("https://*.supabase.co");
    expect(directiva("connect-src")).toContain("wss://*.supabase.co");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});
