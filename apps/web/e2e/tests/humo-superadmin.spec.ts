import { afirmarCancelarNoEscribe } from "../helpers/dialogos.ts";
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarPantallaSana, recorrerSecciones } from "../helpers/humo.ts";

test.describe("superadmin @humo", () => {
  test("superadmin: entra y recorre todo el menu sin errores de consola ni 5xx", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("superadmin");
    expect(aterrizaje).toBe("/superadmin");
    await afirmarPantallaSana(page, "resumen");
    // SA-L-01: el listado de organizaciones ya no es la raiz; vive en su propia ruta.
    await page.goto("/superadmin/organizaciones");
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

  test("panel de agentes: Cancelar y Escape en la palanca no escriben; aplicar con motivo hace un PUT y la fila queda Detenida", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("superadmin");
    await page.goto("/superadmin/agentes");
    await expect(page.getByText("Agente de WhatsApp de restaurantes")).toBeVisible();
    const detener = page.getByRole("button", { name: "Detener Agente de WhatsApp de restaurantes" });
    await expect(detener).toBeVisible();

    await afirmarCancelarNoEscribe(page, mock, detener, { nombre: /Detener Agente de WhatsApp de restaurantes/, verificarFoco: false });

    await detener.click();
    const dialogo = page.getByRole("alertdialog", { name: /Detener Agente de WhatsApp de restaurantes/ });
    await dialogo.getByLabel(/Motivo/).fill("Incidente de prueba: se detiene el agente para validar el flujo");
    await dialogo.getByRole("button", { name: "Detener agente" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "PUT", ruta: "/superadmin/interruptores" })).length).toBe(1);
    await expect(page.getByRole("button", { name: "Reactivar Agente de WhatsApp de restaurantes" })).toBeVisible();
    vigilante.verificar();
  });

  test("panel de agentes: una corrida abre su traza con el error redactado", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("superadmin");
    await page.goto("/superadmin/agentes");
    await page.getByText("/internal/rentas/ical-sync").click();
    const traza = page.getByRole("dialog", { name: "Traza de la corrida" });
    await expect(traza.getByText("timeout del proveedor de calendario")).toBeVisible();
    vigilante.verificar();
  });
});
