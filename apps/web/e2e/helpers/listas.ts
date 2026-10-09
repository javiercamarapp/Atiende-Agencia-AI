// Listas desplegables (`Selector` de @atiende/ui = Radix Select): el disparador es un boton `role=combobox` y las opciones viven en un portal.
// El Selector marca cada opcion con `data-valor` (el valor, no la etiqueta), de modo que estas ayudas sustituyen a
// `selectOption(valor)` / `toHaveValue(valor)` de un <select> nativo.
import { expect, type Locator, type Page } from "@playwright/test";

/** Elige la opcion de ese VALOR. */
export async function elegirValor(disparador: Locator, valor: string): Promise<void> {
  const page: Page = disparador.page();
  await disparador.click();
  await page.locator(`[role="option"][data-valor="${valor}"]`).click();
}

/** Elige la opcion por su etiqueta exacta. */
export async function elegirEtiqueta(disparador: Locator, etiqueta: string): Promise<void> {
  const page: Page = disparador.page();
  await disparador.click();
  await page.getByRole("option", { name: etiqueta, exact: true }).click();
}

/** Afirma el valor ELEGIDO (el `toHaveValue` de un <select>): abre la lista y comprueba que Radix marca esa opcion como elegida; la cierra al terminar. */
export async function esperarValor(disparador: Locator, valor: string): Promise<void> {
  const page: Page = disparador.page();
  await disparador.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.locator(`[role="option"][data-valor="${valor}"]`)).toHaveAttribute("data-state", "checked");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
}
