// ds3 / 2.4: LogoMarca (REDISENO §2.10). Cada marca tiene asset o esta en PENDIENTES_MARCA; sin hex fuera del archivo generado;
// accesibilidad; variante mono/color con el piso de contraste; procedencia verificable del generador.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  contrasteContraFondoClaro,
  LOGO_MARCA_FONDO_CLARO_PEOR_HSL,
  LOGO_MARCA_CLAVES,
  LOGO_MARCA_CONTRASTE_MIN,
  LogoMarca,
  MARCAS_CON_ASSET,
  MARCAS_PENDIENTES,
  pxLogoMarca,
  tieneAsset,
  variantePermitida,
  type LogoMarcaClave,
} from "../src/components/LogoMarca";
import { FUENTE_LOGOS_MARCA, LOGOS_MARCA_GENERADOS, PENDIENTES_MARCA } from "../src/lib/logos-marca.generated";

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(aqui, "..", "..", "..");
const leer = (rel: string) => readFileSync(join(raiz, rel), "utf8");
const html = (marca: LogoMarcaClave, props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(LogoMarca, { marca, ...props }));

const MARCAS_DEL_DOC = [
  "whatsapp", "google", "google-calendar", "stripe", "airbnb", "booking", "vrbo", "expedia", "tripadvisor", "meta", "openstreetmap", "softrestaurant",
] as const;

