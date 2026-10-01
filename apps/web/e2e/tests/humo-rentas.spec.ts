import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";
import { rentas } from "../mock-api/fixtures/rentas.ts";

test.describe("rentas @humo", () => {
  test("owner: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("rentas", "owner");
    expect(aterrizaje.startsWith(`/rentas/${rentas.orgSlug}`)).toBe(true);
    await afirmarPantallaSana(page, "panel");
    await recorrerSecciones(page, { minimo: 8 });
    vigilante.verificar();
  });

  test("cancelar reserva: 'No, mantenerla' y Escape no escriben; confirmar hace un POST /cancelar", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("rentas", "owner");
    await page.goto(`/rentas/${rentas.orgSlug}/calendario`);
    // La vista "Lista" muestra una tarjeta por ocupacion con sus acciones; la de "Calendario" es de solo lectura.
    await page.getByRole("button", { name: "Lista" }).click();
    const cancelar = page.getByRole("button", { name: "Cancelar reserva" });
    await expect(cancelar).toBeVisible();

    await afirmarCancelarNoEscribe(page, mock, cancelar, { nombre: "¿Cancelar esta reserva?", botonCancelar: "No, mantenerla", verificarFoco: false });

    await cancelar.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Sí, cancelar reserva" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/reservas/ocu-1/cancelar" })).length).toBe(1);
    vigilante.verificar();
  });
});
