// Contrato de `vercel.json::headers` (cabeceras de la SPA estática). Solo lee el
// archivo: no despliega nada. Ver docs/SEGURIDAD-CABECERAS.md.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Regla {
  readonly source: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
}
const config = JSON.parse(readFileSync(resolve(__dirname, "../../../vercel.json"), "utf8")) as { headers?: Regla[] };
const reglas = config.headers ?? [];
// Reglas globales (todas las rutas); la unica excepcion declarada es /pedir/* (ver abajo).
const reglasGlobales = reglas.filter((r) => r.source === "/(.*)");
const todas = new Map(reglasGlobales.flatMap((r) => r.headers.map((h) => [h.key.toLowerCase(), h.value] as const)));

describe("vercel.json headers", () => {
  it("aplica a todas las rutas, salvo la excepcion de geolocalizacion de /pedir/*", () => {
    expect(reglasGlobales.length).toBeGreaterThan(0);
    expect(reglas.filter((r) => r.source !== "/(.*)").map((r) => r.source)).toEqual(["/pedir/(.*)"]);
  });

  it("geolocation esta deshabilitada en todo el sitio y solo /pedir/* la permite a su propia pagina, sin tocar nada mas", () => {
    expect(todas.get("permissions-policy")).toContain("geolocation=()");
    const pedir = reglas.find((r) => r.source === "/pedir/(.*)")!;
    expect(pedir.headers.map((h) => h.key)).toEqual(["Permissions-Policy"]);
    expect(pedir.headers[0]!.value).toContain("geolocation=(self)");
    expect(pedir.headers[0]!.value).toContain("camera=()");
    expect(pedir.headers[0]!.value).toContain("microphone=()");
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
