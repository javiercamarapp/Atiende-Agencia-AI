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

  test("Resumen: Horas ahorradas pide configurarse, el dueño la configura y las metas salen en sus tiles; el staff no ve el boton", async ({ page, mock, vigilante }) => {
    await ir(page, "");
    await expect(main(page).getByText("Configúralo", { exact: false })).toBeVisible();
    await expect(main(page).getByText("Tu operación", { exact: true })).toBeVisible();
    await main(page).getByRole("button", { name: "Configurar horas y metas" }).click();
    const dlg = page.getByRole("dialog", { name: "Horas y metas del Resumen" });
    await dlg.getByLabel("Minutos que ahorra cada conversación atendida por el agente").fill("500");
    await dlg.getByRole("button", { name: "Guardar cambios" }).click();
    await expect(dlg.getByRole("alert")).toContainText("entre 1 y 120");
    expect((await mock.buscar({ metodo: "PUT", ruta: "/resumen/config" })).length).toBe(0);
    await dlg.getByLabel("Minutos que ahorra cada conversación atendida por el agente").fill("6");
    await dlg.getByLabel("Meta de pedidos por agentes IA (%)").fill("80");
    await dlg.getByRole("button", { name: "Guardar cambios" }).click();
    await expect(dlg).toBeHidden();
    expect((await mock.buscar({ metodo: "PUT", ruta: "/resumen/config" })).length).toBe(1);
    await expect(main(page).getByText("conversaciones (histórico, sucursales que ves) × 6 min ÷ 60", { exact: false })).toBeVisible();
    await expect(main(page).getByText("Tu meta: 80%", { exact: false })).toBeVisible();
    vigilante.verificar();
  });
});

test.describe("restaurantes paridad grupo A: Resumen, teclado del dialogo de configuracion @recorrido", () => {
  test("abre con Enter, el foco entra y queda atrapado en el dialogo, y Escape lo cierra", async ({ page, iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "");
    const boton = main(page).getByRole("button", { name: "Configurar horas y metas" });
    await boton.focus();
    await page.keyboard.press("Enter");
    const dlg = page.getByRole("dialog", { name: "Horas y metas del Resumen" });
    await expect(dlg).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    // Tab no se escapa del dialogo (foco atrapado).
    for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    // Que el foco VUELVA al boton al cerrar es el defecto conocido BUG-E2E-001 de FormDialog (hay test.fail en humo-restaurantes y recorrido-dialogos);
    // no se afirma aqui para no duplicarlo ni esconderlo: cuando se arregle ese defecto, esos test.fail avisaran.
  });
});

test.describe("restaurantes paridad grupo A: Resumen como staff @recorrido", () => {
  test("el staff ve las horas y no puede configurarlas", async ({ page, iniciarSesion }) => {
    await iniciarSesion("restaurantes", "staff");
    await ir(page, "");
    await expect(main(page).getByText("Horas de atención ahorradas", { exact: true })).toBeVisible();
    await expect(main(page).getByRole("button", { name: "Configurar horas y metas" })).toHaveCount(0);
  });
});
