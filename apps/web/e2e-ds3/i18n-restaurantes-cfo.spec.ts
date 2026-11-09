// i18n ES/EN — CFO de restaurantes (pestanas migradas). Para cada una: la abre en espanol (captura), elige ingles (misma clave que el
// selector del sidebar, `atiende-idioma`), recarga y captura. Exige que en ingles las frases fijas del CFO ya no salgan en espanol y que
// nunca se pinte una clave cruda del catalogo. Lo que arma el servidor (etiquetas de KPI, hallazgos, narrativa) viene de la API simulada
// y sigue en espanol a proposito. Capturas como adjuntos y, con DS3_CAPTURAS=1, en la carpeta de evidencia (i18n-restaurantes-cfo/<pestana>/).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { restaurantes } from "../e2e/mock-api/fixtures/restaurantes.ts";
import { esperarSinCarga, prepararBandera } from "./comun.ts";

const SALIDA = process.env["DS3_SALIDA"] ?? "test-results-ds3/evidencia";
const CLAVE_CRUDA = /\brestaurantes\.[a-zA-Z]+\.[A-Za-z0-9.]+/;
const RANGO = "desde=2026-09-21&hasta=2026-09-27&comparar=periodo_anterior";
const BASE = `/restaurantes/${restaurantes.orgSlug}/cfo`;

/** Pestanas migradas y frases fijas que, en espanol, solo pinta el CFO. */
const PESTANAS: ReadonlyArray<{ readonly id: string; readonly es: RegExp; readonly en: RegExp }> = [
  { id: "resumen", es: /Lo más importante|Resumen narrado|Comparar contra/, en: /What matters most|Narrative summary|Compare with/ },
  { id: "ventas", es: /Tendencia de ventas netas|Forma de pago|Comparar contra/, en: /Net sales trend|Payment method|Compare with/ },
  { id: "estado-resultados", es: /Estado de resultados operativo|Capturar costos|Ajustes del CFO/, en: /Operating P&L|CFO settings/ },
  { id: "clientes", es: /Base de clientes|Recompra por cohorte|Clientes nuevos por semana/, en: /Customer base|Repurchase by cohort/ },
  { id: "platillos", es: /Más y menos vendidos|Mix por categoría|Agotados hoy/, en: /Best and worst sellers|Mix by category/ },
];

test.beforeEach(async ({ page }) => {
  await prepararBandera(page);
  // El idioma solo cambia con el diseno ds3 (el unico con selector ES/EN): este spec lo enciende siempre.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("atiende-diseno", "ds3");
    } catch {
      // Sin almacenamiento: el spec fallara al no ver ingles, que es lo correcto.
    }
  });
});

for (const p of PESTANAS) {
  test(`i18n restaurantes CFO ${p.id}: ES y EN`, async ({ page, iniciarSesion }, info) => {
    await iniciarSesion("restaurantes", "owner");
    const carpeta = join(SALIDA, "i18n-restaurantes-cfo", p.id);
    mkdirSync(carpeta, { recursive: true });
    const main = page.locator("main#contenido-principal");
    const capturar = async (idioma: "es" | "en") => {
      const ruta = join(carpeta, `${info.project.name}-${idioma}.png`);
      await page.screenshot({ path: ruta, fullPage: false });
      await info.attach(`cfo-${p.id}-${idioma}`, { path: ruta, contentType: "image/png" });
    };

    await page.goto(`${BASE}/${p.id}?${RANGO}`);
    await expect(main).toBeVisible();
    await esperarSinCarga(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
    await expect(main).toContainText(p.es);
    await capturar("es");

    await page.evaluate(() => window.localStorage.setItem("atiende-idioma", "en"));
    await page.reload();
    await expect(main).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await expect(main).toContainText(p.en);
    await page.waitForFunction(() => document.querySelectorAll('[role="status"][aria-busy="true"]').length === 0, undefined, { timeout: 20_000 });
    const texto = await main.innerText();
    expect(texto, "frases del CFO que siguen en espanol con EN elegido").not.toMatch(p.es);
    expect(texto).not.toMatch(CLAVE_CRUDA);
    await capturar("en");
  });
}
