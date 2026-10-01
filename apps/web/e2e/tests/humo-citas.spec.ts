import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";
import { citas } from "../mock-api/fixtures/citas.ts";

test.describe("citas @humo", () => {
  test("owner: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("citas", "owner");
    expect(aterrizaje.startsWith(`/citas/${citas.orgSlug}`)).toBe(true);
    await afirmarPantallaSana(page, "panel");
    const { secciones } = await recorrerSecciones(page, { minimo: 10 });
    expect(secciones.some((s) => s.href.endsWith("/agenda"))).toBe(true);
    vigilante.verificar();
  });

  test("cancelar cita: Volver y Escape no escriben; confirmar hace un POST /cancel", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");
    await page.goto(`/citas/${citas.orgSlug}/agenda`);
    const cancelar = page.getByRole("button", { name: /^Cancelar/ }).first();
    await expect(cancelar).toBeVisible();

    await afirmarCancelarNoEscribe(page, mock, cancelar, { nombre: "¿Cancelar esta cita?", botonCancelar: "Volver", verificarFoco: false });

    await cancelar.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancelar cita" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/cancel" })).length).toBe(1);
    vigilante.verificar();
  });
});
