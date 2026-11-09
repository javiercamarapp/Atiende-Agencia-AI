// Accesibilidad con axe (@axe-core/playwright) en las pantallas principales: el login de cada vertical (sin sesion) y el Resumen de cada
// vertical con su owner de e2e/mock-api/personas.ts. Etiquetas WCAG 2.0/2.1/2.2 A y AA (ETIQUETAS_WCAG). Trinquete contra
// e2e-ds3/axe-baseline.json ([{ruta, regla, nodos}], ruta = «/pantalla @proyecto»): una violacion que no esta en la baseline o con mas
// nodos falla; una entrada que bajo falla pidiendo bajar la baseline (el piso solo desciende; logica en axe-trinquete.ts).
//
// Medir para llenar la baseline: AXE_MEDIR=1 no afirma nada; escribe lo medido por pantalla en test-results-ds3/axe-medicion/ y
// e2e-ds3/axe-unir-baseline.ts lo junta en axe-baseline.json (comando exacto en docs/QA-E2E.md, seccion «Accesibilidad con axe»).
// API simulada de e2e/mock-api, nunca la real. El detalle de cada violacion (selector de cada nodo) va adjunto al reporte.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { esperarAnimaciones } from "../e2e/helpers/esperas.ts";
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { orgDe, VERTICALES } from "../e2e/mock-api/personas.ts";
import { claveAxe, compararConBaseline, ETIQUETAS_WCAG, leerBaseline, ordenarEntradas, type EntradaAxe } from "./axe-trinquete.ts";
import { esperarSinCarga, prepararBandera, slug } from "./comun.ts";

const BASELINE = leerBaseline(readFileSync(new URL("./axe-baseline.json", import.meta.url), "utf8"));
const MEDIR = process.env["AXE_MEDIR"] === "1";
const CARPETA_MEDICION = new URL("../test-results-ds3/axe-medicion/", import.meta.url);

test.beforeEach(async ({ page }) => {
  await prepararBandera(page);
});

async function auditar(page: Page, info: TestInfo, ruta: string): Promise<void> {
  const resultado = await new AxeBuilder({ page }).withTags([...ETIQUETAS_WCAG]).analyze();
  const clave = claveAxe(ruta, info.project.name);
  const medidas: EntradaAxe[] = ordenarEntradas(resultado.violations.map((v) => ({ ruta: clave, regla: v.id, nodos: v.nodes.length })));
  const detalle = resultado.violations.map((v) => ({ regla: v.id, impacto: v.impact, ayuda: v.helpUrl, nodos: v.nodes.map((n) => n.target.join(" ")) }));
  await info.attach(`axe-${slug(ruta)}.json`, { body: JSON.stringify(detalle, null, 1), contentType: "application/json" });

  if (MEDIR) {
    mkdirSync(CARPETA_MEDICION, { recursive: true });
    writeFileSync(new URL(`${slug(clave)}.json`, CARPETA_MEDICION), JSON.stringify(medidas, null, 1));
    return;
  }
  const { nuevas, bajaron } = compararConBaseline(clave, medidas, BASELINE);
  expect(nuevas, `violaciones de axe nuevas o que crecieron en ${clave}:\n${nuevas.join("\n")}`).toEqual([]);
  expect(bajaron, `la accesibilidad mejoro en ${clave}; baja e2e-ds3/axe-baseline.json:\n${bajaron.join("\n")}`).toEqual([]);
}

for (const vertical of VERTICALES) {
  test(`axe · login de ${vertical}`, async ({ page }, info) => {
    const ruta = `/${vertical}/login`;
    await page.goto(ruta);
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await esperarAnimaciones(page); // la entrada escalonada del login termina antes de medir contraste
    await auditar(page, info, ruta);
  });

  test(`axe · Resumen de ${vertical} (owner)`, async ({ page, iniciarSesion }, info) => {
    await iniciarSesion(vertical, "owner");
    const ruta = `/${vertical}/${orgDe(vertical).slug}`;
    await page.goto(ruta);
    await expect(page.locator("main#contenido-principal")).toBeVisible();
    await esperarSinCarga(page);
    await esperarAnimaciones(page);
    await auditar(page, info, ruta);
  });
}
