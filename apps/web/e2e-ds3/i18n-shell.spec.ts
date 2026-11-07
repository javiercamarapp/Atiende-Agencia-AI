// i18n ES/EN — shell y navegacion de las 7 consolas. Entra en espanol y lee el menu completo (Sidebar en escritorio, hoja «Más» en
// movil); elige ingles, recarga y vuelve a leerlo con los nombres ingleses de los landmarks. Exige: mismos destinos, ningun texto
// del menu con letras del espanol (acentos, ñ) y casi todos distintos del espanol (solo siglas/nombres propios se repiten: CFDI,
// Staff, P&L...). Captura ES y EN de cada consola (adjuntos y, con DS3_CAPTURAS=1, evidencia-ds3/i18n-shell/<consola>/).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { esMovil, seccionesDelPanel } from "../e2e/helpers/navegacion.ts";
import { VERTICALES } from "../e2e/mock-api/personas.ts";
import { esperarSinCarga, prepararBandera } from "./comun.ts";

const CONSOLAS = [...VERTICALES, "superadmin"] as const;
const SALIDA = process.env["DS3_SALIDA"] ?? "test-results-ds3/evidencia";
/** Textos que se dicen igual en los dos idiomas (siglas, nombres propios, prestamos del ingles). */
const IGUALES = new Set(["CFO", "CFDI", "P&L", "Staff", "Housekeeping", "Bookkeeping", "Revenue", "Tickets", "WhatsApp", "Model Ops", "Orgs", "Radar"]);

async function enlaces(raiz: Locator): Promise<Map<string, string>> {
  const salida = new Map<string, string>();
  const a = raiz.getByRole("link");
  for (let i = 0; i < (await a.count()); i++) {
    const href = await a.nth(i).getAttribute("href");
    const texto = ((await a.nth(i).innerText()) || "").trim();
    if (href && texto && !salida.has(href)) salida.set(href, texto);
  }
  return salida;
}

/** Menu completo en ingles: abre cada grupo del Sidebar o la hoja «More» del movil. */
async function menuEnIngles(page: Page): Promise<Map<string, string>> {
  if (esMovil(page)) {
    await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "More" }).click();
    const hoja = page.getByRole("dialog", { name: "More sections" });
    await expect(hoja).toBeVisible();
    const m = await enlaces(hoja);
    await page.keyboard.press("Escape");
    return m;
  }
  const aside = page.getByRole("complementary", { name: "Main navigation" });
  const todos = await enlaces(aside.locator("nav"));
  const botones = aside.locator("button[aria-expanded]");
  for (let i = 0; i < (await botones.count()); i++) {
    if ((await botones.nth(i).getAttribute("aria-expanded")) === "false") await botones.nth(i).click();
    for (const [h, t] of await enlaces(aside.locator("nav"))) if (!todos.has(h)) todos.set(h, t);
  }
  // Pildoras del pie (Notificaciones, Seguridad de la cuenta...), igual que `seccionesDelPanel` en espanol.
  for (const [h, t] of await enlaces(aside)) if (!todos.has(h)) todos.set(h, t);
  return todos;
}

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
  test(`i18n shell ${consola}: el menu completo cambia a ingles natural`, async ({ page, iniciarSesion }, info) => {
    const capturar = async (idioma: "es" | "en") => {
      const carpeta = join(SALIDA, "i18n-shell", consola);
      mkdirSync(carpeta, { recursive: true });
      const ruta = join(carpeta, `${info.project.name}-${idioma}.png`);
      await page.screenshot({ path: ruta, fullPage: false });
      await info.attach(`${consola}-${idioma}`, { path: ruta, contentType: "image/png" });
    };

    await iniciarSesion(consola, "owner");
    await esperarSinCarga(page);
    const es = new Map((await seccionesDelPanel(page)).map((e) => [e.href, e.texto] as const));
    expect(es.size).toBeGreaterThan(3);
    await capturar("es");

    await page.evaluate(() => window.localStorage.setItem("atiende-idioma", "en"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
    await expect(page.getByRole("complementary", { name: "Main navigation" }).or(page.getByRole("navigation", { name: "Mobile navigation" })).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeAttached();
    await capturar("en");
    const en = await menuEnIngles(page);

    const faltan = [...es.keys()].filter((h) => !en.has(h));
    expect(faltan, "destinos del menu en espanol que no aparecen en ingles").toEqual([]);
    const conEspanol = [...en.values()].filter((t) => /[áéíóúñ¿¡]/i.test(t));
    expect(conEspanol, "textos del menu en ingles con letras del espanol").toEqual([]);
    const iguales = [...es].filter(([h, t]) => en.get(h) === t && !IGUALES.has(t)).map(([, t]) => t);
    expect(iguales, "textos del menu que se quedaron en espanol").toEqual([]);
  });
}
