import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";

test.describe("superadmin @humo", () => {
  test("superadmin: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("superadmin");
    expect(aterrizaje).toBe("/superadmin");
    await afirmarPantallaSana(page, "organizaciones");
    await expect(page.getByText("Taqueria El Faro")).toBeVisible();
    await recorrerSecciones(page, { minimo: 18 });
    vigilante.verificar();
  });

  test("interruptores: Cancelar y Escape no escriben; aplicar hace un PUT", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("superadmin");
    await page.goto("/superadmin/interruptores");
    const detener = page.getByRole("button", { name: "Detener" }).first();
    await expect(detener).toBeVisible();

    await afirmarCancelarNoEscribe(page, mock, detener, { nombre: "Detener", verificarFoco: false });

    await detener.click();
    const dialogo = page.getByRole("dialog", { name: "Detener" });
    await dialogo.getByLabel(/Motivo/).fill("Incidente de prueba: se detiene el LLM para validar el flujo");
    await dialogo.getByRole("button", { name: "Detener" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "PUT", ruta: "/superadmin/interruptores" })).length).toBe(1);
    vigilante.verificar();
  });
});
