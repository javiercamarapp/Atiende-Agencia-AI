// i18n ES/EN — proveedor. En cada una de las 7 consolas: entra en espanol, captura; elige ingles (misma clave que el selector
// del sidebar, `atiende-idioma`), recarga y captura. Exige que <html lang> siga al idioma y que la consola siga pintando.
// Las capturas ES/EN quedan como adjuntos del reporte y, con DS3_CAPTURAS=1, en la carpeta de evidencia (i18n/<consola>/).
// Lo que se traduce en cada consola lo exigen los specs de cada ambito (i18n-shell.spec.ts, ...); este solo prueba el cableado.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { VERTICALES } from "../e2e/mock-api/personas.ts";
import { esperarSinCarga, prepararBandera } from "./comun.ts";

const CONSOLAS = [...VERTICALES, "superadmin"] as const;
const SALIDA = process.env["DS3_SALIDA"] ?? "test-results-ds3/evidencia";

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
  test(`i18n ${consola}: ES -> EN cambia <html lang> y la consola sigue en pie`, async ({ page, iniciarSesion }, info) => {
    await iniciarSesion(consola, "owner");
    await expect(page.locator("main#contenido-principal")).toBeVisible();
    await esperarSinCarga(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "es-MX");
    const capturar = async (idioma: "es" | "en") => {
      const carpeta = join(SALIDA, "i18n", consola);
      mkdirSync(carpeta, { recursive: true });
      const ruta = join(carpeta, `${info.project.name}-${idioma}.png`);
      await page.screenshot({ path: ruta, fullPage: false });
      await info.attach(`${consola}-${idioma}`, { path: ruta, contentType: "image/png" });
    };
    await capturar("es");

    await page.evaluate(() => window.localStorage.setItem("atiende-idioma", "en"));
    await page.reload();
    await expect(page.locator("main#contenido-principal")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await capturar("en");
  });
}