describe("LogoMarca ds3 / 2.4", () => {
  it("cubre las 12 marcas del doc: cada una tiene asset XOR esta en PENDIENTES_MARCA", () => {
    expect([...LOGO_MARCA_CLAVES].sort()).toEqual([...MARCAS_DEL_DOC].sort());
    for (const m of MARCAS_DEL_DOC) {
      const conAsset = m in LOGOS_MARCA_GENERADOS;
      const pendiente = PENDIENTES_MARCA.some((p) => p.marca === m);
      expect(conAsset !== pendiente, m).toBe(true);
    }
    expect(MARCAS_CON_ASSET.length + MARCAS_PENDIENTES.length).toBe(MARCAS_DEL_DOC.length);
  });

  it("las marcas del doc que NO se inventan quedan pendientes: SoftRestaurant, Booking, Vrbo, Google, TripAdvisor, Meta, OSM", () => {
    for (const m of ["softrestaurant", "booking", "vrbo", "google", "tripadvisor", "meta", "openstreetmap"]) {
      expect(PENDIENTES_MARCA.some((p) => p.marca === m), m).toBe(true);
      expect(tieneAsset(m as LogoMarcaClave), m).toBe(false);
    }
  });

  it("cada pendiente trae tipo y motivo no vacios", () => {
    for (const p of PENDIENTES_MARCA) {
      expect(["pendiente-asset", "restringida", "solo-texto"]).toContain(p.tipo);
      expect(p.motivo.length).toBeGreaterThan(20);
    }
  });

  it("cada asset es un unico path de 24x24 con color de marca valido", () => {
    for (const [m, a] of Object.entries(LOGOS_MARCA_GENERADOS)) {
      expect(a.viewBox, m).toBe("0 0 24 24");
      expect(a.path, m).toMatch(/^M[\d.\sMmLlHhVvCcSsQqTtAaZz,+-]+$/);
      expect(a.hex, m).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("sin fill/hex fuera del archivo generado (LogoMarca y su version diferida)", () => {
    for (const rel of ["packages/ui/src/components/LogoMarca.tsx", "packages/ui/src/components/LogoMarcaDiferido.tsx"]) {
      const src = leer(rel);
      expect(src, rel).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
      expect(src, rel).not.toMatch(/style=\{\{/);
      expect(src, rel).not.toMatch(/text-\[\d+px\]/);
    }
  });

  it("marca con asset: svg sin animacion/filtro, focusable=false y nombre accesible por defecto", () => {
    const s = html("stripe");
    expect(s).toContain('role="img"');
    expect(s).toContain('aria-label="Stripe"');
    expect(s).toContain('focusable="false"');
    expect(s).not.toMatch(/animate|filter|shadow|<animate/i);
    expect(html("stripe", { etiqueta: "Pagos con Stripe" })).toContain('aria-label="Pagos con Stripe"');
  });

  it("decorativo o conNombre ocultan el svg; el significado nunca depende solo del logo", () => {
    const dec = html("airbnb", { decorativo: true });
    expect(dec).toContain('aria-hidden="true"');
    expect(dec).not.toContain("aria-label");
    const nom = html("airbnb", { conNombre: true });
    expect(nom).toContain('aria-hidden="true"');
    expect(nom).toContain(">Airbnb<");
  });

  it("mono usa currentColor; color usa el hex del asset solo si hay contraste >= 3:1", () => {
    expect(html("stripe", { variante: "mono" })).toContain('fill="currentColor"');
    // Stripe #635BFF contra el peor fondo claro >= 3:1 -> color permitido.
    expect(contrasteContraFondoClaro(LOGOS_MARCA_GENERADOS.stripe.hex)).toBeGreaterThanOrEqual(LOGO_MARCA_CONTRASTE_MIN);
    const c = html("stripe", { variante: "color" });
    expect(c).toContain(`fill="${LOGOS_MARCA_GENERADOS.stripe.hex}"`);
    expect(c).toContain("dark:bg-white");
    expect(c).toContain("dark:border-border");
    expect(c).toContain("dark:rounded-lg");
  });

  it("si el contraste del glifo es < 3:1 se fuerza mono (WhatsApp verde sobre claro)", () => {
    expect(contrasteContraFondoClaro(LOGOS_MARCA_GENERADOS.whatsapp.hex)).toBeLessThan(LOGO_MARCA_CONTRASTE_MIN);
    expect(variantePermitida(LOGOS_MARCA_GENERADOS.whatsapp, "color")).toBe("mono");
    const s = html("whatsapp", { variante: "color" });
    expect(s).toContain('data-variante="mono"');
    expect(s).toContain('fill="currentColor"');
    expect(s).not.toContain(LOGOS_MARCA_GENERADOS.whatsapp.hex);
  });

  it("tamanos xs/sm/md/lg = 14/16/20/24 px y el minimo por marca manda (Google >= 18)", () => {
    expect(["xs", "sm", "md", "lg"].map((t) => pxLogoMarca("stripe", t as "xs"))).toEqual([14, 16, 20, 24]);
    expect(pxLogoMarca("google", "xs")).toBe(18);
    expect(pxLogoMarca("google", "lg")).toBe(24);
    expect(html("stripe", { tamano: "lg" })).toContain('width="24"');
  });

  it("marca pendiente: icono neutro + nombre visible, sin path de marca ni hex, aunque sea decorativo", () => {
    for (const m of ["softrestaurant", "booking", "vrbo", "google"] as const) {
      const s = html(m, { decorativo: true });
      const nombre = PENDIENTES_MARCA.find((p) => p.marca === m)!.nombre;
      expect(s, m).toContain(`>${nombre}<`);
      expect(s, m).toContain('data-logo-estado="pendiente"');
      expect(s, m).toContain('aria-hidden="true"');
      expect(s, m).not.toMatch(/#[0-9a-fA-F]{6}/);
    }
    expect(html("google", { tamano: "xs" })).toMatch(/width="18"/);
  });

  it("procedencia: el archivo generado y el script comparten version y hashes, y LICENCIAS-MARCAS.md los documenta", () => {
    const script = leer("scripts/marcas/generar-logos.py");
    const lic = leer("LICENCIAS-MARCAS.md");
    expect(script).toContain(`VERSION = "${FUENTE_LOGOS_MARCA.version}"`);
    expect(script).toContain(`SHA1 = "${FUENTE_LOGOS_MARCA.sha1}"`);
    expect(`sha512-${script.match(/SHA512_B64 = "([^"]+)"/)![1]}`).toBe(FUENTE_LOGOS_MARCA.integrity);
    expect(lic).toContain(FUENTE_LOGOS_MARCA.version);
    expect(lic).toContain(FUENTE_LOGOS_MARCA.sha1);
    expect(lic).toContain(FUENTE_LOGOS_MARCA.integrity);
    expect(lic).toContain("CC0");
    expect(lic).toMatch(/nominativo/i);
    for (const p of PENDIENTES_MARCA) expect(lic.includes(`| ${p.nombre} | ${p.tipo} |`), p.marca).toBe(true);
    expect(lic.match(/^\| [^|]+ \| (pendiente-asset|restringida|solo-texto) \|$/gm)).toHaveLength(PENDIENTES_MARCA.length);
    expect(FUENTE_LOGOS_MARCA.licencia).toBe("CC0-1.0");
  });

  it("el generador no ejecuta nada de terceros: sin subprocess/os.system/pip/npm install", () => {
    const script = leer("scripts/marcas/generar-logos.py").replace(/"""[\s\S]*?"""/, "");
    expect(script).not.toMatch(/subprocess|os\.system|eval\(|exec\(|npm install|pip install|extractall/);
  });

  it("LogoMarcaDiferido no importa valores de LogoMarca (solo tipos) para poder dividirse en un chunk", () => {
    const src = leer("packages/ui/src/components/LogoMarcaDiferido.tsx");
    expect(src).toMatch(/import type \{[^}]*\} from "\.\/LogoMarca"/);
    expect(src).not.toMatch(/^import \{[^}]*\} from "\.\/LogoMarca"/m);
    expect(src).toContain('import("./LogoMarca")');
  });

  it("el barrel no re-exporta LogoMarca ni PENDIENTES_MARCA de forma estatica (solo tipos y LogoMarcaDiferido)", () => {
    const src = ts.createSourceFile("index.ts", leer("packages/ui/src/index.ts"), ts.ScriptTarget.Latest, true);
    const ofensores: string[] = [];
    src.forEachChild((n) => {
      if (!ts.isExportDeclaration(n) && !ts.isImportDeclaration(n)) return;
      const mod = n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : "";
      if (!/\/(LogoMarca|logos-marca\.generated)(\.js)?$/.test(mod)) return;
      const soloTipos = ts.isExportDeclaration(n)
        ? n.isTypeOnly || (!!n.exportClause && ts.isNamedExports(n.exportClause) && n.exportClause.elements.every((e) => e.isTypeOnly))
        : !!n.importClause?.isTypeOnly;
      if (!soloTipos) ofensores.push(n.getText());
    });
    expect(ofensores).toEqual([]);
    expect(leer("packages/ui/src/index.ts")).toContain('from "./components/LogoMarcaDiferido.js"');
    const pkg = JSON.parse(leer("packages/ui/package.json")) as { exports: Record<string, string> };
    expect(pkg.exports["./logo-marca"]).toBe("./src/components/LogoMarca.tsx");
    expect(pkg.exports["./logos-marca"]).toBe("./src/lib/logos-marca.generated.ts");
  });

  it("el peso propio de LogoMarca (esbuild, minificado, gzip -9, deps externas) no pasa de 4608 B", async () => {
    // @ts-expect-error script .mjs sin tipos
    const { medirPesoLogoMarca, PRESUPUESTO_LOGO_MARCA_GZ } = await import("../../../scripts/marcas/medir-peso.mjs");
    const { gzip } = (await medirPesoLogoMarca()) as { gzip: number };
    expect(PRESUPUESTO_LOGO_MARCA_GZ).toBe(4608);
    expect(gzip).toBeLessThanOrEqual(4608);
  });

  it("los colores de marca se miden contra el peor fondo claro real: coincide con --sunken ds3 claro y Airbnb queda en mono", () => {
    const css = leer("packages/ui/src/index.css");
    const bloque = css.slice(css.indexOf('html[data-diseno="ds3"] {'));
    const m = /--sunken:\s*([\d.]+) ([\d.]+)% ([\d.]+)%/.exec(bloque)!;
    expect([Number(m[1]), Number(m[2]), Number(m[3])]).toEqual([...LOGO_MARCA_FONDO_CLARO_PEOR_HSL]);
    expect(contrasteContraFondoClaro(LOGOS_MARCA_GENERADOS.airbnb.hex)).toBeLessThan(LOGO_MARCA_CONTRASTE_MIN);
    expect(variantePermitida(LOGOS_MARCA_GENERADOS.airbnb, "color")).toBe("mono");
    expect(variantePermitida(LOGOS_MARCA_GENERADOS.stripe, "color")).toBe("color");
    expect(variantePermitida(LOGOS_MARCA_GENERADOS["google-calendar"], "color")).toBe("color");
  });

  it("el generador fija el host de redireccion y espera entre reintentos", () => {
    const sc = leer("scripts/marcas/generar-logos.py");
    expect(sc).toContain("registry.npmjs.org/");
    expect(sc).toContain("HTTPRedirectHandler");
    expect(sc).toContain("time.sleep");
  });

  it("el generador rechaza redirecciones fuera de registry.npmjs.org (prueba Python de comportamiento)", () => {
    const r = spawnSync("python3", ["-I", join(raiz, "scripts/marcas/test_generar_logos.py")], { encoding: "utf8" });
    expect(r.stderr + r.stdout).toContain("OK");
    expect(r.status).toBe(0);
  });
});
