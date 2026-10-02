// Repartidor (fuera del shell): entregas asignadas y nota de incidencia con useConfirm().pedirTexto.
import { afirmarCancelarNoEscribe, dialogo } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";

test.describe("restaurantes repartidor", () => {
  test("lista las entregas; Volver/Escape no escriben; reportar incidencia hace un PATCH con la nota", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto(`/restaurantes/${restaurantes.orgSlug}/repartidor`);
    await expect(page.getByRole("heading", { name: "Mis entregas" })).toBeVisible();
    await expect(page.getByText("Marisol Pech")).toBeVisible();
    await expect(page.getByRole("button", { name: "Marcar en camino" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Marcar entregado" })).toBeVisible();

    const incidencia = page.getByRole("button", { name: "Reportar incidencia" }).first();
    await afirmarCancelarNoEscribe(page, mock, incidencia, { nombre: /Reportar incidencia/, botonCancelar: "Volver", verificarFoco: false });

    await incidencia.click();
    const d = dialogo(page, /Reportar incidencia/);
    await d.getByLabel("Nota para administración").fill("El cliente no contesta el teléfono.");
    await d.getByRole("button", { name: "Reportar incidencia" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "PATCH", ruta: "/repartidor/orders/" })).length).toBe(1);
    const [patch] = await mock.buscar({ metodo: "PATCH", ruta: "/repartidor/orders/" });
    expect(patch?.cuerpo).toMatchObject({ status: "problema", incidentNote: "El cliente no contesta el teléfono." });
    await expect(page.getByText("El cliente no contesta el teléfono.")).toBeVisible();
    vigilante.verificar();
  });
});
