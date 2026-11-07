// i18n ES/EN — consola de superadmin, grupo «base» (consola, parte diario, organizaciones, gestion y ficha 360). Mismo recorrido que
// i18n-restaurantes.spec.ts: la pantalla en espanol (captura), elige ingles (`atiende-idioma`), recarga y captura. Exige que en ingles
// las frases fijas de cada pantalla ya no salgan en espanol y que nunca se pinte una clave cruda del catalogo. Capturas ES/EN como
// adjuntos y, con DS3_CAPTURAS=1, en la carpeta de evidencia (i18n-superadmin/<pantalla>/). Los datos (nombres de organizaciones,
// razones del servidor) vienen de la API simulada y siguen en espanol a proposito.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "../e2e/helpers/fixtures.ts";
import { esperarSinCarga, prepararBandera } from "./comun.ts";

const SALIDA = process.env["DS3_SALIDA"] ?? "test-results-ds3/evidencia";
const CLAVE_CRUDA = /\bsuperadmin\.[a-z]+\.[A-Za-z0-9.]+/;

/** La ficha no tiene ruta fija: se toma el enlace «Ficha» de la primera organizacion de la tabla. */
async function rutaFicha(page: Page): Promise<string> {
  await page.goto("/superadmin/organizaciones");
  const enlace = page.locator('main a[href^="/superadmin/organizaciones/"]').first();
  await enlace.waitFor({ state: "visible", timeout: 15_000 });
  return (await enlace.getAttribute("href")) ?? "/superadmin/organizaciones";
}

/** Pantallas migradas y las frases que, en espanol, solo puede pintar esa pagina (si alguna sigue con EN, falta migrar algo). */
const PANTALLAS: ReadonlyArray<{ readonly id: string; readonly ruta: string | ((page: Page) => Promise<string>); readonly es: RegExp; readonly en: RegExp }> = [
  { id: "consola", ruta: "/superadmin", es: /Orquestación de agentes|Operaciones atendidas|Ver parte diario/, en: /Agent orchestration|Operations handled|View daily report/ },
  { id: "parte-diario", ruta: "/superadmin/parte-diario", es: /Resumen diario|Generar ahora|Aún no hay resúmenes/, en: /Daily summary|Generate now|No summaries yet/ },
  { id: "organizaciones", ruta: "/superadmin/organizaciones", es: /Todas las organizaciones|Top por costo de IA|Últimos 30 días/, en: /All organizations|Top by AI cost|Last 30 days/ },
  { id: "gestion", ruta: "/superadmin/organizaciones?tab=gestion", es: /Alta de organización|Cada cambio se solicita con motivo/, en: /New organization|Each change is requested with a reason/ },
  { id: "ficha", ruta: rutaFicha, es: /Uso · últimos 30 días|Facturación y contrato|Membresías/, en: /Usage · last 30 days|Billing and contract|Memberships/ },
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
  test(`i18n superadmin ${p.id}: ES y EN`, async ({ page, iniciarSesion }, info) => {
    await iniciarSesion("superadmin");
    const carpeta = join(SALIDA, "i18n-superadmin", p.id);
    mkdirSync(carpeta, { recursive: true });
    const main = page.locator("main#contenido-principal");
    const capturar = async (idioma: "es" | "en") => {
      const ruta = join(carpeta, `${info.project.name}-${idioma}.png`);
      await page.screenshot({ path: ruta, fullPage: false });
      await info.attach(`${p.id}-${idioma}`, { path: ruta, contentType: "image/png" });
    };

    await page.goto(typeof p.ruta === "string" ? p.ruta : await p.ruta(page));
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
