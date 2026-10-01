// Piezas reutilizables del recorrido humo de una vertical: plantilla para los recorridos completos.
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { afirmarUnSoloMain } from "./ds.ts";
import { irASeccion, seccionesDelPanel } from "./navegacion.ts";
import type { EnlaceNav } from "./navegacion.ts";

export const TEXTO_PANTALLA_ROTA = "Esta pantalla no pudo mostrarse";

/** La pagina actual pinto el shell: un <main> con foco programatico, sin el limite de error de la ruta activado. */
export async function afirmarPantallaSana(page: Page, contexto: string): Promise<void> {
  const main = page.locator("main#contenido-principal");
  await expect(main, `${contexto}: falta el <main> del shell`).toBeVisible();
  await expect(page.getByText(TEXTO_PANTALLA_ROTA), `${contexto}: la pantalla lanzo un error de render`).toHaveCount(0);
  await afirmarUnSoloMain(page);
}

export interface ResultadoRecorrido {
  readonly secciones: readonly EnlaceNav[];
}

/**
 * Recorre TODAS las secciones del menu (Sidebar en escritorio, hoja "Más" en movil) con clics reales y comprueba en
 * cada una URL, <main> sano y un solo <main>. La consola/red se verifica aparte con `vigilante.verificar()`.
 */
export async function recorrerSecciones(page: Page, opciones: { minimo: number }): Promise<ResultadoRecorrido> {
  const secciones = await seccionesDelPanel(page);
  expect(secciones.length, "el menu debe listar las secciones del panel").toBeGreaterThanOrEqual(opciones.minimo);
  for (const seccion of secciones) {
    await irASeccion(page, seccion);
    await afirmarPantallaSana(page, `${seccion.texto} (${seccion.href})`);
  }
  return { secciones };
}
