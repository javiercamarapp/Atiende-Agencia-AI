// ds3 / 0.1 (ThemeBoot externo): el tema se aplica ANTES del primer pintado en rutas sin ThemeSelector ni shell (login y paginas
// publicas), sin destello (E24) y sin `data-theme`. La bandera de diseno (`?diseno=ds3`) llega a <html> y se recuerda.
// Los proyectos "-oscuro" siguen al sistema (la fixture guarda `atiende-tema=sistema` y el navegador emula colorScheme dark).
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarModo } from "../helpers/ds.ts";

const RUTAS_SIN_SELECTOR = ["/restaurantes/login", "/restaurantes/restablecer-contrasena"] as const;

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
    expect(alInicio.tema, "html no lleva data-theme").toBeNull();
    await page.waitForLoadState("networkidle");
    await afirmarModo(page, oscuro ? "oscuro" : "claro");
    const alFinal = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(alFinal, "el fondo en DOMContentLoaded es el definitivo (sin destello)").toBe(alInicio.fondo);
  });
}

test("@oscuro el color de la barra del navegador sigue al tema", async ({ page }, info) => {
  const oscuro = info.project.name.endsWith("oscuro");
  await page.goto("/restaurantes/login");
  const color = await page.locator('meta[name="theme-color"]').getAttribute("content");
  expect(color).toBe(oscuro ? "#0e0e10" : "#ffffff");
});

test("?diseno=ds3 enciende la bandera en <html>, se recuerda al navegar sin parametro y ?diseno=off la apaga", async ({ page }) => {
  await page.goto("/restaurantes/login");
  await expect(page.locator("html")).not.toHaveAttribute("data-diseno", /.*/);
  await page.goto("/restaurantes/login?diseno=ds3");
  await expect(page.locator("html")).toHaveAttribute("data-diseno", "ds3");
  await page.goto("/restaurantes/login");
  await expect(page.locator("html")).toHaveAttribute("data-diseno", "ds3");
  await page.goto("/restaurantes/login?diseno=off");
  await expect(page.locator("html")).not.toHaveAttribute("data-diseno", /.*/);
});
