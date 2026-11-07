// ds3 «cifras y montos premium (sin estilo reloj)»: en las 4 pantallas con mas montos (dashboard de restaurantes, CFO, consola de
// superadmin y Resumen de citas) comprueba en el navegador real que (1) ninguna cifra protagonista se pinta en mono ni con el tablero
// del odometro, (2) bajo ds3 las cifras usan la sans de la casa con el signo de moneda mas chico que el entero, (3) el medidor
// (contraste, fuente minima, desbordes) no reporta defectos nuevos. Guarda SIEMPRE una captura por pantalla y proyecto en la carpeta
// de evidencia (`<DS3_SALIDA>/cifras/<pantalla>/<proyecto>-<etapa>.png`) y la adjunta al reporte: `antes` = workflow_dispatch sobre main,
// `despues` = esta rama. Corre en el job capturas-ds3 (E2E_DISENO=ds3) y, sin la bandera, valida que el diseno actual tampoco tenga reloj.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { orgDe } from "../e2e/mock-api/personas.ts";
import { ETAPA, INFORMATIVO, esperarSinCarga, medir, prepararBandera } from "./comun.ts";

const SALIDA = process.env["DS3_SALIDA"] ?? "test-results-ds3/evidencia";
const DS3 = process.env["E2E_DISENO"] === "ds3";
const RANGO_CFO = "desde=2026-09-21&hasta=2026-09-27&comparar=periodo_anterior";

interface Pantalla {
  readonly nombre: string;
  readonly consola: "restaurantes" | "citas" | "superadmin";
  readonly ruta: () => string;
}

const PANTALLAS: readonly Pantalla[] = [
  { nombre: "restaurantes-dashboard", consola: "restaurantes", ruta: () => `/restaurantes/${orgDe("restaurantes").slug}` },
  { nombre: "restaurantes-cfo", consola: "restaurantes", ruta: () => `/restaurantes/${orgDe("restaurantes").slug}/cfo/resumen?${RANGO_CFO}` },
  { nombre: "superadmin-consola", consola: "superadmin", ruta: () => "/superadmin" },
  { nombre: "citas-resumen", consola: "citas", ruta: () => `/citas/${orgDe("citas").slug}/resumen` },
];

/** Selectores de cifras protagonistas (KPI, destacados, totales). */
const CIFRAS = ".cifra, [data-testid='kpi-tile-valor'], .ds3-stat-valor, [data-testid='odometro'], [data-testid='hallazgo-cifra'], [data-testid='kpi-cfo'] p";

test.beforeEach(async ({ page }) => {
  await prepararBandera(page);
});

for (const p of PANTALLAS) {
  test(`cifras sin estilo reloj: ${p.nombre}`, async ({ page, iniciarSesion, vigilante }, info) => {
    await iniciarSesion(p.consola, "owner");
    await page.goto(p.ruta());
    await expect(page.locator("main#contenido-principal")).toBeVisible();
    await esperarSinCarga(page);

    const lectura = await page.evaluate((sel) => {
      const visibles = [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => el.getClientRects().length > 0);
      const enMono = visibles.filter((el) => /mono/i.test(getComputedStyle(el).fontFamily)).map((el) => (el.textContent ?? "").trim().slice(0, 30));
      const cifras = [...document.querySelectorAll<HTMLElement>(".cifra")].filter((el) => el.getClientRects().length > 0);
      const conSimbolo = cifras
        .map((el) => ({ el, s: el.querySelector<HTMLElement>(".cifra-simbolo"), e: el.querySelector<HTMLElement>(".cifra-entero") }))
        .filter((x) => x.s && x.e && !["12", "13", "14"].includes(x.el.dataset["tamano"] ?? ""));
      return {
        visibles: visibles.length,
        cifras: cifras.length,
        enMono,
        tableros: document.querySelectorAll("[data-testid='odometro-digito'], .odometro-hoja").length,
        familias: [...new Set(cifras.map((el) => getComputedStyle(el).fontFamily.split(",")[0]!.replace(/"/g, "").trim()))],
        simboloMasChico: conSimbolo.every((x) => parseFloat(getComputedStyle(x.s!).fontSize) < parseFloat(getComputedStyle(x.e!).fontSize)),
        conSimbolo: conSimbolo.length,
      };
    }, CIFRAS);

    // Evidencia: captura siempre (es el objetivo de esta prueba), en la carpeta de evidencia y adjunta al reporte.
    const carpeta = join(SALIDA, "cifras", p.nombre);
    mkdirSync(carpeta, { recursive: true });
    const png = join(carpeta, `${info.project.name}-${ETAPA}${DS3 ? "-ds3" : ""}.png`);
    await page.screenshot({ path: png, fullPage: true });
    await info.attach(`${p.nombre}-${info.project.name}`, { path: png, contentType: "image/png" });
    await info.attach(`${p.nombre}-lectura`, { body: JSON.stringify(lectura, null, 1), contentType: "application/json" });

    expect(lectura.visibles, "la pantalla pinta cifras protagonistas").toBeGreaterThan(0);
    expect(lectura.tableros, "ningun tablero de digitos del odometro (estilo reloj)").toBe(0);
    expect(lectura.enMono, "ninguna cifra protagonista en mono").toEqual([]);
    if (DS3) {
      expect(lectura.cifras).toBeGreaterThan(0);
      for (const f of lectura.familias) expect(f).toBe("Hanken Grotesk");
      expect(lectura.simboloMasChico, "signo de moneda atenuado (mas chico que el entero)").toBe(true);
    }

    // Paridad Rovaq del Resumen (PARIDAD #5/#6/#18): eyebrow, H1 20/600, frase en vez del odometro, tira de KPI con borde de 3 px.
    if (DS3) {
      const resumen = await page.evaluate(() => {
        const r = document.querySelector<HTMLElement>(".ds3-resumen");
        if (!r) return null;
        const vis = (el: Element | null) => !!el && getComputedStyle(el).display !== "none" && (el as HTMLElement).getClientRects().length > 0;
        const h1 = r.querySelector("h1")!;
        const celda = r.querySelector<HTMLElement>('[data-parte="kpis"] > *');
        return {
          eyebrow: vis(r.querySelector('[data-parte="eyebrow"]')),
          h1: [getComputedStyle(h1).fontSize, getComputedStyle(h1).fontWeight],
          conFrase: r.hasAttribute("data-con-frase"),
          frase: vis(r.querySelector('[data-parte="frase"]')),
          odometro: vis(r.querySelector('[data-testid="odometro"]')),
          bordeKpi: celda ? getComputedStyle(celda).boxShadow : null,
        };
      });
      await info.attach(`${p.nombre}-resumen`, { body: JSON.stringify(resumen, null, 1), contentType: "application/json" });
      if (resumen) {
        expect(resumen.eyebrow, "eyebrow «RESUMEN» visible").toBe(true);
        expect(resumen.h1).toEqual(["20px", "600"]);
        if (resumen.conFrase) {
          expect(resumen.frase, "frase con cifras visible").toBe(true);
          expect(resumen.odometro, "sin odometro bajo ds3 (no existe en Rovaq)").toBe(false);
        }
        if (resumen.bordeKpi !== null) expect(resumen.bordeKpi).toMatch(/inset/);
      }
    }

    const { linea } = await medir(page, info, `cifras-${p.consola}`, p.ruta());
    if (!INFORMATIVO) expect(linea, "el medidor no reporta defectos nuevos").toEqual([]);
    vigilante.verificar();
  });
}
