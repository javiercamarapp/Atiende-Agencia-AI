// i18n ES/EN — restaurantes: historial, comandas al POS, conversaciones y avisos (grupo «autopiloto»). Para cada pantalla migrada: la recorre en espanol (captura), elige ingles (misma clave que
// el selector del sidebar, `atiende-idioma`), recarga y captura. Exige que en ingles el contenido propio de la pagina ya no salga en
// espanol (frases fijas de cada pantalla) y que nunca se pinte una clave cruda del catalogo. Las capturas ES/EN quedan como adjuntos
// del reporte y, con DS3_CAPTURAS=1, en la carpeta de evidencia (i18n-restaurantes/<pantalla>/). Los datos del negocio (productos,
// clientes, sucursales) vienen de la API simulada y siguen en espanol a proposito.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { esperarSinCarga, prepararBandera } from "./comun.ts";

const SALIDA = process.env["DS3_SALIDA"] ?? "test-results-ds3/evidencia";
const CLAVE_CRUDA = /\brestaurantes\.[a-z]+\.[A-Za-z0-9.]+/;

/** Pantallas migradas y las frases que, en espanol, solo puede pintar esa pagina (si alguna sigue con EN, falta migrar algo). */
const PANTALLAS: ReadonlyArray<{ readonly id: string; readonly ruta: string; readonly es: RegExp; readonly en: RegExp }> = [
  { id: "historial", ruta: "/historial", es: /Incidencias \/ no entregados|Todos los estados|Desde|Hasta/, en: /Issues \/ not delivered|All statuses|From/ },
  { id: "comandas-pos", ruta: "/comandas-pos", es: /Por atender|Resueltas|Modo efectivo|Actualizar/, en: /To handle|Resolved|Refresh/ },
  { id: "conversaciones", ruta: "/conversaciones", es: /Bandeja|De guardia ahora|Todos los estados/, en: /Inbox|All statuses/ },
  { id: "avisos", ruta: "/avisos", es: /Mis avisos|Elige qué avisos recibes/, en: /My alerts|Choose which alerts/ },
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

for (const p of PANTALLAS) {
  test(`i18n restaurantes ${p.id}: ES y EN`, async ({ page, iniciarSesion }, info) => {
    const inicio = await iniciarSesion("restaurantes", "owner");
    const base = inicio.split("/").slice(0, 3).join("/");
    const carpeta = join(SALIDA, "i18n-restaurantes", p.id);
    mkdirSync(carpeta, { recursive: true });
    const main = page.locator("main#contenido-principal");
    const capturar = async (idioma: "es" | "en") => {
      const ruta = join(carpeta, `${info.project.name}-${idioma}.png`);
      await page.screenshot({ path: ruta, fullPage: false });
      await info.attach(`${p.id}-${idioma}`, { path: ruta, contentType: "image/png" });
    };

    await page.goto(`${base}${p.ruta}`);
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
    expect(texto, "frases de la pagina que siguen en espanol con EN elegido").not.toMatch(p.es);
    expect(texto).not.toMatch(CLAVE_CRUDA);
    await capturar("en");
  });
}
