import { afirmarCancelarNoEscribe, dialogo as dialogoPorNombre } from "../helpers/dialogos.ts";
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

  // CHAT-11: la ruta del Copiloto entra al humo: abre sin errores de consola ni 5xx y pinta la portada real (h1 + chips de la config).
  test("admin: el Copiloto abre desde su ruta con la portada y los chips, sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("despachos", "admin");
    await page.goto(`/despachos/${despachos.orgSlug}/copiloto`);
    await afirmarPantallaSana(page, "copiloto");
    await expect(page.getByRole("heading", { level: 1, name: "Pregunta a tus datos" })).toBeVisible();
    await expect(page.getByRole("button", { name: "¿Cuánto me deben mis clientes hoy?" })).toBeVisible();
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
    // D-30: cerrar un periodo exige el segundo factor. Cancelar el dialogo no cierra nada; un codigo incorrecto tampoco.
    const verificacion = dialogoPorNombre(page, /Verifica tu identidad/);
    await expect(verificacion).toBeVisible();
    await verificacion.getByRole("button", { name: "Cancelar" }).click();
    await expect(verificacion).toBeHidden();
    expect(await mock.buscar({ metodo: "POST", ruta: "/cerrar" })).toEqual([]);
    await confirmar.click();
    await expect(verificacion).toBeVisible();
    await verificacion.getByLabel("Código de verificación").fill("000000");
    await verificacion.getByRole("button", { name: "Verificar" }).click();
    await expect(verificacion.getByRole("alert")).toContainText("El código es incorrecto o ya se usó.");
    expect(await mock.buscar({ metodo: "POST", ruta: "/cerrar" })).toEqual([]);
    await verificacion.getByLabel("Código de verificación").fill("123456");
    await verificacion.getByRole("button", { name: "Verificar" }).click();
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
