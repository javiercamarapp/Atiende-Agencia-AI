import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";
import { hoteles } from "../mock-api/fixtures/hoteles.ts";

test.describe("hoteles @humo", () => {
  test("owner: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("hoteles", "owner");
    expect(aterrizaje.startsWith(`/hoteles/${hoteles.orgSlug}`)).toBe(true);
    await afirmarPantallaSana(page, "panel");
    await recorrerSecciones(page, { minimo: 12 });
    vigilante.verificar();
  });

  test("cancelar ticket: Volver y Escape no escriben; confirmar hace un POST /cancelar", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("hoteles", "owner");
    await page.goto(`/hoteles/${hoteles.orgSlug}/tickets`);
    await expect(page.getByText("Faltan toallas en la habitacion 204")).toBeVisible();
    const cancelar = page.getByRole("button", { name: "Cancelar", exact: true }).first();

    await afirmarCancelarNoEscribe(page, mock, cancelar, { nombre: "Cancelar este ticket", botonCancelar: "Volver", verificarFoco: false });

    await cancelar.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancelar ticket" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/tickets/tkt-1/cancelar" })).length).toBe(1);
    vigilante.verificar();
  });
});
