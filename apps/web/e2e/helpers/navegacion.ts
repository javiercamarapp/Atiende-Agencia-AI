// Navegacion por el Sidebar (escritorio) y la barra inferior + hoja "Más" (movil) de VerticalShell.
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

export interface EnlaceNav {
  readonly texto: string;
  readonly href: string;
}

export function esMovil(page: Page): boolean {
  const v = page.viewportSize();
  return v !== null && v.width < 768;
}

export function sidebar(page: Page): Locator {
  return page.getByRole("complementary", { name: "Navegación principal" });
}

export function barraMovil(page: Page): Locator {
  return page.getByRole("navigation", { name: "Navegación móvil" });
}

/** Botones de grupo del Sidebar (un acordeon: abrir uno cierra el anterior; los grupos "siempre abiertos" no tienen boton). */
function botonesDeGrupo(page: Page): Locator {
  return sidebar(page).locator("button[aria-expanded]");
}

async function leerEnlaces(raiz: Locator): Promise<EnlaceNav[]> {
  const enlaces = raiz.getByRole("link");
  const n = await enlaces.count();
  const salida: EnlaceNav[] = [];
  for (let i = 0; i < n; i++) {
    const e = enlaces.nth(i);
    const href = await e.getAttribute("href");
    if (href) salida.push({ texto: ((await e.innerText()) || (await e.getAttribute("aria-label")) || "").trim(), href });
  }
  return salida;
}

/** Enlaces de seccion del Sidebar de escritorio: recorre cada grupo del acordeon y une lo que muestra cada uno. */
export async function enlacesSidebar(page: Page): Promise<EnlaceNav[]> {
  const unicos = new Map<string, EnlaceNav>();
  const agregar = async (): Promise<void> => {
    for (const e of await leerEnlaces(sidebar(page))) unicos.set(e.href, e);
  };
  await agregar();
  const botones = botonesDeGrupo(page);
  const n = await botones.count();
  for (let i = 0; i < n; i++) {
    const boton = botones.nth(i);
    if ((await boton.getAttribute("aria-expanded")) === "false") await boton.click();
    await agregar();
  }
  return [...unicos.values()];
}

/** Abre el grupo del Sidebar que contiene `href` (si ya esta visible no hace nada). */
async function abrirGrupoDe(page: Page, href: string): Promise<Locator> {
  const enlace = sidebar(page).locator(`a[href="${href}"]`).first();
  if ((await enlace.count()) > 0) return enlace;
  const botones = botonesDeGrupo(page);
  const n = await botones.count();
  for (let i = 0; i < n; i++) {
    const boton = botones.nth(i);
    if ((await boton.getAttribute("aria-expanded")) === "false") await boton.click();
    if ((await enlace.count()) > 0) return enlace;
  }
  throw new Error(`El Sidebar no tiene ningun enlace a ${href}`);
}

export async function abrirMasMovil(page: Page): Promise<Locator> {
  await barraMovil(page).getByRole("button", { name: "Más" }).click();
  const hoja = page.getByRole("dialog", { name: "Más secciones" });
  await expect(hoja).toBeVisible();
  return hoja;
}

/** Enlaces de la hoja "Más" del movil: son TODAS las secciones del panel. */
export async function enlacesMasMovil(page: Page): Promise<EnlaceNav[]> {
  const hoja = await abrirMasMovil(page);
  const enlaces = await leerEnlaces(hoja);
  await page.keyboard.press("Escape");
  await expect(hoja).toBeHidden();
  return enlaces;
}

/** Todas las secciones navegables del panel actual, segun el viewport. */
export async function seccionesDelPanel(page: Page): Promise<EnlaceNav[]> {
  const todas = esMovil(page) ? await enlacesMasMovil(page) : await enlacesSidebar(page);
  const vistas = new Set<string>();
  return todas.filter((e) => (vistas.has(e.href) ? false : (vistas.add(e.href), true)));
}

/** Navega a una seccion con un clic real en su enlace (en movil, via la hoja "Más"). */
export async function irASeccion(page: Page, enlace: EnlaceNav): Promise<void> {
  if (esMovil(page)) {
    const hoja = await abrirMasMovil(page);
    // `.first()`: el pie de superadmin ("Costos de IA") repite el destino de "Costos y margen" en la seccion "Cuenta".
    await hoja.locator(`a[href="${enlace.href}"]`).first().click();
    await expect(hoja).toBeHidden();
  } else {
    await (await abrirGrupoDe(page, enlace.href)).click();
  }
  await expect(page).toHaveURL(new RegExp(`${enlace.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
}
