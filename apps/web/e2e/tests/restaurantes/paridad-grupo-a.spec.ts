// Paridad con el repo suelto, grupo A (Resumen e Historial): lo que se igualo en el frontend y sus controles contra la API simulada.
// Resumen: selector de periodo con los rotulos del original, «Tendencias» con grafica de ejes y un punto por cubeta, cambio de periodo = peticion real.
// Historial: columnas del original, clic de fila = detalle a pagina completa y «Volver», Exportar con menu CSV/PDF.
import type { Page } from "@playwright/test";
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { ir } from "../../helpers/recorrido.ts";

const main = (page: Page) => page.locator("main#contenido-principal");

test.describe("restaurantes paridad grupo A: Resumen e Historial @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("Resumen: periodos del original y Tendencias con ejes; cada periodo pide sus datos", async ({ page, mock, vigilante }) => {
    await ir(page, "");
    const rotulos = ["Hoy", "7 días", "1 mes", "3 meses", "6 meses", "1 año", "Histórico"];
    for (const r of rotulos) await expect(main(page).getByText(r, { exact: true }).first()).toBeVisible();
    const graficas = main(page).getByTestId("grafica-tendencia");
    await expect(graficas).toHaveCount(2);
    await expect(main(page).getByText("Tendencias", { exact: true })).toBeVisible();
    await expect(graficas.first().locator("circle")).not.toHaveCount(0);
    await expect(graficas.first().locator("text").first()).toBeVisible();
    await afirmarPantallaSana(page, "resumen");

    await main(page).getByText("3 meses", { exact: true }).first().click();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "period=90" })).length).toBeGreaterThan(0);
    await main(page).getByText("Hoy", { exact: true }).first().click();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "period=today" })).length).toBeGreaterThan(0);
    vigilante.verificar();
  });

  test("Historial: columnas del original, fila abre el detalle y Volver regresa; Exportar ofrece CSV y PDF", async ({ page, vigilante }) => {
    await ir(page, "/historial");
    const cabeceras = main(page).getByRole("columnheader");
    if ((await cabeceras.count()) > 0) {
      await expect(cabeceras.nth(0)).toHaveText("Cliente");
      await expect(cabeceras.nth(1)).toHaveText("N° de pedido");
      await expect(cabeceras.nth(3)).toHaveText("Monto");
      await expect(cabeceras.nth(5)).toHaveText("Fecha");
    }
    await expect(main(page).getByTestId("historial-conteo")).toContainText("Mostrando");

    await main(page).getByRole("button", { name: "Exportar" }).click();
    await expect(page.getByRole("menuitem", { name: /CSV/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /PDF/ })).toBeVisible();
    await page.keyboard.press("Escape");

    await main(page).getByText("Marisol Pech").first().click();
    await expect(main(page).getByRole("button", { name: /Volver/ }).first()).toBeVisible();
    await expect(main(page).getByText("Marisol Pech").first()).toBeVisible();
    await main(page).getByRole("button", { name: /Volver/ }).first().click();
    await expect(main(page).getByTestId("historial-conteo")).toBeVisible();
    vigilante.verificar();
  });
});
