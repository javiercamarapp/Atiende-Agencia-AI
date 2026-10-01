// Dialogos: abrir, cerrar con Cancelar o Escape y comprobar que NO se disparo ninguna escritura.
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { ClienteMock } from "../mock-api/cliente.ts";

export function dialogo(page: Page, nombre?: string | RegExp): Locator {
  return nombre === undefined ? page.getByRole("dialog").or(page.getByRole("alertdialog")) : page.getByRole("dialog", { name: nombre }).or(page.getByRole("alertdialog", { name: nombre }));
}

export async function abrirDialogo(page: Page, disparador: Locator, nombre?: string | RegExp): Promise<Locator> {
  await disparador.click();
  const d = dialogo(page, nombre);
  await expect(d).toBeVisible();
  return d;
}

export async function cerrarConEscape(page: Page, d: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(d).toBeHidden();
}

export async function cerrarConCancelar(d: Locator, nombreBoton: string | RegExp = /^(Cancelar|Volver)$/): Promise<void> {
  await d.getByRole("button", { name: nombreBoton }).click();
  await expect(d).toBeHidden();
}

/**
 * Cierra un dialogo destructivo por las dos vias de "no" (Cancelar y Escape) y comprueba que el mock NO recibio
 * ninguna escritura (POST/PUT/PATCH/DELETE). Con `verificarFoco` (por defecto true) comprueba ademas que el foco vuelve
 * al disparador al cerrar (WCAG 2.4.3). Hoy los confirm de useConfirm lo pierden (BUG-E2E-001, ver docs/QA-E2E.md):
 * los humos pasan `verificarFoco: false` y una prueba aparte, marcada test.fail, documenta el defecto.
 */
export async function afirmarCancelarNoEscribe(page: Page, mock: ClienteMock, disparador: Locator, opciones: { nombre?: string | RegExp; botonCancelar?: string | RegExp; verificarFoco?: boolean } = {}): Promise<void> {
  await mock.limpiarRegistro();
  for (const via of ["cancelar", "escape"] as const) {
    const d = await abrirDialogo(page, disparador, opciones.nombre);
    if (via === "cancelar") await cerrarConCancelar(d, opciones.botonCancelar);
    else await cerrarConEscape(page, d);
    if (opciones.verificarFoco ?? true) await expect(disparador).toBeFocused();
    const escrituras = await mock.escrituras();
    expect(escrituras, `Tras cerrar con ${via} no debe haber escrituras`).toEqual([]);
  }
}
