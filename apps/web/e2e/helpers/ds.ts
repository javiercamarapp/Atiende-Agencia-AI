// Aserciones del sistema de diseno (DS v2): un solo <main>, skip link, foco, ?ds=v2 / ?ds=off y claro/oscuro.
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

/** Estado de la bandera DS v2 en <html data-theme="v2">. */
export async function afirmarTemaDs(page: Page, esperado: "v2" | "off"): Promise<void> {
  const html = page.locator("html");
  if (esperado === "v2") await expect(html).toHaveAttribute("data-theme", "v2");
  else await expect(html).not.toHaveAttribute("data-theme", "v2");
}

/** Modo claro/oscuro: `html.dark`. */
export async function afirmarModo(page: Page, esperado: "claro" | "oscuro"): Promise<void> {
  const html = page.locator("html");
  if (esperado === "oscuro") await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  else await expect(html).not.toHaveClass(/(^|\s)dark(\s|$)/);
}

/** Anade `?ds=…` a una ruta (respeta los parametros existentes). */
export function conDs(ruta: string, ds: "v2" | "off"): string {
  return `${ruta}${ruta.includes("?") ? "&" : "?"}ds=${ds}`;
}

/** Sin desbordamiento horizontal de la pagina (importante en 375 px). */
export async function afirmarSinScrollHorizontal(page: Page): Promise<void> {
  const desborda = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(desborda, "la pagina desborda en horizontal").toBe(false);
}
