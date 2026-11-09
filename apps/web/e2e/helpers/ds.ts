// Aserciones del sistema de diseno (DS v2): un solo <main>, skip link, foco y claro/oscuro.
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** Un unico <main> (el del shell) y ninguno anidado: HTML valido y un solo landmark principal. */
export async function afirmarUnSoloMain(page: Page): Promise<void> {
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("main main")).toHaveCount(0);
}

/** El primer Tab alcanza "Saltar al contenido" y activarlo mueve el foco al <main id="contenido-principal">. */
export async function afirmarSkipLink(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Saltar al contenido" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#contenido-principal")).toBeFocused();
}

/** Modo claro/oscuro: `html.dark`. */
export async function afirmarModo(page: Page, esperado: "claro" | "oscuro"): Promise<void> {
  const html = page.locator("html");
  if (esperado === "oscuro") await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  else await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
}

/** Sin desbordamiento horizontal de la pagina (importante en 375 px). */
export async function afirmarSinScrollHorizontal(page: Page): Promise<void> {
  const desborda = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(desborda, "la pagina desborda en horizontal").toBe(false);
}

const SALUDO = /^(Buenos días|Buenas tardes|Buenas noches), /;

/**
 * Encabezado de nivel 1 del Resumen (ResumenLayout de @atiende/ui), segun el diseno que quedo en `<html>`:
 *  - ds3 (por omision desde #758): el nivel 1 es el nombre de la pagina, «Resumen» (`<p role="heading" aria-level="1">`,
 *    PARIDAD-ATIENDE-ROVAQ §R1 y packages/ui/src/ds3/contenido.css) y el saludo `<h1>` se apaga por CSS.
 *  - legado (interruptor de emergencia VITE_DISENO_LEGADO=1): el saludo «Buenos días, <nombre>» sigue siendo el `<h1>`.
 * En los dos casos hay UN solo nivel 1 en el arbol accesible. Sustituye a las aserciones que fijaban el saludo del diseno legado.
 */
export async function afirmarEncabezadoResumen(page: Page): Promise<void> {
  const nivel1 = page.getByRole("heading", { level: 1 });
  await expect(nivel1).toHaveCount(1);
  if ((await page.locator("html").getAttribute("data-diseno")) === "ds3") {
    await expect(nivel1).toHaveText("Resumen");
    await expect(nivel1).toBeVisible();
    await expect(page.locator('.ds3-resumen h1[data-parte="titulo"]'), "el saludo legado no se ve bajo ds3").toBeHidden();
  } else {
    await expect(nivel1).toContainText(SALUDO);
    await expect(nivel1).toBeVisible();
  }
}
