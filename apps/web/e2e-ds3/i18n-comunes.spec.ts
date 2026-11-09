// i18n ES/EN — componentes comunes. En cada consola recorre (en ingles) las primeras pantallas del menu y exige que los textos
// de los componentes compartidos (tabla, paginacion, estados vacio/error/cargando, campos) ya no salgan en espanol. El contenido
// propio de cada pagina se migra en los PRs por vertical; aqui solo se mide lo comun. Capturas ES/EN de la primera pantalla.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { seccionesDelPanel } from "../e2e/helpers/navegacion.ts";
import { VERTICALES } from "../e2e/mock-api/personas.ts";
import { esperarSinCarga, prepararBandera } from "./comun.ts";

const CONSOLAS = [...VERTICALES, "superadmin"] as const;
const SALIDA = process.env["DS3_SALIDA"] ?? "test-results-ds3/evidencia";
/** Frases exactas de los componentes comunes en espanol (no del contenido de la pagina). */
const COMUNES_ES = /Mostrando \d+–\d+ de|Página \d+ de \d+|Sin registros|No hay registros que mostrar|No se pudo cargar la información|Migas de pan|Seleccionar todas/;
const MAX_PANTALLAS = 4;

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

for (const consola of CONSOLAS) {
  test(`i18n comunes ${consola}: tablas, estados y campos en ingles`, async ({ page, iniciarSesion }, info) => {
    await iniciarSesion(consola, "owner");
    await esperarSinCarga(page);
    const rutas = (await seccionesDelPanel(page)).map((e) => e.href).slice(0, MAX_PANTALLAS);
    const carpeta = join(SALIDA, "i18n-comunes", consola);
    mkdirSync(carpeta, { recursive: true });
    const capturar = async (idioma: "es" | "en") => {
      const ruta = join(carpeta, `${info.project.name}-${idioma}.png`);
      await page.screenshot({ path: ruta, fullPage: false });
      await info.attach(`${consola}-${idioma}`, { path: ruta, contentType: "image/png" });
    };
    await page.goto(rutas[0] ?? "/");
    await esperarSinCarga(page);
    await capturar("es");

    await page.evaluate(() => window.localStorage.setItem("atiende-idioma", "en"));
    const hallazgos: string[] = [];
    for (const [i, href] of rutas.entries()) {
      await page.goto(href);
      await expect(page.locator("main#contenido-principal")).toBeVisible();
      await page.waitForFunction(() => document.querySelectorAll('[role="status"][aria-busy="true"]').length === 0, undefined, { timeout: 20_000 });
      if (i === 0) await capturar("en");
      const texto = await page.evaluate(() => `${document.body.innerText}\n${[...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join("\n")}`);
      const m = COMUNES_ES.exec(texto);
      if (m) hallazgos.push(`${href}: «${m[0]}»`);
    }
    expect(hallazgos, "textos de componentes comunes que siguen en espanol con EN elegido").toEqual([]);
  });
}
