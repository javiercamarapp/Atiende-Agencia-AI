// Contrato de `vercel.json::headers` (cabeceras de la SPA estática). Solo lee el
// archivo: no despliega nada. Ver docs/SEGURIDAD-CABECERAS.md.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom (devDependency de la raíz) no trae tipos y el tsconfig de la API no carga la lib DOM: se declara solo lo que usa esta prueba.
interface ElementoScript {
  readonly outerHTML: string;
  readonly textContent: string | null;
  getAttribute(nombre: string): string | null;
}
interface ModuloJsdom {
  readonly JSDOM: new (html: string) => { readonly window: { readonly document: { querySelectorAll(selector: "script"): Iterable<ElementoScript> } } };
}
const { JSDOM } = createRequire(resolve(__dirname, "vercel-headers.spec.ts"))("jsdom") as ModuloJsdom;

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

  it("el microfono es self en la regla global (una SPA no relee la cabecera al navegar): nunca *, y lo demas sigue denegado", () => {
    const valor = todas.get("permissions-policy")!;
    expect(valor).toBe("camera=(), microphone=(self), geolocation=(), payment=(), usb=()");
    expect(valor).not.toContain("*");
    for (const d of ["camera=()", "geolocation=()", "payment=()", "usb=()"]) expect(valor).toContain(d);
  });

  it("geolocation esta deshabilitada en todo el sitio, sin excepcion", () => {
    expect(todas.get("permissions-policy")).toContain("geolocation=()");
  });

  it("/pedir/* (tienda eliminada) redirige (permanent:true, Vercel responde 308) a la raiz y ya no se reescribe a la API", () => {
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

  it("la CSP de la SPA va ENFORCING (ya no Report-Only) y reporta a /v1/csp-report", () => {
    expect(todas.has("content-security-policy")).toBe(true);
    expect(todas.has("content-security-policy-report-only")).toBe(false);
    const csp = todas.get("content-security-policy") ?? "";
    expect(csp).toContain("report-uri /v1/csp-report");
    expect(csp).toContain("report-to csp");
    expect(todas.get("reporting-endpoints")).toBe('csp="/v1/csp-report"');
  });

  it("la CSP cubre las fuentes reales de la SPA y no abre eval, scripts inline ni blob: en scripts", () => {
    const csp = todas.get("content-security-policy") ?? "";
    const directiva = (n: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${n} `)) ?? "";
    expect(directiva("default-src")).toBe("default-src 'self'");
    // theme-boot.js, el bundle de Vite y el AudioWorklet de voz (public/voz/captura-pcm-worklet.js) son archivos del mismo origen.
    expect(directiva("script-src")).toBe("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline.*script-src/);
    expect(directiva("style-src")).toContain("https://fonts.googleapis.com");
    expect(directiva("font-src")).toContain("https://fonts.gstatic.com");
    expect(directiva("connect-src")).toContain("https://*.supabase.co");
    expect(directiva("connect-src")).toContain("wss://*.supabase.co");
    // Vista previa de voz (Gemini Live): el navegador abre el WebSocket con el token efimero que emite la API.
    expect(directiva("connect-src")).toContain("wss://generativelanguage.googleapis.com");
    // Ningun proveedor de LLM se llama desde el navegador (OpenRouter y compania van por el gateway de la API).
    expect(csp).not.toMatch(/openrouter|anthropic|openai/i);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("el AudioWorklet de voz se sirve como archivo estatico (sin blob:, que la CSP bloquearia)", () => {
    const fuente = readFileSync(resolve(__dirname, "../../web/src/lib/voz/entorno-navegador.ts"), "utf8");
    expect(fuente).not.toMatch(/createObjectURL/);
    expect(fuente).toContain("voz/captura-pcm-worklet.js");
    const worklet = readFileSync(resolve(__dirname, "../../web/public/voz/captura-pcm-worklet.js"), "utf8");
    expect(worklet).toContain('registerProcessor("captura-pcm"');
  });

  it("el index.html no tiene scripts inline (la CSP enforcing los bloquearia)", () => {
    // Parseo real del HTML con jsdom (no una regex): ve scripts con mayúsculas, atributos sin comillas, comentarios y cierres raros
    // igual que el navegador que aplica la CSP.
    const html = readFileSync(resolve(__dirname, "../../web/index.html"), "utf8");
    const { document } = new JSDOM(html).window;
    const scripts = [...document.querySelectorAll("script")];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script.getAttribute("src") ?? "", script.outerHTML).toMatch(/^\/(?!\/)/u);
      expect((script.textContent ?? "").trim(), script.outerHTML).toBe("");
    }
  });
});
