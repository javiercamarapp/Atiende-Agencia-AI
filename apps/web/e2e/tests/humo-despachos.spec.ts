import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";
import { despachos } from "../mock-api/fixtures/despachos.ts";

test.describe("despachos @humo", () => {
  test("owner: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("despachos", "owner");
    expect(aterrizaje.startsWith(`/despachos/${despachos.orgSlug}`)).toBe(true);
    await afirmarPantallaSana(page, "panel");
    await recorrerSecciones(page, { minimo: 12 });
    vigilante.verificar();
  });

  test("cierre mensual irreversible: Cancelar/Escape no escriben, texto incorrecto tampoco, el exacto cierra", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("despachos", "admin");
    await page.goto(`/despachos/${despachos.orgSlug}/cierre-mensual/${despachos.periodoId}`);
    const cerrar = page.getByRole("button", { name: "Cerrar período" });
    await expect(cerrar).toBeVisible();

    await afirmarCancelarNoEscribe(page, mock, cerrar, { nombre: /Confirmar cierre de/, verificarFoco: false });

    await cerrar.click();
    const dialogo = page.getByRole("alertdialog");
    const campo = dialogo.getByLabel(/Escribe exactamente 2026-09/);
    const confirmar = dialogo.getByRole("button", { name: "Confirmar cierre irreversible" });
    // Con un texto distinto el boton sigue deshabilitado (candado de la UI) y no sale ninguna peticion.
    await campo.fill("2026-08");
    await expect(confirmar).toBeDisabled();
    expect(await mock.buscar({ metodo: "POST", ruta: "/cerrar" })).toEqual([]);

    await campo.fill("2026-09");
    await confirmar.click();
    await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/cerrar" })).length).toBe(1);
    const [peticion] = await mock.buscar({ metodo: "POST", ruta: "/cerrar" });
    expect(peticion?.cuerpo).toEqual({ confirmacion: "2026-09" });
    await expect(page.getByText(/Cerrado/).first()).toBeVisible();
    vigilante.verificar();
  });

  test("rol sin permiso de cierre: owner no ve 'Cerrar período'", async ({ page, iniciarSesion }) => {
    await iniciarSesion("despachos", "owner");
    await page.goto(`/despachos/${despachos.orgSlug}/cierre-mensual/${despachos.periodoId}`);
    await expect(page.getByRole("heading", { name: /septiembre 2026/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cerrar período" })).toHaveCount(0);
  });
});
