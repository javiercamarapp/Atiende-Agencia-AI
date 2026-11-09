// ThemeBoot externo: el diseno nuevo (ds3, el de todos) y el tema se aplican ANTES del primer pintado en rutas sin ThemeSelector ni
// shell (login y paginas publicas), sin destello (E24) y con el puente `data-theme` igual a `.dark`.
// Los proyectos "-oscuro" siguen al sistema (la fixture guarda `atiende-tema=sistema` y el navegador emula colorScheme dark).
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarModo } from "../helpers/ds.ts";

// El login NO esta aqui: es siempre claro, lo cubre la prueba de abajo.
const RUTAS_SIN_SELECTOR = ["/restaurantes/restablecer-contrasena"] as const;

interface Captura {
  dark: boolean;
  fondo: string;
  tema: string | null;
}

/** Registra el estado de <html> y el fondo del body en DOMContentLoaded (antes de que React monte nada). */
async function vigilarPrimerPintado(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __ds3: Captura };
    document.addEventListener("DOMContentLoaded", () => {
      w.__ds3 = {
        dark: document.documentElement.classList.contains("dark"),
        fondo: getComputedStyle(document.body).backgroundColor,
        tema: document.documentElement.getAttribute("data-theme"),
      };
    });
  });
}

const leerCaptura = (page: Page) => page.evaluate(() => (window as unknown as { __ds3: Captura }).__ds3);

for (const ruta of RUTAS_SIN_SELECTOR) {
  test(`@oscuro ${ruta} sin ThemeSelector tiene html.dark antes del primer paint y el fondo no cambia`, async ({ page }, info) => {
    const oscuro = info.project.name.endsWith("oscuro");
    await vigilarPrimerPintado(page);
    await page.goto(ruta);
    const alInicio = await leerCaptura(page);
    expect(alInicio.dark, "html.dark en DOMContentLoaded").toBe(oscuro);
    expect(alInicio.tema, "puente data-theme igual a la clase dark").toBe(oscuro ? "dark" : "light");
    await page.waitForLoadState("networkidle");
    await afirmarModo(page, oscuro ? "oscuro" : "claro");
    const alFinal = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(alFinal, "el fondo en DOMContentLoaded es el definitivo (sin destello)").toBe(alInicio.fondo);
  });
}

test("@oscuro el login es siempre claro desde el primer pintado, aunque el sistema este en oscuro (sin destello)", async ({ page }) => {
  await vigilarPrimerPintado(page);
  await page.goto("/restaurantes/login");
  const alInicio = await leerCaptura(page);
  expect(alInicio.dark, "html.dark en DOMContentLoaded").toBe(false);
  await page.waitForLoadState("networkidle");
  await afirmarModo(page, "claro");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(alInicio.fondo);
  expect(await page.locator('meta[name="theme-color"]').getAttribute("content")).toBe("#ffffff");
});

test("@oscuro el color de la barra del navegador sigue al tema", async ({ page }, info) => {
  const oscuro = info.project.name.endsWith("oscuro");
  await page.goto("/restaurantes/restablecer-contrasena");
  const color = await page.locator('meta[name="theme-color"]').getAttribute("content");
  expect(color).toBe(oscuro ? "#0e0e10" : "#ffffff");
});

test("el diseno nuevo esta en <html> en todas las consolas y paginas, sin parametro ni almacenamiento", async ({ page }) => {
  for (const ruta of ["/restaurantes/login", "/restaurantes/restablecer-contrasena", "/superadmin", "/no-existe"]) {
    await page.goto(ruta);
    await expect(page.locator("html"), ruta).toHaveAttribute("data-diseno", "ds3");
  }
});

test("los mecanismos retirados (?diseno=off y la bandera vieja en localStorage) ya no apagan el diseno nuevo", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("atiende-diseno", "off"));
  await page.goto("/restaurantes/login?diseno=off");
  await expect(page.locator("html")).toHaveAttribute("data-diseno", "ds3");
});
