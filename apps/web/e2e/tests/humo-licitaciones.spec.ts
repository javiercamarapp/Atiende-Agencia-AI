import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";

test.describe("licitaciones @humo", () => {
  test("owner: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("licitaciones", "owner");
    expect(aterrizaje.startsWith(`/licitaciones/${licitaciones.orgSlug}`)).toBe(true);
    await afirmarPantallaSana(page, "panel");
    await recorrerSecciones(page, { minimo: 9 });
    vigilante.verificar();
  });

  test("dejar de recibir avisos de WhatsApp: Cancelar y Escape no escriben; confirmar hace un POST /opt-out", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("licitaciones", "owner");
    await page.goto(`/licitaciones/${licitaciones.orgSlug}/whatsapp`);
    const baja = page.getByRole("button", { name: "Dejar de recibir avisos" });
    await expect(baja).toBeVisible();

    await afirmarCancelarNoEscribe(page, mock, baja, { nombre: "Dejar de recibir avisos por WhatsApp", verificarFoco: false });

    await baja.click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Dejar de recibir avisos" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/whatsapp/opt-out" })).length).toBe(1);
    await expect(page.getByText("Dejarás de recibir avisos por WhatsApp.")).toBeVisible();
    vigilante.verificar();
  });
});
