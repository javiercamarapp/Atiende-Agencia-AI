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
const todas = new Map(reglas.flatMap((r) => r.headers.map((h) => [h.key.toLowerCase(), h.value] as const)));

describe("vercel.json headers", () => {
  it("aplica a todas las rutas", () => {
    expect(reglas.length).toBeGreaterThan(0);
    expect(reglas.every((r) => r.source === "/(.*)")).toBe(true);
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
